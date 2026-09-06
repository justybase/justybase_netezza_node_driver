import assert from 'node:assert/strict';
import test from 'node:test';
import { expandSqlShortcut, findSqlShortcut } from '../src/renderer/src/lib/sqlShortcuts.ts';

test('ordinary numeric input followed by a space is not rewritten', () => {
  const sql = '111 ';

  assert.equal(findSqlShortcut(sql, sql.length), null);
  assert.equal(expandSqlShortcut(sql, sql.length), null);
});

test('SQL shortcuts replace the token and keep the cursor after the replacement', () => {
  assert.deepEqual(expandSqlShortcut('SX ', 3), {
    value: 'SELECT ',
    cursorOffset: 7
  });
  assert.deepEqual(expandSqlShortcut('SELECT FX ', 10), {
    value: 'SELECT FROM ',
    cursorOffset: 12
  });
});

test('SQL shortcuts do not expand inside strings or comments', () => {
  const stringSql = "SELECT 'SX '";
  assert.equal(expandSqlShortcut(stringSql, stringSql.length), null);
  assert.equal(expandSqlShortcut('-- SX ', 6), null);
  assert.equal(expandSqlShortcut('/* FX */ ', 9), null);
});
