const VAGUE_CITIES = new Set(["", "alpes maritimes", "06", "cannes et cote d azur"]);
const GENERIC_WORDS = new Set([
  "theatre", "thetre", "salle", "musee", "musees", "cinema", "cine", "palais", "centre",
  "espace", "ville", "parc", "chateau", "national", "municipal", "departemental",
  "mediatheque", "bibliotheque", "festival", "scene", "auditorium", "maison",
  "nice", "cannes", "antibes", "grasse", "menton", "monaco", "cagnes", "juan", "pins",
  "les", "des", "une", "sur", "mer", "arts", "art",
]);

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

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function foldText(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cityKey(event) {
  const city = foldText(event.city);
  return VAGUE_CITIES.has(city) ? "" : city;
}

function tokens(value) {
  return foldText(value).split(" ").filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word));
}

function venueGeneric(event) {
  const venue = foldText(event.venue);
  if (!venue) return true;
  if (venue === foldText(event.city)) return true;
  return tokens(event.venue).length === 0;
}

function venuesCompatible(left, right) {
  if (venueGeneric(left) || venueGeneric(right)) return true;
  const a = foldText(left.venue);
  const b = foldText(right.venue);
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  const rightTokens = new Set(tokens(right.venue));
  return tokens(left.venue).some((word) => rightTokens.has(word));
}

function citiesCompatible(left, right) {
  const a = cityKey(left);
  const b = cityKey(right);
  if (!a || !b) return true;
  return a === b;
}

function namesClose(leftName, rightName) {
  const left = foldText(leftName);
  const right = foldText(rightName);
  if (left.length < 4 || right.length < 4) return false;
  if (left === right) return true;
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  return short.length >= 5 && long.includes(short);
}

function distinctiveKey(name) {
  return foldText(name)
    .split(" ")
    .filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word))
    .join(" ");
}

function shorterIsSpecific(leftName, rightName) {
  const left = foldText(leftName);
  const right = foldText(rightName);
  const short = left.length <= right.length ? left : right;
  const words = short.split(" ").filter((word) => word.length >= 5 && !GENERIC_WORDS.has(word));
  if (!words.length) return false;
  if (words.length === 1 && words[0].length < 6) return false;
  return true;
}

function placesMatch(left, right) {
  const a = cityKey(left);
  const b = cityKey(right);
  if (!a || !b || a !== b) return false;
  const leftKey = distinctiveKey(left.name);
  const rightKey = distinctiveKey(right.name);
  if (leftKey && leftKey === rightKey) {
    const words = leftKey.split(" ");
    if (words.length >= 2 || words[0].length >= 6) return true;
  }
  if (!namesClose(left.name, right.name)) return false;
  return shorterIsSpecific(left.name, right.name);
}

function clusterPlaces(places) {
  const byCity = new Map();
  for (const place of places) {
    const city = cityKey(place);
    if (!city) continue;
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push(place);
  }
  const groups = [];
  for (const list of byCity.values()) {
    const ordered = list
      .slice()
      .sort((left, right) => foldText(right.name).length - foldText(left.name).length || left.id.localeCompare(right.id));
    const used = new Set();
    for (const head of ordered) {
      if (used.has(head.id)) continue;
      const group = [head];
      used.add(head.id);
      for (const other of ordered) {
        if (used.has(other.id)) continue;
        if (!placesMatch(head, other)) continue;
        group.push(other);
        used.add(other.id);
      }
      if (group.length > 1) groups.push(group);
    }
  }
  return groups;
}

function placeScore(place, counts) {
  let score = place.status === "published" ? 100 : 0;
  score += (counts.get(place.id) || 0) * 10;
  if (text(place.address)) score += 2;
  if (place.lat != null && place.lng != null) score += 2;
  if (text(place.website)) score += 1;
  score += Math.min(foldText(place.name).length, 80) / 100;
  return score;
}

function pickPlace(group, counts = new Map()) {
  return group.slice().sort((left, right) => placeScore(right, counts) - placeScore(left, counts))[0];
}

function mergedPlace(keeper, donors) {
  const next = {
    name: text(keeper.name),
    address: text(keeper.address),
    lat: keeper.lat == null ? null : Number(keeper.lat),
    lng: keeper.lng == null ? null : Number(keeper.lng),
    hours: text(keeper.hours),
    website: text(keeper.website),
    kind: keeper.kind || "other",
  };
  const names = [keeper, ...donors].map((place) => text(place.name)).filter(Boolean);
  const longest = names.sort((left, right) => foldText(right).length - foldText(left).length)[0];
  if (
    longest &&
    foldText(longest).length > foldText(next.name).length &&
    placesMatch({ name: next.name, city: keeper.city }, { name: longest, city: keeper.city })
  ) {
    next.name = longest;
  }
  for (const donor of donors) {
    if (!next.address) next.address = text(donor.address);
    if ((next.lat == null || next.lng == null) && donor.lat != null && donor.lng != null) {
      next.lat = Number(donor.lat);
      next.lng = Number(donor.lng);
    }
    if (!next.hours) next.hours = text(donor.hours);
    if (!next.website) next.website = text(donor.website);
    if (next.kind === "other" && donor.kind && donor.kind !== "other") next.kind = donor.kind;
  }
  return next;
}

function bookingKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.href;
  } catch {
    return "";
  }
}

function clusterBookings(links) {
  const groups = new Map();
  for (const link of links) {
    const page = bookingKey(link.url);
    if (!page) continue;
    const key = `${link.target_type}:${link.target_id}:${page}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function pickBooking(group) {
  const rank = { approved: 3, proposed: 2, rejected: 1 };
  return group.slice().sort((left, right) => (rank[right.status] || 0) - (rank[left.status] || 0))[0];
}

function titlesMatch(left, right) {
  const a = foldText(left.title);
  const b = foldText(right.title);
  if (a.length < 3 || b.length < 3) return false;
  if (a === b) return true;
  const leftCity = cityKey(left);
  const rightCity = cityKey(right);
  if (!leftCity || leftCity !== rightCity) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 12 || !long.startsWith(`${short} `)) return false;
  const extra = long.slice(short.length + 1).split(" ").filter(Boolean);
  return extra.length > 0 && extra.length <= 5;
}

function sameShow(left, right) {
  if (left.category === "lecture" || right.category === "lecture") return false;
  if (!titlesMatch(left, right)) return false;
  if (!citiesCompatible(left, right)) return false;
  return venuesCompatible(left, right);
}

function unionClusters(events) {
  const parent = events.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    return cursor;
  };
  const unite = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      if (titlesMatch(events[i], events[j]) && venuesCompatible(events[i], events[j])) unite(i, j);
    }
  }
  const groups = new Map();
  events.forEach((event, index) => {
    const key = find(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });
  return [...groups.values()];
}

function clusterShows(events) {
  const usable = events.filter((event) => event.category !== "lecture" && foldText(event.title).length >= 3);
  const specific = new Map();
  const vague = [];
  for (const event of usable) {
    const city = cityKey(event);
    if (!city) vague.push(event);
    else {
      if (!specific.has(city)) specific.set(city, []);
      specific.get(city).push(event);
    }
  }
  const clusters = [];
  for (const cityEvents of specific.values()) clusters.push(...unionClusters(cityEvents));
  for (const event of vague) {
    const hits = clusters.filter((cluster) => cluster.some((item) => foldText(item.title) === foldText(event.title) && venuesCompatible(event, item)));
    if (hits.length === 1) hits[0].push(event);
  }
  return clusters.filter((group) => group.length > 1);
}

function richness(event) {
  let score = event.status === "published" ? 100 : 0;
  if (text(event.address)) score += 8;
  if (text(event.venue) && !venueGeneric(event)) score += 6;
  if (event.lat != null && event.lng != null) score += 4;
  if (text(event.description)) score += 3;
  if (text(event.imageUrl)) score += 4;
  if (text(event.url)) score += 2;
  score += Math.min(asArray(event.days).length, 20);
  return score;
}

function pickKeeper(events) {
  return [...events].sort((left, right) => richness(right) - richness(left) || text(left.id).localeCompare(text(right.id)))[0];
}

function chooseVenue(current, donor, city) {
  const kept = { venue: current, city };
  const incoming = { venue: donor, city };
  if (!text(current)) return text(donor);
  if (venueGeneric(kept) && text(donor) && !venueGeneric(incoming)) return text(donor);
  const shorter = foldText(current);
  const longer = foldText(donor);
  if (longer.length > shorter.length && shorter.length >= 4 && longer.includes(shorter)) return text(donor);
  return text(current);
}

function completeShow(keeper, donors) {
  const days = [...new Set(
    [keeper, ...donors].flatMap((event) => asArray(event.days).map((day) => String(day).slice(0, 10)))
  )].filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().slice(0, 120);
  const city = cityKey(keeper)
    ? text(keeper.city)
    : (donors.map((event) => (cityKey(event) ? text(event.city) : "")).find(Boolean) || text(keeper.city));
  const next = {
    days,
    city,
    venue: text(keeper.venue),
    address: text(keeper.address),
    time: text(keeper.time),
    price: text(keeper.price),
    description: text(keeper.description),
    url: text(keeper.url),
    source: text(keeper.source),
    lat: keeper.lat == null ? null : Number(keeper.lat),
    lng: keeper.lng == null ? null : Number(keeper.lng),
    free: Boolean(keeper.free),
    imageUrl: text(keeper.imageUrl),
    imagePage: text(keeper.imagePage),
    imageStatus: text(keeper.imageStatus),
    ratingScore: keeper.ratingScore == null ? null : Number(keeper.ratingScore),
    ratingCount: keeper.ratingCount == null ? null : Number(keeper.ratingCount),
    ratingSource: text(keeper.ratingSource),
    ratingNote: text(keeper.ratingNote),
    ratingStatus: text(keeper.ratingStatus),
  };
  for (const donor of donors) {
    next.venue = chooseVenue(next.venue, donor.venue, next.city);
    if (!next.address) next.address = text(donor.address);
    if (!next.time) next.time = text(donor.time);
    if (!next.price) next.price = text(donor.price);
    if (!next.description) next.description = text(donor.description);
    if (!next.url) next.url = text(donor.url);
    if (!next.source) next.source = text(donor.source);
    if ((next.lat == null || next.lng == null) && donor.lat != null && donor.lng != null) {
      next.lat = Number(donor.lat);
      next.lng = Number(donor.lng);
    }
    if (!next.free && donor.free && !next.price) next.free = true;
    if (!next.imageUrl && text(donor.imageUrl)) {
      next.imageUrl = text(donor.imageUrl);
      next.imagePage = text(donor.imagePage);
      next.imageStatus = text(donor.imageStatus);
    }
    if (next.ratingScore == null && donor.ratingScore != null) {
      next.ratingScore = Number(donor.ratingScore);
      next.ratingCount = donor.ratingCount == null ? null : Number(donor.ratingCount);
      next.ratingSource = text(donor.ratingSource);
      next.ratingNote = text(donor.ratingNote);
      next.ratingStatus = text(donor.ratingStatus);
    }
  }
  return next;
}

function matchingShows(shows, event) {
  const hits = shows.filter((item) => item.id !== event.id && sameShow(item, event));
  const cities = new Set(hits.map(cityKey).filter(Boolean));
  if (!cityKey(event) && cities.size > 1) return [];
  return hits;
}

function rowToShow(row) {
  return {
    id: row.id,
    title: row.title || "",
    days: asArray(row.days).map((day) => String(day).slice(0, 10)),
    time: row.time_label || row.time || "",
    category: row.category || "",
    city: row.city || "",
    venue: row.venue || "",
    address: row.address || "",
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    price: row.price || "",
    free: row.free === true || row.free === "t" || row.free === "true" || row.free === 1,
    description: row.description || "",
    source: row.source_name || row.source || "",
    url: row.url || "",
    status: row.status || "draft",
    imageUrl: row.image_url || row.imageUrl || "",
    imagePage: row.image_page || row.imagePage || "",
    imageStatus: row.image_status || row.imageStatus || "",
    ratingScore: row.rating_score == null || row.rating_score === "" ? (row.ratingScore == null ? null : Number(row.ratingScore)) : Number(row.rating_score),
    ratingCount: row.rating_count == null || row.rating_count === "" ? (row.ratingCount == null ? null : Number(row.ratingCount)) : Number(row.rating_count),
    ratingSource: row.rating_source || row.ratingSource || "",
    ratingNote: row.rating_note || row.ratingNote || "",
    ratingStatus: row.rating_status || row.ratingStatus || "",
  };
}

function stableId(event) {
  const raw = `${event.title}-${cityKey(event) || foldText(event.city) || "lieu"}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
  return raw || "evenement";
}

async function writeShow(db, id, next) {
  await db.query(
    `UPDATE events SET
      days = $2::jsonb,
      city = $3,
      venue = $4,
      address = $5,
      lat = $6,
      lng = $7,
      time_label = $8,
      price = $9,
      free = $10,
      description = $11,
      url = $12,
      source_name = CASE WHEN $13 = '' THEN source_name ELSE $13 END,
      image_url = CASE WHEN $14 = '' THEN image_url ELSE $14 END,
      image_page = CASE WHEN $14 = '' THEN image_page ELSE $15 END,
      image_status = CASE WHEN $14 = '' THEN image_status ELSE $16 END,
      rating_score = COALESCE(rating_score, $17),
      rating_count = COALESCE(rating_count, $18),
      rating_source = COALESCE(NULLIF(rating_source, ''), NULLIF($19, '')),
      rating_note = COALESCE(NULLIF(rating_note, ''), NULLIF($20, '')),
      rating_status = COALESCE(NULLIF(rating_status, ''), NULLIF($21, '')),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      id,
      JSON.stringify(next.days),
      next.city,
      next.venue,
      next.address,
      next.lat,
      next.lng,
      next.time,
      next.price,
      next.free,
      next.description,
      next.url,
      next.source,
      next.imageUrl,
      next.imagePage,
      next.imageStatus,
      next.ratingScore,
      next.ratingCount,
      next.ratingSource,
      next.ratingNote,
      next.ratingStatus,
    ]
  );
}

async function regroupDuplicates(db, log = async () => {}) {
  const result = await db.query(
    "SELECT * FROM events WHERE status IN ('draft', 'published') AND category <> 'lecture'"
  );
  const shows = result.rows.map(rowToShow);
  const groups = clusterShows(shows);
  let removed = 0;
  for (const group of groups) {
    const keeper = pickKeeper(group);
    const donors = group.filter((event) => event.id !== keeper.id);
    const next = completeShow(keeper, donors);
    await writeShow(db, keeper.id, next);
    for (const donor of donors) {
      await db.query("UPDATE rating_votes SET event_id = $2 WHERE event_id = $1", [donor.id, keeper.id]);
      await db.query("DELETE FROM events WHERE id = $1", [donor.id]);
      removed += 1;
    }
    await log(`${keeper.title} : ${donors.length} doublon(s), ${next.days.length} date(s).`);
  }
  if (!groups.length) await log("Aucun doublon de sortie.");
  const places = await regroupPlaceDuplicates(db, log);
  const bookings = await regroupBookingDuplicates(db, log);
  return { groups: groups.length, removed, places: places.removed, bookings: bookings.removed };
}

async function regroupPlaceDuplicates(db, log = async () => {}) {
  const places = (await db.query("SELECT * FROM places")).rows.map((row) => ({
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
  }));
  const counts = new Map();
  const linked = await db.query(
    "SELECT place_id, COUNT(*)::int AS total FROM events WHERE place_id IS NOT NULL GROUP BY place_id"
  );
  for (const row of linked.rows) counts.set(row.place_id, Number(row.total));
  const groups = clusterPlaces(places);
  let removed = 0;
  for (const group of groups) {
    const keeper = pickPlace(group, counts);
    const donors = group.filter((place) => place.id !== keeper.id);
    const next = mergedPlace(keeper, donors);
    await db.query(
      `UPDATE places SET
         name = $2, address = $3, lat = $4, lng = $5, hours = $6, website = $7, kind = $8,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [keeper.id, next.name, next.address, next.lat, next.lng, next.hours, next.website, next.kind]
    );
    for (const donor of donors) {
      await db.query(
        "UPDATE events SET place_id = $2, updated_at = CURRENT_TIMESTAMP WHERE place_id = $1",
        [donor.id, keeper.id]
      );
      await db.query(
        "UPDATE booking_links SET target_id = $2 WHERE target_type = 'place' AND target_id = $1",
        [donor.id, keeper.id]
      );
      await db.query("DELETE FROM places WHERE id = $1", [donor.id]);
      removed += 1;
    }
    await log(`${next.name} : ${donors.length} lieu(x) en double retiré(s).`);
  }
  if (!groups.length) await log("Aucun lieu en double.");
  return { groups: groups.length, removed };
}

async function regroupBookingDuplicates(db, log = async () => {}) {
  const links = (await db.query("SELECT * FROM booking_links")).rows;
  const groups = clusterBookings(links);
  let removed = 0;
  for (const group of groups) {
    const keeper = pickBooking(group);
    const donors = group.filter((link) => link.id !== keeper.id);
    for (const donor of donors) {
      await db.query("DELETE FROM booking_links WHERE id = $1", [donor.id]);
      removed += 1;
    }
    await log(`${keeper.name || keeper.url} : ${donors.length} réservation(s) en double retirée(s).`);
  }
  if (!groups.length) await log("Aucune réservation en double.");
  return { groups: groups.length, removed };
}

module.exports = {
  foldText,
  cityKey,
  namesClose,
  clusterPlaces,
  mergedPlace,
  clusterBookings,
  bookingKey,
  titlesMatch,
  sameShow,
  clusterShows,
  pickKeeper,
  completeShow,
  matchingShows,
  rowToShow,
  stableId,
  writeShow,
  regroupDuplicates,
};
