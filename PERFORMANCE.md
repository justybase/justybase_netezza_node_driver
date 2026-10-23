# Performance report

Client-side reader performance measured offline against byte-exact appliance
captures, using the same fixtures as the C# reference driver
(`JustyBase.NetezzaDriver`, `NzReplayServer`):

- `dimdate`: `SELECT * FROM JUST_DATA.ADMIN.DIMDATE`, 3652 rows × 19 columns
  (INT4, TIMESTAMP, NVARCHAR).
- `fact200k`: `SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY ORDER BY ROWID LIMIT 200000`,
  200000 rows × 7 columns (INT4, TIMESTAMP, NUMERIC(11,6), NVARCHAR).

## Method

```bash
npm run build && npm run bench:replay -- --samples 10 [--json out.json]
```

- `benchmarks/replay/replay_bench.js` runs the scenarios of the C#
  `ReplayReaderBench` on one open connection. The replay server
  (`tests/helpers/replay/NzReplayServer.js`) runs in a child process over
  loopback, so there is no database latency and its CPU is not counted.
- Each scenario: 3 warmup runs, then N samples with a forced GC before each.
  Reported: median and p95 wall time, client CPU time per op
  (`process.cpuUsage`), rows/s from the median, and GC count/ms per op
  (the forced GC is subtracted from the count).
- Default `commandTimeout` (30 s), so the per-execute timer is included as in
  normal use.
- Host: AMD Ryzen 7 7840HS, WSL2 Linux, Node.js v24.13.1. Absolute numbers are
  noisy (±10%); large ratios are the robust signal.

Correctness gate for every change: `tests/Replay.unit.test.js` pins a SHA-256
digest of every decoded value (with its JS type) of both fixtures, plus
snapshots of the Rust driver's wire fixtures (`tests/fixtures/wire`: numeric
precision matrix, DBOS types, NULL matrix, text protocol, multi-result,
notices, errors, 32 KB varchar), also replayed in 1/3/7-byte chunks.

C# reference on the same fixtures (.NET 10 NativeAOT, same machine, from its
`PERFORMANCE.md`): dimdate full read ~2.3 ms, fact200k full read ~42.5 ms;
read 1 row + dispose: dimdate ~0 ms, fact200k ~9-10 ms (socket transfer only).

## Baseline (3.4.3)

| Fixture | Scenario | Median ms | CPU ms | M rows/s | GC/op |
| --- | --- | ---: | ---: | ---: | ---: |
| dimdate | FullRead_GetValue | 6.20 | 10.37 | 0.59 | 0.9 |
| dimdate | FullDecode_NoGetValue | 5.14 | 7.83 | 0.71 | 0.0 |
| dimdate | FirstColumn | 4.67 | 7.54 | 0.78 | 0.0 |
| dimdate | Read1_Dispose | 4.02 | 6.17 | – | 0.0 |
| dimdate | Read10_Dispose | 4.47 | 7.42 | – | 0.0 |
| dimdate | ForAwait_RowObjects | 7.51 | 11.52 | 0.49 | 0.9 |
| dimdate | Query_RowObjects | 6.05 | 9.87 | 0.60 | 0.1 |
| fact200k | FullRead_GetValue | 155.18 | 184.37 | 1.29 | 10.6 |
| fact200k | FullDecode_NoGetValue | 144.61 | 167.09 | 1.38 | 5.1 |
| fact200k | FirstColumn | 141.90 | 162.95 | 1.41 | 5.0 |
| fact200k | Read1_Dispose | 131.92 | 157.55 | – | 4.1 |
| fact200k | Read10_Dispose | 131.54 | 151.90 | – | 4.0 |
| fact200k | ForAwait_RowObjects | 190.22 | 214.70 | 1.05 | 7.0 |
| fact200k | Query_RowObjects | 220.83 | 356.54 | 0.91 | 7.0 |

CPU profile of fact200k `FullRead_GetValue` (self time): async generator,
microtasks and `read()` ~25%, `utf8Slice`/`toString` (NVARCHAR) ~13%,
`_parseDbosRowInPlace` ~11%, `getCsNumeric` ~9%, timestamp decoding with
`readBigInt64LE` ~8%, GC ~6%.

Gap to C#: ~3.7× on fact200k full read. `Read1_Dispose` costs almost as much
as a full read because `NzDataReader.close()` decodes every remaining row.

---

## 1. Fast discard drain on `close()`

**Problem.** `NzDataReader.close()` iterated the response generator, which
fully decoded every remaining row (strings, numerics, dates) only to drop it.
`SELECT 200k; read(); close()` cost almost a full read.

**Change.** The reader asks the connection to discard (`_beginDiscardingRows`)
before draining. RowStandard (`Y`) and DataRow (`D`) frames are then skipped by
their length; consecutive buffered `Y` frames are skipped in one synchronous
loop; payloads larger than the buffer are discarded chunk by chunk without
growing it (`_discardBytes`). Notices, errors and ReadyForQuery still go through
the normal path. `diagnostics.discardedRows` counts skipped rows. Same design as
the C# `DoNextStepDiscardingRows` / Rust `discard_exact`.

| Fixture | Scenario | Before ms | After ms |
| --- | --- | ---: | ---: |
| dimdate | Read1_Dispose | 4.02 | 1.46 |
| dimdate | Read10_Dispose | 4.47 | 1.09 |
| fact200k | Read1_Dispose | 131.92 | 5.23 |
| fact200k | Read10_Dispose | 131.54 | 5.50 |

fact200k early close: **−96%** (the C# reference needs ~9-10 ms for the same
drain). Full reads are unchanged. Golden digests unchanged.

**Decision: ACCEPTED.**

---

## 2. Fewer promises per row

**Problem.** Every row went through `generator.next()` of an async generator
that itself delegated through `yield*` to a second generator, plus the
`read()` promise: at least three promise hops per row even when the row was
already decoded in the in-buffer batch. Text `D` rows additionally awaited four
reads per row.

**Change.**

- `read()` is no longer `async`: when the connection has already decoded the
  next row (`_batchRowCache`), it takes it synchronously through a
  `ReaderRowSource` and returns a shared resolved promise. The generator is
  resumed only when the batch is exhausted. The generator checks the same batch
  first when resumed, so a row is never delivered twice.
- The `_responseGenerator` → `_responseGeneratorCore` `yield*` layer is merged
  into one generator.
- Text DataRows get the same in-buffer batch as RowStandard rows
  (`_tryReadDataRowBatch`).
- Both batch decoders now stop before a malformed row and leave it to the
  regular path, so its protocol error is raised by the `read()` that reaches
  the row, not by `executeReader()` or an earlier `read()` (previously the
  DBOS batch could throw early). Regression test added.
- `diagnostics` keeps one fixed object shape (`textDataRowView*` counters were
  added lazily before).

| Fixture | Scenario | Before ms | After ms |
| --- | --- | ---: | ---: |
| dimdate | FullRead_GetValue | 5.36 | 4.01 |
| dimdate | FullDecode_NoGetValue | 5.14 | 3.29 |
| fact200k | FullRead_GetValue | 153.97 | 110.53 |
| fact200k | FullDecode_NoGetValue | 144.61 | 104.66 |
| fact200k | ForAwait_RowObjects | 190.22 | 141.61 |
| fact200k | Query_RowObjects | 220.83 | 143.61 |

fact200k full read **−28%**, GC per op roughly halved. Golden digests unchanged.

**Decision: ACCEPTED.**

---

## 3. Bounded decode batch

**Idea.** Cap `_tryReadDbosBatch` (Rust uses 256-row batches) to reduce memory
spikes and wasted decoding before an early `close()`.

| fact200k FullRead_GetValue | 64 | 256 | 1024 | unbounded |
| --- | ---: | ---: | ---: | ---: |
| Median ms | 113.4 | 110.7 | 106.5 | 102.9 |
| GC/op | 22.3 | 11.7 | 7.7 | 5.4 |

Smaller batches only add generator resumptions and garbage. The batch is
already bounded by what is in the read buffer (tens of KB), and early close
now discards instead of decoding (step 1), so `Read10_Dispose` is the same in
every variant (~5.8 ms).

**Decision: REJECTED.** No code change.

---

## 4. NUMERIC decoding without decimal text or BigInt

**Problem.** `getCsNumeric` built the exact decimal text for every value
(`String`, `padStart`, `slice`, template) and then decided number-vs-string by
`parseFloat` + `String(num)` round trip. Values wider than two words, or with
precision > 15, went through one BigInt per 32-bit word plus `toString()`.

**Change.** Same contract, evaluated arithmetically:

- Safe-integer values (any word count, higher words being sign extension):
  for precision ≤ 15 the round-trip rule is closed-form. Scale 0 is always a
  number. Otherwise a value is a number unless its last fraction digit is 0 or
  it is below 1e-6 (where `String()` switches to exponent notation), and the
  number is `unscaled / 10^scale`. With ≤ 15 significant digits that division
  is correctly rounded, so it equals `parseFloat` of the exact text. Text is
  built only when the result is a string.
- Wider values: exact base-1e9 long division over 16-bit limbs (every
  intermediate stays < 2^53), with the decimal point placed while the 9-digit
  chunks are assembled. Same approach as the Rust `decode_wide_into`.
- The old text-based implementation is kept in
  `tests/NumericDecoding.unit.test.js` as the reference. Edge cases, random
  values for every precision 1..38 and scale 0..p, and 20000 arbitrary word
  patterns must return the identical type and value. Mutations of the 1e-6
  boundary and of the trailing-zero rule are caught.

Decoder-only replay (`justybase_netezza_driver_rust/benchmarks/netezza_cross_driver/numeric_replay.js`,
200k iterations × 5 samples, ns/op):

| Case | Before | After | Rust | C# |
| --- | ---: | ---: | ---: | ---: |
| NUMERIC(10,4) `123.4567` | 68.2 | 22.5 | 110.9 | 16.8 |
| NUMERIC(10,4) `3.1400` | 57.8 | 38.1 | 130.0 | 23.1 |
| NUMERIC(30,6) | 276.1 | 143.0 | 18.3 | 23.4 |
| NUMERIC(38,8) negative | 330.6 | 150.0 | 18.1 | 44.8 |

(Rust/C# columns copied from `NUMERIC_ANALYSIS.md`; they return fixed-width
decimal types, while Node returns exact text for wide values.)

| Fixture | Scenario | Before ms | After ms |
| --- | --- | ---: | ---: |
| fact200k | FullRead_GetValue | 110.53 | 97.08 |
| fact200k | FullDecode_NoGetValue | 104.66 | 89.46 |

Golden digests unchanged.

**Decision: ACCEPTED.**

---

## 5. TIMESTAMP and TIME without BigInt

**Problem.** Every TIMESTAMP did `readBigInt64LE` + BigInt division; every TIME
did two BigInt operations and created a new `toString` closure per value.

**Change.**

- TIMESTAMP: exact `int64 / 1000` truncated toward zero, in Number arithmetic,
  using `2^32 = 4294967 * 1000 + 296`. All terms stay safe integers over the
  full int64 range (0001-01-01 … 9999-12-31 included).
- TIME: Number arithmetic when |micros| < 2^53 (always, for a time of day), with
  the BigInt path kept as a fallback. Values are `BinaryTimeValue` instances
  with `toString` on the prototype; own fields and JSON are unchanged.
- `tests/TemporalDecoding.unit.test.js` compares against the previous BigInt
  implementation on edge values (±2^53, int64 min/max, 0001-01-01,
  9999-12-31, -1 µs) and 20000 random values, including `-0` vs `0`.
  Mutations of the truncation correction and of the `-0` normalization are caught.
- INT8 still returns `bigint` (public contract).

| Fixture | Scenario | Before ms | After ms |
| --- | --- | ---: | ---: |
| fact200k | FullRead_GetValue | 97.08 | 84.76 |
| fact200k | FullDecode_NoGetValue | 89.46 | 78.68 |

Golden digests unchanged.

**Decision: ACCEPTED.**

---

## 6. Row loop: precomputed row plan and short-string fast path

**Problem.** After steps 1-5 the profile showed `utf8Slice`/`toString`
(NVARCHAR) at ~20% and `_parseDbosRowInPlace` at ~15% self time. The row loop
re-validated descriptor invariants (`Number.isInteger` on sizes/offsets,
var-index range, null-bitmap bounds) for every field of every row. Every
string value, even `'0'`, was a native `Buffer#toString` call.

**Change.**

- `DbosRowPlan` is built once per result from the descriptor: field kind
  (fixed / varying / after-fixed), offset, null byte and mask in typed arrays,
  plus the end of the fixed area. Per row the fast loop checks the fixed-area
  length once and validates the varying-field chain once (it was validated
  before as well), then only tests null bits and calls the parsers. Irregular
  descriptors, short rows and any anomaly fall back to the previous fully
  checked decoder (`_parseDbosRowChecked`), which still reports the exact
  protocol error.
- `decodeUtf8` / `decodeLatin1` (`src/utils/textDecode.ts`): values of 1-4
  bytes are built with `String.fromCharCode` (UTF-8 only when all bytes are
  ASCII); everything else still uses `Buffer#toString`. Used for NVARCHAR/NCHAR,
  VARCHAR and CHAR. Tested against `Buffer#toString` for every byte value.

| Fixture | Scenario | Before ms | After ms |
| --- | --- | ---: | ---: |
| dimdate | FullRead_GetValue | 4.31 | 3.58 |
| fact200k | FullRead_GetValue | 84.76 | 61.73 |
| fact200k | FullDecode_NoGetValue | 78.68 | 57.66 |
| fact200k | ForAwait_RowObjects | 141.61 | 89.99 |
| fact200k | Query_RowObjects | 143.61 | 89.86 |

Row plan alone (A/B with the plan disabled, string fast path enabled,
fact200k `FullDecode_NoGetValue`, 15 samples, two rounds): 56.2 / 55.7 ms with
the plan vs 62.0 / 67.9 ms without it. Most of the gain comes from the short-string
path (fact200k NVARCHAR values are 1-3 digit strings); dimdate's longer names
gain less. Golden digests unchanged.

**Decision: ACCEPTED.**

---

## 7. Read buffer: bounded size, no split-and-unshift

**Problem.**

- `_ensureBufferData` / `_readBytesSlow` called
  `_ensureBufferCapacity(this._intBufStart + n)`, but the argument means
  "additional writable bytes". Whenever the read position was far into the
  buffer this over-asked and doubled the buffer where compaction would do. The
  buffer never shrank, so it ratcheted up with every large result: reading
  fact200k on one connection left the buffer at 8 MB, 16 MB, 32 MB, then
  64 MB after the 6th query, and every idle connection kept it.
- A socket chunk that did not fit was split: the head was copied, the tail was
  `unshift`ed back into the stream, and the stream copied it again on the next
  `read()`.

**Change.**

- Correct capacity request (`n - buffered`).
- Whole chunks are appended (`_appendChunk`), compacting or growing once if
  needed. A chunk is bounded by the socket's buffered data, so this does not
  grow the buffer without bound.
- After ReadyForQuery a buffer larger than 256 KiB is replaced by a fresh
  64 KiB one when at most 64 KiB is unread (`_shrinkReadBuffer`; Rust
  `shrink_if_large`).

| fact200k, same connection | Query 1 | Query 2 | Query 3 | Query 6 |
| --- | ---: | ---: | ---: | ---: |
| Buffer before | 8 MiB | 16 MiB | 32 MiB | 64 MiB |
| Buffer after | 128 KiB | 128 KiB | 128 KiB | 128 KiB |

Time: fact200k FullRead_GetValue 59.8 → 57.5 ms, FullDecode 57.7 → 53.4-55.2 ms
(small, mostly fewer copies). Regression tests: buffer ≤ 256 KiB across
repeated fact200k reads; a 1 MiB buffer is released after a response. Both fail
on the previous code. Golden digests unchanged.

**Decision: ACCEPTED** (mainly a retained-memory fix).
