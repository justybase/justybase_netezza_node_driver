import { EventEmitter } from 'node:events';
import {
    NzConnection,
    type NzConnectionConfig,
    type ExecuteResult,
    type QueryResult,
    type QueryResultRow,
} from './NzConnection';

const debug = require('debug')('nz:pool');

/**
 * Configuration for the connection pool
 */
export interface NzPoolConfig extends NzConnectionConfig {
    /** Maximum number of connections in the pool (default: 10) */
    max?: number;
    /**
     * Minimum number of idle connections to maintain (default: 0).
     * When min > 0, connections are pre-created into the idle pool after construction.
     */
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
 *   min: 2, // pre-creates 2 idle connections
 *   idleTimeoutMillis: 30000,
 * });
 *
 * // Simple query — returns rows and auto-releases the connection
 * const { rows } = await pool.query('SELECT * FROM my_table WHERE id = $1', [42]);
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
    private _removing: WeakSet<NzConnection> = new WeakSet();
    private _connecting: WeakSet<NzConnection> = new WeakSet();
    private _connectingRequests: WeakMap<NzConnection, PendingItem> = new WeakMap();

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

        if (!Number.isInteger(this._max) || this._max <= 0) {
            throw new RangeError('Pool max must be a positive integer');
        }
        if (!Number.isInteger(this._min) || this._min < 0 || this._min > this._max) {
            throw new RangeError('Pool min must be an integer between 0 and max');
        }
        if (!Number.isFinite(this._idleTimeoutMillis) || this._idleTimeoutMillis < 0) {
            throw new RangeError('Pool idleTimeoutMillis must be a non-negative finite number');
        }
        if (!Number.isFinite(this._connectionTimeoutMillis) || this._connectionTimeoutMillis < 0) {
            throw new RangeError('Pool connectionTimeoutMillis must be a non-negative finite number');
        }
        if (!Number.isFinite(this._maxLifetimeSeconds) || this._maxLifetimeSeconds < 0) {
            throw new RangeError('Pool maxLifetimeSeconds must be a non-negative finite number');
        }
        if (!Number.isFinite(this._maxUses) || this._maxUses <= 0) {
            if (this._maxUses !== Infinity) {
                throw new RangeError('Pool maxUses must be a positive finite number or Infinity');
            }
        }

        if (this._min > 0) {
            process.nextTick(() => this._ensureMinIdle());
        }
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
                if (!client || !release) {
                    reject(new Error('Pool checkout completed without a client or release function'));
                    return;
                }
                resolve({ client, release });
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
     * Execute a query using a connection from the pool and buffer all rows.
     * The connection is automatically released after execution.
     *
     * `T` is the type of each element of `result.rows` and defaults to
     * `QueryResultRow` (`Record<string, unknown>`). Pass an interface or type
     * literal to receive typed rows:
     *
     * ```typescript
     * const { rows } = await pool.query<{ id: number }>('SELECT id FROM t');
     * ```
     */
    async query<T = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
        const { client, release } = await this.connect();

        try {
            const result = await client.query<T>(sql, params);
            release();
            return result;
        } catch (err) {
            release(err instanceof Error ? err : new Error(String(err)));
            throw err;
        }
    }

    /**
     * Execute a non-query SQL statement (INSERT, UPDATE, DELETE, DDL).
     * The connection is automatically released after execution.
     * @returns Number of rows affected (-1 for DDL) and notices
     */
    async executeNonQuery(
        sql: string,
        params?: unknown[]
    ): Promise<{ rowsAffected: number; notices: readonly string[] }> {
        const { client, release } = await this.connect();

        try {
            const result: ExecuteResult = await client.execute(sql, params);
            release();
            return { rowsAffected: result.rowCount, notices: result.notices };
        } catch (err) {
            release(err instanceof Error ? err : new Error(String(err)));
            throw err;
        }
    }

    /**
     * Drain the pool and close all connections. Idempotent.
     */
    async end(): Promise<void> {
        if (this._ended) {
            return;
        }
        if (this._ending) {
            return new Promise<void>((resolve) => {
                const prev = this._endCallback;
                this._endCallback = () => {
                    if (prev) prev();
                    resolve();
                };
            });
        }
        this._ending = true;
        this._rejectPending(new Error('Cannot use a pool after calling end on the pool'));

        return new Promise<void>((resolve) => {
            this._endCallback = resolve;
            this._pulseQueue();
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        return this.end();
    }

    private _ensureMinIdle(): void {
        if (this._ending || this._ended) return;
        while (this._clients.length < this._min && !this._isFull()) {
            this._createIdleClient();
        }
    }

    private _createIdleClient(): void {
        const client = new NzConnection(this._config);
        this._clients.push(client);
        this._useCount.set(client, 0);
        this._connecting.add(client);

        debug('pre-creating idle client for min pool size');

        client
            .connect()
            .then(() => {
                this._connecting.delete(client);
                if (this._ending || this._ended) {
                    this._remove(client);
                    return;
                }
                this._attachClientLifecycle(client);
                this.emit('connect', client);
                this._idle.push({ client, timeoutId: undefined });
                this._pulseQueue();
            })
            .catch((err: Error) => {
                this._connecting.delete(client);
                debug('idle warmup client failed to connect', err);
                this._clients = this._clients.filter((c) => c !== client);
                this._useCount.delete(client);
                this.emit('error', err);
                // A failed warmup client no longer occupies a pool slot. Wake
                // queued callers so they can create a replacement connection.
                this._pulseQueue();
            });
    }

    private _attachClientLifecycle(client: NzConnection): void {
        const onDead = () => {
            if (this._removing.has(client)) return;
            if (!this._clients.includes(client)) return;
            this._remove(client, () => {
                this._ensureMinIdle();
                this._pulseQueue();
            });
        };
        client.on('error', onDead);
        client.on('close', onDead);
    }

    private _pulseQueue(): void {
        debug('pulse queue');

        if (this._ended) {
            debug('pulse queue ended');
            return;
        }

        if (this._ending) {
            debug('pulse queue on ending');
            // A client which is still connecting has not been handed to a
            // caller, so it can be closed immediately. Checked-out clients
            // remain alive until their release callback returns them here.
            const connectingCopy = this._clients.filter((client) => this._connecting.has(client));
            for (const client of connectingCopy) {
                this._remove(client);
            }
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

        const pendingItem = this._pendingQueue.shift() as PendingItem;

        if (this._idle.length) {
            const idleItem = this._idle.pop() as IdleItem;
            if (idleItem.timeoutId) clearTimeout(idleItem.timeoutId);
            this._acquireClient(idleItem.client, pendingItem, false);
            return;
        }

        if (!this._isFull()) {
            this._newClient(pendingItem);
            return;
        }
    }

    private _newClient(pendingItem: PendingItem): void {
        const client = new NzConnection(this._config);
        this._clients.push(client);
        this._useCount.set(client, 0);
        this._connecting.add(client);
        this._connectingRequests.set(client, pendingItem);

        debug('connecting new client');

        // Connection timeout for new connections
        let tid: ReturnType<typeof setTimeout> | undefined;
        let timeoutHit = false;

        if (this._connectionTimeoutMillis) {
            tid = setTimeout(() => {
                debug('ending client due to connection timeout');
                timeoutHit = true;
                this._remove(
                    client,
                    () => this._pulseQueue(),
                    new Error('Connection terminated due to connection timeout')
                );
            }, this._connectionTimeoutMillis);
            if (tid.unref) tid.unref();
        }

        client
            .connect()
            .then(() => {
                this._connecting.delete(client);
                this._connectingRequests.delete(client);
                if (tid) clearTimeout(tid);

                if (!this._clients.includes(client) || pendingItem.timedOut) {
                    // A timeout, pool shutdown, or another lifecycle event may
                    // have removed the client while connect() was still pending.
                    // Never hand that connection to a caller after removal.
                    if (!pendingItem.timedOut) {
                        pendingItem.timedOut = true;
                        pendingItem.callback(new Error('Connection was removed before it became ready'));
                    }
                    return;
                }

                if (this._ending || this._ended) {
                    if (!pendingItem.timedOut) {
                        pendingItem.timedOut = true;
                        pendingItem.callback(new Error('Cannot use a pool after calling end on the pool'));
                    }
                    this._remove(client, () => this._pulseQueue());
                    return;
                }

                this._attachClientLifecycle(client);

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
                this._connecting.delete(client);
                this._connectingRequests.delete(client);
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
        if (!this._clients.includes(client)) {
            // A socket error/close can remove a checked-out client before the
            // caller's finally block invokes release(). Never reinsert that
            // dead client into the idle queue.
            this.emit('release', err, client);
            return;
        }

        const useCount = (this._useCount.get(client) || 0) + 1;
        this._useCount.set(client, useCount);

        this.emit('release', err, client);

        // Remove client on error, pool ending, or use limit exceeded
        if (err || this._ending || useCount >= this._maxUses) {
            if (useCount >= this._maxUses) {
                debug('remove expended client');
            }
            this._remove(client, () => {
                this._ensureMinIdle();
                this._pulseQueue();
            });
            return;
        }

        // Remove expired clients
        if (this._expired.has(client)) {
            debug('remove expired client');
            this._expired.delete(client);
            this._remove(client, () => {
                this._ensureMinIdle();
                this._pulseQueue();
            });
            return;
        }

        // Set up idle timeout
        let tid: ReturnType<typeof setTimeout> | undefined;
        if (this._idleTimeoutMillis && this._isAboveMin()) {
            tid = setTimeout(() => {
                if (this._isAboveMin()) {
                    debug('remove idle client');
                    this._remove(client, () => {
                        this._ensureMinIdle();
                        this._pulseQueue();
                    });
                }
            }, this._idleTimeoutMillis);

            if (this._allowExitOnIdle && tid.unref) {
                tid.unref();
            }
        }

        this._idle.push({ client, timeoutId: tid });
        this._pulseQueue();
    }

    private _remove(
        client: NzConnection,
        callback?: () => void,
        pendingError: Error = new Error('Cannot use a pool after calling end on the pool')
    ): void {
        if (this._removing.has(client) || !this._clients.includes(client)) {
            if (callback) callback();
            return;
        }
        this._removing.add(client);
        this._connecting.delete(client);
        const connectingRequest = this._connectingRequests.get(client);
        this._connectingRequests.delete(client);
        if (connectingRequest && !connectingRequest.timedOut) {
            connectingRequest.timedOut = true;
            connectingRequest.callback(pendingError);
        }

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
        void client.close().catch(() => {
            // Ignore close errors
        });

        this.emit('remove', client);
        if (callback) callback();
    }

    private _rejectPending(error: Error): void {
        const pending = this._pendingQueue.splice(0);
        for (const item of pending) {
            if (item.timedOut) continue;
            item.timedOut = true;
            item.callback(error);
        }
    }
}

export { NzPool };
