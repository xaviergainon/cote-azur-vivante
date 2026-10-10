const { foldText, cityKey } = require("./duplicates");

const PLACE_KINDS = ["theatre", "cinema", "music", "museum", "other"];
const BBOX = { latMin: 43.4, latMax: 44.2, lngMin: 6.5, lngMax: 7.8 };
const VAGUE = new Set(["", "alpes maritimes", "06", "cannes et cote d azur"]);

function text(value, max = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function httpUrl(value) {
  const url = text(value, 400);
  return /^https?:\/\//i.test(url) ? url : "";
}

function slugId(name, city) {
  const raw = `${name}-${city}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
  return raw || "lieu";
}

function normalizeVenue(raw) {
  const name = text(raw.name || raw.title, 140);
  const city = text(raw.city, 80);
  if (name.length < 3 || city.length < 2 || VAGUE.has(foldText(city))) return null;
  const lat = raw.lat == null || raw.lat === "" ? null : Number(raw.lat);
  const lng = raw.lng == null || raw.lng === "" ? null : Number(raw.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  if (hasCoords && (lat < BBOX.latMin || lat > BBOX.latMax || lng < BBOX.lngMin || lng > BBOX.lngMax)) return null;
  const kind = PLACE_KINDS.includes(raw.kind) ? raw.kind : "other";
  return {
    id: slugId(name, city),
    name,
    city,
    address: text(raw.address, 180),
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null,
    hours: text(raw.hours, 180),
    website: httpUrl(raw.website || raw.url),
    kind,
  };
}

function namesClose(venue, placeName) {
  const left = foldText(venue);
  const right = foldText(placeName);
  if (left.length < 4 || right.length < 4) return false;
  if (left === right) return true;
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  return short.length >= 5 && long.includes(short);
}

function matchEventPlace(event, places) {
  const venue = text(event.venue, 140);
  if (!venue || foldText(venue) === foldText(event.city)) return null;
  const hits = places.filter((place) => {
    if (place.status && place.status !== "published") return false;
    const eventCity = cityKey(event);
    const placeCity = cityKey(place);
    if (eventCity && placeCity && eventCity !== placeCity) return false;
    return namesClose(venue, place.name);
  });
  return hits.length === 1 ? hits[0] : null;
}

function acceptBookingUrl(value) {
  const url = httpUrl(value);
  if (!url) return "";
  if (/google\.|gstatic\.com|facebook\.com|instagram\.com|wikipedia\.org/i.test(url)) return "";
  return url;
}

function rowToVenue(row) {
  return {
    id: row.id,
    name: row.name || "",
    city: row.city || "",
    address: row.address || "",
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    hours: row.hours || "",
    website: row.website || "",
    kind: row.kind || "other",
    status: row.status || "draft",
  };
}

async function saveVenue(db, raw) {
  const venue = normalizeVenue(raw);
  if (!venue) return { action: "skipped" };
  const current = await db.query("SELECT * FROM places WHERE id = $1", [venue.id]);
  const existing = current.rows[0];
  if (existing?.status === "published") return { action: "kept", id: venue.id };
  if (!existing) {
    await db.query(
      `INSERT INTO places (id, name, city, address, lat, lng, hours, website, kind, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')`,
      [venue.id, venue.name, venue.city, venue.address, venue.lat, venue.lng, venue.hours, venue.website, venue.kind]
    );
    return { action: "created", id: venue.id, name: venue.name };
  }
  await db.query(
    `UPDATE places SET
      address = CASE WHEN COALESCE(BTRIM(address), '') = '' THEN $2 ELSE address END,
      lat = COALESCE(lat, $3),
      lng = COALESCE(lng, $4),
      hours = CASE WHEN COALESCE(BTRIM(hours), '') = '' THEN $5 ELSE hours END,
      website = CASE WHEN COALESCE(BTRIM(website), '') = '' THEN $6 ELSE website END,
      kind = CASE WHEN kind = 'other' AND $7 <> 'other' THEN $7 ELSE kind END,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'draft'`,
    [venue.id, venue.address, venue.lat, venue.lng, venue.hours, venue.website, venue.kind]
  );
  return { action: "updated", id: venue.id, name: venue.name };
}

async function attachKnownPlaces(db) {
  const places = (await db.query("SELECT * FROM places WHERE status = 'published'")).rows.map(rowToVenue);
  const events = await db.query(
    `SELECT id, title, venue, city, address, lat, lng
     FROM events
     WHERE status IN ('draft', 'published') AND place_id IS NULL AND COALESCE(BTRIM(venue), '') <> ''`
  );
  let attached = 0;
  const notes = [];
  for (const event of events.rows) {
    const place = matchEventPlace(event, places);
    if (!place) continue;
    await db.query(
      `UPDATE events SET
        place_id = $2,
        address = CASE WHEN COALESCE(BTRIM(address), '') = '' THEN $3 ELSE address END,
        lat = COALESCE(lat, $4),
        lng = COALESCE(lng, $5),
        city = CASE WHEN city = '' OR city = 'Alpes-Maritimes' THEN $6 ELSE city END,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND place_id IS NULL`,
      [event.id, place.id, place.address, place.lat, place.lng, place.city]
    );
    attached += 1;
    notes.push(`${event.title} → ${place.name}`);
  }
  return { attached, notes };
}

async function saveBookingProposal(db, raw) {
  const url = acceptBookingUrl(raw.url);
  const targetType = raw.targetType === "event" ? "event" : "place";
  const targetId = text(raw.targetId, 120);
  const name = text(raw.name, 80) || "Billetterie";
  if (!url || !targetId) return { action: "skipped" };
  const existing = await db.query(
    `SELECT id, status FROM booking_links
     WHERE target_type = $1 AND target_id = $2 AND status IN ('proposed', 'approved')
     LIMIT 1`,
    [targetType, targetId]
  );
  if (existing.rows.length) return { action: "kept", id: existing.rows[0].id };
  const id = `billet-${targetType}-${targetId}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 110);
  const inserted = await db.query(
    `INSERT INTO booking_links (id, target_type, target_id, name, url, status, note)
     VALUES ($1, $2, $3, $4, $5, 'proposed', $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, targetType, targetId, name, url, text(raw.note, 180)]
  );
  if (!inserted.rows.length) return { action: "kept", id };
  return { action: "created", id, name };
}

module.exports = {
  PLACE_KINDS,
  normalizeVenue,
  namesClose,
  matchEventPlace,
  acceptBookingUrl,
  saveVenue,
  attachKnownPlaces,
  saveBookingProposal,
};
