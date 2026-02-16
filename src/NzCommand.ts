// NzConnection type reference for circular dependency
import { NzDataReader } from './NzDataReader';

interface NzConnection {
    execute(command: NzCommand, bufferOnly: boolean): Promise<boolean>;
    executeReader(command: NzCommand): Promise<NzDataReader>;
    cancel(): Promise<void>;
    commandTimeout?: number;
}

interface PreparedStatement {
    description?: ColumnInfo[];
}

interface ColumnInfo {
    name: string;
    typeOid: number;
    typeLen: number;
    typeMod: number;
    format: number;
}

/**
 * Represents a SQL command to be executed against Netezza database
 */
class NzCommand {
    connection: NzConnection;
    commandText: string;
    parameters: unknown[];
    _recordsAffected: number;
    commandTimeout: number;
    _preparedStatement?: PreparedStatement;

    constructor(connection: NzConnection) {
        this.connection = connection;
        this.commandText = '';
        this.parameters = [];
        this._recordsAffected = -1;
        this.commandTimeout = connection.commandTimeout !== undefined ? connection.commandTimeout : 30; // Default 30s, 0 = no timeout
    }

    async execute(): Promise<boolean> {
        return this.connection.execute(this, false);
    }

    async executeNonQuery(): Promise<number> {
        await this.connection.execute(this, false);
        return this._recordsAffected;
    }

    async executeReader(): Promise<NzDataReader> {
        return this.connection.executeReader(this);
    }

    async cancel(): Promise<void> {
        return this.connection.cancel();
    }
}

export { NzCommand };
