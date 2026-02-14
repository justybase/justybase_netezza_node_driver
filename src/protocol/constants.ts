/**
 * Protocol constants for Netezza driver
 */

export const BackendMessageCode = {
    AuthenticationRequest: 'R'.charCodeAt(0), // 82
    ErrorResponse: 'E'.charCodeAt(0), // 69
    NoticeResponse: 'N'.charCodeAt(0), // 78
    BackendKeyData: 'K'.charCodeAt(0), // 75
    ReadyForQuery: 'Z'.charCodeAt(0), // 90
    RowDescription: 'T'.charCodeAt(0), // 84
    RowDescriptionStandard: 'X'.charCodeAt(0), // 88 - binary row description for standard tables
    DataRow: 'D'.charCodeAt(0), // 68
    CommandComplete: 'C'.charCodeAt(0), // 67
    EmptyQueryResponse: 'I'.charCodeAt(0), // 73
    RowStandard: 'Y'.charCodeAt(0), // 89 - binary row data for standard tables
    CopyInResponse: 'G'.charCodeAt(0), // 71
    CopyOutResponse: 'H'.charCodeAt(0), // 72
    CopyDone: 'c'.charCodeAt(0), // 99
    CopyData: 'd'.charCodeAt(0), // 100
} as const;

export type BackendMessageCodeType = (typeof BackendMessageCode)[keyof typeof BackendMessageCode];

// Based on C# NzConnection.cs
export const NzType = {
    NzTypeRecAddr: 1,
    NzTypeDouble: 2,
    NzTypeInt: 3,
    NzTypeFloat: 4,
    NzTypeMoney: 5,
    NzTypeDate: 6,
    NzTypeNumeric: 7,
    NzTypeTime: 8,
    NzTypeTimestamp: 9,
    NzTypeInterval: 10,
    NzTypeTimeTz: 11,
    NzTypeBool: 12,
    NzTypeInt1: 13,
    NzTypeBinary: 14,
    NzTypeChar: 15,
    NzTypeVarChar: 16,
    NzDEPR_Text: 17,
    NzTypeUnknown: 18,
    NzTypeInt2: 19,
    NzTypeInt8: 20,
    NzTypeVarFixedChar: 21,
    NzTypeGeometry: 22,
    NzTypeVarBinary: 23,
    NzDEPR_Blob: 24,
    NzTypeNChar: 25,
    NzTypeNVarChar: 26,
    NzDEPR_NText: 27,
    NzTypeJson: 30,
    NzTypeJsonb: 31,
    NzTypeJsonpath: 32,
    NzTypeLastEntry: 33,
    NzTypeIntvsAbsTimeFIX: 39,
} as const;

export type NzTypeValue = (typeof NzType)[keyof typeof NzType];

export const ProtocolVersion = {
    CP_VERSION_2: 2,
    CP_VERSION_3: 3,
    CP_VERSION_4: 4,
    CP_VERSION_5: 5,
    CP_VERSION_6: 6,
} as const;

export type ProtocolVersionValue = (typeof ProtocolVersion)[keyof typeof ProtocolVersion];

export const HandshakeCode = {
    HSV2_CLIENT_BEGIN: 1,
    HSV2_DB: 2,
    HSV2_USER: 3,
    HSV2_OPTIONS: 4,
    HSV2_REMOTE_PID: 6,
    HSV2_CLIENT_TYPE: 8,
    HSV2_PROTOCOL: 9,
    HSV2_SSL_NEGOTIATE: 11,
    HSV2_SSL_CONNECT: 12,
    HSV2_APPNAME: 13,
    HSV2_CLIENT_OS: 14,
    HSV2_CLIENT_HOST_NAME: 15,
    HSV2_CLIENT_OS_USER: 16,
    HSV2_64BIT_VARLENA_ENABLED: 17,
    HSV2_CLIENT_DONE: 1000,
} as const;

export type HandshakeCodeValue = (typeof HandshakeCode)[keyof typeof HandshakeCode];

export const ExtabSock = {
    DATA: 1,
    ERROR: 2,
    DONE: 3,
} as const;

export type ExtabSockValue = (typeof ExtabSock)[keyof typeof ExtabSock];
