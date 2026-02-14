import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { Handshake } from './Handshake';
import { PGUtil } from './utils/PGUtil';
import { NzCommand } from './NzCommand';
import { NzDataReader } from './NzDataReader';
import { DbosTupleDesc } from './DbosTupleDesc';
import { BackendMessageCode, NzType, ExtabSock } from './protocol/constants';
import * as TypeConversions from './types/TypeConversions';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const debug = require('debug')('nz:connection');

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
    // eslint-disable-next-line no-control-regex
    const cleanText = commandText.replace(/\x00/g, '').trim();

    // Split by whitespace
    const values = cleanText.split(/\s+/);
    const command = values[0];

    // Commands that have row counts (same as C# driver)
    const commandsWithCount = ['INSERT', 'UPDATE', 'DELETE'];

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
    rejectUnauthorized?: boolean;
    connectionTimeout?: number; // Connection timeout in seconds (default: 30)
}

interface ColumnInfo {
    name: string;
    typeOid: number;
    typeLen: number;
    typeMod: number;
    format: number;
}

type Stream = net.Socket | tls.TLSSocket;

class NzConnection extends EventEmitter {
    config: NzConnectionConfig;
    private _socket: net.Socket | null = null;
    private _stream: Stream | null = null;
    private _backendProcessId: number = 0;
    private _backendSecretKey: number = 0;
    private _commandNumber: number = -1;
    private _connected: boolean = false;
    private _rowDescription: ColumnInfo[] | null = null;
    private _rows: any[] = [];
    private _tupdesc: DbosTupleDesc = new DbosTupleDesc();
    private _tmpBuffer: Buffer = Buffer.alloc(65536);

    // Internal buffer pool for better performance with large result sets
    // Using pool reduces GC pressure from frequent Buffer allocations
    private static readonly BUFFER_SIZE = 1024 * 1024; // 1 MB
    private static readonly POOL_SIZE = 4; // 4 buffers = 4 MB per connection
    private _bufferPool: Buffer[] = [];
    private _bufferPoolIndex: number = 0;
    private _intBuf!: Buffer;
    private _intBufStart: number = 0;
    private _intBufEnd: number = 0;

    private _initializeBufferPool(): void {
        // Pre-allocate buffers to avoid runtime allocations
        for (let i = 0; i < NzConnection.POOL_SIZE; i++) {
            this._bufferPool.push(Buffer.allocUnsafe(NzConnection.BUFFER_SIZE));
        }
        this._intBuf = this._bufferPool[0];
    }

    /**
     * Rotates to the next buffer in the pool to avoid expensive copy operations.
     * When current buffer has remaining data, it's copied to the new buffer.
     * This is more efficient than frequent small memcpy operations.
     */
    private _rotateBuffer(): void {
        const remaining = this._intBufEnd - this._intBufStart;
        this._bufferPoolIndex = (this._bufferPoolIndex + 1) % NzConnection.POOL_SIZE;
        const newBuf = this._bufferPool[this._bufferPoolIndex];

        if (remaining > 0) {
            // Copy remaining data to the new buffer at offset 0
            this._intBuf.copy(newBuf, 0, this._intBufStart, this._intBufEnd);
            this._intBufStart = 0;
            this._intBufEnd = remaining;
        } else {
            this._intBufStart = 0;
            this._intBufEnd = 0;
        }
        this._intBuf = newBuf;
    }

    commandTimeout: number = 30;
    connectionTimeout: number = 10; // Default 10 seconds for connection timeout
    private _executing: boolean = false;
    private _exportStream: fs.WriteStream | null = null;

    // Static registry for virtual import streams
    private static _streamRegistry: Map<string, Readable> = new Map();

    static registerImportStream(id: string, stream: Readable) {
        this._streamRegistry.set(id, stream);
    }

    static unregisterImportStream(id: string) {
        this._streamRegistry.delete(id);
    }

    constructor(config: NzConnectionConfig) {
        super();
        this.config = config;
        // Initialize buffer pool for better I/O performance
        this._initializeBufferPool();
        // Apply connection timeout from config
        if (config.connectionTimeout !== undefined) {
            this.connectionTimeout = config.connectionTimeout;
        }
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
                const handshake = new Handshake(this._socket!, this._stream, this.config.host, this.config as any);
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

    async cancel(): Promise<void> {
        if (!this._backendProcessId || !this._backendSecretKey) return;

        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            socket.on('error', (err) => {
                debug('Cancel socket error', err);
                reject(err);
            });
            socket.connect(this.config.port || 5480, this.config.host, () => {
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

    close(): void {
        this._bufferPool = [];
        if (this._socket) {
            this._socket.end();
            this._socket.destroy();
        }
    }

    createCommand(sql?: string): NzCommand {
        const cmd = new NzCommand(this as any);
        if (sql) cmd.commandText = sql;
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

    private async _readBytes(n: number): Promise<Buffer> {
        if (this._intBufEnd - this._intBufStart >= n) {
            const result = Buffer.from(this._intBuf.subarray(this._intBufStart, this._intBufStart + n));
            this._intBufStart += n;
            return result;
        }
        return this._readBytesSlow(n);
    }

    private async _readBytesSlow(n: number): Promise<Buffer> {
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
                const chunk = this._stream!.read() as Buffer | null;
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
            // Use buffer rotation instead of copying data to front
            // This is more efficient as it avoids frequent memcpy operations
            this._rotateBuffer();
        }

        while (this._intBufEnd - this._intBufStart < n) {
            const chunk = this._stream!.read() as Buffer | null;
            if (chunk !== null) {
                const space = this._intBuf.length - this._intBufEnd;
                if (chunk.length <= space) {
                    chunk.copy(this._intBuf, this._intBufEnd);
                    this._intBufEnd += chunk.length;
                } else {
                    chunk.copy(this._intBuf, this._intBufEnd, 0, space);
                    this._intBufEnd += space;
                    this._stream!.unshift(chunk.slice(space));
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
        if (!this._socket || this._socket.destroyed) throw new Error('Socket closed or destroyed during read');
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this._stream!.removeListener('readable', onReadable);
                this._stream!.removeListener('close', onClose);
                this._stream!.removeListener('error', onError);
                this._stream!.removeListener('end', onClose);
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

            this._stream!.once('readable', onReadable);
            this._stream!.once('close', onClose);
            this._stream!.once('end', onClose);
            this._stream!.once('error', onError);
        });
    }

    private _feedBuffer(buf: Buffer): void {
        this._stream!.unshift(buf);
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
            // Use buffer rotation instead of copying data to front
            // This is more efficient as it avoids frequent memcpy operations
            this._rotateBuffer();
        }

        while (this._intBufEnd - this._intBufStart < n) {
            const chunk = this._stream!.read() as Buffer | null;
            if (chunk !== null) {
                const space = this._intBuf.length - this._intBufEnd;
                if (chunk.length <= space) {
                    chunk.copy(this._intBuf, this._intBufEnd);
                    this._intBufEnd += chunk.length;
                } else {
                    chunk.copy(this._intBuf, this._intBufEnd, 0, space);
                    this._intBufEnd += space;
                    this._stream!.unshift(chunk.slice(space));
                }
            } else {
                await this._waitForReadable();
            }
        }
    }

    async execute(command: NzCommand, _bufferOnly: boolean = false): Promise<boolean> {
        const timeoutSeconds = command.commandTimeout;
        if (!timeoutSeconds || timeoutSeconds <= 0) {
            return this._doExecute(command);
        }

        let timer: NodeJS.Timeout | undefined;
        const execPromise = this._doExecute(command);

        const timeoutPromise = new Promise<boolean>((resolve, reject) => {
            timer = setTimeout(async () => {
                debug('Command timeout triggered');
                try {
                    await this.cancel();
                } catch (e: any) {
                    debug('Cancel failed during timeout:', e.message);
                }
                reject(new Error('Command execution timeout'));
            }, timeoutSeconds * 1000);
        });

        try {
            return await Promise.race([execPromise, timeoutPromise]);
        } catch (err: any) {
            if (err.message && err.message.includes('Command execution timeout')) {
                execPromise.catch(() => {});
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private async _doExecute(command: NzCommand): Promise<boolean> {
        if (this._executing) {
            throw new Error('Connection is already executing a command');
        }
        this._executing = true;
        try {
            debug('Executing:', command.commandText);
            this._preExecution(command.commandText);

            let error: Error | null = null;
            for await (const msg of this._responseGenerator(command)) {
                if (msg.type === 'ErrorResponse') {
                    error = new Error('Netezza Error: ' + msg.message);
                }
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

        let timer: NodeJS.Timeout | undefined;
        const execPromise = this._doExecuteReader(command);

        const timeoutPromise = new Promise<NzDataReader>((resolve, reject) => {
            timer = setTimeout(async () => {
                debug('Command timeout triggered');
                try {
                    await this.cancel();
                    reject(new Error('Command execution timeout'));
                } catch (e: any) {
                    reject(new Error('Command execution timeout (Cancel failed: ' + e.message + ')'));
                }
            }, timeoutSeconds * 1000);
        });

        try {
            return await Promise.race([execPromise, timeoutPromise]);
        } catch (err: any) {
            if (err.message && err.message.includes('Command execution timeout')) {
                execPromise.catch(() => {});
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private async _doExecuteReader(command: NzCommand): Promise<NzDataReader> {
        if (this._executing) {
            throw new Error('Connection is already executing a command');
        }
        this._executing = true;

        try {
            debug('Executing Reader:', command.commandText);
            this._preExecution(command.commandText);

            const generator = this._responseGenerator(command);
            let columns: ColumnInfo[] = [];

            let item = await generator.next();
            let error: Error | null = null;
            let initialNextItem: any = null;

            while (!item.done) {
                const val = item.value;
                if (val.type === 'RowDescription') {
                    columns = val.columns!;
                } else if (val.type === 'RowDescriptionStandard') {
                    const desc = val.desc;
                    if (desc && desc.numFields > 0 && columns.length === 0) {
                        const ps = (command as any)._preparedStatement;
                        if (ps && ps.description) {
                            columns = ps.description;
                        }
                    }
                } else if (val.type === 'DataRow' || val.type === 'CommandComplete' || val.type === 'ReadyForQuery') {
                    if (!error && columns.length > 0) {
                        initialNextItem = val;
                        break;
                    }
                } else if (val.type === 'ErrorResponse') {
                    error = new Error('Netezza Error: ' + val.message);
                }

                item = await generator.next();
            }

            if (error) {
                this._executing = false;
                throw error;
            }

            return new NzDataReader(
                command as any,
                generator as any,
                columns as any,
                () => {
                    this._executing = false;
                },
                initialNextItem
            );
        } catch (e) {
            this._executing = false;
            throw e;
        }
    }

    private _preExecution(query: string): void {
        const queryBytes = Buffer.from(query, 'utf8');
        const buf = Buffer.allocUnsafe(1 + 4 + queryBytes.length + 1);
        buf[0] = 'P'.charCodeAt(0);
        if (this._commandNumber !== -1) {
            this._commandNumber++;
            buf.writeInt32BE(this._commandNumber, 1);
        } else {
            buf[1] = 0xff;
            buf[2] = 0xff;
            buf[3] = 0xff;
            buf[4] = 0xff;
        }
        if (this._commandNumber > 100000) this._commandNumber = 1;
        queryBytes.copy(buf, 5);
        buf[5 + queryBytes.length] = 0;
        this._stream!.write(buf);
    }

    private async *_responseGenerator(command: NzCommand): AsyncGenerator<any> {
        this._rows = [];
        this._rowDescription = null;

        let completed = false;

        while (!completed) {
            let type = await this._readByte();

            while (type === 0) {
                type = await this._readByte();
            }

            if (type === 'u'.charCodeAt(0)) {
                await this._handleExternalTableExportStart();
                continue;
            }

            if (type === 'U'.charCodeAt(0)) {
                await this._handleExternalTableExportData();
                continue;
            }

            if (type === 'l'.charCodeAt(0)) {
                await this._handleExternalTableImport();
                continue;
            }

            if (type === 'x'.charCodeAt(0)) {
                await this._readBytes(4);
                debug('Error operation cancel (Ext Tbl)');
                continue;
            }

            if (type === 'e'.charCodeAt(0)) {
                await this._readBytes(4);
                const len = PGUtil.readInt32(await this._readBytes(4));
                // logDir is read but not used - kept for protocol compliance
                await this._readBytes(len - 1);
                await this._readBytes(1);

                const filenameBuf: number[] = [];
                let b = (await this._readBytes(1))[0];
                filenameBuf.push(b);
                while (true) {
                    b = (await this._readBytes(1))[0];
                    if (b === 0) break;
                    filenameBuf.push(b);
                }
                // logType is read but not used - kept for protocol compliance
                await this._readBytes(4);

                await this._consumeExternalTableLogData();
                continue;
            }

            await this._readBytes(4);

            if (type === BackendMessageCode.CommandComplete) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                const commandText = data.toString('utf8');
                debug('CommandComplete:', commandText);
                // Parse rows affected from CommandComplete message
                // Netezza returns patterns like: "INSERT 0 1", "UPDATE 5", "DELETE 3", "CREATE TABLE"
                const rowsAffected = parseCommandCompleteRows(commandText);
                command._recordsAffected = rowsAffected;
                yield { type: 'CommandComplete', text: commandText, rowsAffected };
                continue;
            }

            if (type === BackendMessageCode.ReadyForQuery) {
                completed = true;
                yield { type: 'ReadyForQuery' };
                continue;
            }

            if (type === 0x4c) {
                completed = true;
                continue;
            }
            if (type === 0x30 || type === 0x41) {
                continue;
            }

            if (type === 0x50) {
                const len = await this._readInt32();
                await this._readBytes(len);
                continue;
            }

            if (type === BackendMessageCode.ErrorResponse) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                yield { type: 'ErrorResponse', message: data.toString('utf8') };
                continue;
            }

            if (type === BackendMessageCode.RowDescription) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                this._parseRowDescription(data, command);
                yield { type: 'RowDescription', columns: this._rowDescription };
                continue;
            }

            if (type === BackendMessageCode.DataRow) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                const row = this._parseDataRow(data);
                yield { type: 'DataRow', row };
                continue;
            }

            if (type === BackendMessageCode.RowDescriptionStandard) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                this._tupdesc.parse(data, (command as any)._preparedStatement);
                yield { type: 'RowDescriptionStandard', desc: this._tupdesc };
                continue;
            }

            if (type === BackendMessageCode.RowStandard) {
                const row = await this._resReadDbosTuple(command);
                yield { type: 'DataRow', row };
                continue;
            }

            if (type === BackendMessageCode.NoticeResponse) {
                const len = await this._readInt32();
                const data = await this._readBytes(len);
                const message = data.toString('utf8').replace(/\0/g, '').trim();
                this.emit('notice', { message });
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

    private async _consumeExternalTableLogData(): Promise<void> {
        while (true) {
            const lenBuf = await this._readBytes(4);
            const len = PGUtil.readInt32(lenBuf);
            if (len === 0) return;

            const data = await this._readBytes(len);
            debug('ExtLog Content:', data.toString('utf8'));
        }
    }

    private async _handleExternalTableExportStart(): Promise<void> {
        await this._readBytes(4);
        await this._readBytes(10);
        await this._readBytes(16);
        const len = PGUtil.readInt32(await this._readBytes(4));
        const filenameBuf = await this._readBytes(len);
        const filename = filenameBuf.toString('utf8');
        debug('ExternalTable Export Start. File:', filename);

        try {
            this._exportStream = fs.createWriteStream(filename);
            this._exportStream.on('error', (err) => {
                this._exportStream?.destroy();
                this._exportStream = null;
                debug('Export Stream Error:', err);
            });
            const buf = Buffer.alloc(4);
            await new Promise<void>((resolve) => this._stream!.write(buf, () => resolve()));
        } catch (e) {
            debug('Error opening export file:', e);
            const buf = Buffer.alloc(4);
            PGUtil.writeInt32(buf, 1, 0);
            this._stream!.write(buf);
        }
    }

    private async _handleExternalTableExportData(): Promise<void> {
        debug('Handle Export Data: Skipping 8 bytes...');
        const skip1 = await this._readBytes(4);
        debug('Skipped 4:', skip1.toString('hex'));
        const skip2 = await this._readBytes(4);
        debug('Skipped 4 (2):', skip2.toString('hex'));

        await this._consumeExternalTableData(this._exportStream);
        if (this._exportStream && !this._exportStream.closed) {
            this._exportStream.destroy();
        }
        this._exportStream = null;
    }

    private async _consumeExternalTableData(writeStream: fs.WriteStream | null): Promise<void> {
        debug('Entering Consume Loop');
        while (true) {
            debug('Reading status...');
            const statusBuf = await this._readBytes(4);
            const status = PGUtil.readInt32(statusBuf);
            debug('ExtTab Status:', status);

            if (status === ExtabSock.DATA) {
                const numBytes = PGUtil.readInt32(await this._readBytes(4));
                debug('Block Length:', numBytes);
                const data = await this._readBytes(numBytes);
                if (writeStream) {
                    writeStream.write(data);
                }
            } else if (status === ExtabSock.DONE) {
                debug('ExternalTable Data Done');
                if (writeStream) {
                    await new Promise<void>((resolve) => {
                        debug('Waiting for writeStream finish...');
                        if (writeStream.writableFinished) {
                            debug('Stream already finished');
                            return resolve();
                        }
                        const timeout = setTimeout(() => {
                            debug('Stream finish timeout! Destroying...');
                            writeStream.destroy();
                            resolve();
                        }, 5000);

                        const onFinish = () => {
                            debug('Stream finished event');
                            clearTimeout(timeout);
                            cleanup();
                            resolve();
                        };
                        const onError = (err: Error) => {
                            debug('Stream error on end:', err);
                            clearTimeout(timeout);
                            cleanup();
                            resolve();
                        };
                        const cleanup = () => {
                            writeStream.removeListener('finish', onFinish);
                            writeStream.removeListener('error', onError);
                        };
                        writeStream.on('finish', onFinish);
                        writeStream.on('error', onError);
                        writeStream.end();
                    });
                }
                return;
            } else if (status === ExtabSock.ERROR) {
                const len = PGUtil.readInt16(await this._readBytes(2));
                const msg = (await this._readBytes(len)).toString('utf8');
                debug('ExternalTable Data Error:', msg);
                if (writeStream) writeStream.end();
                return;
            } else {
                debug('Unknown ExtTab Status:', status);
                if (writeStream) writeStream.end();
                return;
            }
        }
    }

    private async _handleExternalTableImport(): Promise<void> {
        await this._readBytes(8);

        const filenameBuf: number[] = [];
        let b = (await this._readBytes(1))[0];
        filenameBuf.push(b);
        while (b !== 0) {
            b = (await this._readBytes(1))[0];
            if (b !== 0) filenameBuf.push(b);
        }
        const filename = Buffer.from(filenameBuf).toString('utf8');
        debug('ExternalTable Import Start. File:', filename);

        const hostVersion = PGUtil.readInt32(await this._readBytes(4));
        debug('Host Version:', hostVersion);
        const clientVerBuf = Buffer.alloc(4);
        PGUtil.writeInt32(clientVerBuf, 1, 0);
        await new Promise<void>((resolve) => this._stream!.write(clientVerBuf, () => resolve()));
        debug('Sent Client Version');

        const format = PGUtil.readInt32(await this._readBytes(4));
        const bufSize = PGUtil.readInt32(await this._readBytes(4));

        debug('ExtTab Import Config:', { hostVersion, format, bufSize });

        if (NzConnection._streamRegistry.has(filename)) {
            debug('Using virtual import stream for:', filename);
        } else if (!fs.existsSync(filename)) {
            debug('Import file not found:', filename);
            const errBuf = Buffer.alloc(4);
            PGUtil.writeInt32(errBuf, ExtabSock.ERROR, 0);
            this._stream!.write(errBuf);
            return;
        }

        // Get file size for progress tracking (approximate for stream if available)
        let totalSize = 0;
        let readStream: Readable;

        if (NzConnection._streamRegistry.has(filename)) {
            readStream = NzConnection._streamRegistry.get(filename)!;
            // Try to get size from stream property if set manually by user on the stream object
            totalSize = (readStream as any).byteLength || 0;
        } else {
            const fileStats = fs.statSync(filename);
            totalSize = fileStats.size;
            readStream = fs.createReadStream(filename, { highWaterMark: bufSize || 65536 });
        }

        let bytesSent = 0;

        await new Promise<void>((resolve, reject) => {
            readStream.on('data', (chunk: string | Buffer) => {
                const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const header = Buffer.alloc(8);
                PGUtil.writeInt32(header, ExtabSock.DATA, 0);
                PGUtil.writeInt32(header, chunkBuf.length, 4);

                // Handle backpressure: pause readStream if TCP buffer is full
                const canContinue1 = this._stream!.write(header);
                const canContinue2 = this._stream!.write(chunkBuf);

                if (!canContinue1 || !canContinue2) {
                    readStream.pause();
                    this._stream!.once('drain', () => {
                        readStream.resume();
                    });
                }

                // Emit progress event
                bytesSent += chunkBuf.length;
                this.emit('importProgress', {
                    bytesSent,
                    totalSize,
                    percentComplete: totalSize > 0 ? Math.round((bytesSent / totalSize) * 100) : 0,
                });
            });

            readStream.on('end', () => {
                debug('Import Stream End');
                const doneBuf = Buffer.alloc(4);
                PGUtil.writeInt32(doneBuf, ExtabSock.DONE, 0);
                this._stream!.write(doneBuf);
                resolve();
            });

            readStream.on('error', (err) => {
                debug('Import Stream Error:', err);
                const errBuf = Buffer.alloc(4);
                PGUtil.writeInt32(errBuf, ExtabSock.ERROR, 0);
                this._stream!.write(errBuf);
                const msg = err.message || 'Error';
                const lenBuf = Buffer.alloc(2);
                lenBuf.writeInt16BE(msg.length);
                this._stream!.write(lenBuf);
                this._stream!.write(Buffer.from(msg, 'utf8'));
                reject(err);
            });
        });
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

        if (command) (command as any)._preparedStatement = { description: this._rowDescription };
    }

    private _parseDataRow(data: Buffer): any[] {
        const numberOfCol = this._rowDescription!.length;
        const bitmapLen = Math.ceil(numberOfCol / 8);
        let dataIdx = bitmapLen;
        const row: any[] = [];

        for (let columnNumber = 0; columnNumber < numberOfCol; columnNumber++) {
            const byteToTest = data[Math.floor(columnNumber / 8)];
            const positionInByte = 7 - (columnNumber % 8);
            const hasValue = (byteToTest & (1 << positionInByte)) !== 0;

            if (!hasValue) {
                row.push(null);
                continue;
            }

            const vlen = data.readInt32BE(dataIdx);
            dataIdx += 4;
            const actualLen = vlen - 4;

            if (actualLen <= 0) {
                row.push(null);
                continue;
            }

            const colDesc = this._rowDescription![columnNumber];
            const typeOid = colDesc?.typeOid;

            const value = data.toString('utf8', dataIdx, dataIdx + actualLen);

            if (typeOid === 1083) {
                row.push(TypeConversions.parseTimeString(value));
            } else {
                row.push(value);
            }
            dataIdx += actualLen;
        }
        return row;
    }

    private async _resReadDbosTuple(_command: NzCommand): Promise<any[]> {
        const numFields = this._tupdesc.numFields;
        await this._readBytes(4);
        const rowLength = PGUtil.readInt32(await this._readBytes(4));
        const data = await this._readBytes(rowLength);
        const row = new Array(numFields);
        for (let i = 0; i < numFields; i++) {
            if (this._columnIsNull(data, i)) {
                row[i] = null;
                continue;
            }
            const fieldData = this._cTableFieldAt(data, i);
            const fldType = this._tupdesc.fieldType[i];
            const fldLen = this._tupdesc.fieldSize[i];
            row[i] = this._parseFieldByType(fieldData, fldType, fldLen, i);
        }
        return row;
    }

    private _parseFieldByType(fieldData: Buffer, fldType: number, fldLen: number, fieldIdx: number): any {
        switch (fldType) {
            case NzType.NzTypeChar:
                return fieldData.toString('latin1', 0, fldLen).trimEnd();
            case NzType.NzTypeNChar:
            case NzType.NzTypeNVarChar: {
                const cursize = fieldData.readInt16LE(0) - 2;
                return fieldData.toString('utf8', 2, 2 + cursize);
            }

            case NzType.NzTypeVarChar:
            case NzType.NzTypeVarFixedChar: {
                const s = fieldData.readInt16LE(0) - 2;
                return fieldData.toString('latin1', 2, 2 + s);
            }

            case NzType.NzTypeInt8:
                return fieldData.readBigInt64LE(0);
            case NzType.NzTypeInt:
                return fieldData.readInt32LE(0);
            case NzType.NzTypeInt2:
                return fieldData.readInt16LE(0);
            case NzType.NzTypeInt1:
                return fieldData.readInt8(0);
            case NzType.NzTypeDouble:
                return fieldData.readDoubleLE(0);
            case NzType.NzTypeFloat:
                return fieldData.readFloatLE(0);
            case NzType.NzTypeDate:
                return TypeConversions.toDateTimeFrom4Bytes(fieldData);
            case NzType.NzTypeTime:
                return TypeConversions.timeRecvFloat(fieldData);
            case NzType.NzTypeInterval:
                return TypeConversions.intervalRecvFloat(fieldData);
            case NzType.NzTypeTimeTz:
                return TypeConversions.timetzOutput(fieldData, fldLen);
            case NzType.NzTypeTimestamp:
                return TypeConversions.toDateTimeFrom8Bytes(fieldData);
            case NzType.NzTypeBool:
                return fieldData[0] === 0x01;
            case NzType.NzTypeNumeric: {
                const p = this._tupdesc.getFieldPrecision(fieldIdx);
                const s = this._tupdesc.getFieldScale(fieldIdx);
                const c = this._tupdesc.getNumericDigitCount(fieldIdx);
                return TypeConversions.getCsNumeric(fieldData, p, s, c);
            }
            default:
                return fieldData.toString('utf8', 0, fldLen);
        }
    }

    private _columnIsNull(data: Buffer, fieldLf: number): boolean {
        if (!this._tupdesc.nullsAllowed) return false;
        const col = this._tupdesc.fieldPhysField[fieldLf];
        const byte = data[2 + Math.floor(col / 8)];
        return (byte & (1 << (col % 8))) !== 0;
    }

    private _cTableFieldAt(data: Buffer, i: number): Buffer {
        if (this._tupdesc.fieldFixedSize[i] !== 0) return data.slice(this._tupdesc.fieldOffset[i]);
        let p = data.slice(this._tupdesc.fixedFieldsSize);
        for (let j = 0; j < this._tupdesc.fieldOffset[i]; j++) {
            const l = p.readInt16LE(0);
            p = p.slice(l % 2 === 0 ? l : l + 1);
        }
        return p;
    }
}

export { NzConnection };
