#!/usr/bin/env node
/**
 * Conformance runner for @justybase/netezza-driver (Node.js).
 *
 * Implements conformance/runner-contract.md v1. Requires a built driver:
 *   npm run build
 * Then:
 *   node tools/conformance/runner.js --profile smoke
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');
const CONFORMANCE_ROOT = path.join(WORKSPACE_ROOT, 'conformance');

const entry = process.env.NZ_NODE_DRIVER_ENTRY || path.join(REPO_ROOT, 'dist', 'cjs', 'index.js');
const { NzConnection, NzPool } = require(entry);
const os = require('os');

const INTEGER_CLASSES = new Set(['int1', 'int2', 'int4', 'int8']);
const FLOAT_CLASSES = new Set(['float4', 'float8']);
const TEXT_CLASSES = new Set(['char', 'text', 'nchar', 'nvarchar']);

const OID_CLASS = {
  16: 'bool',
  17: 'bytes',
  18: 'char',
  19: 'text',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'int4',
  700: 'float4',
  701: 'float8',
  705: 'unknown',
  1042: 'char',
  1043: 'text',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamp',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2500: 'int1',
  2522: 'nchar',
  2530: 'nvarchar',
  2569: 'bytes',
  2950: 'text',
  3614: 'text',
  3802: 'text',
  114: 'text',
};

function classifyOid(oid) {
  return OID_CLASS[oid] || 'unknown';
}

const OID_NAME = {
  17: 'BYTEA',
  2568: 'VARBINARY',
  2569: 'VARBINARY',
};

function typeNameForOid(oid, fallback) {
  const declared = fallback && !String(fallback).startsWith('UNKNOWN(') ? fallback : null;
  return declared || OID_NAME[oid] || fallback || `OID:${oid}`;
}

function loadEnv(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function config() {
  const required = ['NZ_DEV_HOST', 'NZ_DEV_USER', 'NZ_DEV_PASSWORD'];
  const missing = required.filter((name) => !process.env[name]);
  const database = process.env.NZ_DEV_DB || process.env.NZ_DEV_DATABASE;
  if (!database) missing.push('NZ_DEV_DB (or NZ_DEV_DATABASE)');
  if (missing.length) {
    console.error(`node runner: missing configuration: ${missing.join(', ')}`);
    process.exit(2);
  }
  let host = process.env.NZ_DEV_HOST;
  if (host === 'localhost' || host === '::1') host = '127.0.0.1';
  return {
    host,
    port: Number(process.env.NZ_DEV_PORT || 5480),
    database,
    user: process.env.NZ_DEV_USER,
    password: process.env.NZ_DEV_PASSWORD,
    schema: process.env.NZ_CONFORMANCE_SCHEMA || 'CONFORMANCE',
    commandTimeout: Number(process.env.NZ_CONFORMANCE_COMMAND_TIMEOUT || 30),
  };
}

function loadCases(dir) {
  const cases = [];
  const seen = new Set();
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const document = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (document.kit_version !== 1) {
      console.error(`node runner: unsupported kit_version in ${name}`);
      process.exit(2);
    }
    for (const item of document.cases || []) {
      if (!item.id || seen.has(item.id)) {
        console.error(`node runner: invalid or duplicate case id ${item.id}`);
        process.exit(2);
      }
      seen.add(item.id);
      cases.push(item);
    }
  }
  return cases;
}

function selectCases(cases, profile, filters) {
  return cases.filter((item) => {
    if (filters.length) return filters.some((needle) => item.id.includes(needle));
    const caseProfile = item.profile || 'full';
    if (profile === 'full') return caseProfile === 'full' || caseProfile === 'smoke';
    return caseProfile === profile;
  });
}

function renderSql(sql, schema) {
  if (!schema || schema.toUpperCase() === 'CONFORMANCE') return sql;
  return sql.replace(/CONFORMANCE\./g, `${schema.toUpperCase()}.`).replace(/'CONFORMANCE'/g, `'${schema.toUpperCase()}'`);
}

function parseInterval(text) {
  let sign = 1;
  let body = String(text).trim();
  if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1).trim();
  }
  let months = 0;
  let days = 0;
  let microseconds = 0;
  const years = body.match(/(\d+)\s+years?/i);
  if (years) months += Number(years[1]) * 12;
  const mons = body.match(/(\d+)\s+mons?/i);
  if (mons) months += Number(mons[1]);
  const day = body.match(/(\d+)\s+days?/i);
  if (day) days = Number(day[1]);
  const time = body.match(/(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/);
  if (time) {
    const hours = Number(time[1]);
    const minutes = Number(time[2]);
    const seconds = Number(time[3]);
    const fraction = time[4] ? Number(time[4].padEnd(6, '0')) : 0;
    microseconds = ((hours * 60 + minutes) * 60 + seconds) * 1000000 + fraction;
  }
  return { months: sign * months, days: sign * days, microseconds: sign * microseconds };
}

function canonicalValue(value, typeClass) {
  if (value === null || value === undefined) return null;
  if (INTEGER_CLASSES.has(typeClass)) return String(value);
  if (typeClass === 'numeric') return typeof value === 'string' ? value : String(value);
  if (FLOAT_CLASSES.has(typeClass)) {
    const number = Number(value);
    if (Number.isNaN(number)) return 'NaN';
    if (number === Infinity) return 'Infinity';
    if (number === -Infinity) return '-Infinity';
    return number;
  }
  if (typeClass === 'bool') return Boolean(value);
  if (typeClass === 'date') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  }
  if (typeClass === 'time') {
    if (value && typeof value === 'object' && typeof value.toString === 'function' && 'hours' in value) {
      return value.toString();
    }
    return String(value);
  }
  if (typeClass === 'timetz') {
    const text = String(value);
    return text.replace(/([+-]\d{2})$/, '$1:00');
  }
  if (typeClass === 'timestamp' || typeClass === 'timestamptz') {
    if (value instanceof Date) {
      const micros = typeof value.microseconds === 'number' ? value.microseconds : 0;
      const base = value.toISOString().slice(0, 19).replace('T', ' ');
      return micros === 0 ? base : `${base}.${String(micros).padStart(6, '0')}`;
    }
    return String(value);
  }
  if (typeClass === 'interval') return parseInterval(value);
  if (typeClass === 'bytes') {
    if (Buffer.isBuffer(value)) return value.toString('base64');
    return String(value);
  }
  return String(value);
}

function classifyError(error) {
  const message = String(error && error.message ? error.message : error);
  const lowered = message.toLowerCase();
  let kind = 'other';
  if (lowered.includes('certificate') || lowered.includes('self-signed') || lowered.includes('ssl') || lowered.includes('tls') || lowered.includes('handshake')) kind = 'connection';
  else if (lowered.includes('timeout') || lowered.includes('timed out')) kind = 'timeout';
  else if (lowered.includes('cancel')) kind = 'cancelled';
  else if (lowered.includes('syntax') || lowered.includes('expected next item') || lowered.includes('expecting') || /found\s+"/.test(lowered)) kind = 'syntax';
  else if (lowered.includes('permission') || lowered.includes('denied')) kind = 'permission';
  else if (lowered.includes('function') && lowered.includes('does not exist')) kind = 'function';
  else if (lowered.includes('cannot contain null') || lowered.includes('not null') || lowered.includes('unique constraint')) kind = 'constraint';
  else if (lowered.includes('attribute') || lowered.includes('column')) kind = 'column';
  else if (lowered.includes('does not exist') || lowered.includes('not found') || lowered.includes('cannot find')) kind = 'relation';
  else if (lowered.includes('pg_atoi') || lowered.includes("can't parse") || lowered.includes('divide by 0') || lowered.includes('out of range') || lowered.includes('invalid')) kind = 'type';
  return { class: kind, message, code: error && error.code ? String(error.code) : null };
}

async function executeStatement(connection, sql, timeoutSeconds) {
  const command = connection.createCommand(sql);
  if (typeof timeoutSeconds === 'number' && timeoutSeconds > 0) {
    command.commandTimeout = timeoutSeconds;
  }
  const reader = await connection.executeReader(command);
  try {
    const columns = [];
    const descriptions = reader.columnDescriptions || [];
    for (let index = 0; index < descriptions.length; index += 1) {
      const description = descriptions[index];
      let metadata = {};
      try {
        metadata = reader.getColumnMetadata(index) || {};
      } catch {
        metadata = {};
      }
      columns.push({
        name: description.name,
        type_name: typeNameForOid(description.typeOid, metadata.typeName || metadata.declaredTypeName),
        type_class: classifyOid(description.typeOid),
      });
    }
    const rows = [];
    while (await reader.read()) {
      const row = [];
      for (let index = 0; index < columns.length; index += 1) row.push(reader.getValue(index));
      rows.push(row);
    }
    return { columns, rows };
  } finally {
    await reader.close();
  }
}

function apiColumns(spec) {
  return spec.map(([name, typeName, typeClass]) => ({ name, type_name: typeName, type_class: typeClass }));
}

function normalizeText(text) {
  return String(text).toUpperCase().split(/\s+/).filter(Boolean).join(' ');
}

async function apiMetadataDdl(connection, settings, spec) {
  const schema = spec.schema || settings.schema;
  const meta = connection.meta;
  const checks = [];
  const tables = await meta.getTables(schema);
  const existingTables = new Set(tables.map((item) => String(item.tableName || '').toUpperCase()));
  for (const name of spec.tables || []) checks.push(['tables', name, existingTables.has(String(name).toUpperCase())]);
  const columns = await meta.getColumns(spec.table, schema);
  const existingColumns = new Set(columns.map((item) => String(item.name || '').toUpperCase()));
  for (const name of spec.columns || []) checks.push(['columns', name, existingColumns.has(String(name).toUpperCase())]);
  const ddl = await meta.getTableDdl(spec.table, schema);
  const haystack = normalizeText(ddl);
  for (const fragment of spec.fragments || []) checks.push(['ddl', fragment, haystack.includes(normalizeText(fragment))]);
  return {
    columns: apiColumns([['check', 'VARCHAR', 'text'], ['name', 'VARCHAR', 'text'], ['ok', 'BOOLEAN', 'bool']]),
    rows: checks,
  };
}

async function apiPoolReuse(connection, settings, spec) {
  const pool = new NzPool({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    min: 0,
    max: Math.max(1, Number(spec.max_size || 1)),
    idleTimeoutMillis: 60000,
  });
  const checks = [];
  try {
    const first = await pool.connect();
    let firstSid;
    try {
      const result = await first.client.query('SELECT CURRENT_SID AS value');
      firstSid = result.rows[0].VALUE;
    } finally {
      first.release();
    }
    const second = await pool.connect();
    let secondSid;
    try {
      const result = await second.client.query('SELECT CURRENT_SID AS value');
      secondSid = result.rows[0].VALUE;
    } finally {
      second.release();
    }
    checks.push(['same_session', firstSid === secondSid]);
    checks.push(['stats_within_limit', pool.totalCount <= Math.max(1, Number(spec.max_size || 1))]);
  } finally {
    await pool.end();
  }
  return {
    columns: apiColumns([['check', 'VARCHAR', 'text'], ['ok', 'BOOLEAN', 'bool']]),
    rows: checks,
  };
}

async function apiExternalRoundtrip(connection, settings, spec) {
  const schema = String(spec.schema || settings.schema).toUpperCase();
  const source = `${schema}.CASE_EXT_SRC`;
  const destination = `${schema}.CASE_EXT_DST`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nz-conformance-external-'));
  const sqlDirectory = directory.replace(/\\/g, '/');
  const externalFile = `${sqlDirectory}/export.txt`;
  try {
    const statements = [
      `DROP TABLE ${source} IF EXISTS`,
      `DROP TABLE ${destination} IF EXISTS`,
      `CREATE TABLE ${source} (ID INTEGER, LABEL VARCHAR(20)) DISTRIBUTE ON (ID)`,
      `INSERT INTO ${source} VALUES (1, 'one')`,
      `INSERT INTO ${source} VALUES (2, 'two')`,
      `CREATE EXTERNAL TABLE '${externalFile}' USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${sqlDirectory}') AS SELECT * FROM ${source}`,
      `CREATE TABLE ${destination} (ID INTEGER, LABEL VARCHAR(20)) DISTRIBUTE ON (ID)`,
      `INSERT INTO ${destination} SELECT * FROM EXTERNAL '${externalFile}' USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${sqlDirectory}')`,
    ];
    for (const statement of statements) await connection.query(statement);
    const result = await connection.query(
      `SELECT COUNT(*)::INTEGER AS row_count, COALESCE(SUM(ID), 0)::INTEGER AS checksum FROM ${destination}`
    );
    const row = result.rows[0];
    return {
      columns: apiColumns([['row_count', 'INTEGER', 'int4'], ['checksum', 'INTEGER', 'int4']]),
      rows: [[String(row.ROW_COUNT), String(row.CHECKSUM)]],
    };
  } finally {
    for (const statement of [`DROP TABLE ${source} IF EXISTS`, `DROP TABLE ${destination} IF EXISTS`]) {
      try { await connection.query(statement); } catch { /* ignore */ }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function apiTlsFailClosed(connection, settings) {
  const tlsConnection = new NzConnection({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    securityLevel: 'OnlySecuredSession',
  });
  await tlsConnection.connect();
  await tlsConnection.close();
  return {
    columns: apiColumns([['check', 'VARCHAR', 'text']]),
    rows: [['unexpected_tls_success']],
  };
}

const API_OPERATIONS = {
  metadata_ddl: apiMetadataDdl,
  pool_reuse: apiPoolReuse,
  external_roundtrip: apiExternalRoundtrip,
  tls_fail_closed: apiTlsFailClosed,
};

async function executeApiCase(connection, settings, item) {
  const started = Date.now();
  const result = {
    case_id: item.id,
    status: 'pass',
    duration_ms: 0,
    columns: [],
    rows: [],
    row_count: 0,
    result_sets: [],
    error: null,
    profile: item.profile || 'full',
  };
  try {
    for (const statement of item.setup || []) {
      try {
        await executeStatement(connection, renderSql(statement, settings.schema));
      } catch (error) {
        if (!String(error.message || error).toLowerCase().includes('does not exist')) throw error;
      }
    }
    const operation = (item.api || {}).operation;
    const handler = API_OPERATIONS[operation];
    if (!handler) throw new Error(`unsupported api operation ${operation}`);
    const outcome = await handler(connection, settings, item.api || {});
    result.columns = outcome.columns;
    result.rows = outcome.rows;
    result.row_count = outcome.rows.length;
    result.result_sets = [{ columns: outcome.columns, rows: outcome.rows, row_count: outcome.rows.length }];
  } catch (error) {
    result.status = 'error';
    result.error = classifyError(error);
  } finally {
    for (const statement of item.cleanup || []) {
      try {
        await executeStatement(connection, renderSql(statement, settings.schema));
      } catch (error) {
        console.error(`cleanup warning [${item.id}]: ${error.message || error}`);
      }
    }
    result.duration_ms = Date.now() - started;
  }
  return result;
}

async function executeCase(connection, settings, item) {
  const started = Date.now();
  const caseId = item.id;
  const sql = renderSql(item.sql || '', settings.schema);
  const params = item.params || [];
  const values = params.map((param) => param.value);
  const timeoutSeconds = typeof item.timeout === 'number' ? item.timeout : undefined;
  const result = {
    case_id: caseId,
    status: 'pass',
    duration_ms: 0,
    columns: [],
    rows: [],
    row_count: 0,
    result_sets: [],
    error: null,
    profile: item.profile || 'full',
  };

  try {
    for (const statement of item.setup || []) {
      try {
        await executeStatement(connection, renderSql(statement, settings.schema));
      } catch (error) {
        if (!String(error.message || error).toLowerCase().includes('does not exist')) throw error;
      }
    }

    const sets = [];
    if (item.multi_statement) {
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        sets.push(await executeStatement(connection, statement, timeoutSeconds));
      }
    } else if (params.length) {
      const command = connection.createCommand(sql, values);
      if (typeof timeoutSeconds === 'number' && timeoutSeconds > 0) {
        command.commandTimeout = timeoutSeconds;
      }
      const reader = await connection.executeReader(command);
      try {
        const descriptions = reader.columnDescriptions || [];
        const columns = descriptions.map((description, index) => {
          let metadata = {};
          try { metadata = reader.getColumnMetadata(index) || {}; } catch { metadata = {}; }
          return {
            name: description.name,
            type_name: typeNameForOid(description.typeOid, metadata.typeName || metadata.declaredTypeName),
            type_class: classifyOid(description.typeOid),
          };
        });
        const rows = [];
        while (await reader.read()) {
          const row = [];
          for (let index = 0; index < columns.length; index += 1) row.push(reader.getValue(index));
          rows.push(row);
        }
        sets.push({ columns, rows });
      } finally {
        await reader.close();
      }
    } else {
      sets.push(await executeStatement(connection, sql, timeoutSeconds));
    }

    const primarySets = sets.filter((set) => set.columns.length > 0);
    const primary = primarySets.length ? primarySets[0] : { columns: [], rows: [] };
    result.columns = primary.columns;
    result.rows = primary.rows.map((row) => row.map((value, index) => canonicalValue(value, primary.columns[index] ? primary.columns[index].type_class : 'unknown')));
    result.row_count = primary.rows.length;
    result.result_sets = primarySets.map((set) => ({
      columns: set.columns,
      rows: set.rows.map((row) => row.map((value, index) => canonicalValue(value, set.columns[index] ? set.columns[index].type_class : 'unknown'))),
      row_count: set.rows.length,
    }));
  } catch (error) {
    result.status = 'error';
    result.error = classifyError(error);
    try { await connection.rollback(); } catch { /* ignore */ }
  } finally {
    for (const statement of item.cleanup || []) {
      try {
        await executeStatement(connection, renderSql(statement, settings.schema));
      } catch (error) {
        console.error(`cleanup warning [${caseId}]: ${error.message || error}`);
      }
    }
    result.duration_ms = Date.now() - started;
  }
  return result;
}

function parseArgs(argv) {
  const args = { profile: null, case: [], casesDir: path.join(CONFORMANCE_ROOT, 'cases'), out: null, env: null, failFast: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--profile') args.profile = argv[++index];
    else if (flag === '--case') args.case.push(argv[++index]);
    else if (flag === '--cases-dir') args.casesDir = argv[++index];
    else if (flag === '--out') args.out = argv[++index];
    else if (flag === '--env') args.env = argv[++index];
    else if (flag === '--fail-fast') args.failFast = true;
    else if (flag === '--verbose') args.verbose = true;
    else { console.error(`node runner: unknown argument ${flag}`); process.exit(2); }
  }
  if (!args.profile) { console.error('node runner: --profile is required'); process.exit(2); }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv(args.env);
  const settings = config();
  const cases = selectCases(loadCases(args.casesDir), args.profile, args.case);
  if (!cases.length) { console.error('node runner: no cases selected'); return 2; }

  const connection = new NzConnection({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
  });
  connection.commandTimeout = settings.commandTimeout;

  try {
    await connection.connect();
  } catch (error) {
    console.error(`node runner: connection failed: ${error.message || error}`);
    return 2;
  }

  const out = args.out ? fs.createWriteStream(args.out, { encoding: 'utf8' }) : process.stdout;
  let failures = 0;
  try {
    for (const item of cases) {
      const result = item.api
      ? await executeApiCase(connection, settings, item)
      : await executeCase(connection, settings, item);
      out.write(`${JSON.stringify(result)}\n`);
      if (args.verbose || result.status !== 'pass') {
        console.error(`${result.status === 'pass' ? 'ok  ' : 'ERR '} ${item.id} (${result.duration_ms} ms)`);
      }
      if (result.status === 'error') {
        failures += 1;
        if (args.failFast) break;
      }
    }
  } finally {
    if (args.out) await new Promise((resolve) => out.end(resolve));
    try { await connection.close(); } catch { /* ignore */ }
  }
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`node runner crash: ${error && error.stack ? error.stack : error}`);
    process.exit(3);
  });
