const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DEFAULT_SOURCES } = require("./defaults");
const { ROOT } = require("./db");
const { hashPassword } = require("./secrets");
const { getRaw, setRaw, setSecret, readMapsKeyFromFile } = require("./settings");

function sourceId(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function loadBundledAgenda() {
  const file = path.join(ROOT, "js", "events-data.js");
  const code = fs.readFileSync(file, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { timeout: 2000, filename: "events-data.js" });
  return sandbox.window.AGENDA_06;
}

async function ensureSources(db) {
  for (const source of DEFAULT_SOURCES) {
    const id = sourceId(source.name);
    await db.query(
      `INSERT INTO sources (id, name, url, enabled)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [id, source.name, source.url]
    );
  }
}

async function ensureEvents(db) {
  const count = await db.query("SELECT COUNT(*) AS n FROM events");
  if (Number(count.rows[0].n) > 0) return;
  const agenda = loadBundledAgenda();
  for (const event of agenda.events || []) {
    await db.query(
      `INSERT INTO events (
        id, title, days, time_label, category, city, venue, address,
        lat, lng, price, free, description, source_name, url, status
      ) VALUES (
        $1, $2, $3::jsonb, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, 'published'
      ) ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.title,
        JSON.stringify(event.days || []),
        event.time || "",
        event.category,
        event.city,
        event.venue || "",
        event.address || "",
        event.lat ?? null,
        event.lng ?? null,
        event.price || "",
        Boolean(event.free),
        event.description || "",
        event.source || "",
        event.url || "",
      ]
    );
  }
}

async function bootstrap(db, appSecret) {
  if (process.env.ADMIN_PASSWORD && !(await getRaw(db, "admin_password_hash"))) {
    await setRaw(db, "admin_password_hash", hashPassword(process.env.ADMIN_PASSWORD));
  }
  if (!(await getRaw(db, "google_maps_api_key"))) {
    const key = process.env.GOOGLE_MAPS_API_KEY || readMapsKeyFromFile();
    if (key) await setSecret(db, appSecret, "google_maps_api_key", key);
  }
  if (process.env.GEMINI_API_KEY && !(await getRaw(db, "gemini_api_key"))) {
    await setSecret(db, appSecret, "gemini_api_key", process.env.GEMINI_API_KEY);
  }
  if (process.env.GEMINI_MODEL && !(await getRaw(db, "gemini_model"))) {
    await setRaw(db, "gemini_model", process.env.GEMINI_MODEL);
  }
  await ensureSources(db);
  await ensureEvents(db);
}

module.exports = { bootstrap, ensureSources, sourceId };
