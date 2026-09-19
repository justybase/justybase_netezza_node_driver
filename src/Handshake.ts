import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type * as net from 'node:net';
import * as tls from 'node:tls';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGUtil } from './utils/PGUtil';
import { BackendMessageCode, HandshakeCode, ProtocolVersion } from './protocol/constants';
import { createNzDatabaseError } from './errors/NzDatabaseError';
import { SocketTransport } from './transport/SocketTransport';
import { normalizeClientType } from './clientTypes';
import { validateProtocolLength, validateProtocolLengthAfterOverhead } from './protocol/ProtocolLength';
import createDebug from 'debug';

const debug = createDebug('nz:handshake');

/**
 * Upper bound for a legacy (length-less) error text, so a malformed frame can
 * never make us buffer an unbounded amount of data looking for a terminator.
 */
const MAX_LEGACY_ERROR_TEXT_BYTES = 4096;

/** Minimum characters needed to distinguish a zero-length legacy text frame from a message type byte. */
const MIN_LEGACY_ERROR_TEXT_CHARS = 4;

/**
 * The legacy format is only recognised when the four bytes read as a frame
 * length are printable ASCII: a real message prefix ("Pass", "FATA", ...)
 * never contains a control byte or a high byte. Malformed binary lengths must
 * still fail closed in the length validation below.
 */
const isPrintableAscii = (byte: number): boolean => byte >= 0x20 && byte <= 0x7e;

/**
 * Bytes accepted inside a legacy error text: printable ASCII, the common
 * whitespace control bytes and UTF-8 continuation bytes. Other control bytes
 * mean the payload is binary data rather than a text error.
 */
const isLegacyErrorTextByte = (byte: number): boolean =>
    byte >= 0x20 ? byte !== 0x7f : byte === 0x09 || byte === 0x0a || byte === 0x0d;

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

    /**
     * Reads an ErrorResponse after its type byte has already been consumed.
     * Netezza servers use both normal length-prefixed frames and legacy
     * NUL-terminated text (including a zero-length, NUL-only response).
     * Transport and framing errors intentionally escape unchanged.
     */
    private async _throwHandshakeErrorResponse(stage: string): Promise<never> {
        const lenBuf = await this.readBytes(4);
        const len = PGUtil.readInt32(lenBuf);
        const legacyText = await this._readLegacyConnectionErrorText(lenBuf, len);
        if (legacyText !== null) throw createNzDatabaseError(legacyText);

        const bodyLength = validateProtocolLengthAfterOverhead(len, 4, `${stage}FrameLength`, `${stage}Payload`);
        const body = await this.readBytes(bodyLength);
        throw createNzDatabaseError(body);
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
            } else if (beresp === BackendMessageCode.ErrorResponse) {
                return this._throwHandshakeErrorResponse('handshakeNegotiationError');
            } else {
                return false;
            }
        }
    }

    async connSendHandshakeInfo(database: string, user: string): Promise<boolean> {
        if (!(await this.connSendDatabase(database))) return false;

        if (!(await this.connSecureSession())) return false;

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
        if (beresp === BackendMessageCode.ErrorResponse) {
            return this._throwHandshakeErrorResponse('databaseSelectionError');
        }
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
                            } else if (beresp === BackendMessageCode.ErrorResponse) {
                                this._throwHandshakeErrorResponse('sslHandshakeError').catch(reject);
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

        if (beresp === BackendMessageCode.ErrorResponse) {
            return this._throwHandshakeErrorResponse('secureSessionError');
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
            if (beresp === BackendMessageCode.ErrorResponse) {
                return this._throwHandshakeErrorResponse('handshakeError');
            }
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
                return this._throwHandshakeErrorResponse('handshakeError');
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
        if (beresp === BackendMessageCode.ErrorResponse) {
            return this._throwHandshakeErrorResponse('authenticationError');
        }
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

    /**
     * Reads a NUL-terminated legacy error text, starting at the next byte.
     *
     * Returns null when the bytes cannot be such a text: a control byte, no
     * terminator before the connection ends, more than
     * `MAX_LEGACY_ERROR_TEXT_BYTES`, or fewer than `minChars` characters. The
     * caller then falls back to the strict frame length validation, so a dead
     * or truncated stream reports a deterministic protocol error instead of a
     * generic socket error or a bogus database error.
     */
    private async _readLegacyErrorText(
        minChars: number,
        isAllowedByte: (byte: number) => boolean,
        initialBytes: number[] = []
    ): Promise<string | null> {
        const chars: number[] = [...initialBytes];
        if (chars.length > MAX_LEGACY_ERROR_TEXT_BYTES) return null;
        while (true) {
            let byte: number;
            try {
                byte = await this.readByte();
            } catch (e) {
                debug('Legacy error text could not be read', e);
                return null;
            }
            if (byte === 0) break;
            if (!isAllowedByte(byte)) return null;
            if (chars.length >= MAX_LEGACY_ERROR_TEXT_BYTES) return null;
            chars.push(byte);
        }
        if (chars.length < minChars) return null;
        return Buffer.from(chars).toString('utf8');
    }

    /**
     * Detects the legacy Netezza error format that some versions use when a
     * connection cannot be completed: a NUL-terminated text message where an
     * ErrorResponse frame would normally be.
     *
     * Two framings are seen in the wild:
     *  - no length field at all, so the first four characters of the message
     *    (for example "Pass" in "Password authentication failed") are read as
     *    the frame length and look like an absurd int32 value;
     *  - a zero frame length followed by the text.
     *
     * Both are accepted only when the payload actually looks like text. Anything
     * else must fail closed in `validateProtocolLengthAfterOverhead`: a malformed
     * frame that is reported as `NzDatabaseError` would skip the reconnect path
     * driven by `NzProtocolError`.
     *
     * Returns the legacy message, or null when the regular frame handling must
     * run instead.
     */
    private async _readLegacyConnectionErrorText(lenBuf: Buffer, len: number): Promise<string | null> {
        if (lenBuf.every(isPrintableAscii)) {
            const rest = await this._readLegacyErrorText(0, isLegacyErrorTextByte);
            return rest === null ? null : lenBuf.toString('utf8') + rest;
        }

        if (len !== 0) return null;

        // The zero length framing is ambiguous. Accept an explicitly empty
        // NUL-terminated response as a database error, while requiring a real
        // text message to have at least the same four characters that make the
        // length-less form recognisable. This prevents a following binary
        // message such as ReadyForQuery (`Z` + length) from being consumed as
        // an error string.
        let first: number;
        try {
            first = await this.readByte();
        } catch (e) {
            debug('Empty-frame legacy error text could not be read', e);
            return null;
        }
        if (first === 0) return '';
        if (!isLegacyErrorTextByte(first)) return null;
        return this._readLegacyErrorText(MIN_LEGACY_ERROR_TEXT_CHARS, isLegacyErrorTextByte, [first]);
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
                return this._throwHandshakeErrorResponse('connectionCompleteError');
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
