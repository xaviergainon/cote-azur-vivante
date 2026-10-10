const fs = require("node:fs");
const path = require("node:path");
const { decrypt, encrypt, hint } = require("./secrets");
const { DEFAULT_GEMINI_MODEL } = require("./defaults");
const { ROOT } = require("./db");

async function getRaw(db, key) {
  const result = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? null;
}

async function setRaw(db, key, value) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

async function getSecret(db, appSecret, key) {
  const raw = await getRaw(db, key);
  if (!raw) return "";
  try {
    return decrypt(raw, appSecret) || "";
  } catch {
    return "";
  }
}

async function setSecret(db, appSecret, key, value) {
  await setRaw(db, key, encrypt(value, appSecret));
}

function readMapsKeyFromFile() {
  const file = path.join(ROOT, "js", "config.js");
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/googleMapsApiKey:\s*"([^"]+)"/);
  const key = match?.[1] || "";
  if (!key || key === "YOUR_GOOGLE_MAPS_API_KEY") return "";
  return key;
}

async function mapsKey(db, appSecret) {
  const stored = await getSecret(db, appSecret, "google_maps_api_key");
  if (stored) return stored;
  return process.env.GOOGLE_MAPS_API_KEY || readMapsKeyFromFile() || "";
}

async function geminiKey(db, appSecret) {
  const stored = await getSecret(db, appSecret, "gemini_api_key");
  if (stored) return stored;
  return process.env.GEMINI_API_KEY || "";
}

async function geminiModel(db) {
  return (await getRaw(db, "gemini_model")) || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

async function cursorKey(db, appSecret) {
  const stored = await getSecret(db, appSecret, "cursor_api_key");
  if (stored) return stored;
  return process.env.CURSOR_API_KEY || "";
}

async function llmProvider(db) {
  const stored = await getRaw(db, "llm_provider");
  return stored === "gemini" ? "gemini" : "cursor";
}

async function cursorModel(db) {
  return (await getRaw(db, "cursor_model")) || "";
}

async function publicSettings(db, appSecret) {
  const maps = await mapsKey(db, appSecret);
  const gemini = await geminiKey(db, appSecret);
  const cursor = await cursorKey(db, appSecret);
  return {
    maps: { configured: Boolean(maps), hint: hint(maps) },
    gemini: { configured: Boolean(gemini), hint: hint(gemini) },
    cursor: { configured: Boolean(cursor), hint: hint(cursor) },
    model: await geminiModel(db),
    provider: await llmProvider(db),
    cursorModel: await cursorModel(db),
  };
}

module.exports = {
  getRaw,
  setRaw,
  getSecret,
  setSecret,
  mapsKey,
  geminiKey,
  geminiModel,
  cursorKey,
  llmProvider,
  cursorModel,
  publicSettings,
  readMapsKeyFromFile,
};
