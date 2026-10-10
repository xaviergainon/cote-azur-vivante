const crypto = require("node:crypto");
const { CATEGORY_KEYS, DEFAULT_QUERIES, DEFAULT_LIBRARY_QUERIES, upgradeQueries } = require("./defaults");
const { acceptWebRating, openDates } = require("./ratings");
const { fetchPublicPage, assertPublicHttpUrl } = require("./fetch-page");
const { listMissingImages, summarizeMissing, queueMissing, dedicatedLink, readPosterPages, textMentions, markImagesChecked } = require("./images");
const { deliverScanMail } = require("./mail");
const { geminiKey, geminiModel, cursorKey, cursorModel, llmProvider, mapsKey, getRaw, setRaw } = require("./settings");
const { loadBriefs, fillBrief } = require("./briefs");
const { matchingShows, rowToShow, stableId, completeShow, pickKeeper, writeShow, regroupDuplicates, foldText } = require("./duplicates");
const { acceptTime, listingPage } = require("./showtimes");
const { saveVenue, attachKnownPlaces, saveBookingProposal, geocodeAddress, reverseGeocode, venueIsSpecific, venueTwins, venueFromEvent, ensurePlacePoint, normalizeVenue } = require("./venues");

const TIME_RULE = "Champ time : l'heure de la séance si la source l'écrit, sous la forme 20h30. Sinon time est vide. N'écris pas « selon séances » ni « voir la source ».";

function withTimeRule(instruction) {
  return /20h30/.test(instruction) ? instruction : `${instruction}\n${TIME_RULE}`;
}
const { createCursorSession } = require("./cursor");
const { planPilotSteps, healthSentence, pilotHalted } = require("./pilot");

const CURSOR_GUARD = `N'ouvre aucun dépôt, n'écris aucun fichier, ne crée aucune pull request.
Question indépendante des précédentes.
Ajoute aussi "pages" : jusqu'à 4 URL https de pages d'événements, jamais un lien Google.`;

const BBOX = { latMin: 43.4, latMax: 44.2, lngMin: 6.5, lngMax: 7.8 };
const HORIZON_DAYS = 30;
const active = new Set();
let currentStop = null;

function parisDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftIsoDay(iso, delta) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

function horizon(now = new Date()) {
  const today = parisDay(now);
  return {
    today,
    minDay: shiftIsoDay(today, -1),
    maxDay: shiftIsoDay(today, HORIZON_DAYS),
  };
}

const MAX_SPAN_DAYS = 92;

function parseIsoDay(value) {
  const day = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const [year, month, date] = day.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10);
  return check === day ? day : "";
}

function daySpan(minDay, maxDay) {
  const [y1, m1, d1] = minDay.split("-").map(Number);
  const [y2, m2, d2] = maxDay.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function windowError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function collectionWindow(override = {}) {
  const base = horizon();
  const rawMin = override.minDay;
  const rawMax = override.maxDay;
  const minProvided = rawMin != null && String(rawMin).trim() !== "";
  const maxProvided = rawMax != null && String(rawMax).trim() !== "";
  const minDay = minProvided ? parseIsoDay(rawMin) : base.minDay;
  const maxDay = maxProvided ? parseIsoDay(rawMax) : base.maxDay;
  if (minProvided && !minDay) throw windowError("Date de début invalide.");
  if (maxProvided && !maxDay) throw windowError("Date de fin invalide.");
  if (minDay > maxDay) throw windowError("La date de fin est avant la date de début.");
  if (daySpan(minDay, maxDay) + 1 > MAX_SPAN_DAYS) {
    throw windowError("La fenêtre d’essai est limitée à 92 jours.");
  }
  return {
    today: base.today,
    minDay,
    maxDay,
    custom: minDay !== base.minDay || maxDay !== base.maxDay,
  };
}

function windowDays(bounds) {
  if (bounds.days && bounds.days.size) return [...bounds.days].sort();
  const days = [];
  for (let day = bounds.minDay; day && day <= bounds.maxDay && days.length < 100; day = shiftIsoDay(day, 1)) {
    days.push(day);
  }
  return days;
}

function daysPhrase(days) {
  if (!days.length) return "aucun";
  const contiguous = days.every((day, index) => index === 0 || shiftIsoDay(days[index - 1], 1) === day);
  if (contiguous) return `${days[0]} → ${days[days.length - 1]} (${days.length} jour${days.length > 1 ? "s" : ""})`;
  if (days.length <= 8) return days.join(", ");
  return `${days.length} jours, de ${days[0]} à ${days[days.length - 1]}`;
}

function boundsPhrase(bounds) {
  return daysPhrase(windowDays(bounds));
}

function splitWindow(bounds, scanned) {
  const seen = new Set(scanned);
  const fresh = [];
  const known = [];
  for (const day of windowDays(bounds)) {
    (seen.has(day) ? known : fresh).push(day);
  }
  return { fresh, known };
}

function phaseBounds(bounds, days) {
  return {
    today: bounds.today,
    minDay: days[0],
    maxDay: days[days.length - 1],
    days: new Set(days),
    custom: bounds.custom,
  };
}

function knownLines(known) {
  if (!known.length) return "(aucune sortie connue sur cette source pour ces jours)";
  return known
    .map((event) => `- ${event.id} | ${event.title} | ${(event.days || []).join(",")} | ${event.city}`)
    .join("\n");
}

function eventsForSource(catalog, source, days) {
  const allowed = new Set(days);
  let host = "";
  try {
    host = new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }
  return catalog
    .filter((event) => {
      if (!event.days.some((day) => allowed.has(day))) return false;
      if (event.source && event.source === source.name) return true;
      try {
        return host && new URL(event.url).hostname.replace(/^www\./, "") === host;
      } catch {
        return false;
      }
    });
}

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

function slugId(title, day, time) {
  const raw = `${title}-${day || ""}-${time || ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
  return raw || "evenement";
}

function clip(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function inBox(lat, lng) {
  return lat >= BBOX.latMin && lat <= BBOX.latMax && lng >= BBOX.lngMin && lng <= BBOX.lngMax;
}

function normalizeEvent(raw, source, bounds = collectionWindow()) {
  const title = clip(raw.title, 180);
  if (title.length < 3) return null;
  const { minDay, maxDay } = bounds;
  const allowed = bounds.days;
  const days = asArray(raw.days)
    .map((day) => String(day).slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= minDay && day <= maxDay && (!allowed || allowed.has(day)));
  if (!days.length) return null;
  const lat = raw.lat == null || raw.lat === "" ? null : Number(raw.lat);
  const lng = raw.lng == null || raw.lng === "" ? null : Number(raw.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  if (hasCoords && !inBox(lat, lng)) return null;
  const category = CATEGORY_KEYS.includes(raw.category) ? raw.category : "festival";
  const price = clip(raw.price, 80) || "Voir la source";
  const url = /^https?:\/\//i.test(raw.url || "") ? clip(raw.url, 400) : source.url;
  return {
    id: slugId(title, days[0], raw.time),
    title,
    days,
    time: acceptTime(raw.time),
    category,
    city: clip(raw.city, 80) || "Alpes-Maritimes",
    venue: clip(raw.venue, 140),
    address: clip(raw.address, 180),
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null,
    price,
    free: Boolean(raw.free) || /gratuit/i.test(price),
    description: clip(raw.description, 500),
    source: source.name,
    url,
  };
}

async function appendLog(db, id, line) {
  await db.query(
    `UPDATE agent_runs SET log = log || $2 WHERE id = $1`,
    [id, `${line}\n`]
  );
}

function generationConfig(model, extra = {}) {
  const config = { maxOutputTokens: 8192, ...extra };
  if (/gemini-3/i.test(model || "")) config.thinkingConfig = { thinkingLevel: "LOW" };
  return config;
}

function visibleText(body) {
  return (body.candidates?.[0]?.content?.parts || [])
    .filter((part) => part && !part.thought && part.text)
    .map((part) => part.text)
    .join("");
}

function stopError() {
  const error = new Error("Collecte interrompue.");
  error.name = "AbortError";
  return error;
}

function throwIfStopped() {
  if (currentStop?.controller.signal.aborted) throw currentStop.controller.signal.reason || stopError();
}

function isStop(error) {
  if (currentStop?.controller.signal.aborted && /interrompue|aborted/i.test(error?.message || "")) return true;
  return error?.name === "AbortError" && /interrompue/i.test(error?.message || "");
}

function runSignal() {
  return currentStop?.controller.signal;
}

function sleep(ms, signal = runSignal()) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || stopError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || stopError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let lastGeminiCall = 0;

async function geminiGenerate(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const signal = runSignal();
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    throwIfStopped();
    const gap = lastGeminiCall + 13000 - Date.now();
    if (gap > 0) await sleep(gap);
    lastGeminiCall = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": body.key,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      body: JSON.stringify(body.payload),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok) return json;
    const message = json.error?.message || `Gemini HTTP ${response.status}`;
    lastError = new Error(message);
    const retryable = response.status === 429 || /quota|high demand|rate limit|unavailable/i.test(message);
    if (!retryable || attempt === 3) throw lastError;
    const retry = /retry in ([\d.]+)s/i.exec(message);
    const delay = retry ? Math.ceil(Number(retry[1]) * 1000) + 1000 : 45000;
    await sleep(Math.min(delay, 70000));
  }
  throw lastError;
}

async function askGemini({ key, model, source, text, window = collectionWindow(), task = "discover", known = [], instruction }) {
  const { today } = window;
  const phrase = boundsPhrase(window);
  const review = task === "review";
  const body = await geminiGenerate(model, {
    key,
    payload: {
      systemInstruction: {
        parts: [
          {
            text: instruction || (review
              ? `Tu relis une page déjà parcourue. Réponds uniquement en JSON {"events":[],"missing":[]}. Jours : ${phrase}. events : seulement les sorties nouvelles, absentes de la liste. missing : {"id","reason"} si la page annule ou retire un id de la liste. Dans le doute, missing reste vide. category parmi : ${CATEGORY_KEYS.join(", ")}. N'invente rien.`
              : `Tu extrais des sorties publiques des Alpes-Maritimes et de Monaco. Réponds uniquement en JSON {"events":[...]}. N'invente aucun événement qui n'est pas dans le texte. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD, uniquement ces jours : ${phrase}. Si un événement dure plusieurs jours, ou a commencé avant et continue, liste chaque jour encore ouvert dans ces jours. lat/lng seulement dans les Alpes-Maritimes ou à Monaco, pas en Italie au-delà, sinon null. Si rien n'est exploitable, {"events":[]}.`),
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: review
                ? `Nous sommes le ${today} (Paris). Jours déjà parcourus : ${phrase}.\nDéjà en base :\n${knownLines(known)}\nSource : ${source.name} (${source.url}).\nTexte :\n${text}`
                : `Nous sommes le ${today} (Paris). Jours pas encore parcourus : ${phrase}. Source : ${source.name} (${source.url}).\nTexte :\n${text}`,
            },
          ],
        },
      ],
      generationConfig: generationConfig(model, { responseMimeType: "application/json" }),
    },
  });
  const raw = visibleText(body);
  return {
    events: parseEventsJson(raw),
    urls: groundingUrls(body),
    missing: review ? parseMissing(raw, new Set(known.map((event) => event.id))) : [],
  };
}

function parsePayload(raw) {
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Réponse illisible");
  return JSON.parse(body.slice(start, end + 1));
}

function parseEventsJson(raw) {
  const parsed = parsePayload(raw);
  return Array.isArray(parsed.events) ? parsed.events : [];
}

function parseMissing(raw, allowedIds) {
  let parsed;
  try {
    parsed = parsePayload(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed.missing) ? parsed.missing : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!allowedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, reason: clip(row?.reason, 240) || "Plus annoncé sur la source." });
  }
  return out.slice(0, 40);
}

function pageUrls(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
    return [...new Set(pages.filter((url) => /^https:\/\//i.test(String(url))))].slice(0, 4);
  } catch {
    return [];
  }
}

function groundingUrls(body) {
  const chunks = body.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const urls = [];
  for (const chunk of chunks) {
    const uri = chunk.web?.uri || "";
    if (!/^https:\/\//i.test(uri)) continue;
    if (/google\./i.test(uri) || /gstatic\.com/i.test(uri)) continue;
    urls.push(uri);
  }
  return [...new Set(urls)];
}

async function loadQueries(db) {
  const raw = await getRaw(db, "agent_queries");
  if (!raw) return DEFAULT_QUERIES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return upgradeQueries(parsed).slice(0, 5);
  } catch {
    return DEFAULT_QUERIES;
  }
  return DEFAULT_QUERIES;
}

async function loadLibraryQueries(db) {
  const raw = await getRaw(db, "library_queries");
  if (!raw) return DEFAULT_LIBRARY_QUERIES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((line) => line.trim()).filter(Boolean).slice(0, 5);
  } catch {
    return DEFAULT_LIBRARY_QUERIES;
  }
  return [];
}

async function searchWeb({ key, model, query, window = collectionWindow(), task = "discover", instruction }) {
  const { today } = window;
  const phrase = boundsPhrase(window);
  const review = task === "review";
  const body = await geminiGenerate(model, {
    key,
    payload: {
      systemInstruction: {
        parts: [
          {
            text: instruction || (review
              ? `Tu cherches les sorties nouvelles des Alpes-Maritimes et de Monaco sur des jours déjà parcourus (${phrase}). Réponds uniquement en JSON {"events":[...]}. Ne renvoie que les nouveautés. Ne signale pas d'absence. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD, uniquement ces jours. lat/lng seulement dans les Alpes-Maritimes ou à Monaco, pas en Italie au-delà, sinon null. url : la page de l'événement.`
              : `Tu cherches des sorties publiques à venir dans les Alpes-Maritimes et à Monaco. Réponds uniquement en JSON {"events":[...]}. N'invente pas un événement sans source web. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD, uniquement ces jours : ${phrase}. Couvre tous ces jours, pas seulement la semaine en cours : développe chaque plage en une date par jour. lat/lng seulement dans les Alpes-Maritimes ou à Monaco, pas en Italie au-delà, sinon null. url : la page de l'événement.`),
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{
            text: `Nous sommes le ${today} (Paris). Cherche sur ces jours : ${phrase}. Recherche Google : ${String(query).replace(/cette semaine|prochains jours/gi, phrase)}`,
          }],
        },
      ],
      tools: [{ google_search: {} }],
      generationConfig: generationConfig(model),
    },
  });
  const raw = visibleText(body);
  return { events: parseEventsJson(raw), urls: groundingUrls(body), missing: [] };
}

function sameDocument(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function posterForEvent(page, event, batchSize) {
  const image = page?.image || "";
  if (!image || batchSize !== 1) return "";
  const pageUrl = page.pageUrl || "";
  const eventUrl = event.url || "";
  if (pageUrl && eventUrl && !sameDocument(pageUrl, eventUrl)) return "";
  return image;
}

async function proposeImage(db, id, image, pageUrl) {
  if (!image) return false;
  const result = await db.query(
    `UPDATE events
     SET image_url = $2, image_page = $3, image_status = 'proposed', image_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND (image_status IS NULL OR image_status = '' OR image_status = 'proposed')`,
    [id, image, pageUrl || ""]
  );
  return Boolean(result.rowCount);
}

async function keepEvents(db, found, source, page = {}, bounds = collectionWindow()) {
  let created = 0;
  let updated = 0;
  let kept = 0;
  const ids = [];
  for (const raw of found.slice(0, 40)) {
    const event = normalizeEvent(raw, source, bounds);
    if (!event) continue;
    event.image = posterForEvent(page, event, found.slice(0, 40).length);
    event.imagePage = event.image ? (page.pageUrl || source.url || "") : "";
    const result = await saveEvent(db, event);
    if (result.action === "created") created += 1;
    else if (result.action === "updated") updated += 1;
    ids.push(result.id);
    kept += 1;
  }
  const linked = await attachKnownPlaces(db);
  return { created, updated: updated + linked.attached, kept, ids, attached: linked.attached };
}

async function proposeAbsence(db, id, reason) {
  const result = await db.query(
    `UPDATE events
     SET flag_status = 'missing', flag_note = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status IN ('draft', 'published')`,
    [id, clip(reason, 240) || "Plus annoncé sur la source."]
  );
  return Boolean(result.rowCount);
}

async function loadScannedDays(db) {
  const raw = await getRaw(db, "scanned_days");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day));
    } catch {
      /* La valeur est illisible : on reconstruit depuis les journaux. */
    }
  }
  const runs = await db.query(
    "SELECT log FROM agent_runs WHERE status = 'done' AND log LIKE '%Fenêtre %' ORDER BY started_at DESC NULLS LAST LIMIT 8"
  );
  const days = new Set();
  for (const row of runs.rows) {
    for (const match of String(row.log || "").matchAll(/Fenêtre (\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})/g)) {
      if (match[1] > match[2]) continue;
      for (let day = match[1]; day <= match[2] && days.size < 200; day = shiftIsoDay(day, 1)) days.add(day);
    }
  }
  const list = [...days].sort();
  if (list.length) await setRaw(db, "scanned_days", JSON.stringify(list));
  return list;
}

async function rememberScannedDays(db, already, days, today) {
  const floor = shiftIsoDay(today, -21);
  const merged = new Set([...(already || []), ...days]);
  const kept = [...merged].filter((day) => day >= floor).sort().slice(-120);
  await setRaw(db, "scanned_days", JSON.stringify(kept));
}

async function loadCatalog(db) {
  const result = await db.query(
    "SELECT id, title, days, city, source_name, url FROM events WHERE status IN ('draft', 'published')"
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: clip(row.title, 80),
    days: asArray(row.days).map((day) => String(day).slice(0, 10)),
    city: clip(row.city, 40),
    source: row.source_name || "",
    url: row.url || "",
  }));
}

async function saveEvent(db, event) {
  const catalog = await db.query(
    "SELECT * FROM events WHERE status IN ('draft', 'published') AND category <> 'lecture'"
  );
  const shows = catalog.rows.map(rowToShow);
  const hits = matchingShows(shows, event);
  if (hits.length) {
    const keeper = pickKeeper(hits);
    const next = completeShow(keeper, [event]);
    await writeShow(db, keeper.id, next);
    await proposeImage(db, keeper.id, event.image, event.imagePage);
    return { action: "updated", id: keeper.id };
  }
  let id = stableId(event);
  if (shows.some((item) => item.id === id)) id = `${id}-${crypto.randomBytes(3).toString("hex")}`.slice(0, 96);
  event.id = id;
  await db.query(
    `INSERT INTO events (
      id, title, days, time_label, category, city, venue, address,
      lat, lng, price, free, description, source_name, url, status
    ) VALUES (
      $1, $2, $3::jsonb, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, 'draft'
    )`,
    [
      event.id,
      event.title,
      JSON.stringify(event.days),
      event.time,
      event.category,
      event.city,
      event.venue,
      event.address,
      event.lat,
      event.lng,
      event.price,
      event.free,
      event.description,
      event.source,
      event.url,
    ]
  );
  await proposeImage(db, event.id, event.image, event.imagePage);
  return { action: "created", id: event.id };
}

async function savePlace(db, event) {
  const existing = await db.query("SELECT id, status FROM events WHERE id = $1", [event.id]);
  if (!existing.rows.length) {
    await db.query(
      `INSERT INTO events (
        id, title, days, time_label, category, city, venue, address,
        lat, lng, price, free, description, source_name, url, status
      ) VALUES (
        $1, $2, $3::jsonb, $4, 'lecture', $5, $6, $7,
        $8, $9, $10, TRUE, $11, $12, $13, 'draft'
      )`,
      [
        event.id, event.title, JSON.stringify(event.days), event.time, event.city,
        event.venue, event.address, event.lat, event.lng, event.price,
        event.description, event.source, event.url,
      ]
    );
    await proposeImage(db, event.id, event.image, event.imagePage);
    return "created";
  }
  await db.query(
    `UPDATE events SET
      days = $2::jsonb,
      time_label = $3,
      venue = CASE WHEN $4 = '' THEN venue ELSE $4 END,
      address = CASE WHEN $5 = '' THEN address ELSE $5 END,
      lat = COALESCE($6, lat),
      lng = COALESCE($7, lng),
      description = CASE WHEN $8 = '' THEN description ELSE $8 END,
      url = CASE WHEN $9 = '' THEN url ELSE $9 END,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND category = 'lecture'`,
    [
      event.id, JSON.stringify(event.days), event.time, event.venue, event.address,
      event.lat, event.lng, event.description, event.url,
    ]
  );
  await proposeImage(db, event.id, event.image, event.imagePage);
  return "updated";
}

function normalizePlace(raw, source, bounds) {
  const title = clip(raw.title, 180);
  const city = clip(raw.city, 80);
  if (title.length < 3 || city.length < 2 || city === "Alpes-Maritimes") return null;
  const start = bounds.today > bounds.minDay ? bounds.today : bounds.minDay;
  const days = openDates(raw.weekdays, start, bounds.maxDay);
  if (!days.length) return null;
  const lat = raw.lat == null || raw.lat === "" ? null : Number(raw.lat);
  const lng = raw.lng == null || raw.lng === "" ? null : Number(raw.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  if (hasCoords && !inBox(lat, lng)) return null;
  const url = /^https?:\/\//i.test(raw.url || "") ? clip(raw.url, 400) : clip(source.url, 400);
  return {
    id: slugId(`lecture ${title}`, city, "lieu"),
    title,
    days,
    time: clip(raw.hours || raw.time, 40) || "Selon les horaires",
    category: "lecture",
    city,
    venue: clip(raw.venue, 140) || title,
    address: clip(raw.address, 180),
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null,
    price: "Entrée libre",
    free: true,
    description: clip(raw.description, 500),
    source: source.name,
    url,
    image: "",
    imagePage: "",
  };
}

async function askModel({ provider, cursor, key, model, instruction, question, search = false, waitMs = 180000 }) {
  if (provider === "cursor") {
    if (!cursor) throw new Error("Session Cursor absente.");
    const searchLine = search
      ? "Cherche sur le web public, pas dans un dépôt. N'écris aucun fichier et ne crée aucune pull request. Réponds seulement par le JSON demandé."
      : "N'ouvre aucun dépôt et n'écris aucun fichier.";
    return parsePayload(await cursor.reply(`${instruction}\n${question}\n${searchLine}`, waitMs));
  }
  const payload = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
    generationConfig: generationConfig(model, search ? {} : { responseMimeType: "application/json" }),
  };
  if (search) payload.tools = [{ google_search: {} }];
  const body = await geminiGenerate(model, { key, payload });
  return parsePayload(visibleText(body));
}

async function rememberPlace(db, raw, source, bounds, tally) {
  const place = normalizePlace(raw, source, bounds);
  if (!place) return;
  const result = await savePlace(db, place);
  if (result === "created") tally.created += 1;
  else tally.updated += 1;
  tally.places.push(place);
}

async function collectLibraries(db, runId, bounds, model) {
  const sources = await db.query(
    "SELECT name, url FROM sources WHERE enabled = TRUE AND kind = 'library' ORDER BY name ASC"
  );
  const queries = await loadLibraryQueries(db);
  await appendLog(
    db,
    runId,
    `Bibliothèques et médiathèques, à part de la collecte du jour. Ouverture du ${bounds.today} au ${bounds.maxDay}. ${sources.rows.length} page(s), ${queries.length} recherche(s).`
  );
  const briefs = await loadBriefs(db);
  const instruction = fillBrief(briefs.libraries, {
    jours: `${bounds.today} au ${bounds.maxDay}`,
    categories: CATEGORY_KEYS.join(", "),
    aujourdhui: bounds.today,
  });
  const tally = { created: 0, updated: 0, places: [] };
  for (const query of queries) {
    throwIfStopped();
    await appendLog(db, runId, `Recherche : ${query}`);
    try {
      const found = await askModel({
        ...model,
        instruction,
        question: `Nous sommes le ${bounds.today} (Paris). Recherche : ${query}`,
        search: true,
      });
      const places = Array.isArray(found.places) ? found.places : [];
      for (const place of places.slice(0, 20)) await rememberPlace(db, place, { name: "Recherche bibliothèques", url: "" }, bounds, tally);
      await appendLog(db, runId, `Recherche : ${places.length} lieu(x) lu(s).`);
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, `Recherche « ${query} » : ${error.message}`);
    }
  }
  for (const source of sources.rows) {
    throwIfStopped();
    await appendLog(db, runId, `Lecture de ${source.name}…`);
    try {
      const page = await fetchPublicPage(source.url, runSignal());
      const found = await askModel({
        ...model,
        instruction,
        question: `Nous sommes le ${bounds.today} (Paris). Source : ${source.name} (${source.url}).\nTexte :\n${page.text}`,
      });
      const places = Array.isArray(found.places) ? found.places : [];
      const before = tally.places.length;
      for (const place of places.slice(0, 20)) await rememberPlace(db, place, source, bounds, tally);
      const own = tally.places.slice(before).filter((place) => place.url && place.url === (page.pageUrl || source.url));
      if (own.length === 1 && page.image) {
        own[0].image = page.image;
        own[0].imagePage = page.pageUrl || source.url;
        await proposeImage(db, own[0].id, page.image, own[0].imagePage);
      }
      await appendLog(db, runId, `${source.name} : ${places.length} lieu(x) lu(s).`);
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, `${source.name} : ${error.message}`);
    }
  }
  const seen = new Map();
  for (const place of tally.places) {
    if (!place.url) continue;
    seen.set(place.url, (seen.get(place.url) || 0) + 1);
  }
  let photos = 0;
  const tried = new Set();
  for (const place of tally.places) {
    throwIfStopped();
    if (!place.url || seen.get(place.url) !== 1 || tried.has(place.url) || place.image) continue;
    if (tried.size >= 20) break;
    tried.add(place.url);
    try {
      const page = await fetchPublicPage(place.url, runSignal());
      if (page.image && await proposeImage(db, place.id, page.image, page.pageUrl || place.url)) photos += 1;
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, `${place.title} : ${error.message}`);
    }
  }
  await appendLog(db, runId, `${photos} affiche(s) proposée(s). Rien n’est publié sans toi.`);
  return tally;
}

async function collectRatings(db, runId, model) {
  const hints = await db.query(
    "SELECT name, url FROM sources WHERE enabled = TRUE AND kind = 'reviews' ORDER BY name ASC"
  );
  const hintText = hints.rows.map((source) => `${source.name} : ${source.url}`).join("\n");
  const today = parisDay();
  const horizon = shiftIsoDay(today, 30);
  const targets = await db.query(
    `SELECT id, title, venue, city, url, category
     FROM events
     WHERE status IN ('draft', 'published')
       AND category <> 'lecture'
       AND (
         rating_checked_at IS NULL
         OR rating_status IS DISTINCT FROM 'kept'
         OR rating_checked_at < CURRENT_TIMESTAMP - INTERVAL '25 days'
       )
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(days) AS day
         WHERE day >= $1 AND day <= $2
       )
     ORDER BY rating_checked_at ASC NULLS FIRST
     LIMIT 12`,
    [today, horizon]
  );
  await appendLog(
    db,
    runId,
    `Avis, à part de la collecte. ${targets.rows.length} sortie(s) à regarder. La moyenne de la salle sur 5 est gardée dès qu’une page la donne, même avec un seul avis.`
  );
  const briefs = await loadBriefs(db);
  const instruction = fillBrief(briefs.ratings, {
    jours: "",
    categories: CATEGORY_KEYS.join(", "),
    aujourdhui: "",
  });
  let kept = 0;
  let cleared = 0;
  let skipped = 0;
  for (const event of targets.rows) {
    throwIfStopped();
    try {
      const found = await askModel({
        ...model,
        instruction,
        search: true,
        question: `Salle : ${event.venue || "inconnue"}. Commune : ${event.city || "inconnue"}. Spectacle : ${event.title}. Page : ${event.url || "inconnue"}.
Cherche d’abord la moyenne publique de cette salle, dans cette commune. Un seul avis suffit. Si le spectacle a la sienne, prends-la. Si la commune n’est pas la bonne, samePlace=false.
${hintText ? `Pages d’avis possibles, sans t’y limiter :\n${hintText}` : "Cherche sur Google et les sites d’avis publics."}`,
      });
      const judgment = acceptWebRating(found);
      if (judgment.action === "keep") {
        await db.query(
          `UPDATE events
           SET rating_score = $2, rating_count = $3, rating_source = $4, rating_note = $5,
               rating_status = 'kept', rating_checked_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [event.id, judgment.score, judgment.count, judgment.source, judgment.reason]
        );
        kept += 1;
        await appendLog(db, runId, `${event.title} : ${judgment.score}/5, ${judgment.count} avis, ${judgment.source}.`);
      } else if (judgment.action === "clear") {
        await db.query(
          `UPDATE events
           SET rating_score = NULL, rating_count = NULL, rating_source = NULL, rating_note = $2,
               rating_status = 'discarded', rating_checked_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [event.id, judgment.reason]
        );
        cleared += 1;
        await appendLog(db, runId, `${event.title} : écarté, ${judgment.reason}`);
      } else {
        await db.query(
          "UPDATE events SET rating_checked_at = CURRENT_TIMESTAMP, rating_note = $2 WHERE id = $1",
          [event.id, judgment.reason]
        );
        skipped += 1;
        await appendLog(db, runId, `${event.title} : pas de note, ${judgment.reason}`);
      }
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, `${event.title} : ${error.message}`);
    }
  }
  return { created: kept, updated: skipped + cleared, kept, cleared, skipped };
}

function posterPageUrl(value, listingUrl) {
  const raw = String(value || "").trim();
  if (!/^https:\/\//i.test(raw)) return "";
  if (/google\.|gstatic|facebook\.com|instagram\.com|wikipedia\.org|youtube\.com|youtu\.be/i.test(raw)) return "";
  if (listingUrl && sameDocument(raw, listingUrl)) return "";
  return raw.slice(0, 400);
}

async function proposePagePoster(db, runId, event, pageUrl) {
  const page = await fetchPublicPage(pageUrl, runSignal());
  if (!page.image || !textMentions(page.text, event.title)) {
    await appendLog(db, runId, `${event.title} : pas d’affiche sur la page du spectacle.`);
    return 0;
  }
  const proposed = await proposeImage(db, event.id, page.image, page.pageUrl || pageUrl);
  if (!proposed) return 0;
  await appendLog(db, runId, `${event.title} : affiche proposée.`);
  return 1;
}

async function completeMissingImages(db, runId, loadModel) {
  const summary = summarizeMissing(await listMissingImages(db));
  const queue = queueMissing(summary);
  const batch = queue.slice(0, 80);
  await appendLog(
    db,
    runId,
    `Sans affiche : ${summary.missing} (brouillons et publiés). Page propre : ${summary.uniquePages}. Agenda partagé : ${summary.sharedEvents}. Sans lien : ${summary.noUrl}. Ce passage en ouvre ${batch.length}, dont ${batch.filter((item) => item.shared).length} agenda(s) partagé(s).`
  );
  if (queue.length > batch.length) {
    await appendLog(db, runId, `${queue.length - batch.length} sortie(s) restent pour le prochain passage. Chaque lancement reprend les plus anciennes, et d’abord celles jamais ouvertes.`);
  }
  const pages = new Map();
  const loadPage = (url) => {
    if (!pages.has(url)) pages.set(url, fetchPublicPage(url, runSignal()));
    return pages.get(url);
  };
  let found = 0;
  const pending = [];
  const remember = async (item) => {
    await markImagesChecked(db, [item.event.id]);
  };
  for (const item of batch) {
    throwIfStopped();
    try {
      if (!item.shared) {
        const page = await fetchPublicPage(item.url, runSignal());
        if (!page.image) {
          await appendLog(db, runId, `${item.event.title} : pas d’affiche sur sa page.`);
        } else if (await proposeImage(db, item.event.id, page.image, page.pageUrl || item.url)) {
          found += 1;
          await appendLog(db, runId, `${item.event.title} : affiche proposée.`);
        }
        await remember(item);
      } else {
        const listing = await loadPage(item.url);
        const link = dedicatedLink(listing.links, item.event.title, listing.pageUrl || item.url);
        if (link) {
          found += await proposePagePoster(db, runId, item.event, link);
          await remember(item);
        } else {
          pending.push(item);
        }
      }
    } catch (error) {
      if (isStop(error)) throw error;
      const blocked = /quota|rate limit|high demand|clé .+absente|active run/i.test(error.message);
      await appendLog(db, runId, `${item.event.title} : ${error.message}`);
      if (blocked) {
        if (/quota|rate limit|high demand/i.test(error.message)) {
          await appendLog(db, runId, "Quota atteint. Les affiches restantes reprennent au prochain passage.");
        }
        break;
      }
      await remember(item);
    }
    await sleep(300);
  }
  const searchBatch = 8;
  const searchPasses = 3;
  const toSearch = pending.slice(0, searchBatch * searchPasses);
  if (pending.length > toSearch.length) {
    await appendLog(db, runId, `${pending.length - toSearch.length} page(s) de spectacle restent pour le prochain passage. Ce passage en cherche ${toSearch.length}, par groupes de ${searchBatch}.`);
  } else if (toSearch.length) {
    await appendLog(db, runId, `Recherche de ${toSearch.length} page(s) de spectacle, par groupes de ${searchBatch}.`);
  }
  for (let offset = 0; offset < toSearch.length; offset += searchBatch) {
    throwIfStopped();
    const group = toSearch.slice(offset, offset + searchBatch);
    let model = null;
    try {
      model = await loadModel();
      const lines = group.map((item) => {
        const where = [item.event.venue, item.event.city].filter(Boolean).join(", ");
        return `id=${item.event.id} | ${item.event.title} | ${where || "lieu non précisé"}`;
      }).join("\n");
      const answer = await askModel({
        ...model,
        search: true,
        waitMs: 240000,
        instruction: "Tu cherches la page de chaque sortie, dans les Alpes-Maritimes ou à Monaco. Réponds uniquement en JSON {\"pages\":[{\"id\":\"\",\"url\":\"\"}]}. Une entrée par id, l'id recopié tel quel. url est une page https qui présente ce spectacle seul, dans cette salle. Pas un agenda qui liste plusieurs sorties, pas Google, pas Facebook, pas Instagram. Si tu n'es pas sûr, url est vide.",
        question: lines,
      });
      const pagesFound = readPosterPages(answer);
      if (!pagesFound) throw new Error("Réponse illisible");
      for (const item of group) {
        throwIfStopped();
        try {
          const pageUrl = posterPageUrl(pagesFound.get(item.event.id), item.url);
          if (!pageUrl) {
            await appendLog(db, runId, `${item.event.title} : pas de page propre au spectacle.`);
          } else {
            found += await proposePagePoster(db, runId, item.event, pageUrl);
          }
          await remember(item);
        } catch (error) {
          if (isStop(error)) throw error;
          await appendLog(db, runId, `${item.event.title} : ${error.message}`);
          if (/quota|rate limit|high demand|clé .+absente|active run/i.test(error.message)) throw error;
          await remember(item);
        }
      }
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, error.message);
      const blocked = /quota|rate limit|high demand|clé .+absente|active run|illisible|dépassé/i.test(error.message);
      if (blocked) {
        await appendLog(db, runId, "Les pages de spectacle encore à chercher reprennent au prochain passage.");
        break;
      }
      for (const item of group) await remember(item);
    } finally {
      if (model?.cursor) await model.cursor.close();
    }
  }
  return found;
}

function quotaStop(error) {
  return /quota|rate limit|high demand/i.test(error.message || "");
}

function blankText(value) {
  return !String(value || "").trim();
}

async function stampDetail(db, id) {
  await db.query("UPDATE events SET detail_checked_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
}

async function completeMissingDetails(db, runId, loadModel, maps) {
  const today = parisDay();
  const horizon = shiftIsoDay(today, 30);
  const result = await db.query(
    `SELECT events.*,
            EXISTS (
              SELECT 1 FROM booking_links
              WHERE status IN ('proposed', 'approved')
                AND ((target_type = 'event' AND target_id = events.id)
                  OR (target_type = 'place' AND events.place_id IS NOT NULL AND target_id = events.place_id))
            ) AS has_booking
     FROM events
     WHERE status IN ('draft', 'published')
       AND (detail_checked_at IS NULL OR detail_checked_at < CURRENT_TIMESTAMP - INTERVAL '14 days')
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(days) AS day
         WHERE day >= $1 AND day <= $2
       )
     ORDER BY detail_checked_at ASC NULLS FIRST, updated_at ASC
     LIMIT 80`,
    [today, horizon]
  );
  const queue = result.rows.filter((event) => {
    const noAddress = blankText(event.address);
    const noPoint = event.lat == null || event.lng == null;
    const noPlace = venueIsSpecific(event.venue, event.city) && !event.place_id;
    const noBooking = event.has_booking !== true && event.has_booking !== "t";
    return noAddress || noPoint || noPlace || noBooking;
  }).slice(0, 8);
  await appendLog(db, runId, queue.length
    ? `${queue.length} fiche(s) incomplète(s), les plus anciennes d’abord. Une vérification tient 14 jours.`
    : "Aucune fiche incomplète à revoir. Celles vérifiées depuis moins de 14 jours attendent.");
  const places = (await db.query("SELECT * FROM places")).rows;
  let created = 0;
  let updated = 0;
  let geocode = maps || "";
  for (const event of queue) {
    throwIfStopped();
    const notes = [];
    try {
      const twins = venueTwins(event, places);
      if (!event.place_id && twins.length === 1 && twins[0].status === "published") {
        const place = twins[0];
        await db.query(
          `UPDATE events SET
             place_id = $2,
             address = CASE WHEN COALESCE(BTRIM(address), '') = '' THEN $3 ELSE address END,
             lat = COALESCE(lat, $4),
             lng = COALESCE(lng, $5),
             city = CASE WHEN city = '' OR city = 'Alpes-Maritimes' THEN $6 ELSE city END,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND place_id IS NULL`,
          [event.id, place.id, place.address || "", place.lat, place.lng, place.city]
        );
        event.place_id = place.id;
        if (blankText(event.address) && place.address) event.address = place.address;
        if (event.lat == null && place.lat != null) event.lat = place.lat;
        if (event.lng == null && place.lng != null) event.lng = place.lng;
        notes.push(`lieu déjà validé, ${place.name}`);
        updated += 1;
      } else if (!event.place_id && twins.length === 1) {
        notes.push(`lieu déjà en brouillon, ${twins[0].name}`);
      } else if (twins.length > 1) {
        notes.push("plusieurs lieux proches, aucun n'est proposé");
      }
      if (geocode && blankText(event.address) && event.lat != null && event.lng != null) {
        try {
          const street = await reverseGeocode(geocode, event.lat, event.lng);
          if (street) {
            await db.query(
              `UPDATE events SET address = $2, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1 AND COALESCE(BTRIM(address), '') = ''`,
              [event.id, street]
            );
            event.address = street;
            notes.push(`adresse ${street}`);
            updated += 1;
          }
        } catch (error) {
          if (error.code !== "REQUEST_DENIED" && error.code !== "OVER_QUERY_LIMIT") throw error;
          geocode = "";
        }
      } else if (geocode && !blankText(event.address) && (event.lat == null || event.lng == null)) {
        try {
          const point = await geocodeAddress(geocode, event.address, event.city);
          if (point) {
            await db.query(
              `UPDATE events SET lat = COALESCE(lat, $2), lng = COALESCE(lng, $3), updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [event.id, point.lat, point.lng]
            );
            event.lat = point.lat;
            event.lng = point.lng;
            notes.push("point");
            updated += 1;
          }
        } catch (error) {
          if (error.code !== "REQUEST_DENIED" && error.code !== "OVER_QUERY_LIMIT") throw error;
          geocode = "";
        }
      }
      const askPlace = venueIsSpecific(event.venue, event.city) && !event.place_id && twins.length === 0;
      const askBooking = event.has_booking !== true && event.has_booking !== "t";
      if (askPlace || askBooking) {
        const model = await loadModel();
        try {
          const known = places
            .filter((place) => foldText(place.city) === foldText(event.city))
            .map((place) => place.name)
            .slice(0, 24);
          const where = [event.venue, event.city, event.address].filter((part) => !blankText(part)).join(", ");
          const answer = await askModel({
            ...model,
            search: true,
            waitMs: 240000,
            instruction: "Tu complètes UNE sortie des Alpes-Maritimes ou de Monaco. Réponds uniquement en JSON {\"place\":null,\"booking\":null}. place, seulement s'il est demandé : {\"name\",\"city\",\"address\",\"lat\",\"lng\",\"website\",\"kind\"}. kind parmi theatre, cinema, music, museum, other. name est le bâtiment, pas le spectacle. Pas un lieu déjà cité. lat/lng dans les Alpes-Maritimes ou à Monaco, sinon null. booking, seulement s'il est demandé : {\"name\",\"url\"}. url est la page https qui vend le billet de cette sortie. Pas Google, pas Facebook, pas Instagram. Si tu n'es pas sûr, laisse null.",
            question: `Titre : ${event.title}\nLieu écrit : ${where || "non précisé"}\nPage : ${event.url || "aucune"}\n${askPlace ? "Cherche le lieu." : "Ne cherche pas le lieu : place reste null."}\n${askBooking ? "Cherche le lien de réservation de cette sortie." : "Ne cherche pas de billet : booking reste null."}\nLieux déjà connus dans cette commune : ${known.join(" ; ") || "aucun"}.`,
          });
          const rawPlace = answer?.place && typeof answer.place === "object" ? answer.place : {};
          const rawBooking = answer?.booking && typeof answer.booking === "object" ? answer.booking : null;
          if (askPlace) {
            let venue = venueFromEvent(event, rawPlace);
            if (venue) venue = await ensurePlacePoint(venue, geocode);
            const same = venue ? venueTwins({ venue: venue.name, city: venue.city }, places) : [];
            if (venue && same.length === 0) {
              const saved = await saveVenue(db, venue);
              if (saved.action === "created") {
                created += 1;
                places.push({ ...venue, status: "draft" });
                const point = venue.lat != null && venue.lng != null ? `, latitude ${venue.lat}, longitude ${venue.lng}` : "";
                notes.push(`lieu proposé, ${saved.name}${point}`);
              }
              if (blankText(event.address) && venue.address) {
                await db.query(
                  `UPDATE events SET address = $2, updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1 AND COALESCE(BTRIM(address), '') = ''`,
                  [event.id, venue.address]
                );
                event.address = venue.address;
                notes.push(`adresse ${venue.address}`);
                updated += 1;
              }
              if ((event.lat == null || event.lng == null) && venue.lat != null && venue.lng != null) {
                await db.query(
                  `UPDATE events SET lat = COALESCE(lat, $2), lng = COALESCE(lng, $3), updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1`,
                  [event.id, venue.lat, venue.lng]
                );
                notes.push("point");
                updated += 1;
              }
            } else if (same.length === 1 && same[0].status === "published" && !event.place_id) {
              notes.push(`lieu déjà validé, ${same[0].name}`);
            } else if (same.length) {
              notes.push("lieu déjà proposé");
            }
          }
          if (askBooking && rawBooking?.url) {
            const saved = await saveBookingProposal(db, {
              url: rawBooking.url,
              name: rawBooking.name,
              targetType: "event",
              targetId: event.id,
              note: event.title,
            });
            if (saved.action === "created") {
              created += 1;
              notes.push(`réservation proposée, ${saved.name}`);
            }
          }
        } finally {
          if (model?.cursor) await model.cursor.close();
        }
      }
      if (!notes.length) notes.push("rien de plus pour l'instant");
      await appendLog(db, runId, `${event.title} : ${notes.join(". ")}.`);
      await stampDetail(db, event.id);
    } catch (error) {
      if (isStop(error)) throw error;
      if (error.code === "REQUEST_DENIED" || error.code === "OVER_QUERY_LIMIT") {
        geocode = "";
        await appendLog(db, runId, "Géocodage indisponible. Les adresses restantes reprennent au prochain passage.");
        break;
      }
      await appendLog(db, runId, `${event.title} : ${error.message}`);
      const blocked = /quota|rate limit|high demand|clé .+absente|active run|illisible|dépassé/i.test(error.message);
      if (blocked) {
        await appendLog(db, runId, "Les fiches restantes reprennent au prochain passage.");
        break;
      }
      await stampDetail(db, event.id);
    }
  }
  return { created, updated };
}

async function collectVenues(db, runId, model, maps = "") {
  const briefs = await loadBriefs(db);
  const queries = [
    "théâtres et salles de spectacle des Alpes-Maritimes et de Monaco, adresse, horaires, site",
    "cinémas, musées et scènes musicales à Nice, Cannes, Antibes, Grasse, Menton et Monaco",
  ];
  let created = 0;
  let updated = 0;
  for (const query of queries) {
    throwIfStopped();
    if (created >= 12) break;
    await appendLog(db, runId, `Recherche : ${query}`);
    try {
      const found = await askModel({
        ...model,
        instruction: briefs.venues,
        question: `Recherche : ${query}`,
        search: true,
      });
      const places = Array.isArray(found.places) ? found.places : [];
      for (const raw of places) {
        if (created >= 12) break;
        let venue = normalizeVenue(raw);
        if (venue && maps) {
          try {
            venue = await ensurePlacePoint(venue, maps);
          } catch (error) {
            if (error.code !== "REQUEST_DENIED" && error.code !== "OVER_QUERY_LIMIT") throw error;
            maps = "";
          }
        }
        const saved = await saveVenue(db, venue || raw);
        if (saved.action === "created") {
          created += 1;
          await appendLog(db, runId, `${saved.name} : brouillon.`);
        } else if (saved.action === "updated") {
          updated += 1;
        }
      }
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, error.message);
      if (quotaStop(error)) {
        await appendLog(db, runId, "Quota Gemini atteint. Les lieux restants reprennent au prochain passage.");
        break;
      }
    }
  }
  const linked = await attachKnownPlaces(db);
  if (linked.attached) await appendLog(db, runId, `${linked.attached} sortie(s) rattachée(s) à un lieu déjà validé.`);
  return { created, updated: updated + linked.attached };
}

async function collectBookings(db, runId, model) {
  const briefs = await loadBriefs(db);
  const today = parisDay();
  const places = await db.query(
    `SELECT id, name, city, website FROM places
     WHERE status = 'published'
       AND NOT EXISTS (
         SELECT 1 FROM booking_links
         WHERE target_type = 'place' AND target_id = places.id AND status IN ('proposed', 'approved')
       )
     ORDER BY name ASC
     LIMIT 6`
  );
  const events = await db.query(
    `SELECT id, title, venue, city, url FROM events
     WHERE status IN ('draft', 'published')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(days) AS day WHERE day >= $1)
       AND NOT EXISTS (
         SELECT 1 FROM booking_links
         WHERE status IN ('proposed', 'approved')
           AND ((target_type = 'event' AND target_id = events.id)
             OR (target_type = 'place' AND events.place_id IS NOT NULL AND target_id = events.place_id))
       )
     ORDER BY updated_at DESC
     LIMIT 6`,
    [today]
  );
  const targets = [
    ...places.rows.map((place) => ({
      type: "place",
      id: place.id,
      label: `${place.name}, ${place.city}`,
      site: place.website || "",
    })),
    ...events.rows.map((event) => ({
      type: "event",
      id: event.id,
      label: `${event.title}, ${[event.venue, event.city].filter(Boolean).join(", ")}`,
      site: event.url || "",
    })),
  ];
  let created = 0;
  for (const target of targets) {
    throwIfStopped();
    try {
      const found = await askModel({
        ...model,
        instruction: briefs.bookings,
        question: `Trouve la page de réservation pour : ${target.label}. Page connue : ${target.site || "aucune"}.`,
        search: true,
      });
      const saved = await saveBookingProposal(db, {
        url: found.url,
        name: found.name,
        targetType: target.type,
        targetId: target.id,
        note: found.reason,
      });
      if (saved.action === "created") {
        created += 1;
        await appendLog(db, runId, `${target.label} : ${saved.name} proposée.`);
      } else {
        await appendLog(db, runId, `${target.label} : pas de billetterie retenue.`);
      }
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, `${target.label} : ${error.message}`);
      if (quotaStop(error)) {
        await appendLog(db, runId, "Quota Gemini atteint. Les réservations restantes reprennent au prochain passage.");
        break;
      }
    }
  }
  return { created, updated: 0 };
}

async function askForTime(model, event, instruction) {
  const where = [event.venue, event.city].filter(Boolean).join(", ");
  const question = `Titre : ${event.title}\nLieu : ${where || "non précisé"}\nJours : ${(event.days || []).join(", ")}\nPage connue : ${event.url || "aucune"}`;
  return askModel({ ...model, instruction, question, search: true });
}

async function completeMissingTimes(db, runId, model, limit) {
  const today = parisDay();
  const horizon = shiftIsoDay(today, 30);
  const result = await db.query(
    `SELECT * FROM events
     WHERE status IN ('draft', 'published') AND category <> 'lecture'
     ORDER BY time_checked_at ASC NULLS FIRST, updated_at ASC
     LIMIT 200`
  );
  const queue = result.rows
    .map((row) => ({
      row,
      days: asArray(row.days).map((day) => String(day).slice(0, 10)).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)),
    }))
    .filter(({ row, days }) => days.some((day) => day >= today && day <= horizon) && !acceptTime(row.time_label))
    .sort((left, right) => {
      const nextLeft = left.days.find((day) => day >= today) || "9999";
      const nextRight = right.days.find((day) => day >= today) || "9999";
      return nextLeft.localeCompare(nextRight);
    })
    .slice(0, limit);
  const briefs = await loadBriefs(db);
  let filled = 0;
  for (const item of queue) {
    throwIfStopped();
    const event = rowToShow(item.row);
    event.days = item.days.filter((day) => day >= today && day <= horizon).slice(0, 6);
    try {
      const found = await askForTime(model, event, briefs.times);
      const time = acceptTime(found?.time);
      const page = /^https:\/\//i.test(found?.url || "") && !/google\.|gstatic\.com/i.test(found.url) ? clip(found.url, 400) : "";
      if (time) {
        await db.query(
          `UPDATE events
           SET time_label = $2,
               url = CASE WHEN $3 = '' THEN url ELSE $3 END,
               time_checked_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [event.id, time, listingPage(event.url) ? page : ""]
        );
        filled += 1;
        await appendLog(db, runId, `${event.title} : ${time}.`);
      } else {
        await db.query("UPDATE events SET time_checked_at = CURRENT_TIMESTAMP WHERE id = $1", [event.id]);
        await appendLog(db, runId, `${event.title} : horaire non trouvé.`);
      }
    } catch (error) {
      if (isStop(error)) throw error;
      const quota = /quota|rate limit|high demand/i.test(error.message);
      if (!quota) await db.query("UPDATE events SET time_checked_at = CURRENT_TIMESTAMP WHERE id = $1", [event.id]);
      await appendLog(db, runId, `${event.title} : ${error.message}`);
      if (quota) {
        const engine = model.provider === "cursor" ? "Cursor" : "Gemini";
        await appendLog(db, runId, `Quota ${engine} atteint. Les horaires restants reprennent au prochain passage.`);
        break;
      }
    }
  }
  if (!queue.length) await appendLog(db, runId, "Aucun horaire manquant dans les 30 jours.");
  return filled;
}

async function executeRun(ctx, runId, bounds = collectionWindow()) {
  const { db, secret } = ctx;
  let created = 0;
  let updated = 0;
  let cursor = null;
  let stopped = false;
  let reportAs = "";
  try {
    throwIfStopped();
    await db.query(
      `UPDATE agent_runs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runId]
    );
    const provider = await llmProvider(db);
    const engineLabel = async () => {
      if (provider === "cursor") return `Cursor ${(await cursorModel(db)) || "Auto"}`;
      return await geminiModel(db);
    };
    const run = await db.query("SELECT trigger_name FROM agent_runs WHERE id = $1", [runId]);
    const triggerNames = {
      schedule: "planifié, sorties",
      library: "planifié, bibliothèques",
      ratings: "planifié, avis",
      images: "planifié, affiches",
      times: "planifié, horaires",
      duplicates: "planifié, doublons",
      venues: "planifié, lieux",
      bookings: "planifié, réservations",
      details: "planifié, fiches",
    };
    const triggerName = run.rows[0]?.trigger_name;
    const session = bounds.task === "pilot";
    const steps = session
      ? (Array.isArray(bounds.pilotSteps) ? bounds.pilotSteps : [])
      : [{ task: bounds.task }];
    if (session) {
      await appendLog(db, runId, bounds.pilotHealth || "Pilote. Je regarde la santé des sorties.");
      await appendLog(db, runId, `Pilote. Moteur : ${await engineLabel()}.`);
      const names = steps.map((step) => step.label).filter(Boolean);
      await appendLog(
        db,
        runId,
        names.length
          ? `Pilote. J’utilise : ${names.join(", ")}.`
          : "Pilote. Rien à reprendre. Les brouillons et les propositions attendent une validation."
      );
    }
    const doneLabels = [];
    const failedLabels = [];
    for (const step of steps) {
      if (session) bounds.task = step.task;
      const trigger = session
        ? `piloté, ${step.label || "santé"}`
        : (triggerNames[triggerName] || "manuel");
      if (session && step.label) {
        const waiting = Number(step.waiting || 0);
        await appendLog(db, runId, `Pilote. ${step.label}${waiting > 0 ? `, ${waiting} en attente` : ""}.`);
      }
      const startedCreated = created;
      const startedUpdated = updated;
      const ended = async (line, counts) => {
        await appendLog(db, runId, line);
        if (!session) {
          await db.query(
            `UPDATE agent_runs
             SET status = 'done', created_count = $2, updated_count = $3, finished_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [runId, counts ? Number(counts.created || 0) : created, counts ? Number(counts.updated || 0) : updated]
          );
          return true;
        }
        if (counts) {
          created += Number(counts.created || 0);
          updated += Number(counts.updated || 0);
        }
        doneLabels.push(step.label || bounds.task);
        if (step.trigger) await notePilotStep(db, step.trigger);
        return false;
      };
      try {
    if (bounds.task === "images") {
      await appendLog(db, runId, `Déclenchement ${trigger}. ${await engineLabel()}. Compléter les affiches manquantes. Les agendas ne sont pas relus.`);
      let modelPromise = null;
      const loadModel = () => {
        if (!modelPromise) {
          modelPromise = (async () => {
            const chosen = await llmProvider(db);
            if (chosen === "cursor") {
              const key = await cursorKey(db, secret);
              if (!key) throw new Error("Clé Cursor absente. Enregistre-la dans Clés API.");
              const name = await cursorModel(db);
              cursor = createCursorSession({ key, model: name, signal: runSignal() });
              return { provider: chosen, cursor, key: "", model: name };
            }
            const key = await geminiKey(db, secret);
            if (!key) throw new Error("Clé Gemini absente. Enregistre-la dans Clés API.");
            const name = await geminiModel(db);
            return { provider: chosen, cursor: null, key, model: name };
          })();
        }
        return modelPromise;
      };
      const found = await completeMissingImages(db, runId, loadModel);
      if (await ended(
        `Terminé. ${found} affiche(s) proposée(s). Rien n’est publié sans toi.`,
        { created: found, updated: 0 }
      )) return;
      continue;
    }
    if (bounds.task === "duplicates") {
      await appendLog(db, runId, `Déclenchement ${trigger}. Regrouper les doublons. Les agendas ne sont pas relus.`);
      const result = await regroupDuplicates(db, (line) => appendLog(db, runId, line));
      if (await ended(
        `Terminé. ${result.groups} fiche(s) complétée(s), ${result.removed} doublon(s) retiré(s), ${result.places} lieu(x) en double, ${result.bookings} réservation(s) en double.`,
        { created: result.removed, updated: result.groups }
      )) return;
      continue;
    }
    if (bounds.task === "times") {
      let timeModel;
      if (provider === "cursor") {
        const key = await cursorKey(db, secret);
        if (!key) throw new Error("Clé Cursor absente. Enregistre-la dans Clés API.");
        const name = (await cursorModel(db)) || "Auto";
        if (!cursor) cursor = createCursorSession({ key, model: name === "Auto" ? "" : name, signal: runSignal() });
        timeModel = { provider, cursor, key: "", model: name };
      } else {
        const key = await geminiKey(db, secret);
        if (!key) throw new Error("Clé Gemini absente. Enregistre-la dans Clés API.");
        const name = await geminiModel(db);
        timeModel = { provider, cursor: null, key, model: name };
      }
      const engine = timeModel.provider === "cursor" ? `Cursor ${timeModel.model}` : timeModel.model;
      await appendLog(db, runId, `Déclenchement ${trigger}. ${engine}. Horaires manquants. Les agendas ne sont pas relus.`);
      const filled = await completeMissingTimes(db, runId, timeModel, 12);
      if (await ended(`Terminé. ${filled} horaire(s) ajouté(s).`, { created: 0, updated: filled })) return;
      continue;
    }
    if (bounds.task === "details") {
      await appendLog(db, runId, `Déclenchement ${trigger}. ${await engineLabel()}. Compléter les fiches incomplètes. Les agendas ne sont pas relus.`);
      let modelPromise = null;
      const loadModel = () => {
        if (!modelPromise) {
          modelPromise = (async () => {
            const chosen = await llmProvider(db);
            if (chosen === "cursor") {
              const key = await cursorKey(db, secret);
              if (!key) throw new Error("Clé Cursor absente. Enregistre-la dans Clés API.");
              const name = await cursorModel(db);
              cursor = createCursorSession({ key, model: name, signal: runSignal() });
              return { provider: chosen, cursor, key: "", model: name };
            }
            const key = await geminiKey(db, secret);
            if (!key) throw new Error("Clé Gemini absente. Enregistre-la dans Clés API.");
            const name = await geminiModel(db);
            return { provider: chosen, cursor: null, key, model: name };
          })();
        }
        return modelPromise;
      };
      const maps = await mapsKey(db, secret);
      const result = await completeMissingDetails(db, runId, loadModel, maps);
      if (await ended(
        `Terminé. ${result.updated} complément(s), ${result.created} proposition(s). Un lieu nouveau reste en brouillon, un billet attend dans Réservations.`,
        { created: result.created, updated: result.updated }
      )) return;
      continue;
    }
    const { minDay, maxDay } = bounds;
    const spanNote = bounds.custom ? "essai" : "30 jours";
    let geminiKeyValue = "";
    let geminiModelName = "";
    if (provider === "cursor") {
      const key = await cursorKey(db, secret);
      if (!key) throw new Error("Clé Cursor absente. Enregistre-la dans Clés API.");
      const modelName = await cursorModel(db);
      cursor = createCursorSession({ key, model: modelName, signal: runSignal() });
    } else {
      geminiKeyValue = await geminiKey(db, secret);
      if (!geminiKeyValue) throw new Error("Clé Gemini absente. Enregistre-la dans Clés API.");
      geminiModelName = await geminiModel(db);
    }
    const model = { provider, cursor, key: geminiKeyValue, model: geminiModelName };
    if (bounds.task === "venues" || bounds.task === "bookings") {
      const placesTask = bounds.task === "venues";
      const engine = provider === "cursor" ? "Cursor" : geminiModelName;
      await appendLog(
        db,
        runId,
        `Déclenchement ${trigger}. ${engine}. ${placesTask ? "Lieux culturels." : "Billetteries."} Les agendas ne sont pas relus.`
      );
      const maps = placesTask ? await mapsKey(db, secret) : "";
      const result = placesTask
        ? await collectVenues(db, runId, model, maps)
        : await collectBookings(db, runId, model);
      if (await ended(
        placesTask
          ? `Terminé. ${result.created} lieu(x) proposé(s). Rien n’est publié sans toi.`
          : `Terminé. ${result.created} réservation(s) proposée(s). Rien n’est publié sans toi.`,
        { created: result.created, updated: result.updated || 0 }
      )) return;
      continue;
    }
    if (bounds.task === "libraries" || bounds.task === "ratings") {
      const engine = provider === "cursor" ? "Cursor" : geminiModelName;
      await appendLog(db, runId, `Déclenchement ${trigger}. ${engine}.`);
      const result = bounds.task === "libraries"
        ? await collectLibraries(db, runId, bounds, model)
        : await collectRatings(db, runId, model);
      if (await ended(
        bounds.task === "libraries"
          ? `Terminé. ${result.created} lieu(x) nouveau(x), ${result.updated} horaire(s) revu(s). Les nouveaux restent en brouillon.`
          : `Terminé. ${result.kept} note(s) gardée(s), ${result.skipped} sans assez d’avis, ${result.cleared} écartée(s).`,
        { created: result.created, updated: result.updated }
      )) return;
      continue;
    }

    const engine = provider === "cursor" ? `Cursor ${await cursorModel(db) || "Auto"}, sans dépôt` : `Modèle ${geminiModelName}`;
    await appendLog(db, runId, `Déclenchement ${trigger}. ${engine}. Fenêtre ${minDay} → ${maxDay} (${spanNote}).`);

    const scanned = await loadScannedDays(db);
    const plan = splitWindow(bounds, scanned);
    const catalog = await loadCatalog(db);
    const touched = new Set();
    const seen = new Set();
    const pageCache = new Map();
    const queries = await loadQueries(db);
    const briefs = await loadBriefs(db);
    const briefFor = (key, window) => fillBrief(briefs[key], {
      jours: boundsPhrase(window),
      categories: CATEGORY_KEYS.join(", "),
      aujourdhui: window.today,
    });
    let extraPages = 0;
    let flagged = 0;
    const sources = await db.query(
      "SELECT id, name, url FROM sources WHERE enabled = TRUE AND COALESCE(kind, 'agenda') = 'agenda' ORDER BY name ASC"
    );
    const list = sources.rows.slice(0, 12);
    if (sources.rows.length > list.length) {
      await appendLog(db, runId, `${sources.rows.length - list.length} source(s) ignorée(s) : limite de 12 par collecte.`);
    }

    const fetchCached = (url) => {
      if (!pageCache.has(url)) {
        const pending = fetchPublicPage(url, runSignal());
        pageCache.set(url, pending);
        pending.catch(() => pageCache.delete(url));
      }
      return pageCache.get(url);
    };

    const askPage = async (source, text, phase, known) => {
      const phaseWindow = phaseBounds(bounds, phase === "review" ? plan.known : plan.fresh);
      const instruction = withTimeRule(briefFor(phase === "review" ? "review_page" : "discover_page", phaseWindow));
      if (provider === "cursor") {
        const facts = phase === "review"
          ? `Déjà en base :\n${knownLines(known)}\nSource : ${source.name} (${source.url}).\nTexte :\n${text}`
          : `Jours pas encore parcourus : ${boundsPhrase(phaseWindow)}.\nSource : ${source.name} (${source.url}).\nTexte :\n${text}`;
        const raw = await cursor.reply(`${instruction}\n${CURSOR_GUARD}\n${facts}`);
        return {
          events: parseEventsJson(raw),
          urls: pageUrls(raw),
          missing: phase === "review" ? parseMissing(raw, new Set(known.map((event) => event.id))) : [],
        };
      }
      return askGemini({
        key: geminiKeyValue,
        model: geminiModelName,
        source,
        text,
        window: phaseWindow,
        task: phase,
        known,
        instruction,
      });
    };

    const search = async (query, phase) => {
      const phaseWindow = phaseBounds(bounds, phase === "review" ? plan.known : plan.fresh);
      const phrase = boundsPhrase(phaseWindow);
      const instruction = withTimeRule(briefFor(phase === "review" ? "review_search" : "discover_search", phaseWindow));
      if (provider === "cursor") {
        const asked = String(query).replace(/cette semaine|prochains jours/gi, phrase);
        const intro = phase === "review"
          ? `Jours déjà parcourus : ${phrase}. Cherche seulement les sorties nouvelles. Ne propose aucune suppression.`
          : `Jours pas encore parcourus : ${phrase}.`;
        const raw = await cursor.reply(`${instruction}\n${CURSOR_GUARD}\n${intro}\nCherche sur le web des sorties des Alpes-Maritimes et de Monaco : ${asked}`);
        return { events: parseEventsJson(raw), urls: pageUrls(raw), missing: [] };
      }
      return searchWeb({
        key: geminiKeyValue,
        model: geminiModelName,
        query,
        window: phaseWindow,
        task: phase,
        instruction,
      });
    };

    const walk = async (phase, days) => {
      throwIfStopped();
      if (!days.length) return;
      const phaseWindow = phaseBounds(bounds, days);
      const order = phase === "review"
        ? (plan.fresh.length ? ", en second" : "")
        : (plan.known.length ? ", en premier" : "");
      await appendLog(
        db,
        runId,
        phase === "review"
          ? `Jours déjà vus${order} : ${daysPhrase(days)}. Nouveautés, puis vérification des sorties déjà en base.`
          : `Jours neufs${order} : ${daysPhrase(days)}.`
      );
      for (const query of queries) {
        throwIfStopped();
        await appendLog(db, runId, `${phase === "review" ? "Vérification" : "Recherche"} : ${query}`);
        try {
          const found = await search(query, phase);
          const saved = await keepEvents(db, found.events, { name: "Recherche Google", url: "" }, {}, phaseWindow);
          created += saved.created;
          updated += saved.updated;
          if (saved.attached) await appendLog(db, runId, `${saved.attached} sortie(s) rattachée(s) à un lieu validé.`);
          saved.ids.forEach((id) => touched.add(id));
          await appendLog(db, runId, `Recherche : ${saved.kept} événement(s) retenu(s).`);
          for (const url of found.urls) {
            if (extraPages >= 4 || seen.has(url)) continue;
            seen.add(url);
            try {
              await assertPublicHttpUrl(url);
            } catch {
              continue;
            }
            extraPages += 1;
            await appendLog(db, runId, `Page trouvée : ${url}`);
            try {
              const fetched = await fetchCached(url);
              const pageSource = { name: new URL(url).hostname, url };
              const matched = phase === "review" ? eventsForSource(catalog, pageSource, days) : [];
              const known = matched.slice(0, 30);
              const page = await askPage(pageSource, fetched.text, phase, known);
              const pageSaved = await keepEvents(db, page.events, pageSource, fetched, phaseWindow);
              created += pageSaved.created;
              updated += pageSaved.updated;
              if (pageSaved.attached) await appendLog(db, runId, `${pageSaved.attached} sortie(s) rattachée(s) à un lieu validé.`);
              pageSaved.ids.forEach((id) => touched.add(id));
              const noted = phase === "review" ? await noteAbsences(page.missing, known) : 0;
              await appendLog(
                db,
                runId,
                `${pageSource.name} : ${pageSaved.kept} événement(s) retenu(s)${noted ? `, ${noted} absence(s) à vérifier` : ""}.`
              );
            } catch (error) {
              if (isStop(error)) throw error;
              await appendLog(db, runId, `${url} : ${error.message}`);
            }
          }
        } catch (error) {
          if (isStop(error)) throw error;
          await appendLog(db, runId, `Recherche « ${query} » : ${error.message}`);
        }
      }
      for (const source of list) {
        throwIfStopped();
        await appendLog(db, runId, `${phase === "review" ? "Vérification de" : "Lecture de"} ${source.name}…`);
        try {
          const fetched = await fetchCached(source.url);
          const matched = phase === "review" ? eventsForSource(catalog, source, days) : [];
          const known = matched.slice(0, 30);
          if (matched.length > known.length) {
            await appendLog(db, runId, `${source.name} : comparaison limitée à 30 sorties.`);
          }
          const found = await askPage(source, fetched.text, phase, known);
          const saved = await keepEvents(db, found.events, source, fetched, phaseWindow);
          created += saved.created;
          updated += saved.updated;
          if (saved.attached) await appendLog(db, runId, `${saved.attached} sortie(s) rattachée(s) à un lieu validé.`);
          saved.ids.forEach((id) => touched.add(id));
          const noted = phase === "review" ? await noteAbsences(found.missing, known) : 0;
          await appendLog(
            db,
            runId,
            `${source.name} : ${saved.kept} événement(s) retenu(s)${noted ? `, ${noted} absence(s) à vérifier` : ""}.`
          );
        } catch (error) {
          if (isStop(error)) throw error;
          await appendLog(db, runId, `${source.name} : ${error.message}`);
        }
      }
    };

    const noteAbsences = async (missing, known) => {
      const allowed = new Set(known.map((event) => event.id));
      let count = 0;
      for (const item of missing || []) {
        if (!allowed.has(item.id) || touched.has(item.id)) continue;
        if (await proposeAbsence(db, item.id, item.reason)) {
          count += 1;
          flagged += 1;
        }
      }
      return count;
    };

    await walk("discover", plan.fresh);
    await walk("review", plan.known);
    if (provider === "cursor" || model.key) {
      const filled = await completeMissingTimes(db, runId, model, 6);
      updated += filled;
    } else {
      await appendLog(db, runId, "Horaires manquants non cherchés : clé Gemini absente.");
    }
    const linked = await attachKnownPlaces(db);
    if (linked.attached) {
      updated += linked.attached;
      await appendLog(db, runId, `${linked.attached} sortie(s) rattachée(s) à un lieu validé.`);
    }
    await rememberScannedDays(db, scanned, [...plan.fresh, ...plan.known], bounds.today);
    const fresh = created - startedCreated;
    const touchedCount = updated - startedUpdated;
    if (await ended(
      `Terminé. ${fresh} nouveau(x), ${touchedCount} mis à jour, ${flagged} absence(s) à vérifier. Les nouveaux restent en brouillon. Rien n'est supprimé sans toi.`
    )) return;
      } catch (stepError) {
        if (isStop(stepError) || !session) throw stepError;
        failedLabels.push(step.label || bounds.task);
        await appendLog(
          db,
          runId,
          `Pilote. ${step.label || "Cette étape"} s’arrête : ${stepError.message}. Je continue.`
        );
      } finally {
        if (session && cursor) {
          await cursor.close();
          cursor = null;
        }
      }
    }
    if (session) {
      const used = doneLabels.length ? doneLabels.join(", ") : "aucun";
      const failed = failedLabels.length ? ` En échec : ${failedLabels.join(", ")}.` : "";
      await db.query(
        `UPDATE agent_runs
         SET status = 'done', created_count = $2, updated_count = $3, finished_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, created, updated]
      );
      await appendLog(
        db,
        runId,
        `Pilote. Terminé. Agents utilisés : ${used}.${failed} Rien n’est publié sans toi.`
      );
      if (doneLabels.includes("sorties")) reportAs = "schedule";
      else if (doneLabels.includes("bibliothèques")) reportAs = "library";
      else if (doneLabels.includes("avis")) reportAs = "ratings";
    }
  } catch (error) {
    stopped = isStop(error);
    await db.query(
      `UPDATE agent_runs
       SET status = $2, error = $3, created_count = $4, updated_count = $5, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runId, stopped ? "stopped" : "error", stopped ? "" : error.message, created, updated]
    );
    await appendLog(
      db,
      runId,
      stopped ? "Collecte interrompue. Ce qui était déjà enregistré reste en place." : `Échec : ${error.message}`
    );
  } finally {
    if (currentStop?.runId === runId) currentStop = null;
    if (cursor) await cursor.close();
    try {
      if (!stopped) {
        const mail = await deliverScanMail(ctx, runId, "Résultat de la collecte automatique.", reportAs);
        if (!mail.skipped) {
          await appendLog(
            db,
            runId,
            mail.sent ? `Rapport envoyé à ${mail.to}.` : `Rapport non envoyé : ${mail.reason}`
          );
        }
      }
    } catch (error) {
      try {
        await appendLog(db, runId, `Rapport non envoyé : ${error.message}`);
      } catch {
        console.error("mail", error.message);
      }
    }
    active.delete(runId);
  }
}

const SCHEDULED_TASKS = {
  schedule: "discover",
  library: "libraries",
  ratings: "ratings",
  images: "images",
  times: "times",
  duplicates: "duplicates",
  venues: "venues",
  bookings: "bookings",
  details: "details",
};

async function pilotContext(db, secret) {
  const today = parisDay();
  const horizon = shiftIsoDay(today, 30);
  const [runs, images, details, times, gemini, cursorReady, provider] = await Promise.all([
    db.query(
      `SELECT trigger_name, status, started_at FROM agent_runs
       WHERE started_at > CURRENT_TIMESTAMP - INTERVAL '40 days'
       ORDER BY started_at DESC
       LIMIT 300`
    ),
    db.query(
      `SELECT COUNT(*)::int AS total FROM events
       WHERE status IN ('draft', 'published') AND COALESCE(image_url, '') = ''`
    ),
    db.query(
      `SELECT COUNT(*)::int AS total FROM events
       WHERE status IN ('draft', 'published')
         AND (detail_checked_at IS NULL OR detail_checked_at < CURRENT_TIMESTAMP - INTERVAL '14 days')
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(days) AS day
           WHERE day >= $1 AND day <= $2
         )
         AND (
           COALESCE(BTRIM(address), '') = ''
           OR lat IS NULL OR lng IS NULL
           OR place_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM booking_links
             WHERE status IN ('proposed', 'approved')
               AND ((target_type = 'event' AND target_id = events.id)
                 OR (target_type = 'place' AND events.place_id IS NOT NULL AND target_id = events.place_id))
           )
         )`,
      [today, horizon]
    ),
    db.query(
      `SELECT COUNT(*)::int AS total FROM events
       WHERE status IN ('draft', 'published')
         AND category <> 'lecture'
         AND COALESCE(BTRIM(time_label), '') = ''
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(days) AS day
           WHERE day >= $1 AND day <= $2
         )`,
      [today, horizon]
    ),
    geminiKey(db, secret).catch(() => ""),
    cursorKey(db, secret).catch(() => ""),
    llmProvider(db),
  ]);
  const chosenReady = provider === "cursor" ? Boolean(cursorReady) : Boolean(gemini);
  return {
    now: new Date(),
    runs: runs.rows,
    gemini: Boolean(gemini),
    model: chosenReady,
    backlog: {
      images: Number(images.rows[0]?.total || 0),
      details: Number(details.rows[0]?.total || 0),
      times: Number(times.rows[0]?.total || 0),
    },
  };
}

async function notePilotStep(db, trigger) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO agent_runs (id, status, log, started_at, finished_at, trigger_name)
     VALUES ($1, 'done', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3)`,
    [id, "Compté dans le pilote.\n", trigger]
  );
}

async function recordIdlePilot(ctx, health) {
  const id = crypto.randomUUID();
  const text = health
    ? `${health}\nPilote. Rien à reprendre. Les brouillons et les propositions attendent une validation.\n`
    : "Pilote. Rien à reprendre. Les brouillons et les propositions attendent une validation.\n";
  await ctx.db.query(
    `INSERT INTO agent_runs (id, status, log, started_at, finished_at, trigger_name)
     VALUES ($1, 'done', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'pilot')`,
    [id, text]
  );
  return id;
}

async function queueRun(ctx, trigger, windowOverride) {
  if (runInProgress()) return null;
  if (trigger === "pilot" || (trigger === "manual" && windowOverride?.task === "pilot")) {
    const context = await pilotContext(ctx.db, ctx.secret);
    if (trigger === "pilot" && pilotHalted(context.runs, context.now)) return null;
    const steps = planPilotSteps(context);
    const health = healthSentence(context.backlog);
    if (!steps.length) return trigger === "manual" ? recordIdlePilot(ctx, health) : null;
    const bounds = collectionWindow(windowOverride || {});
    bounds.task = "pilot";
    bounds.pilotSteps = steps;
    bounds.pilotHealth = health;
    const id = crypto.randomUUID();
    await ctx.db.query(
      "INSERT INTO agent_runs (id, status, log, started_at, trigger_name) VALUES ($1, 'queued', '', CURRENT_TIMESTAMP, 'pilot')",
      [id]
    );
    if (!startRun(ctx, id, bounds)) {
      await ctx.db.query("DELETE FROM agent_runs WHERE id = $1", [id]);
      return null;
    }
    return id;
  }
  const bounds = collectionWindow(trigger === "schedule" ? {} : (windowOverride || {}));
  if (SCHEDULED_TASKS[trigger]) bounds.task = SCHEDULED_TASKS[trigger];
  else {
    const asked = windowOverride?.task;
    bounds.task = ["images", "libraries", "ratings", "duplicates", "times", "venues", "bookings", "details"].includes(asked) ? asked : "discover";
  }
  const id = crypto.randomUUID();
  const name = SCHEDULED_TASKS[trigger] ? trigger : "manual";
  await ctx.db.query(
    "INSERT INTO agent_runs (id, status, log, started_at, trigger_name) VALUES ($1, 'queued', '', CURRENT_TIMESTAMP, $2)",
    [id, name]
  );
  if (!startRun(ctx, id, bounds)) {
    await ctx.db.query("DELETE FROM agent_runs WHERE id = $1", [id]);
    return null;
  }
  return id;
}

function startRun(ctx, runId, bounds = collectionWindow()) {
  if (active.size) return false;
  const controller = new AbortController();
  currentStop = { runId, controller };
  active.add(runId);
  setImmediate(() => {
    executeRun(ctx, runId, bounds).catch((error) => {
      console.error(error);
      active.delete(runId);
      if (currentStop?.runId === runId) currentStop = null;
    });
  });
  return true;
}

function interruptRun() {
  if (!currentStop || currentStop.controller.signal.aborted) return currentStop?.runId || null;
  currentStop.controller.abort(stopError());
  return currentStop.runId;
}

function runInProgress() {
  return active.size > 0;
}

module.exports = {
  startRun,
  runInProgress,
  queueRun,
  interruptRun,
  generationConfig,
  visibleText,
  horizon,
  collectionWindow,
  splitWindow,
  daysPhrase,
  parseMissing,
  eventsForSource,
  posterForEvent,
};
