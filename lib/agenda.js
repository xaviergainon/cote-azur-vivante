const { CATEGORIES } = require("./defaults");
const { blendRating } = require("./ratings");

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

function mapEvent(row, { includeStatus = false, votes = [] } = {}) {
  const event = {
    id: row.id,
    title: row.title,
    days: asArray(row.days),
    time: row.time_label || "",
    category: row.category,
    city: row.city || "",
    venue: row.venue || "",
    address: row.address || row.place_address || "",
    lat: row.lat != null ? Number(row.lat) : row.place_lat != null ? Number(row.place_lat) : null,
    lng: row.lng != null ? Number(row.lng) : row.place_lng != null ? Number(row.place_lng) : null,
    price: row.price || "",
    free: row.free === true || row.free === "t" || row.free === "true" || row.free === 1,
    description: row.description || "",
    source: row.source_name || "",
    url: row.url || "",
  };
  const rating = blendRating({
    status: row.rating_status,
    score: row.rating_score,
    count: row.rating_count,
    source: row.rating_source,
    votes,
  });
  if (rating) event.rating = rating;
  const image = httpUrl(row.image_url);
  if (includeStatus) {
    event.status = row.status;
    event.image = image;
    event.imagePage = row.image_page || "";
    event.imageStatus = row.image_status || "";
    event.flagStatus = row.flag_status || "";
    event.flagNote = row.flag_note || "";
    event.placeShare = Number(row.place_share || 0);
    event.placeId = row.place_id || "";
    event.placeName = row.place_name || "";
    event.ratingStatus = row.rating_status || "";
    event.ratingNote = row.rating_note || "";
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
    `SELECT events.*,
            places.lat AS place_lat,
            places.lng AS place_lng,
            places.address AS place_address
     FROM events
     LEFT JOIN places ON places.id = events.place_id AND places.status = 'published'
     WHERE events.status = 'published'
     ORDER BY events.title ASC`
  );
  const votesResult = await db.query("SELECT event_id, score FROM rating_votes");
  const votesByEvent = new Map();
  for (const row of votesResult.rows) {
    const list = votesByEvent.get(row.event_id) || [];
    list.push(Number(row.score));
    votesByEvent.set(row.event_id, list);
  }
  const sourcesResult = await db.query(
    "SELECT name, url FROM sources WHERE enabled = TRUE ORDER BY name ASC"
  );
  const linksResult = await db.query(
    "SELECT target_type, target_id, name, url FROM booking_links WHERE status = 'approved'"
  );
  const bookingFor = new Map();
  for (const link of linksResult.rows) bookingFor.set(`${link.target_type}:${link.target_id}`, link);
  const events = eventsResult.rows.map((row) => {
    const event = mapEvent(row, { votes: votesByEvent.get(row.id) || [] });
    const link = bookingFor.get(`event:${row.id}`) || (row.place_id ? bookingFor.get(`place:${row.place_id}`) : null);
    if (link) event.booking = { name: link.name, url: link.url };
    return event;
  });
  const days = [...new Set(events.flatMap((event) => event.days))].sort();
  return {
    meta: {
      title: "Côte d'Azur Vivante",
      subtitle: "Spectacles, festivals, conférences et sorties dans les Alpes-Maritimes et à Monaco",
      generatedAt: new Date().toISOString(),
      days,
      sources: sourcesResult.rows,
    },
    categories: CATEGORIES,
    events,
  };
}

module.exports = { mapEvent, publicAgenda, asArray, httpUrl };
