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
