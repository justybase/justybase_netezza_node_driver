import * as net from 'net';
import * as tls from 'tls';
import type { WriteStream } from 'fs';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { Handshake } from './Handshake';
import { PGUtil } from './utils/PGUtil';
import { NzCommand } from './NzCommand';
import { NzDataReader, GeneratorItem, ColumnDescription } from './NzDataReader';
import { DbosTupleDesc } from './DbosTupleDesc';
import { BackendMessageCode, NzType } from './protocol/constants';
import { buildSimpleQueryPacket } from './protocol/QueryExecutor';
import { ColumnInfo, ResponseMessage } from './protocol/messages';
import * as TypeConversions from './types/TypeConversions';
import { createNzDatabaseError } from './errors/NzDatabaseError';
import { substituteParameters } from './protocol/sqlParameters';
import { parseConnectionString } from './connectionString';
import { ExternalTableHandler, ExternalTableIO } from './external/ExternalTableHandler';
import createDebug from 'debug';

const debug = createDebug('nz:connection');

/**
 * Parse rows affected from Netezza CommandComplete message.
 * Netezza returns patterns like:
 * - "INSERT 0 1" (oid ignored, last number is row count)
 * - "UPDATE 5" (direct row count)
 * - "DELETE 3" (direct row count)
 * - "SELECT 10" (row count for SELECT)
 * - "CREATE TABLE" (no row count, returns -1)
 *
 * Uses same logic as C# driver: split by space and take last value
 */
function parseCommandCompleteRows(commandText: string): number {
    // Remove trailing null byte and trim whitespace
    const cleanText = commandText.replace(/\x00/g, '').trim();

    // Split by whitespace
    const values = cleanText.split(/\s+/);
    const command = values[0];

    // Commands that have row counts (same as C# driver, plus SELECT when server reports it)
    const commandsWithCount = ['INSERT', 'UPDATE', 'DELETE', 'SELECT'];

    if (commandsWithCount.includes(command.toUpperCase())) {
        // Take the last value as row count (same as C#: values[^1])
        const lastValue = values[values.length - 1];
        const parsed = parseInt(lastValue, 10);
        if (!isNaN(parsed)) {
            return parsed;
        }
    }

    return -1;
}

export interface NzConnectionConfig {
    host: string;
    port?: number;
    database: string;
    user: string;
    password: string;
    securityLevel?: string;
    sslCerFilePath?: string;
    /**
     * When true (default), the TLS layer verifies the server certificate against
     * the system CA store (or against `sslCerFilePath` if provided).
     *
     * Set to `false` to allow self-signed or otherwise untrusted certificates.
     * Use this option only for testing or when you trust the network and server.
     */
    rejectUnauthorized?: boolean;
    connectionTimeout?: number; // Connection timeout in seconds (default: 30)
    /** Application name reported to Netezza for Guardium audit / system table visibility */
    appName?: string;
    /** OS user name reported to Netezza */
    osUser?: string;
    /** Client hostname reported to Netezza */
    clientHostName?: string;
}

export interface QueryResult {
    rows: Record<string, unknown>[];
    rowCount: number;
    fields: { name: string; dataTypeID: number; dataTypeSize: number; dataTypeModifier: number }[];
    notices: string[];
}

export interface ExecuteResult {
    rowCount: number;
    notices: string[];
}

type Stream = net.Socket | tls.TLSSocket;

type TextValueParser = (value: string) => unknown;
type TextBufferParser = (data: Buffer, offset: number, len: number) => unknown;
type BinaryFieldParser = (buffer: Buffer, fieldStart: number) => unknown;

/**
 * Netezza database connection.
 *
 * Events:
 * - `notice` — server NoticeResponse (`{ message: string }`)
 * - `error` — socket/protocol error after connect
 * - `close` — underlying socket closed
 */
class NzConnection extends EventEmitter {
    config: NzConnectionConfig;
    private _socket: net.Socket | null = null;
    private _stream: Stream | null = null;
    private _backendProcessId: number = 0;
    private _backendSecretKey: number = 0;
    private _commandNumber: number = 0;
    /** Incremented on every command execution. Used to detect stale timeout-cancel calls. */
    private _commandGeneration: number = 0;
    private _connected: boolean = false;
    private _closing: boolean = false;
    private _rowDescription: ColumnInfo[] | null = null;
    private _textColumnParsers: TextValueParser[] | null = null;
    private _textBufferParsers: (TextBufferParser | null)[] | null = null;
    private _binaryFieldParsers: BinaryFieldParser[] | null = null;
    private _rows: unknown[] = [];
    private _tupdesc: DbosTupleDesc = new DbosTupleDesc();
    private _batchRowCache: unknown[][] | null = null;
    private _tmpBuffer: Buffer = Buffer.alloc(65536);
    private _varOffsetsScratch: number[] = [];

    // Diagnostics counters
    private _diag: Record<string, number> = {};
    /** Read-only view of internal protocol/performance counters */
    get diagnostics(): Readonly<Record<string, number>> {
        return this._diag;
    }
    private _resetDiag(): void {
        this._diag = {
            readBytesCalls: 0,
            readBytesBytes: 0,
            readBytesSlowCalls: 0,
            readBytesSlowBytes: 0,
            ensureBufferCompactions: 0,
            ensureBufferRegrows: 0,
            resReadDbosTupleCalls: 0,
            parseDbosRowCalls: 0,
            parseDbosRowVarOffsetsAlloc: 0,
            generatorYields: 0,
            generatorYieldsDataRow: 0,
            generatorYieldsRowDesc: 0,
            generatorYieldsCmdComplete: 0,
            tryReadDbosBatchCalls: 0,
            tryReadDbosBatchRows: 0,
            tryReadDbosBatchPeeks: 0,
            batchCacheHits: 0,
            getValueCalls: 0,
            textParseDataRowCalls: 0,
            textParseSlowPath: 0,
            textParseFastPath: 0,
        };
    }

    // Single dynamic internal buffer for reading from the stream.
    // Grows as needed by reallocation instead of using a fixed-size circular pool,
    // which avoids data corruption when consumption lags behind arrival.
    private _intBuf!: Buffer;
    private _intBufStart: number = 0;
    private _intBufEnd: number = 0;

    private _initBuffer(): void {
        this._intBuf = Buffer.allocUnsafe(65536);
    }

    /**
     * Ensures the internal buffer has at least `needed` bytes of writable space.
     * Compacts remaining unconsumed data to the front, or grows the buffer if necessary.
     */
    private _ensureBufferCapacity(needed: number): void {
        const remaining = this._intBufEnd - this._intBufStart;

        // Already enough space from current write position
        if (this._intBuf.length - this._intBufEnd >= needed) return;

        // Enough total capacity if we compact to front
        if (this._intBuf.length - remaining >= needed) {
            if (remaining > 0) {
                this._intBuf.copy(this._intBuf, 0, this._intBufStart, this._intBufEnd);
            }
            this._diag.ensureBufferCompactions = (this._diag.ensureBufferCompactions || 0) + 1;
            this._intBufStart = 0;
            this._intBufEnd = remaining;
            return;
        }

        // Need to grow: allocate new buffer, preserving remaining data
        const newSize = Math.max(this._intBuf.length * 2, remaining + needed, 65536);
        const newBuf = Buffer.allocUnsafe(newSize);
        if (remaining > 0) {
            this._intBuf.copy(newBuf, 0, this._intBufStart, this._intBufEnd);
        }
        this._diag.ensureBufferRegrows = (this._diag.ensureBufferRegrows || 0) + 1;
        this._intBuf = newBuf;
        this._intBufStart = 0;
        this._intBufEnd = remaining;
    }

    commandTimeout: number = 30;
    connectionTimeout: number = 10; // Default 10 seconds for connection timeout
    private _executing: boolean = false;
    /**
     * The promise for an in-flight execute operation whose protocol response
     * is still being consumed (the whole execution for execute(); only the
     * startup phase for executeReader()). A timeout deliberately rejects the
     * public promise before this operation has finished, so close() must keep
     * the stream alive until it settles.
     *
     * Note: once a reader has been handed to the caller, this is cleared while
     * rows are still being streamed — close() does not wait for an active
     * reader, it just closes the socket so the pending read rejects.
     */
    private _activeExecution: Promise<unknown> | null = null;
    private _exportStream: WriteStream | null = null;
    private readonly _external: ExternalTableHandler;

    // Static registry for virtual import streams
    private static _streamRegistry: Map<string, Readable> = new Map();

    static registerImportStream(id: string, stream: Readable) {
        this._streamRegistry.set(id, stream);
    }

    static unregisterImportStream(id: string) {
        this._streamRegistry.delete(id);
    }

    constructor(config: NzConnectionConfig | string) {
        super();
        this.config = typeof config === 'string' ? parseConnectionString(config) : config;
        this._initBuffer();
        if (this.config.connectionTimeout !== undefined) {
            this.connectionTimeout = this.config.connectionTimeout;
        }
        this._external = new ExternalTableHandler(this._createExternalTableIO());
    }

    private _createExternalTableIO(): ExternalTableIO {
        return {
            readBytes: (n) => this._readBytes(n),
            readInt32: () => this._readInt32(),
            write: (data) => {
                return new Promise<void>((resolve, reject) => {
                    if (!this._stream) {
                        reject(new Error('Not connected'));
                        return;
                    }
                    // Resolve/reject only from the write callback (or drain) so a late
                    // socket error cannot reject after the promise already settled.
                    let settled = false;
                    const fail = (err: Error) => {
                        if (settled) return;
                        settled = true;
                        reject(err);
                    };
                    const succeed = () => {
                        if (settled) return;
                        settled = true;
                        resolve();
                    };
                    const ok = this._stream.write(data, (err) => {
                        if (err) {
                            fail(err);
                            return;
                        }
                        if (ok) succeed();
                    });
                    if (!ok) {
                        this._stream.once('drain', succeed);
                    }
                });
            },
            emit: (event, ...args) => this.emit(event, ...args),
            getExportStream: () => this._exportStream,
            setExportStream: (s) => {
                this._exportStream = s;
            },
            hasImportStream: (id) => NzConnection._streamRegistry.has(id),
            getImportStream: (id) => NzConnection._streamRegistry.get(id)!,
        };
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.config.host) return reject(new Error('Host is required'));

            let connectionTimedOut = false;
            let connectionTimer: NodeJS.Timeout | undefined;

            // Set up connection timeout
            if (this.connectionTimeout > 0) {
                connectionTimer = setTimeout(() => {
                    connectionTimedOut = true;
                    debug('Connection timeout triggered after', this.connectionTimeout, 'seconds');
                    if (this._socket) {
                        this._socket.destroy();
                    }
                    reject(new Error(`Connection timeout after ${this.connectionTimeout} seconds`));
                }, this.connectionTimeout * 1000);
            }

            const clearConnectionTimeout = () => {
                if (connectionTimer) {
                    clearTimeout(connectionTimer);
                    connectionTimer = undefined;
                }
            };

            this._socket = new net.Socket();
            this._socket.connect(this.config.port || 5480, this.config.host, async () => {
                if (connectionTimedOut) return; // Already timed out
                debug('Socket connected');
                this._socket!.setNoDelay(true);
                this._stream = this._socket!;
                const handshake = new Handshake(
                    this._socket!,
                    this._stream,
                    this.config.host,
                    this.config as NzConnectionConfig & {
                        securityLevel?:
                            | 'PreferredUnsecured'
                            | 'OnlyUnsecuredSession'
                            | 'PreferredSecuredSession'
                            | 'OnlySecuredSession';
                    }
                );
                try {
                    this._stream = await handshake.startup(
                        this.config.database,
                        this.config.user,
                        this.config.password
                    );
                    if (connectionTimedOut) return; // Check again after async handshake
                    clearConnectionTimeout();
                    this._connected = true;
                    this._backendProcessId = handshake.backendProcessId;
                    this._backendSecretKey = handshake.backendSecretKey;
                    resolve();
                } catch (err) {
                    clearConnectionTimeout();
                    this._socket!.destroy();
                    reject(err);
                }
            });
            this._socket.on('error', (err) => {
                debug('Socket error', err);
                clearConnectionTimeout();
                if (!this._connected) reject(err);
                else this.emit('error', err);
            });
            this._socket.on('close', () => {
                debug('Socket closed');
                clearConnectionTimeout();
                this._connected = false;
                this.emit('close');
            });
        });
    }

    async cancel(internalGen?: number): Promise<void> {
        if (!this._backendProcessId || !this._backendSecretKey) return;
        // If a newer command already started, this cancel is stale — abort.
        if (internalGen !== undefined && internalGen !== this._commandGeneration) {
            debug('Stale cancel detected — generation mismatch, skipping');
            return;
        }

        const timeoutSeconds = this.connectionTimeout || 10;
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();

            const timer = setTimeout(() => {
                debug('Cancel socket timeout after', timeoutSeconds, 'seconds');
                socket.destroy();
                reject(new Error(`Cancel connection timeout after ${timeoutSeconds} seconds`));
            }, timeoutSeconds * 1000);

            const cleanup = () => {
                clearTimeout(timer);
                socket.removeAllListeners();
            };

            socket.on('error', (err) => {
                cleanup();
                debug('Cancel socket error', err);
                reject(err);
            });
            socket.setTimeout(timeoutSeconds * 1000, () => {
                cleanup();
                socket.destroy();
                reject(new Error(`Cancel connection timeout after ${timeoutSeconds} seconds`));
            });
            socket.connect(this.config.port || 5480, this.config.host, () => {
                cleanup();

                // Check again right before sending — the command may have finished since connect started.
                if (internalGen !== undefined && internalGen !== this._commandGeneration) {
                    debug('Stale cancel after connect — generation mismatch, discarding socket');
                    socket.end();
                    socket.destroy();
                    resolve();
                    return;
                }

                const buf = Buffer.alloc(16);
                PGUtil.writeInt32(buf, 16, 0);
                PGUtil.writeInt32(buf, 80877102, 4);
                PGUtil.writeInt32(buf, this._backendProcessId, 8);
                PGUtil.writeInt32(buf, this._backendSecretKey, 12);

                socket.write(buf, () => {});
                socket.on('close', () => resolve());
                socket.on('end', () => resolve());
                socket.on('error', () => resolve());
            });
        });
    }

    /**
     * Close the connection. Idempotent — safe to call multiple times.
     * Emits `close` when the underlying socket closes.
     */
    async close(): Promise<void> {
        if (this._closing) {
            return;
        }
        if (!this._socket || this._socket.destroyed) {
            await this._waitForActiveExecution();
            this._connected = false;
            this._socket = null;
            this._stream = null;
            return;
        }

        this._closing = true;
        this._connected = false;
        const sock = this._socket;

        await new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            sock.once('close', done);
            try {
                sock.end();
            } catch {
                /* ignore */
            }
            try {
                sock.destroy();
            } catch {
                /* ignore */
            }
            if (sock.destroyed) {
                done();
            }
        });

        // A timed-out executeReader() may still be unwinding its async
        // generator after the socket close event. Do not clear _stream until
        // that cleanup has completed.
        await this._waitForActiveExecution();
        this._socket = null;
        this._stream = null;
        this._closing = false;
    }

    private async _waitForActiveExecution(): Promise<void> {
        const activeExecution = this._activeExecution;
        if (activeExecution) {
            await activeExecution.catch(() => undefined);
        }
    }

    private _trackExecution<T>(execution: Promise<T>): Promise<T> {
        this._activeExecution = execution;
        execution.then(
            () => {
                if (this._activeExecution === execution) this._activeExecution = null;
            },
            () => {
                if (this._activeExecution === execution) this._activeExecution = null;
            }
        );
        return execution;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    private _assertCanExecute(): void {
        if (this._closing || !this._connected || !this._stream) {
            throw new Error('Connection is closed');
        }
    }

    createCommand(sql?: string, params?: unknown[]): NzCommand {
        const cmd = new NzCommand(this);
        if (sql) cmd.commandText = sql;
        if (params) cmd.parameters = params;
        return cmd;
    }

    async beginTransaction(): Promise<void> {
        const cmd = this.createCommand('BEGIN');
        await this.execute(cmd);
    }

    async commit(): Promise<void> {
        const cmd = this.createCommand('COMMIT');
        await this.execute(cmd);
    }

    async rollback(): Promise<void> {
        const cmd = this.createCommand('ROLLBACK');
        await this.execute(cmd);
    }

    /**
     * Run `fn` inside a BEGIN/COMMIT transaction. Rolls back on throw.
     */
    async transaction<T>(fn: (conn: this) => Promise<T>): Promise<T> {
        await this.beginTransaction();
        try {
            const result = await fn(this);
            await this.commit();
            return result;
        } catch (err) {
            try {
                await this.rollback();
            } catch {
                /* ignore rollback failure */
            }
            throw err;
        }
    }

    /**
     * Execute SQL and buffer all rows. Parameters use client-side escaped interpolation ($1, $2, ...).
     */
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
        const cmd = this.createCommand(sql, params);
        const reader = await this.executeReader(cmd);
        try {
            const rows: Record<string, unknown>[] = [];
            while (await reader.read()) {
                rows.push(reader.getRowObject()!);
            }
            const fields = (reader.columnDescriptions || []).map((c) => ({
                name: c.name,
                dataTypeID: c.typeOid,
                dataTypeSize: c.typeLen,
                dataTypeModifier: c.typeMod,
            }));
            return {
                rows,
                rowCount: cmd._recordsAffected >= 0 ? cmd._recordsAffected : rows.length,
                fields,
                notices: [...cmd.notices],
            };
        } finally {
            await reader.close();
        }
    }

    private async _skipBytes(n: number): Promise<void> {
        await this._ensureBufferData(n);
        this._intBufStart += n;
    }

    private async _readBytes(n: number): Promise<Buffer> {
        this._diag.readBytesCalls = (this._diag.readBytesCalls || 0) + 1;
        this._diag.readBytesBytes = (this._diag.readBytesBytes || 0) + n;
        if (this._intBufEnd - this._intBufStart >= n) {
            const result = Buffer.from(this._intBuf.subarray(this._intBufStart, this._intBufStart + n));
            this._intBufStart += n;
            return result;
        }
        return this._readBytesSlow(n);
    }

    private async _readBytesSlow(n: number): Promise<Buffer> {
        this._diag.readBytesSlowCalls = (this._diag.readBytesSlowCalls || 0) + 1;
        this._diag.readBytesSlowBytes = (this._diag.readBytesSlowBytes || 0) + n;
        const stream = this._assertReadableStream();
        if (n > this._intBuf.length) {
            const chunks: Buffer[] = [];
            const available = this._intBufEnd - this._intBufStart;
            if (available > 0) {
                chunks.push(Buffer.from(this._intBuf.subarray(this._intBufStart, this._intBufEnd)));
                this._intBufStart = 0;
                this._intBufEnd = 0;
            }

            let remaining = n - available;
            while (remaining > 0) {
                const chunk = stream.read() as Buffer | null;
                if (chunk !== null) {
                    if (chunk.length <= remaining) {
                        chunks.push(chunk);
                        remaining -= chunk.length;
                    } else {
                        chunks.push(chunk.slice(0, remaining));
                        this._feedBuffer(chunk.slice(remaining));
                        remaining = 0;
                    }
                } else {
                    await this._waitForReadable();
                }
            }
            return Buffer.concat(chunks, n);
        }

        if (this._intBuf.length - this._intBufStart < n) {
            this._ensureBufferCapacity(this._intBufStart + n);
        }

        while (this._intBufEnd - this._intBufStart < n) {
            const chunk = stream.read() as Buffer | null;
            if (chunk !== null) {
                const space = this._intBuf.length - this._intBufEnd;
                if (chunk.length <= space) {
                    chunk.copy(this._intBuf, this._intBufEnd);
                    this._intBufEnd += chunk.length;
                } else {
                    chunk.copy(this._intBuf, this._intBufEnd, 0, space);
                    this._intBufEnd += space;
                    stream.unshift(chunk.slice(space));
                }
            } else {
                await this._waitForReadable();
            }
        }

        const result = Buffer.from(this._intBuf.subarray(this._intBufStart, this._intBufStart + n));
        this._intBufStart += n;
        return result;
    }

    private async _waitForReadable(): Promise<void> {
        const stream = this._stream;
        if (!stream || !this._socket || this._socket.destroyed) {
            throw new Error('Socket closed or destroyed during read');
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                if (settled) return;
                settled = true;
                stream.removeListener('readable', onReadable);
                stream.removeListener('close', onClose);
                stream.removeListener('error', onError);
                stream.removeListener('end', onClose);
            };
            const onReadable = () => {
                cleanup();
                resolve();
            };
            const onClose = () => {
                cleanup();
                reject(new Error('Socket closed/ended during read'));
            };
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };

            stream.once('readable', onReadable);
            stream.once('close', onClose);
            stream.once('end', onClose);
            stream.once('error', onError);
        });
    }

    private async _waitForReadableTimeout(timeoutMs: number): Promise<boolean> {
        const stream = this._stream;
        if (!stream || !this._socket || this._socket.destroyed) return false;
        return new Promise((resolve) => {
            let settled = false;
            const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                stream.removeListener('readable', onReadable);
                stream.removeListener('close', onDone);
                stream.removeListener('error', onDone);
                stream.removeListener('end', onDone);
            };
            const onReadable = () => {
                cleanup();
                resolve(true);
            };
            const onDone = () => {
                cleanup();
                resolve(false);
            };
            const timer = setTimeout(
                () => {
                    cleanup();
                    resolve(false);
                },
                Math.max(1, timeoutMs)
            );

            stream.once('readable', onReadable);
            stream.once('close', onDone);
            stream.once('end', onDone);
            stream.once('error', onDone);
        });
    }

    private _feedBuffer(buf: Buffer): void {
        const stream = this._assertReadableStream();
        stream.unshift(buf);
    }

    /**
     * Returns the current stream, or throws a clean error when the connection
     * has been closed while a reader is still being consumed.
     */
    private _assertReadableStream(): Stream {
        const stream = this._stream;
        if (!stream || !this._socket || this._socket.destroyed) {
            throw new Error('Connection is closed');
        }
        return stream;
    }

    /** Copy any already-buffered socket bytes into the internal parse buffer. */
    private _pullAvailableFromStream(): number {
        if (!this._stream) return 0;
        let pulled = 0;
        while (true) {
            const chunk = this._stream.read() as Buffer | null;
            if (chunk === null) break;
            this._ensureBufferCapacity(chunk.length);
            chunk.copy(this._intBuf, this._intBufEnd);
            this._intBufEnd += chunk.length;
            pulled += chunk.length;
        }
        return pulled;
    }

    private _discardLeadingNulls(): number {
        let n = 0;
        while (this._intBufStart < this._intBufEnd && this._intBuf[this._intBufStart] === 0) {
            this._intBufStart++;
            n++;
        }
        return n;
    }

    private _bufferedAvailable(): number {
        return this._intBufEnd - this._intBufStart;
    }

    private async _waitForOrphanedBytes(needed: number, deadlineMs: number): Promise<boolean> {
        while (this._bufferedAvailable() < needed) {
            this._pullAvailableFromStream();
            if (this._bufferedAvailable() >= needed) return true;
            const remaining = deadlineMs - Date.now();
            if (remaining <= 0) return false;
            const got = await this._waitForReadableTimeout(Math.min(remaining, 250));
            if (!got && this._bufferedAvailable() < needed) {
                this._pullAvailableFromStream();
                if (this._bufferedAvailable() >= needed) return true;
                if (Date.now() >= deadlineMs) return false;
            }
        }
        return true;
    }

    private _protocolSyncError(context: string, detail: string): Error {
        const preview = String(context || '')
            .replace(/\s+/g, ' ')
            .slice(0, 80);
        return new Error(
            `Connection protocol out of sync before executing "${preview}": ${detail}. Reconnect required.`
        );
    }

    /**
     * If a previous command left an unread backend response on the wire/buffer
     * (e.g. abandoned SELECT CURRENT_SID after cancel/timeout), consume it up to
     * ReadyForQuery before sending the next query. Otherwise that leftover
     * RowDescription/DataRow is incorrectly attributed to the new command.
     */
    private async _ensureProtocolSynced(context: string): Promise<void> {
        const ORPHAN_DRAIN_MS = 2000;
        this._pullAvailableFromStream();
        this._discardLeadingNulls();
        if (this._bufferedAvailable() <= 0) return;

        debug('Orphaned backend data before command, draining:', this._bufferedAvailable(), context);
        const deadline = Date.now() + ORPHAN_DRAIN_MS;

        while (true) {
            this._pullAvailableFromStream();
            this._discardLeadingNulls();

            if (this._bufferedAvailable() <= 0) {
                // Do not treat empty buffer as synced — wait for ReadyForQuery / more data.
                if (!(await this._waitForOrphanedBytes(1, deadline))) {
                    throw this._protocolSyncError(context, 'orphaned response incomplete (no ReadyForQuery)');
                }
                continue;
            }

            if (!(await this._waitForOrphanedBytes(1, deadline))) {
                throw this._protocolSyncError(context, 'truncated orphaned message type byte');
            }

            let type = await this._readByte();
            while (type === 0) {
                if (!(await this._waitForOrphanedBytes(1, deadline))) {
                    throw this._protocolSyncError(context, 'truncated orphaned null padding');
                }
                type = await this._readByte();
            }

            if (!(await this._waitForOrphanedBytes(4, deadline))) {
                throw this._protocolSyncError(context, `truncated orphaned header for type 0x${type.toString(16)}`);
            }
            await this._skipBytes(4);

            if (type === BackendMessageCode.ReadyForQuery || type === BackendMessageCode.ReadyForQueryAlt) {
                this._discardLeadingNulls();
                return;
            }

            if (
                type === BackendMessageCode.EmptyQueryResponse ||
                type === BackendMessageCode.ControlZero ||
                type === BackendMessageCode.ControlA
            ) {
                continue;
            }

            // Binary row: after the 4-byte header skip, payload is 8 + rowLength (same as _resReadDbosTuple).
            if (type === BackendMessageCode.RowStandard) {
                if (!(await this._waitForOrphanedBytes(8, deadline))) {
                    throw this._protocolSyncError(context, 'truncated orphaned RowStandard header');
                }
                const rowLength = this._intBuf.readInt32BE(this._intBufStart + 4);
                if (rowLength < 0 || rowLength > 10_000_000) {
                    throw this._protocolSyncError(context, `invalid orphaned RowStandard rowLength=${rowLength}`);
                }
                const total = 8 + rowLength;
                if (!(await this._waitForOrphanedBytes(total, deadline))) {
                    throw this._protocolSyncError(context, 'truncated orphaned RowStandard payload');
                }
                await this._skipBytes(total);
                continue;
            }

            if (
                type === BackendMessageCode.CommandComplete ||
                type === BackendMessageCode.ErrorResponse ||
                type === BackendMessageCode.NoticeResponse ||
                type === BackendMessageCode.RowDescription ||
                type === BackendMessageCode.DataRow ||
                type === BackendMessageCode.RowDescriptionStandard ||
                type === BackendMessageCode.BackendPayloadP
            ) {
                if (!(await this._waitForOrphanedBytes(4, deadline))) {
                    throw this._protocolSyncError(context, `truncated orphaned length for type 0x${type.toString(16)}`);
                }
                const len = await this._readInt32();
                if (len < 0 || len > 10_000_000) {
                    throw this._protocolSyncError(
                        context,
                        `invalid orphaned length=${len} for type 0x${type.toString(16)}`
                    );
                }
                if (len > 0) {
                    if (!(await this._waitForOrphanedBytes(len, deadline))) {
                        throw this._protocolSyncError(
                            context,
                            `truncated orphaned payload for type 0x${type.toString(16)}`
                        );
                    }
                    await this._skipBytes(len);
                }
                continue;
            }

            // Unknown length-prefixed backend message
            if (!(await this._waitForOrphanedBytes(4, deadline))) {
                throw this._protocolSyncError(
                    context,
                    `truncated orphaned length for unknown type 0x${type.toString(16)}`
                );
            }
            const len = await this._readInt32();
            if (len < 0 || len > 10_000_000) {
                throw this._protocolSyncError(
                    context,
                    `invalid orphaned length=${len} for unknown type 0x${type.toString(16)}`
                );
            }
            if (len > 0) {
                if (!(await this._waitForOrphanedBytes(len, deadline))) {
                    throw this._protocolSyncError(
                        context,
                        `truncated orphaned payload for unknown type 0x${type.toString(16)}`
                    );
                }
                await this._skipBytes(len);
            }
        }
    }

    private async _readInt32(): Promise<number> {
        await this._ensureBufferData(4);
        const val = this._intBuf.readInt32BE(this._intBufStart);
        this._intBufStart += 4;
        return val;
    }

    private async _readInt16(): Promise<number> {
        await this._ensureBufferData(2);
        const val = this._intBuf.readInt16BE(this._intBufStart);
        this._intBufStart += 2;
        return val;
    }

    private async _readByte(): Promise<number> {
        await this._ensureBufferData(1);
        const val = this._intBuf[this._intBufStart];
        this._intBufStart += 1;
        return val;
    }

    private async _ensureBufferData(n: number): Promise<void> {
        if (this._intBufEnd - this._intBufStart >= n) return;

        if (this._intBuf.length - this._intBufStart < n) {
            this._ensureBufferCapacity(this._intBufStart + n);
        }

        const stream = this._assertReadableStream();
        while (this._intBufEnd - this._intBufStart < n) {
            const chunk = stream.read() as Buffer | null;
            if (chunk !== null) {
                const space = this._intBuf.length - this._intBufEnd;
                if (chunk.length <= space) {
                    chunk.copy(this._intBuf, this._intBufEnd);
                    this._intBufEnd += chunk.length;
                } else {
                    chunk.copy(this._intBuf, this._intBufEnd, 0, space);
                    this._intBufEnd += space;
                    stream.unshift(chunk.slice(space));
                }
            } else {
                await this._waitForReadable();
            }
        }
    }

    async execute(command: NzCommand, bufferOnly?: boolean): Promise<boolean>;
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
    async execute(
        commandOrSql: NzCommand | string,
        bufferOnlyOrParams: boolean | unknown[] = false
    ): Promise<boolean | ExecuteResult> {
        if (typeof commandOrSql === 'string') {
            const cmd = this.createCommand(
                commandOrSql,
                Array.isArray(bufferOnlyOrParams) ? bufferOnlyOrParams : undefined
            );
            const rowCount = await cmd.executeNonQuery();
            return { rowCount, notices: [...cmd.notices] };
        }

        const timeoutSeconds = commandOrSql.commandTimeout;
        if (!timeoutSeconds || timeoutSeconds <= 0) {
            return this._doExecute(commandOrSql);
        }

        const execGen = this._commandGeneration + 1;
        let timer: NodeJS.Timeout | undefined;
        const execPromise = this._trackExecution(this._doExecute(commandOrSql));

        const timeoutPromise = new Promise<boolean>((resolve, reject) => {
            timer = setTimeout(() => {
                debug('Command timeout triggered');
                // Reject immediately so the caller always sees the timeout,
                // regardless of how cancel() or the socket close race settles.
                reject(new Error('Command execution timeout'));
                this.cancel(execGen).catch((e: unknown) => {
                    debug('Cancel failed during timeout:', (e as Error).message);
                });
            }, timeoutSeconds * 1000);
        });

        try {
            return await Promise.race([execPromise, timeoutPromise]);
        } catch (err: unknown) {
            if ((err as Error).message && (err as Error).message.includes('Command execution timeout')) {
                execPromise.catch(() => {});
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private async _doExecute(command: NzCommand): Promise<boolean> {
        this._assertCanExecute();
        if (this._executing) {
            throw new Error('Connection is already executing a command');
        }
        this._executing = true;
        this._commandGeneration++;
        try {
            debug('Executing:', command.commandText);
            await this._ensureProtocolSynced(command.commandText);
            this._assertCanExecute();
            this._preExecution(command);

            let error: Error | null = null;
            const notices: string[] = [];
            let rowsSeen = 0;
            let sawResultSet = false;
            for await (const msg of this._responseGenerator(command)) {
                if (msg.type === 'ErrorResponse') {
                    error = msg.error || createNzDatabaseError(msg.message);
                } else if (msg.type === 'NoticeResponse') {
                    notices.push(msg.message);
                } else if (msg.type === 'RowDescription' || msg.type === 'RowDescriptionStandard') {
                    sawResultSet = true;
                } else if (msg.type === 'DataRow') {
                    sawResultSet = true;
                    rowsSeen += 1;
                }
            }
            command._notices = notices;
            // SELECT (and similar) CommandComplete often has no row count; use drained rows.
            if (command._recordsAffected < 0 && sawResultSet) {
                command._recordsAffected = rowsSeen;
            }
            if (error) throw error;
            return true;
        } finally {
            this._executing = false;
        }
    }

    async executeReader(command: NzCommand): Promise<NzDataReader> {
        const timeoutSeconds = command.commandTimeout || this.commandTimeout;
        if (!timeoutSeconds || timeoutSeconds <= 0) {
            return this._doExecuteReader(command);
        }

        const execGen = this._commandGeneration + 1;
        let timer: NodeJS.Timeout | undefined;
        const execPromise = this._trackExecution(this._doExecuteReader(command));

        const timeoutPromise = new Promise<NzDataReader>((resolve, reject) => {
            timer = setTimeout(() => {
                debug('Command timeout triggered');
                // Reject immediately so the caller always sees the timeout,
                // regardless of how cancel() or the socket close race settles.
                reject(new Error('Command execution timeout'));
                this.cancel(execGen).catch((e: unknown) => {
                    debug('Cancel failed during timeout:', (e as Error).message);
                });
            }, timeoutSeconds * 1000);
        });

        try {
            return await Promise.race([execPromise, timeoutPromise]);
        } catch (err: unknown) {
            if ((err as Error).message && (err as Error).message.includes('Command execution timeout')) {
                // If the execution actually completed before the cancel landed,
                // it resolved with a reader that nobody received. Close it so
                // releaseCallback fires and _executing is not stuck as true,
                // which would permanently block the connection.
                execPromise
                    .then((reader) => {
                        if (reader) {
                            reader.close().catch(() => undefined);
                        }
                    })
                    .catch(() => undefined);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private async _doExecuteReader(command: NzCommand): Promise<NzDataReader> {
        this._assertCanExecute();
        if (this._executing) {
            throw new Error('Connection is already executing a command');
        }
        this._executing = true;
        this._commandGeneration++;
        this._resetDiag();

        try {
            debug('Executing Reader:', command.commandText);
            await this._ensureProtocolSynced(command.commandText);
            this._assertCanExecute();
            this._preExecution(command);

            const generator = this._responseGenerator(command);
            let columns: ColumnInfo[] = [];
            let columnNullability: boolean[] | null = null;

            let item = await generator.next();
            let error: Error | null = null;
            let initialNextItem: ResponseMessage | null = null;
            const notices: string[] = [];

            while (!item.done) {
                const val = item.value;
                if (val.type === 'RowDescription') {
                    columns = val.columns!;
                    columnNullability = null;
                } else if (val.type === 'RowDescriptionStandard') {
                    const desc = val.desc;
                    if (desc && desc.numFields > 0) {
                        columnNullability = [...desc.fieldNullAllowed];
                        if (columns.length === 0) {
                            const ps = command._cachedRowDescription;
                            if (ps && ps.description) {
                                columns = ps.description;
                            }
                        }
                    }
                } else if (val.type === 'DataRow' || val.type === 'CommandComplete' || val.type === 'ReadyForQuery') {
                    if (!error && columns.length > 0) {
                        initialNextItem = val;
                        break;
                    }
                } else if (val.type === 'ErrorResponse') {
                    error = val.error || createNzDatabaseError(val.message);
                } else if (val.type === 'NoticeResponse') {
                    notices.push(val.message);
                }

                item = await generator.next();
            }

            command._notices = notices;

            if (error) {
                this._executing = false;
                throw error;
            }

            return new NzDataReader(
                command,
                generator as AsyncGenerator<GeneratorItem>,
                columns as ColumnDescription[] | null,
                columnNullability,
                () => {
                    this._executing = false;
                },
                initialNextItem as GeneratorItem | null
            );
        } catch (e) {
            this._executing = false;
            throw e;
        }
    }

    private _preExecution(command: NzCommand): void {
        const query =
            command.parameters && command.parameters.length > 0
                ? substituteParameters(command.commandText, command.parameters)
                : command.commandText;
        this._commandNumber++;
        if (this._commandNumber > 100000) this._commandNumber = 1;
        this._assertReadableStream().write(buildSimpleQueryPacket(query, this._commandNumber));
    }

    private async *_responseGenerator(command: NzCommand): AsyncGenerator<ResponseMessage> {
        this._rows = [];
        this._rowDescription = null;
        this._textColumnParsers = null;
        this._textBufferParsers = null;
        this._binaryFieldParsers = null;
        this._batchRowCache = null;
        this._tupdesc.clear();

        let completed = false;

        while (!completed) {
            // Drain batch cache first
            if (this._batchRowCache && this._batchRowCache.length > 0) {
                const cached = this._batchRowCache.shift()!;
                this._diag.batchCacheHits = (this._diag.batchCacheHits || 0) + 1;
                this._diag.generatorYields = (this._diag.generatorYields || 0) + 1;
                this._diag.generatorYieldsDataRow = (this._diag.generatorYieldsDataRow || 0) + 1;
                yield { type: 'DataRow', row: cached };
                continue;
            }

            let type = await this._readByte();

            while (type === 0) {
                type = await this._readByte();
            }

            if (type === 'u'.charCodeAt(0)) {
                await this._external.handleExportStart();
                continue;
            }

            if (type === 'U'.charCodeAt(0)) {
                await this._external.handleExportData();
                continue;
            }

            if (type === 'l'.charCodeAt(0)) {
                await this._external.handleImport();
                continue;
            }

            if (type === 'x'.charCodeAt(0)) {
                await this._skipBytes(4);
                debug('Error operation cancel (Ext Tbl)');
                continue;
            }

            if (type === 'e'.charCodeAt(0)) {
                await this._readBytes(4);
                const len = PGUtil.readInt32(await this._readBytes(4));
                const logDirBuf = await this._readBytes(len - 1);
                const logDir = logDirBuf.toString('utf8');
                await this._readBytes(1); // null terminator

                const filenameBuf: number[] = [];
                let b = (await this._readBytes(1))[0];
                filenameBuf.push(b);
                while (true) {
                    b = (await this._readBytes(1))[0];
                    if (b === 0) break;
                    filenameBuf.push(b);
                }
                const filename = Buffer.from(filenameBuf).toString('utf8');

                const logTypeBuf = await this._readBytes(4);
                const logType = PGUtil.readInt32(logTypeBuf);

                await this._external.saveLog(logDir, filename, logType);
                continue;
            }

            await this._skipBytes(4);

            if (type === BackendMessageCode.CommandComplete) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                const commandText = data.toString('utf8');
                debug('CommandComplete:', commandText);
                const rowsAffected = parseCommandCompleteRows(commandText);
                command._recordsAffected = rowsAffected;
                this._diag.generatorYields = (this._diag.generatorYields || 0) + 1;
                this._diag.generatorYieldsCmdComplete = (this._diag.generatorYieldsCmdComplete || 0) + 1;
                yield { type: 'CommandComplete', text: commandText, rowsAffected };
                continue;
            }

            if (type === BackendMessageCode.ReadyForQuery) {
                completed = true;
                this._diag.generatorYields = (this._diag.generatorYields || 0) + 1;
                yield { type: 'ReadyForQuery' };
                continue;
            }

            if (type === BackendMessageCode.ReadyForQueryAlt) {
                completed = true;
                continue;
            }
            if (type === BackendMessageCode.ControlZero || type === BackendMessageCode.ControlA) {
                continue;
            }

            if (type === BackendMessageCode.BackendPayloadP) {
                const len = await this._readInt32();
                await this._readBytes(len);
                continue;
            }

            if (type === BackendMessageCode.ErrorResponse) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                const err = createNzDatabaseError(data);
                yield { type: 'ErrorResponse', message: err.message, error: err };
                continue;
            }

            if (type === BackendMessageCode.RowDescription) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                this._parseRowDescription(data, command);
                this._diag.generatorYields = (this._diag.generatorYields || 0) + 1;
                this._diag.generatorYieldsRowDesc = (this._diag.generatorYieldsRowDesc || 0) + 1;
                yield { type: 'RowDescription', columns: this._rowDescription! };
                continue;
            }

            if (type === BackendMessageCode.DataRow) {
                this._diag.textParseDataRowCalls = (this._diag.textParseDataRowCalls || 0) + 1;
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                const row = this._parseDataRow(data);
                this._diag.generatorYields = (this._diag.generatorYields || 0) + 1;
                this._diag.generatorYieldsDataRow = (this._diag.generatorYieldsDataRow || 0) + 1;
                yield { type: 'DataRow', row };
                continue;
            }

            if (type === BackendMessageCode.RowDescriptionStandard) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                this._tupdesc.parse(data, command._cachedRowDescription);
                this._binaryFieldParsers = this._buildBinaryFieldParsers();
                yield { type: 'RowDescriptionStandard', desc: this._tupdesc };
                continue;
            }

            if (type === BackendMessageCode.RowStandard) {
                const row = await this._resReadDbosTuple(command);
                // Try batch-read more rows from internal buffer while data is hot
                if (!this._batchRowCache) {
                    this._batchRowCache = this._tryReadDbosBatch();
                }
                this._diag.generatorYields = (this._diag.generatorYields || 0) + 1;
                this._diag.generatorYieldsDataRow = (this._diag.generatorYieldsDataRow || 0) + 1;
                yield { type: 'DataRow', row };
                continue;
            }

            if (type === BackendMessageCode.NoticeResponse) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                const message = data.toString('utf8').replace(/\0/g, '').trim();
                debug(`Notice: ${message}`);
                this.emit('notice', { message });
                yield { type: 'NoticeResponse', message };
                continue;
            }

            debug('Unknown message:', '0x' + type.toString(16));
            try {
                const len = await this._readInt32();
                if (len > 0 && len < 10000000) await this._readBytes(len);
            } catch {
                /* ignore */
            }
        }
    }

    private _parseRowDescription(data: Buffer, command: NzCommand): void {
        debug('parseRowDescription data length:', data.length, 'hex:', data.toString('hex').substring(0, 100));
        let offset = 0;
        if (data.length < 2) {
            debug('Data too short for row description');
            return;
        }
        const count = data.readInt16BE(offset);
        offset += 2;
        debug('Column count:', count);
        this._rowDescription = [];

        for (let i = 0; i < count && offset < data.length; i++) {
            const nameStart = offset;
            while (offset < data.length && data[offset] !== 0) offset++;
            const name = data.toString('utf8', nameStart, offset);
            offset++;

            if (offset + 11 > data.length) {
                debug('Not enough data for column', i, 'at offset', offset, 'need 11 more, have', data.length - offset);
                break;
            }

            const typeOid = data.readInt32BE(offset);
            offset += 4;
            const typeLen = data.readInt16BE(offset);
            offset += 2;
            const typeMod = data.readInt32BE(offset);
            offset += 4;
            const format = data[offset];
            offset += 1;

            this._rowDescription.push({ name, typeOid, typeLen, typeMod, format });
            debug('Column', i, ':', name, 'typeOid:', typeOid, 'typeLen:', typeLen);
        }

        this._textColumnParsers = this._rowDescription.map((column) =>
            TypeConversions.createTextValueParser(column.typeOid, column.typeMod)
        );

        this._textBufferParsers = this._rowDescription.map((column) =>
            TypeConversions.createTextBufferParser(column.typeOid, column.typeMod)
        );

        if (command) command._cachedRowDescription = { description: this._rowDescription };
    }

    private _parseDataRow(data: Buffer): unknown[] {
        const numberOfCol = this._rowDescription!.length;
        const bitmapLen = Math.ceil(numberOfCol / 8);
        let dataIdx = bitmapLen;
        const row = new Array(numberOfCol);

        for (let columnNumber = 0; columnNumber < numberOfCol; columnNumber++) {
            const byteToTest = data[Math.floor(columnNumber / 8)];
            const positionInByte = 7 - (columnNumber % 8);
            const hasValue = (byteToTest & (1 << positionInByte)) !== 0;

            if (!hasValue) {
                row[columnNumber] = null;
                continue;
            }

            const vlen = data.readInt32BE(dataIdx);
            dataIdx += 4;
            const actualLen = vlen - 4;

            if (actualLen <= 0) {
                row[columnNumber] = null;
                continue;
            }

            // Fast path: parse directly from Buffer for known types
            const bufParser = this._textBufferParsers?.[columnNumber];
            if (bufParser) {
                this._diag.textParseFastPath = (this._diag.textParseFastPath || 0) + 1;
                row[columnNumber] = bufParser(data, dataIdx, actualLen);
            } else {
                this._diag.textParseSlowPath = (this._diag.textParseSlowPath || 0) + 1;
                const colDesc = this._rowDescription![columnNumber];
                const value = data.toString('utf8', dataIdx, dataIdx + actualLen);
                const parser = this._textColumnParsers?.[columnNumber];
                row[columnNumber] = parser
                    ? parser(value)
                    : TypeConversions.parseTextValue(value, colDesc?.typeOid, colDesc?.typeMod ?? -1);
            }
            dataIdx += actualLen;
        }
        return row;
    }

    private async _resReadDbosTuple(_command: NzCommand): Promise<unknown[]> {
        this._diag.resReadDbosTupleCalls = (this._diag.resReadDbosTupleCalls || 0) + 1;
        // In-place parsing: read from _intBuf directly without copying
        await this._ensureBufferData(8);
        const rowLength = this._intBuf.readInt32BE(this._intBufStart + 4);
        const totalMsg = 8 + rowLength;
        await this._ensureBufferData(totalMsg);
        const row = this._parseDbosRowInPlace(this._intBuf, this._intBufStart + 8);
        this._intBufStart += totalMsg;
        return row;
    }

    private _parseDbosRow(data: Buffer): unknown[] {
        return this._parseDbosRowInPlace(data, 0);
    }

    private _parseDbosRowInPlace(buffer: Buffer, baseOffset: number): unknown[] {
        const numFields = this._tupdesc.numFields;
        const parsers = this._binaryFieldParsers;
        const row = new Array(numFields);
        this._diag.parseDbosRowCalls = (this._diag.parseDbosRowCalls || 0) + 1;

        // Pre-compute variable field offsets once per row (O(n) instead of O(n²))
        const numVaryingFields = this._tupdesc.numVaryingFields ?? 0;
        const fixedFieldsSize = this._tupdesc.fixedFieldsSize;
        let varFieldStarts: number[] | null = null;
        if (numVaryingFields > 0) {
            if (this._varOffsetsScratch.length < numVaryingFields) {
                this._varOffsetsScratch = new Array(numVaryingFields);
            }
            varFieldStarts = this._varOffsetsScratch;
            this._diag.parseDbosRowVarOffsetsAlloc = (this._diag.parseDbosRowVarOffsetsAlloc || 0) + 1;
            let voff = baseOffset + fixedFieldsSize;
            for (let j = 0; j < numVaryingFields; j++) {
                varFieldStarts[j] = voff;
                const vlen = buffer.readUInt16LE(voff);
                voff += vlen;
                if (vlen % 2 !== 0) voff += 1;
            }
        }

        for (let i = 0; i < numFields; i++) {
            if (this._columnIsNullInPlace(buffer, baseOffset, i)) {
                row[i] = null;
                continue;
            }

            let fieldStart: number;
            const fixedSize = this._tupdesc.fieldFixedSize[i];
            if (fixedSize !== 0) {
                fieldStart = baseOffset + this._tupdesc.fieldOffset[i];
            } else if (varFieldStarts) {
                fieldStart = varFieldStarts[this._tupdesc.fieldOffset[i]];
            } else {
                fieldStart = baseOffset + fixedFieldsSize;
            }

            const parser = parsers?.[i];
            if (parser) {
                row[i] = parser(buffer, fieldStart);
            } else {
                const fldType = this._tupdesc.fieldType[i];
                const fldLen = this._tupdesc.fieldSize[i];
                row[i] = this._parseFieldByTypeInPlace(buffer, fieldStart, fldType, fldLen, i);
            }
        }

        return row;
    }

    private _columnIsNullInPlace(buffer: Buffer, baseOffset: number, fieldLf: number): boolean {
        if (!this._tupdesc.nullsAllowed) return false;
        const byteOffset = baseOffset + this._tupdesc.fieldNullByteOffset[fieldLf];
        const bitMask = this._tupdesc.fieldNullBitMask[fieldLf];
        return (buffer[byteOffset] & bitMask) !== 0;
    }

    /**
     * Try to read additional DBOS rows from the internal buffer.
     * Called after the first row is read, to batch-process remaining rows
     * without per-row async overhead.
     * Validates rowLen against msgLen to detect data corruption.
     */
    private _tryReadDbosBatch(): unknown[][] {
        const rows: unknown[][] = [];
        this._diag.tryReadDbosBatchCalls = (this._diag.tryReadDbosBatchCalls || 0) + 1;

        while (true) {
            const available = this._intBufEnd - this._intBufStart;
            if (available < 1) break;
            this._diag.tryReadDbosBatchPeeks = (this._diag.tryReadDbosBatchPeeks || 0) + 1;

            // Next byte should be 'Y' (RowStandard)
            if (this._intBuf[this._intBufStart] !== 89) break;

            // We need: type(1) + msgLen(4) to compute total message size
            if (available < 5) break;
            const msgLen = this._intBuf.readInt32BE(this._intBufStart + 1);
            const totalMsg = 1 + 4 + msgLen;
            if (available < totalMsg) break;

            if (msgLen < 8) break;

            const payloadStart = this._intBufStart + 5;
            const payloadEnd = payloadStart + msgLen;
            if (payloadEnd > this._intBufEnd) break;

            const rowLen = this._intBuf.readInt32BE(payloadStart + 4);
            if (rowLen <= 0 || 8 + rowLen !== msgLen) break;

            // In-place parse without subarray
            const dataStart = payloadStart + 8;
            rows.push(this._parseDbosRowInPlace(this._intBuf, dataStart));

            this._intBufStart = payloadEnd;
        }

        this._diag.tryReadDbosBatchRows = (this._diag.tryReadDbosBatchRows || 0) + rows.length;
        return rows;
    }

    private _buildBinaryFieldParsers(): BinaryFieldParser[] {
        const numFields = this._tupdesc.numFields;
        const parsers = new Array<BinaryFieldParser>(numFields);

        for (let i = 0; i < numFields; i++) {
            const fldType = this._tupdesc.fieldType[i];
            const fldLen = this._tupdesc.fieldSize[i];

            switch (fldType) {
                case NzType.NzTypeChar:
                    parsers[i] = (buf: Buffer, off: number) => buf.toString('latin1', off, off + fldLen).trimEnd();
                    break;
                case NzType.NzTypeNChar:
                case NzType.NzTypeNVarChar:
                    parsers[i] = (buf: Buffer, off: number) => {
                        const cursize = buf.readInt16LE(off) - 2;
                        return buf.toString('utf8', off + 2, off + 2 + cursize);
                    };
                    break;
                case NzType.NzTypeVarChar:
                case NzType.NzTypeVarFixedChar:
                    parsers[i] = (buf: Buffer, off: number) => {
                        const cursize = buf.readInt16LE(off) - 2;
                        return buf.toString('latin1', off + 2, off + 2 + cursize);
                    };
                    break;
                case NzType.NzTypeInt8:
                    parsers[i] = (buf: Buffer, off: number) => buf.readBigInt64LE(off);
                    break;
                case NzType.NzTypeInt:
                    parsers[i] = (buf: Buffer, off: number) => buf.readInt32LE(off);
                    break;
                case NzType.NzTypeInt2:
                    parsers[i] = (buf: Buffer, off: number) => buf.readInt16LE(off);
                    break;
                case NzType.NzTypeInt1:
                    parsers[i] = (buf: Buffer, off: number) => buf.readInt8(off);
                    break;
                case NzType.NzTypeDouble:
                    parsers[i] = (buf: Buffer, off: number) => buf.readDoubleLE(off);
                    break;
                case NzType.NzTypeFloat:
                    parsers[i] = (buf: Buffer, off: number) => buf.readFloatLE(off);
                    break;
                case NzType.NzTypeDate:
                    parsers[i] = (buf: Buffer, off: number) => TypeConversions.toDateTimeFrom4Bytes(buf, off);
                    break;
                case NzType.NzTypeTime:
                    parsers[i] = (buf: Buffer, off: number) => TypeConversions.timeRecvFloat(buf, off);
                    break;
                case NzType.NzTypeInterval:
                    parsers[i] = (buf: Buffer, off: number) => TypeConversions.intervalRecvFloat(buf, off);
                    break;
                case NzType.NzTypeTimeTz:
                    parsers[i] = (buf: Buffer, off: number) => TypeConversions.timetzOutput(buf, fldLen, off);
                    break;
                case NzType.NzTypeTimestamp:
                    parsers[i] = (buf: Buffer, off: number) => TypeConversions.toDateTimeFrom8Bytes(buf, off);
                    break;
                case NzType.NzTypeBool:
                    parsers[i] = (buf: Buffer, off: number) => buf[off] === 0x01;
                    break;
                case NzType.NzTypeNumeric: {
                    const precision = this._tupdesc.getFieldPrecision(i);
                    const scale = this._tupdesc.getFieldScale(i);
                    const digitCount = this._tupdesc.getNumericDigitCount(i);
                    parsers[i] = (buf: Buffer, off: number) =>
                        TypeConversions.getCsNumeric(buf, precision, scale, digitCount, off);
                    break;
                }
                default:
                    parsers[i] = (buf: Buffer, off: number) => buf.toString('utf8', off, off + fldLen);
                    break;
            }
        }

        return parsers;
    }

    private _parseFieldByType(fieldData: Buffer, fldType: number, fldLen: number, fieldIdx: number): unknown {
        return this._parseFieldByTypeInPlace(fieldData, 0, fldType, fldLen, fieldIdx);
    }

    private _parseFieldByTypeInPlace(
        buffer: Buffer,
        offset: number,
        fldType: number,
        fldLen: number,
        fieldIdx: number
    ): unknown {
        switch (fldType) {
            case NzType.NzTypeChar:
                return buffer.toString('latin1', offset, offset + fldLen).trimEnd();
            case NzType.NzTypeNChar:
            case NzType.NzTypeNVarChar: {
                const cursize = buffer.readInt16LE(offset) - 2;
                return buffer.toString('utf8', offset + 2, offset + 2 + cursize);
            }
            case NzType.NzTypeVarChar:
            case NzType.NzTypeVarFixedChar: {
                const s = buffer.readInt16LE(offset) - 2;
                return buffer.toString('latin1', offset + 2, offset + 2 + s);
            }
            case NzType.NzTypeInt8:
                return buffer.readBigInt64LE(offset);
            case NzType.NzTypeInt:
                return buffer.readInt32LE(offset);
            case NzType.NzTypeInt2:
                return buffer.readInt16LE(offset);
            case NzType.NzTypeInt1:
                return buffer.readInt8(offset);
            case NzType.NzTypeDouble:
                return buffer.readDoubleLE(offset);
            case NzType.NzTypeFloat:
                return buffer.readFloatLE(offset);
            case NzType.NzTypeDate:
                return TypeConversions.toDateTimeFrom4Bytes(buffer, offset);
            case NzType.NzTypeTime:
                return TypeConversions.timeRecvFloat(buffer, offset);
            case NzType.NzTypeInterval:
                return TypeConversions.intervalRecvFloat(buffer, offset);
            case NzType.NzTypeTimeTz:
                return TypeConversions.timetzOutput(buffer, fldLen, offset);
            case NzType.NzTypeTimestamp:
                return TypeConversions.toDateTimeFrom8Bytes(buffer, offset);
            case NzType.NzTypeBool:
                return buffer[offset] === 0x01;
            case NzType.NzTypeNumeric: {
                const p = this._tupdesc.getFieldPrecision(fieldIdx);
                const s = this._tupdesc.getFieldScale(fieldIdx);
                const c = this._tupdesc.getNumericDigitCount(fieldIdx);
                return TypeConversions.getCsNumeric(buffer, p, s, c, offset);
            }
            default:
                return buffer.toString('utf8', offset, offset + fldLen);
        }
    }

    private _columnIsNull(data: Buffer, fieldLf: number): boolean {
        return this._columnIsNullInPlace(data, 0, fieldLf);
    }
}

export { NzConnection };
