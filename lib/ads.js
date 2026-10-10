const { getRaw, setRaw } = require("./settings");

const CLIENT_RE = /^ca-pub-\d{10,16}$/;
const SLOT_RE = /^\d{8,12}$/;

function parseClient(value) {
  const client = String(value || "").trim();
  return CLIENT_RE.test(client) ? client : "";
}

function parseSlot(value) {
  const slot = String(value || "").trim();
  return SLOT_RE.test(slot) ? slot : "";
}

function adsTxtLine(client) {
  const id = parseClient(client);
  if (!id) return "";
  return `google.com, pub-${id.slice("ca-pub-".length)}, DIRECT, f08c47fec0942fa0`;
}

function slotAfter(cardCount) {
  const count = Number(cardCount) || 0;
  const spots = [];
  for (let after = 9; after <= count && spots.length < 3; after += 9) spots.push(after);
  return spots;
}

async function readAds(db) {
  const client = parseClient(await getRaw(db, "ads_client"));
  const slot = parseSlot(await getRaw(db, "ads_slot"));
  const enabled = (await getRaw(db, "ads_enabled")) === "1";
  return { enabled, client, slot, live: enabled && Boolean(client && slot) };
}

async function publicAds(db) {
  const ads = await readAds(db);
  if (!ads.live) return null;
  return { client: ads.client, slot: ads.slot };
}

async function adsTxtBody(db) {
  const ads = await readAds(db);
  if (!ads.live) return "";
  return `${adsTxtLine(ads.client)}\n`;
}

async function saveAds(db, body) {
  const enabled = body.enabled === true || body.enabled === "1";
  const rawClient = String(body.client ?? "").trim();
  const rawSlot = String(body.slot ?? "").trim();
  const client = parseClient(rawClient);
  const slot = parseSlot(rawSlot);
  if (rawClient && !client) {
    const error = new Error("Identifiant éditeur invalide. Forme attendue : ca-pub- suivi de chiffres.");
    error.status = 400;
    throw error;
  }
  if (rawSlot && !slot) {
    const error = new Error("Emplacement invalide. Colle uniquement les chiffres du bloc AdSense.");
    error.status = 400;
    throw error;
  }
  if (enabled && (!client || !slot)) {
    const error = new Error("Pour activer, indique l’identifiant éditeur et l’emplacement.");
    error.status = 400;
    throw error;
  }
  await setRaw(db, "ads_enabled", enabled ? "1" : "0");
  if (client) await setRaw(db, "ads_client", client);
  else await db.query("DELETE FROM settings WHERE key = 'ads_client'");
  if (slot) await setRaw(db, "ads_slot", slot);
  else await db.query("DELETE FROM settings WHERE key = 'ads_slot'");
  return readAds(db);
}

module.exports = {
  parseClient,
  parseSlot,
  adsTxtLine,
  slotAfter,
  readAds,
  publicAds,
  adsTxtBody,
  saveAds,
};
