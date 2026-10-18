require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool: PgPool } = require('pg');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check route so the React frontend knows the backend is online
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'CSV-to-DW Node.js Backend is running!' });
});

// Strict SQL identifier sanitizer
function sanitizeIdentifier(name) {
  const cleaned = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[0-9]+/, '_$&');
  if (!cleaned || cleaned.length > 63) {
    throw new Error(`Invalid SQL identifier: "${name}"`);
  }
  return cleaned;
}

function getConnectionConfig(conn = {}) {
  const engine = (conn.engine || 'postgresql').toLowerCase();
  if (engine === 'postgresql') {
    return {
      engine: 'postgresql',
      host: conn.host || process.env.PG_HOST || 'localhost',
      port: Number(conn.port || process.env.PG_PORT || 5432),
      database: conn.database || process.env.PG_DATABASE || 'postgres',
      user: conn.username || process.env.PG_USER || 'postgres',
      password: conn.password || process.env.PG_PASSWORD || ''
    };
  } else {
    return {
      engine: 'mysql',
      host: conn.host || process.env.MYSQL_HOST || 'localhost',
      port: Number(conn.port || process.env.MYSQL_PORT || 3306),
      database: conn.database || process.env.MYSQL_DATABASE || 'test',
      user: conn.username || process.env.MYSQL_USER || 'root',
      password: conn.password || process.env.MYSQL_PASSWORD || ''
    };
  }
}

function mapSqlType(logicalType) {
  switch (logicalType) {
    case 'integer': return 'BIGINT';
    case 'decimal': return 'DECIMAL(14,2)';
    case 'boolean': return 'BOOLEAN';
    case 'date': return 'DATE';
    case 'timestamp': return 'TIMESTAMP';
    default: return 'VARCHAR(255)';
  }
}

// 1. Test Database Connection (PostgreSQL or MySQL)
app.post('/api/connections/test', async (req, res) => {
  const startTime = Date.now();
  const cfg = getConnectionConfig(req.body);

  try {
    if (cfg.engine === 'postgresql') {
      const pool = new PgPool({ ...cfg, connectionTimeoutMillis: 5000 });
      const result = await pool.query('SELECT version() AS version, current_database() AS db');
      await pool.end();
      return res.json({
        success: true,
        latencyMs: Date.now() - startTime,
        serverVersion: result.rows[0].version.split(',')[0],
        database: result.rows[0].db
      });
    } else {
      const conn = await mysql.createConnection({ ...cfg, connectTimeout: 5000 });
      const [rows] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db');
      await conn.end();
      return res.json({
        success: true,
        latencyMs: Date.now() - startTime,
        serverVersion: `MySQL ${rows[0].version}`,
        database: rows[0].db
      });
    }
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// 2. Load Staging, Dimension & Fact Tables inside an Atomic SQL Transaction
app.post('/api/warehouse/load', async (req, res) => {
  const { connection, tables } = req.body;
  const cfg = getConnectionConfig(connection);
  const startTime = Date.now();
  const logs = [];

  if (!tables || typeof tables !== 'object') {
    return res.status(400).json({ error: 'Missing warehouse tables payload.' });
  }

  if (cfg.engine === 'postgresql') {
    const pool = new PgPool(cfg);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      logs.push('BEGIN TRANSACTION (PostgreSQL)');

      const orderedNames = Object.keys(tables).sort((a, b) => {
        const rank = (t) => (t.type === 'staging' ? 1 : t.type === 'dimension' ? 2 : 3);
        return rank(tables[a]) - rank(tables[b]);
      });

      for (const rawTableName of orderedNames) {
        const tbl = tables[rawTableName];
        const tableName = sanitizeIdentifier(rawTableName);
        const cols = tbl.columns.map((c) => ({
          name: sanitizeIdentifier(c.name),
          sqlType: mapSqlType(c.dataType),
          pk: Boolean(c.pk)
        }));

        const colDefs = cols.map((c) => `"${c.name}" ${c.sqlType}${c.pk ? ' PRIMARY KEY' : ''}`);
        await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
        await client.query(`CREATE TABLE "${tableName}" (${colDefs.join(', ')})`);

        const rows = tbl.rows || [];
        for (const row of rows) {
          const colNames = cols.map((c) => `"${c.name}"`).join(', ');
          const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
          const values = cols.map((c) => (row[c.name] === '' || row[c.name] === undefined ? null : row[c.name]));
          await client.query(`INSERT INTO "${tableName}" (${colNames}) VALUES (${placeholders})`, values);
        }
        logs.push(`Loaded ${rows.length} rows into "${tableName}"`);
      }

      await client.query('COMMIT');
      logs.push('COMMIT TRANSACTION successful');
      return res.json({ success: true, durationMs: Date.now() - startTime, logs });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ success: false, error: err.message, logs });
    } finally {
      client.release();
      await pool.end();
    }
  } else {
    let conn;
    try {
      conn = await mysql.createConnection(cfg);
      await conn.beginTransaction();
      logs.push('START TRANSACTION (MySQL)');

      for (const [rawTableName, tbl] of Object.entries(tables)) {
        const tableName = sanitizeIdentifier(rawTableName);
        const cols = tbl.columns.map((c) => ({
          name: sanitizeIdentifier(c.name),
          sqlType: mapSqlType(c.dataType),
          pk: Boolean(c.pk)
        }));

        const colDefs = cols.map((c) => `\`${c.name}\` ${c.sqlType}${c.pk ? ' PRIMARY KEY' : ''}`);
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        await conn.query(`DROP TABLE IF EXISTS \`${tableName}\``);
        await conn.query(`CREATE TABLE \`${tableName}\` (${colDefs.join(', ')})`);
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');

        const rows = tbl.rows || [];
        for (const row of rows) {
          const colNames = cols.map((c) => `\`${c.name}\``).join(', ');
          const placeholders = cols.map(() => '?').join(', ');
          const values = cols.map((c) => (row[c.name] === '' || row[c.name] === undefined ? null : row[c.name]));
          await conn.query(`INSERT INTO \`${tableName}\` (${colNames}) VALUES (${placeholders})`, values);
        }
        logs.push(`Loaded ${rows.length} rows into \`${tableName}\``);
      }

      await conn.commit();
      return res.json({ success: true, durationMs: Date.now() - startTime, logs });
    } catch (err) {
      if (conn) await conn.rollback();
      return res.status(500).json({ success: false, error: err.message, logs });
    } finally {
      if (conn) await conn.end();
    }
  }
});

// 3. Run Analytical SQL Queries
app.post('/api/warehouse/query', async (req, res) => {
  const { connection, sql } = req.body;
  const trimmedSql = String(sql || '').trim();

  if (/^\s*(DROP|TRUNCATE|DELETE|ALTER|UPDATE|INSERT|GRANT|REVOKE)\b/i.test(trimmedSql)) {
    return res.status(403).json({
      error: 'Guardrail Triggered: Only read-only SELECT queries are allowed.'
    });
  }

  const cfg = getConnectionConfig(connection);
  const startTime = Date.now();

  try {
    if (cfg.engine === 'postgresql') {
      const pool = new PgPool(cfg);
      const result = await pool.query(trimmedSql);
      await pool.end();
      return res.json({
        columns: result.fields.map((f) => f.name),
        rows: result.rows,
        rowCount: result.rowCount,
        executionTimeMs: Date.now() - startTime
      });
    } else {
      const conn = await mysql.createConnection(cfg);
      const [rows, fields] = await conn.query(trimmedSql);
      await conn.end();
      return res.json({
        columns: fields.map((f) => f.name),
        rows,
        rowCount: rows.length,
        executionTimeMs: Date.now() - startTime
      });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log('✅ Step 4 Passed: Full ETL Backend running on http://localhost:4000');
});