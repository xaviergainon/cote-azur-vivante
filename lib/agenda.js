const { CATEGORIES } = require("./defaults");

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapEvent(row, { includeStatus = false } = {}) {
  const event = {
    id: row.id,
    title: row.title,
    days: asArray(row.days),
    time: row.time_label || "",
    category: row.category,
    city: row.city || "",
    venue: row.venue || "",
    address: row.address || "",
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    price: row.price || "",
    free: row.free === true || row.free === "t" || row.free === "true" || row.free === 1,
    description: row.description || "",
    source: row.source_name || "",
    url: row.url || "",
  };
  const image = httpUrl(row.image_url);
  if (includeStatus) {
    event.status = row.status;
    event.image = image;
    event.imagePage = row.image_page || "";
    event.imageStatus = row.image_status || "";
    event.flagStatus = row.flag_status || "";
    event.flagNote = row.flag_note || "";
  } else if (row.image_status === "approved" && image) {
    event.image = image;
  }
  return event;
}

function httpUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url.slice(0, 500) : "";
}

async function publicAgenda(db) {
  const eventsResult = await db.query(
    "SELECT * FROM events WHERE status = 'published' ORDER BY title ASC"
  );
  const sourcesResult = await db.query(
    "SELECT name, url FROM sources WHERE enabled = TRUE ORDER BY name ASC"
  );
  const events = eventsResult.rows.map((row) => mapEvent(row));
  const days = [...new Set(events.flatMap((event) => event.days))].sort();
  return {
    meta: {
      title: "Côte d'Azur Vivante",
      subtitle: "Spectacles, festivals, conférences & sorties dans les Alpes-Maritimes",
      generatedAt: new Date().toISOString(),
      days,
      sources: sourcesResult.rows,
    },
    categories: CATEGORIES,
    events,
  };
}

module.exports = { mapEvent, publicAgenda, asArray, httpUrl };
