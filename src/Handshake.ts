import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type * as net from 'node:net';
import * as tls from 'node:tls';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGUtil } from './utils/PGUtil';
import { BackendMessageCode, HandshakeCode, ProtocolVersion } from './protocol/constants';
import { createNzDatabaseError, NzDatabaseError } from './errors/NzDatabaseError';
import { SocketTransport } from './transport/SocketTransport';
import { normalizeClientType } from './clientTypes';
import {
    NzProtocolError,
    validateProtocolLength,
    validateProtocolLengthAfterOverhead,
} from './protocol/ProtocolLength';
import createDebug from 'debug';

const debug = createDebug('nz:handshake');

interface HandshakeOptions {
    securityLevel?: 'PreferredUnsecured' | 'OnlyUnsecuredSession' | 'PreferredSecuredSession' | 'OnlySecuredSession';
    sslCerFilePath?: string;
    rejectUnauthorized?: boolean;
    /** Application name reported to Netezza for Guardium audit / system table visibility */
    appName?: string;
    /** OS user name reported to Netezza */
    osUser?: string;
    /** Client hostname reported to Netezza */
    clientHostName?: string;
    /** Numeric Netezza client type sent in the handshake (default: Node, 15) */
    clientType?: number;
}

type Stream = net.Socket | tls.TLSSocket;

class Handshake {
    private _socket: net.Socket;
    private _stream: Stream;
    private _options: HandshakeOptions;
    private _transport: SocketTransport = new SocketTransport();

    private _hsVersion: number = -1;
    private _protocol1: number = -1;
    private _protocol2: number = -1;

    private _guardiumClientOS: string;
    private _guardiumClientOSUser: string;
    private _guardiumAppName: string;
    private _guardiumClientHostName: string;
    private _clientType: number;

    public backendProcessId: number = 0;
    public backendSecretKey: number = 0;

    constructor(socket: net.Socket, stream: Stream, _host: string, options: HandshakeOptions = {}) {
        this._socket = socket;
        this._stream = stream;
        this._options = options;
        this._transport.attach(stream);
        this._clientType = normalizeClientType(options.clientType);

        this._guardiumClientOS = process.platform;
        this._guardiumClientOSUser = options.osUser || process.env.USERNAME || process.env.USER || 'unknown';
        this._guardiumAppName = options.appName || path.basename(process.argv[1] || 'node');
        this._guardiumClientHostName = options.clientHostName || os.hostname();
    }

    private _setStream(stream: Stream): void {
        this._stream = stream;
        this._transport.attach(stream);
    }

    async startup(database: string, user: string, password: string): Promise<Stream> {
        if (!(await this.connHandshakeNegotiate())) {
            throw new Error('Handshake negotiation unsuccessful');
        }

        debug('Sending handshake info');
        if (!(await this.connSendHandshakeInfo(database, user))) {
            throw new Error('Error in ConnSendHandshakeInfo');
        }

        if (!(await this.connAuthenticate(password))) {
            throw new Error('Error in ConnAuthenticate');
        }

        if (!(await this.connConnectionComplete())) {
            throw new Error('Error in ConnConnectionComplete');
        }

        // SocketTransport may have pulled extra TCP chunks; return leftovers to the stream
        // so NzConnection's own reader sees a continuous protocol byte stream.
        this._transport.flushUnreadToStream();
        return this._stream;
    }

    async readBytes(n: number): Promise<Buffer> {
        return this._transport.readBytes(n);
    }

    async readByte(): Promise<number> {
        const buf = await this.readBytes(1);
        return buf[0];
    }

    async connHandshakeNegotiate(): Promise<boolean> {
        let version: number = ProtocolVersion.CP_VERSION_6;
        while (true) {
            debug(`Sending version: ${version}`);

            PGUtil.writeInt32(this._stream, 8);
            PGUtil.writeInt16(this._stream, HandshakeCode.HSV2_CLIENT_BEGIN);
            PGUtil.writeInt16(this._stream, version);

            const beresp = await this.readByte();
            debug(`Got response: ${String.fromCharCode(beresp)}`);

            if (beresp === 'N'.charCodeAt(0)) {
                this._hsVersion = version;
                this._protocol2 = 0;
                return true;
            } else if (beresp === 'M'.charCodeAt(0)) {
                const newVersion = await this.readByte();
                const verChar = String.fromCharCode(newVersion);
                if (verChar === '2') version = ProtocolVersion.CP_VERSION_2;
                else if (verChar === '3') version = ProtocolVersion.CP_VERSION_3;
                else if (verChar === '4') version = ProtocolVersion.CP_VERSION_4;
                else if (verChar === '5') version = ProtocolVersion.CP_VERSION_5;
            } else {
                return false;
            }
        }
    }

    async connSendHandshakeInfo(database: string, user: string): Promise<boolean> {
        if (!(await this.connSendDatabase(database))) return false;

        await this.connSecureSession();

        this.connSetNextDataProtocol(this._protocol1, this._protocol2);

        if (this._hsVersion === ProtocolVersion.CP_VERSION_6 || this._hsVersion === ProtocolVersion.CP_VERSION_4) {
            return this.connSendHandshakeVersion4(this._hsVersion, user);
        } else {
            return this.connSendHandshakeVersion2(this._hsVersion, user);
        }
    }

    async connSendDatabase(database: string): Promise<boolean> {
        const dbBytes = Buffer.from(database, 'utf8');
        const len = 4 + 2 + dbBytes.length + 1;
        PGUtil.writeInt32(this._stream, len);
        PGUtil.writeInt16(this._stream, HandshakeCode.HSV2_DB);
        this._stream.write(dbBytes);
        this._stream.write(Buffer.from([0]));

        const beresp = await this.readByte();
        if (beresp === 'N'.charCodeAt(0)) return true;
        return false;
    }

    async connSecureSession(): Promise<boolean> {
        const len = 4 + 2 + 4;

        let securityLevelInt = 0; // PreferredUnsecured
        const level = this._options.securityLevel;
        if (level === 'OnlyUnsecuredSession') securityLevelInt = 1;
        else if (level === 'PreferredSecuredSession') securityLevelInt = 2;
        else if (level === 'OnlySecuredSession') securityLevelInt = 3;

        PGUtil.writeInt32(this._stream, len);
        PGUtil.writeInt16(this._stream, HandshakeCode.HSV2_SSL_NEGOTIATE);
        PGUtil.writeInt32(this._stream, securityLevelInt);

        const beresp = await this.readByte();
        if (beresp === 'N'.charCodeAt(0)) {
            if (this._options.securityLevel === 'OnlySecuredSession') {
                throw new Error('Server refused secure session, but OnlySecuredSession was requested.');
            }
            return true;
        }

        if (beresp === 'S'.charCodeAt(0)) {
            debug('Upgrading to SSL...');

            const connectBuf = Buffer.alloc(6);
            connectBuf.writeInt32BE(6, 0);
            connectBuf.writeInt16BE(HandshakeCode.HSV2_SSL_CONNECT, 4);

            await new Promise<void>((resolve) => {
                const flushed = this._stream.write(connectBuf);
                if (flushed) resolve();
                else this._stream.once('drain', resolve);
            });

            this._socket.removeAllListeners('data');
            this._socket.removeAllListeners('readable');

            const sslOptions: tls.ConnectionOptions = {
                socket: this._socket,
                // Secure by default: verify server certificate unless user explicitly opts out
                rejectUnauthorized: this._options.rejectUnauthorized !== false,
            };

            if (this._options.sslCerFilePath) {
                try {
                    sslOptions.ca = fs.readFileSync(this._options.sslCerFilePath);
                } catch (err) {
                    debug('Failed to load cert file', err);
                    throw err;
                }
            }

            return new Promise<boolean>((resolve, reject) => {
                // Return any over-read plaintext bytes to the socket before TLS wraps it.
                this._transport.flushUnreadToStream();
                const secureSocket = tls.connect(sslOptions, () => {
                    debug('SSL Connected');
                    this._setStream(secureSocket);
                    this._stream.on('error', (err) => {
                        debug('Secure Stream Error', err);
                    });

                    this.readByte()
                        .then((beresp) => {
                            if (beresp === 'N'.charCodeAt(0)) {
                                resolve(true);
                            } else {
                                reject(
                                    new Error(
                                        `SSL Handshake failed: Unexpected response ${String.fromCharCode(beresp)}`
                                    )
                                );
                            }
                        })
                        .catch((err) => {
                            debug('Failed to read SSL confirmation', err);
                            reject(err);
                        });
                });
                secureSocket.on('error', (err) => {
                    debug('SSL Connection Error', err);
                    reject(err);
                });
            });
        }

        return false;
    }

    connSetNextDataProtocol(_p1: number, _p2: number): boolean {
        if (this._protocol2 === 0) this._protocol2 = 5;
        this._protocol1 = 3;
        return true;
    }

    async connSendHandshakeVersion4(hsVersion: number, user: string): Promise<boolean> {
        const userBytes = Buffer.from(user, 'utf8');
        let len = 4 + 2 + userBytes.length + 1;
        PGUtil.writeInt32(this._stream, len);
        PGUtil.writeInt16(this._stream, HandshakeCode.HSV2_USER);
        this._stream.write(userBytes);
        this._stream.write(Buffer.from([0]));

        let information: number = HandshakeCode.HSV2_APPNAME;

        while (information !== 0) {
            const beresp = await this.readByte();
            if (beresp !== 'N'.charCodeAt(0)) return false;

            switch (information) {
                case HandshakeCode.HSV2_APPNAME:
                    await this.sendStringOption(information, this._guardiumAppName);
                    information = HandshakeCode.HSV2_CLIENT_OS;
                    break;
                case HandshakeCode.HSV2_CLIENT_OS:
                    await this.sendStringOption(information, this._guardiumClientOS);
                    information = HandshakeCode.HSV2_CLIENT_HOST_NAME;
                    break;
                case HandshakeCode.HSV2_CLIENT_HOST_NAME:
                    await this.sendStringOption(information, this._guardiumClientHostName);
                    information = HandshakeCode.HSV2_CLIENT_OS_USER;
                    break;
                case HandshakeCode.HSV2_CLIENT_OS_USER:
                    await this.sendStringOption(information, this._guardiumClientOSUser);
                    information = HandshakeCode.HSV2_PROTOCOL;
                    break;
                case HandshakeCode.HSV2_PROTOCOL:
                    len = 4 + 2 + 2 + 2;
                    PGUtil.writeInt32(this._stream, len);
                    PGUtil.writeInt16(this._stream, information);
                    PGUtil.writeInt16(this._stream, this._protocol1);
                    PGUtil.writeInt16(this._stream, this._protocol2);
                    information = HandshakeCode.HSV2_REMOTE_PID;
                    break;
                case HandshakeCode.HSV2_REMOTE_PID:
                    len = 4 + 2 + 4;
                    PGUtil.writeInt32(this._stream, len);
                    PGUtil.writeInt16(this._stream, information);
                    PGUtil.writeInt32(this._stream, process.pid);
                    information = HandshakeCode.HSV2_CLIENT_TYPE;
                    break;
                case HandshakeCode.HSV2_CLIENT_TYPE:
                    len = 4 + 2 + 2;
                    PGUtil.writeInt32(this._stream, len);
                    PGUtil.writeInt16(this._stream, information);
                    PGUtil.writeInt16(this._stream, this._clientType);
                    if (hsVersion >= 5) information = HandshakeCode.HSV2_64BIT_VARLENA_ENABLED;
                    else information = HandshakeCode.HSV2_CLIENT_DONE;
                    break;
                case HandshakeCode.HSV2_64BIT_VARLENA_ENABLED:
                    len = 4 + 2 + 2;
                    PGUtil.writeInt32(this._stream, len);
                    PGUtil.writeInt16(this._stream, information);
                    PGUtil.writeInt16(this._stream, 1);
                    information = HandshakeCode.HSV2_CLIENT_DONE;
                    break;
                case HandshakeCode.HSV2_CLIENT_DONE:
                    len = 4 + 2;
                    PGUtil.writeInt32(this._stream, len);
                    PGUtil.writeInt16(this._stream, information);
                    return true;
            }
        }
        return false;
    }

    async connSendHandshakeVersion2(hsVersion: number, user: string): Promise<boolean> {
        const userBytes = Buffer.from(user, 'utf8');
        let len = 4 + 2 + userBytes.length + 1;
        PGUtil.writeInt32(this._stream, len);
        PGUtil.writeInt16(this._stream, HandshakeCode.HSV2_USER);
        this._stream.write(userBytes);
        this._stream.write(Buffer.from([0]));

        let information: number = HandshakeCode.HSV2_PROTOCOL;

        while (information !== 0) {
            debug(`Waiting for response in v2 loop. Info: ${information}`);
            const beresp = await this.readByte();
            debug(`Got response: ${String.fromCharCode(beresp)}`);

            if (beresp === 'N'.charCodeAt(0)) {
                switch (information) {
                    case HandshakeCode.HSV2_PROTOCOL:
                        len = 4 + 2 + 2 + 2;
                        PGUtil.writeInt32(this._stream, len);
                        PGUtil.writeInt16(this._stream, information);
                        PGUtil.writeInt16(this._stream, this._protocol1);
                        PGUtil.writeInt16(this._stream, this._protocol2);
                        information = HandshakeCode.HSV2_REMOTE_PID;
                        break;
                    case HandshakeCode.HSV2_REMOTE_PID:
                        len = 4 + 2 + 4;
                        PGUtil.writeInt32(this._stream, len);
                        PGUtil.writeInt16(this._stream, information);
                        PGUtil.writeInt32(this._stream, process.pid);
                        information = HandshakeCode.HSV2_CLIENT_TYPE;
                        break;
                    case HandshakeCode.HSV2_OPTIONS:
                        information = HandshakeCode.HSV2_CLIENT_TYPE;
                        break;
                    case HandshakeCode.HSV2_CLIENT_TYPE:
                        len = 4 + 2 + 2;
                        PGUtil.writeInt32(this._stream, len);
                        PGUtil.writeInt16(this._stream, information);
                        PGUtil.writeInt16(this._stream, this._clientType);
                        if (hsVersion === ProtocolVersion.CP_VERSION_5 || hsVersion === ProtocolVersion.CP_VERSION_6) {
                            information = HandshakeCode.HSV2_64BIT_VARLENA_ENABLED;
                        } else {
                            information = HandshakeCode.HSV2_CLIENT_DONE;
                        }
                        break;
                    case HandshakeCode.HSV2_64BIT_VARLENA_ENABLED:
                        len = 4 + 2 + 2;
                        PGUtil.writeInt32(this._stream, len);
                        PGUtil.writeInt16(this._stream, information);
                        PGUtil.writeInt16(this._stream, 1);
                        information = HandshakeCode.HSV2_CLIENT_DONE;
                        break;
                    case HandshakeCode.HSV2_CLIENT_DONE:
                        len = 4 + 2;
                        PGUtil.writeInt32(this._stream, len);
                        PGUtil.writeInt16(this._stream, information);
                        return true;
                }
            } else if (beresp === BackendMessageCode.ErrorResponse) {
                try {
                    const lenBuf = await this.readBytes(4);
                    const len = PGUtil.readInt32(lenBuf);
                    const bodyLength = validateProtocolLengthAfterOverhead(
                        len,
                        4,
                        'handshakeErrorFrameLength',
                        'handshakeErrorPayload'
                    );
                    const body = await this.readBytes(bodyLength);
                    throw createNzDatabaseError(body);
                } catch (e) {
                    if (e instanceof NzDatabaseError || e instanceof NzProtocolError) throw e;
                    throw new NzDatabaseError({
                        message: 'Handshake V2 Failed: ErrorResponse from backend',
                        raw: 'Handshake V2 Failed: ErrorResponse from backend',
                    });
                }
            } else {
                throw new Error(`Handshake V2 Failed: Unexpected response ${String.fromCharCode(beresp)}`);
            }
        }
        return false;
    }

    async sendStringOption(opcode: number, value: string): Promise<void> {
        const bytes = Buffer.from(value, 'utf8');
        const len = 4 + 2 + bytes.length + 1;
        PGUtil.writeInt32(this._stream, len);
        PGUtil.writeInt16(this._stream, opcode);
        this._stream.write(bytes);
        this._stream.write(Buffer.from([0]));
    }

    async connAuthenticate(password: string): Promise<boolean> {
        const beresp = await this.readByte();
        if (beresp !== BackendMessageCode.AuthenticationRequest) return false;

        const areq = PGUtil.readInt32(await this.readBytes(4));
        debug(`Auth request: ${areq}`);

        if (areq === 0) return true; // OK
        if (areq === 3) {
            // Plain
            const pwdBytes = Buffer.from(password, 'utf8');
            const len = 4 + pwdBytes.length + 1;
            PGUtil.writeInt32(this._stream, len);
            this._stream.write(pwdBytes);
            this._stream.write(Buffer.from([0]));
            return true;
        }
        if (areq === 5) {
            // MD5
            return this._hashAuthenticate('md5', password);
        }
        if (areq === 6) {
            // SHA256
            return this._hashAuthenticate('sha256', password);
        }

        debug(`Unsupported authentication type: ${areq}`);
        return false;
    }

    private async _hashAuthenticate(algorithm: string, password: string): Promise<boolean> {
        debug(`Using ${algorithm} authentication`);
        const salt = await this.readBytes(2);
        const pwdBytes = Buffer.from(password, 'utf8');
        const hash = crypto
            .createHash(algorithm)
            .update(Buffer.concat([salt, pwdBytes]))
            .digest('base64');
        const trimmedHash = hash.replace(/=+$/, '');

        const finalPwdBytes = Buffer.from(trimmedHash, 'utf8');
        const len = 4 + finalPwdBytes.length + 1;
        PGUtil.writeInt32(this._stream, len);
        this._stream.write(finalPwdBytes);
        this._stream.write(Buffer.from([0]));
        return true;
    }

    async readString(): Promise<string> {
        const chars: number[] = [];
        while (true) {
            const b = await this.readByte();
            if (b === 0) break;
            chars.push(b);
        }
        return Buffer.from(chars).toString('utf8');
    }

    async connConnectionComplete(): Promise<boolean> {
        while (true) {
            const beresp = await this.readByte();
            debug(`Resp: ${String.fromCharCode(beresp)} (0x${beresp.toString(16)})`);

            if (beresp === BackendMessageCode.AuthenticationRequest) {
                const areq = PGUtil.readInt32(await this.readBytes(4));
                debug(`Auth req in complete: ${areq}`);
                continue;
            }
            if (beresp === BackendMessageCode.ErrorResponse) {
                const lenBuf = await this.readBytes(4);
                const len = PGUtil.readInt32(lenBuf);

                // Some Netezza versions return a legacy, NUL-terminated text
                // error here instead of a length-prefixed ErrorResponse body.
                // The first four characters (for example, "Pass") therefore
                // look like an absurd frame length when interpreted as int32.
                // Only accept this compatibility form when all four bytes are
                // printable ASCII; binary malformed lengths must still fail
                // closed below.
                const isLegacyTextPrefix = lenBuf.every((byte) => byte >= 0x20 && byte <= 0x7e);
                if (isLegacyTextPrefix) {
                    let legacyMessage = lenBuf.toString('utf8');
                    legacyMessage += await this.readString();
                    throw createNzDatabaseError(legacyMessage);
                }

                const bodyLength = validateProtocolLengthAfterOverhead(
                    len,
                    4,
                    'connectionCompleteErrorFrameLength',
                    'connectionCompleteErrorPayload'
                );
                const body = await this.readBytes(bodyLength);
                throw createNzDatabaseError(body);
            }

            const skipped = await this.readBytes(4);
            debug(`Skipped 4 bytes: ${skipped.toString('hex')}`);

            if (beresp === BackendMessageCode.BackendKeyData) {
                const padding = await this.readBytes(4);
                debug(`KeyData Padding: ${padding.toString('hex')}`);

                const pid = PGUtil.readInt32(await this.readBytes(4));
                const key = PGUtil.readInt32(await this.readBytes(4));
                debug(`KeyData: PID=${pid} Key=${key}`);
                this.backendProcessId = pid;
                this.backendSecretKey = key;

                continue;
            }
            if (beresp === BackendMessageCode.ReadyForQuery) {
                debug('ReadyForQuery');
                return true;
            }
            if (beresp === BackendMessageCode.NoticeResponse) {
                const len = validateProtocolLength(
                    PGUtil.readInt32(await this.readBytes(4)),
                    'connectionCompleteNoticePayload'
                );
                const body = await this.readBytes(len);
                debug(`Notice: ${body.toString()}`);
            }
        }
    }
}

export { Handshake };
