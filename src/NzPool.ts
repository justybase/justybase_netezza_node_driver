import { EventEmitter } from 'events';
import { NzConnection, NzConnectionConfig } from './NzConnection';
import { NzDataReader } from './NzDataReader';

const debug = require('debug')('nz:pool');

/**
 * Configuration for the connection pool
 */
export interface NzPoolConfig extends NzConnectionConfig {
    /** Maximum number of connections in the pool (default: 10) */
    max?: number;
    /** Minimum number of idle connections to maintain (default: 0) */
    min?: number;
    /** Milliseconds a connection can sit idle before being closed (default: 10000). Set 0 to disable. */
    idleTimeoutMillis?: number;
    /** Milliseconds to wait for a connection before timing out (default: 0 = no timeout) */
    connectionTimeoutMillis?: number;
    /** Maximum number of times a connection can be checked out before being destroyed (default: Infinity) */
    maxUses?: number;
    /** Maximum lifetime of a connection in seconds (default: 0 = no limit) */
    maxLifetimeSeconds?: number;
    /** If true, allow Node.js process to exit even if pool has idle connections (default: false) */
    allowExitOnIdle?: boolean;
}

interface IdleItem {
    client: NzConnection;
    timeoutId: ReturnType<typeof setTimeout> | undefined;
}

interface PendingItem {
    callback: (err: Error | undefined, client?: NzConnection, release?: (err?: Error) => void) => void;
    timedOut: boolean;
}

/**
 * A connection pool for NzConnection instances.
 *
 * Manages a pool of reusable database connections with configurable limits,
 * idle timeouts, lifetime management, and health checking.
 *
 * @example
 * ```typescript
 * const pool = new NzPool({
 *   host: 'netezza-host',
 *   database: 'mydb',
 *   user: 'admin',
 *   password: 'secret',
 *   max: 10,
 *   idleTimeoutMillis: 30000,
 * });
 *
 * // Simple query
 * const reader = await pool.query('SELECT * FROM my_table');
 *
 * // Manual checkout
 * const { client, release } = await pool.connect();
 * try {
 *   const cmd = client.createCommand('SELECT 1');
 *   await cmd.execute();
 * } finally {
 *   release();
 * }
 *
 * await pool.end();
 * ```
 */
class NzPool extends EventEmitter {
    private _config: NzPoolConfig;
    private _clients: NzConnection[] = [];
    private _idle: IdleItem[] = [];
    private _expired: WeakSet<NzConnection> = new WeakSet();
    private _pendingQueue: PendingItem[] = [];
    private _ending: boolean = false;
    private _ended: boolean = false;
    private _endCallback: (() => void) | undefined;
    private _useCount: WeakMap<NzConnection, number> = new WeakMap();

    private readonly _max: number;
    private readonly _min: number;
    private readonly _idleTimeoutMillis: number;
    private readonly _connectionTimeoutMillis: number;
    private readonly _maxUses: number;
    private readonly _maxLifetimeSeconds: number;
    private readonly _allowExitOnIdle: boolean;

    constructor(config: NzPoolConfig) {
        super();
        this._config = { ...config };
        this._max = config.max ?? 10;
        this._min = config.min ?? 0;
        this._idleTimeoutMillis = config.idleTimeoutMillis ?? 10000;
        this._connectionTimeoutMillis = config.connectionTimeoutMillis ?? 0;
        this._maxUses = config.maxUses ?? Infinity;
        this._maxLifetimeSeconds = config.maxLifetimeSeconds ?? 0;
        this._allowExitOnIdle = config.allowExitOnIdle ?? false;
    }

    /** Number of clients waiting in the queue for a connection */
    get waitingCount(): number {
        return this._pendingQueue.length;
    }

    /** Number of idle connections currently in the pool */
    get idleCount(): number {
        return this._idle.length;
    }

    /** Total number of connections managed by the pool (idle + in-use) */
    get totalCount(): number {
        return this._clients.length;
    }

    /** Number of connections that have exceeded their max lifetime */
    get expiredCount(): number {
        return this._clients.reduce((acc, c) => acc + (this._expired.has(c) ? 1 : 0), 0);
    }

    private _isFull(): boolean {
        return this._clients.length >= this._max;
    }

    private _isAboveMin(): boolean {
        return this._clients.length > this._min;
    }

    /**
     * Checkout a connection from the pool.
     * Returns a promise with the client and a release function.
     */
    async connect(): Promise<{ client: NzConnection; release: (err?: Error) => void }> {
        if (this._ending) {
            throw new Error('Cannot use a pool after calling end on the pool');
        }

        return new Promise<{ client: NzConnection; release: (err?: Error) => void }>((resolve, reject) => {
            const callback = (err: Error | undefined, client?: NzConnection, release?: (err?: Error) => void) => {
                if (err) return reject(err);
                resolve({ client: client!, release: release! });
            };

            // If we have idle clients, use one immediately
            if (this._idle.length) {
                const pendingItem: PendingItem = { callback, timedOut: false };
                this._pendingQueue.push(pendingItem);
                // Schedule pulse on next tick to process queue
                process.nextTick(() => this._pulseQueue());
                return;
            }

            // If pool isn't full, create a new connection
            if (!this._isFull()) {
                const pendingItem: PendingItem = { callback, timedOut: false };
                this._newClient(pendingItem);
                return;
            }

            // Pool is full, queue this request
            if (!this._connectionTimeoutMillis) {
                this._pendingQueue.push({ callback, timedOut: false });
                return;
            }

            // Set up connection timeout
            const pendingItem: PendingItem = { callback: () => {}, timedOut: false };
            const tid = setTimeout(() => {
                this._pendingQueue = this._pendingQueue.filter((i) => i !== pendingItem);
                pendingItem.timedOut = true;
                callback(new Error('Timeout exceeded when trying to connect'));
            }, this._connectionTimeoutMillis);

            if (tid.unref) tid.unref();

            pendingItem.callback = (err, client, release) => {
                clearTimeout(tid);
                callback(err, client, release);
            };

            this._pendingQueue.push(pendingItem);
        });
    }

    /**
     * Execute a query using a connection from the pool.
     * The connection is automatically released after the reader is closed.
     */
    async query(sql: string): Promise<NzDataReader> {
        const { client, release } = await this.connect();

        try {
            const cmd = client.createCommand(sql);
            const reader = await cmd.executeReader();

            // Wrap the reader's close to also release the connection
            const originalClose = reader.close.bind(reader);
            reader.close = async () => {
                try {
                    await originalClose();
                } finally {
                    release();
                }
            };

            return reader;
        } catch (err) {
            release(err instanceof Error ? err : new Error(String(err)));
            throw err;
        }
    }

    /**
     * Execute a non-query SQL statement (INSERT, UPDATE, DELETE, DDL).
     * The connection is automatically released after execution.
     * @returns Number of rows affected (-1 for DDL)
     */
    async executeNonQuery(sql: string): Promise<{ rowsAffected: number; notices: readonly string[] }> {
        const { client, release } = await this.connect();

        try {
            const cmd = client.createCommand(sql);
            const rowsAffected = await cmd.executeNonQuery();
            release();
            return { rowsAffected, notices: cmd.notices };
        } catch (err) {
            release(err instanceof Error ? err : new Error(String(err)));
            throw err;
        }
    }

    /**
     * Drain the pool and close all connections.
     */
    async end(): Promise<void> {
        if (this._ending) {
            throw new Error('Called end on pool more than once');
        }
        this._ending = true;

        return new Promise<void>((resolve) => {
            this._endCallback = resolve;
            this._pulseQueue();
        });
    }

    private _pulseQueue(): void {
        debug('pulse queue');

        if (this._ended) {
            debug('pulse queue ended');
            return;
        }

        if (this._ending) {
            debug('pulse queue on ending');
            // Close all idle connections
            if (this._idle.length) {
                const idleCopy = this._idle.slice();
                for (const item of idleCopy) {
                    this._remove(item.client);
                }
            }
            // If no more clients, we're done
            if (!this._clients.length) {
                this._ended = true;
                if (this._endCallback) this._endCallback();
            }
            return;
        }

        // Nothing waiting? Nothing to do.
        if (!this._pendingQueue.length) {
            debug('no queued requests');
            return;
        }

        // No idle clients and pool is full? Can't help.
        if (!this._idle.length && this._isFull()) {
            return;
        }

        const pendingItem = this._pendingQueue.shift()!;

        if (this._idle.length) {
            const idleItem = this._idle.pop()!;
            if (idleItem.timeoutId) clearTimeout(idleItem.timeoutId);
            return this._acquireClient(idleItem.client, pendingItem, false);
        }

        if (!this._isFull()) {
            return this._newClient(pendingItem);
        }
    }

    private _newClient(pendingItem: PendingItem): void {
        const client = new NzConnection(this._config);
        this._clients.push(client);
        this._useCount.set(client, 0);

        debug('connecting new client');

        // Connection timeout for new connections
        let tid: ReturnType<typeof setTimeout> | undefined;
        let timeoutHit = false;

        if (this._connectionTimeoutMillis) {
            tid = setTimeout(() => {
                debug('ending client due to connection timeout');
                timeoutHit = true;
                client.close();
            }, this._connectionTimeoutMillis);
        }

        client
            .connect()
            .then(() => {
                if (tid) clearTimeout(tid);

                // Set up max lifetime timer
                if (this._maxLifetimeSeconds > 0) {
                    const lifetimeTimer = setTimeout(() => {
                        debug('marking client as expired due to max lifetime');
                        this._expired.add(client);
                        // If idle, force acquire and release to trigger removal
                        const idleIdx = this._idle.findIndex((item) => item.client === client);
                        if (idleIdx !== -1) {
                            const removed = this._idle.splice(idleIdx, 1)[0];
                            if (removed.timeoutId) clearTimeout(removed.timeoutId);
                            this._remove(client, () => this._pulseQueue());
                        }
                    }, this._maxLifetimeSeconds * 1000);
                    if (lifetimeTimer.unref) lifetimeTimer.unref();
                }

                this._acquireClient(client, pendingItem, true);
            })
            .catch((err: Error) => {
                if (tid) clearTimeout(tid);
                debug('client failed to connect', err);
                this._clients = this._clients.filter((c) => c !== client);
                this._useCount.delete(client);

                if (timeoutHit) {
                    err = new Error('Connection terminated due to connection timeout');
                }

                this._pulseQueue();

                if (!pendingItem.timedOut) {
                    pendingItem.callback(err);
                }
            });
    }

    private _acquireClient(client: NzConnection, pendingItem: PendingItem, isNew: boolean): void {
        if (isNew) {
            this.emit('connect', client);
        }
        this.emit('acquire', client);

        let released = false;
        const release = (err?: Error) => {
            if (released) {
                throw new Error('Release called on client which has already been released to the pool.');
            }
            released = true;
            this._release(client, err);
        };

        if (!pendingItem.timedOut) {
            pendingItem.callback(undefined, client, release);
        } else {
            // Already timed out, just release
            release();
        }
    }

    private _release(client: NzConnection, err?: Error): void {
        const useCount = (this._useCount.get(client) || 0) + 1;
        this._useCount.set(client, useCount);

        this.emit('release', err, client);

        // Remove client on error, pool ending, or use limit exceeded
        if (err || this._ending || useCount >= this._maxUses) {
            if (useCount >= this._maxUses) {
                debug('remove expended client');
            }
            return this._remove(client, () => this._pulseQueue());
        }

        // Remove expired clients
        if (this._expired.has(client)) {
            debug('remove expired client');
            this._expired.delete(client);
            return this._remove(client, () => this._pulseQueue());
        }

        // Set up idle timeout
        let tid: ReturnType<typeof setTimeout> | undefined;
        if (this._idleTimeoutMillis && this._isAboveMin()) {
            tid = setTimeout(() => {
                if (this._isAboveMin()) {
                    debug('remove idle client');
                    this._remove(client, () => this._pulseQueue());
                }
            }, this._idleTimeoutMillis);

            if (this._allowExitOnIdle && tid.unref) {
                tid.unref();
            }
        }

        this._idle.push({ client, timeoutId: tid });
        this._pulseQueue();
    }

    private _remove(client: NzConnection, callback?: () => void): void {
        // Remove from idle list
        const idleIdx = this._idle.findIndex((item) => item.client === client);
        if (idleIdx !== -1) {
            const removed = this._idle.splice(idleIdx, 1)[0];
            if (removed.timeoutId) clearTimeout(removed.timeoutId);
        }

        // Remove from clients list
        this._clients = this._clients.filter((c) => c !== client);
        this._useCount.delete(client);

        // Close the connection
        try {
            client.close();
        } catch {
            // Ignore close errors
        }

        this.emit('remove', client);
        if (callback) callback();
    }
}

export { NzPool };
