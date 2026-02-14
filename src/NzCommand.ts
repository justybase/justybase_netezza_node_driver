// NzConnection type reference for circular dependency
interface NzConnection {
    execute(command: any, bufferOnly: boolean): Promise<void>;
    executeReader(command: any): Promise<any>;
    cancel(): Promise<void>;
    commandTimeout?: number;
}

/**
 * Represents a SQL command to be executed against Netezza database
 */
class NzCommand {
    connection: NzConnection;
    commandText: string;
    parameters: any[];
    _recordsAffected: number;
    commandTimeout: number;
    _preparedStatement?: any;

    constructor(connection: NzConnection) {
        this.connection = connection;
        this.commandText = '';
        this.parameters = [];
        this._recordsAffected = -1;
        this.commandTimeout = connection.commandTimeout !== undefined ? connection.commandTimeout : 30; // Default 30s, 0 = no timeout
    }

    async execute(): Promise<void> {
        return this.connection.execute(this, false);
    }

    async executeNonQuery(): Promise<number> {
        await this.connection.execute(this, false);
        return this._recordsAffected;
    }

    async executeReader(): Promise<any> {
        return this.connection.executeReader(this);
    }

    async cancel(): Promise<void> {
        return this.connection.cancel();
    }
}

export { NzCommand };
