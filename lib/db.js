const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".data");

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    days JSONB NOT NULL,
    time_label TEXT,
    category TEXT NOT NULL,
    city TEXT NOT NULL,
    venue TEXT,
    address TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    price TEXT,
    free BOOLEAN NOT NULL DEFAULT FALSE,
    description TEXT,
    source_name TEXT,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    log TEXT NOT NULL DEFAULT '',
    created_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS events_status_idx ON events (status)`,
  `CREATE TABLE IF NOT EXISTS rating_votes (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    score NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

function loadAppSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.trim()) {
    return process.env.APP_SECRET.trim();
  }
  if (process.env.DATABASE_URL) {
    throw new Error(
      "APP_SECRET est obligatoire avec DATABASE_URL. Ajoute cette variable sur Railway avant de déployer."
    );
  }
  const file = path.join(DATA_DIR, "app-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function postgresSsl(connectionString) {
  if (/sslmode=disable/i.test(connectionString)) return false;
  if (/sslmode=require/i.test(connectionString) || process.env.DATABASE_SSL === "true") {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function openDatabase() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: postgresSsl(process.env.DATABASE_URL),
    });
    return {
      kind: "postgres",
      query(text, params = []) {
        return pool.query(text, params);
      },
      async close() {
        await pool.end();
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const client = new PGlite(path.join(DATA_DIR, "pglite"));
  await client.waitReady;
  return {
    kind: "pglite",
    query(text, params = []) {
      return client.query(text, params);
    },
    async close() {
      await client.close();
    },
  };
}

async function initDb() {
  const secret = loadAppSecret();
  const db = await openDatabase();
  for (const sql of STATEMENTS) {
    await db.query(sql);
  }
  await db.query(
    "ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trigger_name TEXT NOT NULL DEFAULT 'manual'"
  );
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS image_page TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS image_status TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS flag_status TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS flag_note TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS image_checked_at TIMESTAMPTZ");
  await db.query("ALTER TABLE sources ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'agenda'");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS rating_score NUMERIC");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS rating_count INTEGER");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS rating_source TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS rating_note TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS rating_status TEXT");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS rating_checked_at TIMESTAMPTZ");
  await db.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS time_checked_at TIMESTAMPTZ");
  await db.query(
    `UPDATE events
     SET image_url = NULL, image_page = NULL, image_status = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE image_status = 'proposed'
       AND image_url IN (
         SELECT image_url FROM events
         WHERE image_status = 'proposed' AND COALESCE(image_url, '') <> ''
         GROUP BY image_url
         HAVING COUNT(*) > 2
       )`
  );
  return { db, secret };
}

module.exports = { initDb, ROOT, DATA_DIR };
