import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { ExtabSock } from '../protocol/constants';
import { PGUtil } from '../utils/PGUtil';
import createDebug from 'debug';

const debug = createDebug('nz:external');

/**
 * IO facade so ExternalTableHandler does not import NzConnection (avoids cycles).
 * Static stream registry stays on NzConnection; pass callbacks here.
 */
export interface ExternalTableIO {
    readBytes(n: number): Promise<Buffer>;
    readInt32(): Promise<number>;
    write(data: Buffer): Promise<void> | void;
    emit(event: string, ...args: unknown[]): boolean;
    getExportStream(): fs.WriteStream | null;
    setExportStream(s: fs.WriteStream | null): void;
    hasImportStream(id: string): boolean;
    getImportStream(id: string): Readable;
}

export class ExternalTableHandler {
    constructor(private readonly _io: ExternalTableIO) {}

    async saveLog(logDir: string, filename: string, logType: number): Promise<void> {
        let extension: string;
        if (logType === 1) {
            extension = '.nzlog';
        } else if (logType === 2) {
            extension = '.nzbad';
        } else if (logType === 3) {
            extension = '.nzstats';
        } else {
            extension = '.log';
        }

        const fullPath = path.join(logDir, filename + extension);
        debug('Saving external table log to:', fullPath);

        const writeStream = fs.createWriteStream(fullPath, { encoding: 'utf8' });
        let hasError = false;

        writeStream.on('error', (err) => {
            hasError = true;
            debug('Error writing external table log:', err);
        });

        try {
            while (true) {
                const lenBuf = await this._io.readBytes(4);
                const len = PGUtil.readInt32(lenBuf);
                if (len === 0) break; // EOF

                const data = await this._io.readBytes(len);
                if (!hasError) {
                    writeStream.write(data);
                }
            }

            await new Promise<void>((resolve, reject) => {
                writeStream.end(() => {
                    debug('External table log saved successfully:', fullPath);
                    resolve();
                });
                writeStream.on('error', reject);
            });
        } catch (err) {
            writeStream.destroy();
            debug('Error saving external table log:', err);
            throw err;
        }
    }

    async handleExportStart(): Promise<void> {
        await this._io.readBytes(4);
        await this._io.readBytes(10);
        await this._io.readBytes(16);
        const len = PGUtil.readInt32(await this._io.readBytes(4));
        const filenameBuf = await this._io.readBytes(len);
        const filename = filenameBuf.toString('utf8');
        debug('ExternalTable Export Start. File:', filename);

        try {
            const exportStream = fs.createWriteStream(filename);
            this._io.setExportStream(exportStream);
            exportStream.on('error', (err) => {
                exportStream.destroy();
                this._io.setExportStream(null);
                debug('Export Stream Error:', err);
            });
            const buf = Buffer.alloc(4);
            await this._io.write(buf);
        } catch (e) {
            debug('Error opening export file:', e);
            const buf = Buffer.alloc(4);
            PGUtil.writeInt32(buf, 1, 0);
            await this._io.write(buf);
        }
    }

    async handleExportData(): Promise<void> {
        debug('Handle Export Data: Skipping 8 bytes...');
        const skip1 = await this._io.readBytes(4);
        debug('Skipped 4:', skip1.toString('hex'));
        const skip2 = await this._io.readBytes(4);
        debug('Skipped 4 (2):', skip2.toString('hex'));

        const exportStream = this._io.getExportStream();
        await this._consumeData(exportStream);
        if (exportStream && !exportStream.closed) {
            exportStream.destroy();
        }
        this._io.setExportStream(null);
    }

    private async _consumeData(writeStream: fs.WriteStream | null): Promise<void> {
        debug('Entering Consume Loop');
        while (true) {
            debug('Reading status...');
            const statusBuf = await this._io.readBytes(4);
            const status = PGUtil.readInt32(statusBuf);
            debug('ExtTab Status:', status);

            if (status === ExtabSock.DATA) {
                const numBytes = PGUtil.readInt32(await this._io.readBytes(4));
                debug('Block Length:', numBytes);
                const data = await this._io.readBytes(numBytes);
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
                const len = PGUtil.readInt16(await this._io.readBytes(2));
                const msg = (await this._io.readBytes(len)).toString('utf8');
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

    async handleImport(): Promise<void> {
        await this._io.readBytes(8);

        const filenameBuf: number[] = [];
        let b = (await this._io.readBytes(1))[0];
        filenameBuf.push(b);
        while (b !== 0) {
            b = (await this._io.readBytes(1))[0];
            if (b !== 0) filenameBuf.push(b);
        }
        const filename = Buffer.from(filenameBuf).toString('utf8');
        debug('ExternalTable Import Start. File:', filename);

        const hostVersion = PGUtil.readInt32(await this._io.readBytes(4));
        debug('Host Version:', hostVersion);
        const clientVerBuf = Buffer.alloc(4);
        PGUtil.writeInt32(clientVerBuf, 1, 0);
        await this._io.write(clientVerBuf);
        debug('Sent Client Version');

        const format = PGUtil.readInt32(await this._io.readBytes(4));
        const bufSize = PGUtil.readInt32(await this._io.readBytes(4));

        debug('ExtTab Import Config:', { hostVersion, format, bufSize });

        if (this._io.hasImportStream(filename)) {
            debug('Using virtual import stream for:', filename);
        } else if (!fs.existsSync(filename)) {
            debug('Import file not found:', filename);
            const errBuf = Buffer.alloc(4);
            PGUtil.writeInt32(errBuf, ExtabSock.ERROR, 0);
            await this._io.write(errBuf);
            return;
        }

        let totalSize = 0;
        let readStream: Readable;

        if (this._io.hasImportStream(filename)) {
            readStream = this._io.getImportStream(filename);
            totalSize = (readStream as Readable & { byteLength?: number }).byteLength || 0;
        } else {
            const fileStats = fs.statSync(filename);
            totalSize = fileStats.size;
            readStream = fs.createReadStream(filename, { highWaterMark: bufSize || 65536 });
        }

        let bytesSent = 0;

        try {
            // Consume the stream sequentially. The previous data/end event
            // implementation could emit DONE while an asynchronous DATA write
            // was still pending, especially for already-buffered virtual streams.
            for await (const chunk of readStream) {
                const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const header = Buffer.alloc(8);
                PGUtil.writeInt32(header, ExtabSock.DATA, 0);
                PGUtil.writeInt32(header, chunkBuf.length, 4);

                await this._io.write(header);
                await this._io.write(chunkBuf);

                bytesSent += chunkBuf.length;
                this._io.emit('importProgress', {
                    bytesSent,
                    totalSize,
                    percentComplete: totalSize > 0 ? Math.round((bytesSent / totalSize) * 100) : 0,
                });
            }

            debug('Import Stream End');
            const doneBuf = Buffer.alloc(4);
            PGUtil.writeInt32(doneBuf, ExtabSock.DONE, 0);
            await this._io.write(doneBuf);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            debug('Import Stream Error:', error);

            try {
                const errBuf = Buffer.alloc(4);
                PGUtil.writeInt32(errBuf, ExtabSock.ERROR, 0);
                await this._io.write(errBuf);

                const message = Buffer.from(error.message || 'Error', 'utf8');
                const messageLength = Math.min(message.length, 0x7fff);
                const lenBuf = Buffer.alloc(2);
                lenBuf.writeInt16BE(messageLength);
                await this._io.write(lenBuf);
                await this._io.write(message.subarray(0, messageLength));
            } catch (protocolError) {
                debug('Error sending import stream failure:', protocolError);
            }

            throw err;
        }
    }
}
