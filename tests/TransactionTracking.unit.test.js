/**
 * Offline unit tests for NzConnection explicit-transaction tracking.
 *
 * Netezza does not report the transaction status in ReadyForQuery (the frame is
 * `Z` + code + a zero-length payload), so the driver infers `inTransaction`
 * from the statements it sends. `_preExecution` is the single choke point every
 * execution path goes through, so the tests drive it with a stub stream.
 */

const { NzConnection } = require('../dist/cjs/NzConnection');

const baseConfig = {
    host: 'localhost',
    database: 'db',
    user: 'user',
    password: 'password',
};

function createConnection() {
    const connection = new NzConnection(baseConfig);
    // Minimal stand-ins for the parts of net.Socket used by _preExecution.
    connection._socket = { destroyed: false };
    connection._stream = { write: () => true };
    return connection;
}

/** Sends `sql` through the normal execution choke point without a live server. */
function send(connection, sql, params) {
    connection._preExecution(connection.createCommand(sql, params));
}

/** Connection whose stub socket accepts close() and reports it back. */
function createClosableConnection() {
    const connection = new NzConnection(baseConfig);
    const socket = {
        destroyed: false,
        _listeners: {},
        on(event, listener) {
            const listeners = this._listeners[event] || [];
            listeners.push(listener);
            this._listeners[event] = listeners;
        },
        once(event, listener) {
            this.on(event, listener);
        },
        removeAllListeners() {
            this._listeners = {};
        },
        end() {},
        destroy() {
            this.destroyed = true;
            for (const listener of this._listeners.close || []) listener();
        },
    };
    connection._socket = socket;
    connection._stream = { write: () => true, destroyed: false };
    return connection;
}

describe('NzConnection transaction tracking', () => {
    test('is false on a fresh connection', () => {
        expect(createConnection().inTransaction).toBe(false);
    });

    test.each([
        ['BEGIN'],
        ['begin'],
        ['  begin  '],
        ['BEGIN;'],
        ['START TRANSACTION'],
        ['start transaction'],
        ['/* report job */ BEGIN'],
        ['-- open a transaction\nBEGIN'],
    ])('treats %j as opening a transaction', (sql) => {
        const connection = createConnection();
        send(connection, sql);
        expect(connection.inTransaction).toBe(true);
    });

    test.each([['COMMIT'], ['commit'], ['ROLLBACK'], ['rollback'], ['END']])(
        'treats %j as closing a transaction',
        (sql) => {
            const connection = createConnection();
            send(connection, 'BEGIN');
            send(connection, sql);
            expect(connection.inTransaction).toBe(false);
        }
    );

    // `END` is a COMMIT synonym, but it also terminates a CASE expression and a
    // procedure body, so only a statement-initial keyword may count.
    test.each([
        ['SELECT CASE WHEN 1 = 1 THEN 1 ELSE 2 END'],
        ['SELECT 1'],
        ["SELECT 'begin' AS label"],
    ])('leaves the state untouched for %j', (sql) => {
        const connection = createConnection();
        expect(connection.inTransaction).toBe(false);
        send(connection, sql);
        expect(connection.inTransaction).toBe(false);
    });

    // `AS BEGIN_PROC ... END; END_PROC` is how this project's own live tests
    // create procedures, so its inner `END;` must not close the transaction.
    test('treats a BEGIN_PROC ... END_PROC body as part of its statement', () => {
        const connection = createConnection();
        send(connection, 'BEGIN');
        send(
            connection,
            'CREATE OR REPLACE PROCEDURE p() RETURNS INTEGER EXECUTE AS OWNER LANGUAGE NZPLSQL AS BEGIN_PROC BEGIN RETURN 1; END; END_PROC'
        );
        expect(connection.inTransaction).toBe(true);

        send(connection, 'COMMIT');
        expect(connection.inTransaction).toBe(false);
    });

    test('does not treat a BEGIN_PROC body as a transaction opener', () => {
        const connection = createConnection();
        send(connection, 'CREATE PROCEDURE p() RETURNS INTEGER LANGUAGE NZPLSQL AS BEGIN_PROC BEGIN RETURN 1; END; END_PROC');
        expect(connection.inTransaction).toBe(false);
    });

    test('keeps tracking a real transaction that follows a routine body', () => {
        const connection = createConnection();
        send(
            connection,
            'CREATE PROCEDURE p() RETURNS INTEGER LANGUAGE NZPLSQL AS BEGIN_PROC BEGIN RETURN 1; END; END_PROC; BEGIN'
        );
        expect(connection.inTransaction).toBe(true);
    });

    test('does not let a CASE ... END inside a transaction close it', () => {
        const connection = createConnection();
        send(connection, 'BEGIN');
        send(connection, 'SELECT CASE WHEN 1 = 1 THEN 1 ELSE 2 END AS flag');
        expect(connection.inTransaction).toBe(true);
    });

    test('lets the last statement of a batch decide the state', () => {
        const open = createConnection();
        send(open, 'INSERT INTO t VALUES (1); BEGIN');
        expect(open.inTransaction).toBe(true);

        const closed = createConnection();
        send(closed, 'BEGIN; INSERT INTO t VALUES (1); COMMIT');
        expect(closed.inTransaction).toBe(false);

        const rolledBack = createConnection();
        send(rolledBack, 'BEGIN; INSERT INTO t VALUES (1); ROLLBACK');
        expect(rolledBack.inTransaction).toBe(false);
    });

    test('tracks parameters substituted into the statement text', () => {
        const connection = createConnection();
        send(connection, 'BEGIN');
        send(connection, 'SELECT $1 AS note', ['commit']);
        expect(connection.inTransaction).toBe(true);
    });

    test('keeps a previously open transaction when the next statement is unrelated', () => {
        const connection = createConnection();
        send(connection, 'BEGIN');
        send(connection, 'SELECT 1');
        send(connection, 'UPDATE t SET c = 1');
        expect(connection.inTransaction).toBe(true);
    });

    // A ';' inside a literal, a quoted identifier or a dollar-quoted body must
    // not start a new statement: the fragment after it would otherwise begin
    // with text like `COMMIT')` and silently close an open transaction, which
    // would make the pool skip its rollback-on-release.
    test.each([
        ["INSERT INTO t VALUES ('a;COMMIT')"],
        ["SELECT 'it''s; COMMIT' AS c"],
        ["SELECT 'a\\';COMMIT' AS c"],
        ['SELECT $$; COMMIT$$ AS body'],
        ['SELECT $tag$; COMMIT$tag$ AS body'],
        ['SELECT "weird;COMMIT" FROM t'],
        ['SELECT 1; -- COMMIT'],
        ['BEGIN -- COMMIT\n; SELECT 1'],
        ['SELECT 1 /* COMMIT */'],
        ["INSERT INTO t VALUES ('$$;ROLLBACK$$')"],
    ])('keeps the transaction open through %j', (sql) => {
        const connection = createConnection();
        send(connection, 'BEGIN');
        expect(connection.inTransaction).toBe(true);
        send(connection, sql);
        expect(connection.inTransaction).toBe(true);
    });

    test('still sees a real COMMIT after a literal containing a semicolon', () => {
        const connection = createConnection();
        send(connection, "BEGIN; INSERT INTO t VALUES ('a;b'); COMMIT");
        expect(connection.inTransaction).toBe(false);
    });

    test('applies dollar-quoted bodies as a single statement', () => {
        const connection = createConnection();
        send(connection, 'BEGIN');
        send(
            connection,
            'CREATE OR REPLACE PROCEDURE p() RETURNS INTEGER LANGUAGE NZPLSQL AS $$ BEGIN RETURN 1; END; $$'
        );
        expect(connection.inTransaction).toBe(true);
    });

    test('close() resets the flag so a later session starts clean', async () => {
        const connection = createClosableConnection();
        send(connection, 'BEGIN');
        expect(connection.inTransaction).toBe(true);

        await connection.close();
        expect(connection.inTransaction).toBe(false);
        expect(connection._stream).toBeNull();
    });
});
