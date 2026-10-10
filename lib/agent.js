const crypto = require("node:crypto");
const { CATEGORY_KEYS, DEFAULT_QUERIES, PREVIOUS_QUERIES, DEFAULT_LIBRARY_QUERIES } = require("./defaults");
const { acceptWebRating, openDates } = require("./ratings");
const { fetchPublicPage, assertPublicHttpUrl } = require("./fetch-page");
const { listMissingImages, summarizeMissing, markImagesChecked } = require("./images");
const { deliverScanMail } = require("./mail");
const { geminiKey, geminiModel, cursorKey, cursorModel, llmProvider, getRaw, setRaw } = require("./settings");
const { loadBriefs, fillBrief } = require("./briefs");
const { matchingShows, rowToShow, stableId, completeShow, pickKeeper, writeShow, regroupDuplicates } = require("./duplicates");
const { acceptTime, listingPage } = require("./showtimes");
const { saveVenue, attachKnownPlaces, saveBookingProposal } = require("./venues");

const TIME_RULE = "Champ time : l'heure de la séance si la source l'écrit, sous la forme 20h30. Sinon time est vide. N'écris pas « selon séances » ni « voir la source ».";

function withTimeRule(instruction) {
  return /20h30/.test(instruction) ? instruction : `${instruction}\n${TIME_RULE}`;
}
const { createCursorSession } = require("./cursor");

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

function sameQueries(list, previous) {
  return list.length === previous.length && list.every((line, index) => line === previous[index]);
}

async function loadQueries(db) {
  const raw = await getRaw(db, "agent_queries");
  if (!raw) return DEFAULT_QUERIES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      const list = parsed.map(String).map((line) => line.trim()).filter(Boolean).slice(0, 5);
      return sameQueries(list, PREVIOUS_QUERIES) ? DEFAULT_QUERIES : list;
    }
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

async function askModel({ provider, cursor, key, model, instruction, question, search = false }) {
  if (provider === "cursor") {
    if (!cursor) throw new Error("Session Cursor absente.");
    const searchLine = search
      ? "Cherche sur le web public, pas dans un dépôt. N'écris aucun fichier et ne crée aucune pull request. Réponds seulement par le JSON demandé."
      : "N'ouvre aucun dépôt et n'écris aucun fichier.";
    return parsePayload(await cursor.reply(`${instruction}\n${question}\n${searchLine}`));
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
  const targets = await db.query(
    `SELECT id, title, venue, city, url, category
     FROM events
     WHERE status IN ('draft', 'published')
       AND (rating_checked_at IS NULL OR rating_checked_at < CURRENT_TIMESTAMP - INTERVAL '25 days')
     ORDER BY rating_checked_at ASC NULLS FIRST
     LIMIT 12`
  );
  await appendLog(
    db,
    runId,
    `Avis, à part de la collecte. ${targets.rows.length} sortie(s) à regarder. Une note sur 5 n’est gardée qu’avec au moins 8 avis sur le bon lieu.`
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
    const where = [event.title, event.venue, event.city].filter(Boolean).join(", ");
    try {
      const found = await askModel({
        ...model,
        instruction,
        search: true,
        question: `Lieu : ${where}. Page : ${event.url || "inconnue"}.
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

async function completeMissingImages(db, runId) {
  const summary = summarizeMissing(await listMissingImages(db));
  await appendLog(
    db,
    runId,
    `Sans affiche : ${summary.missing} (brouillons et publiés). Page propre : ${summary.uniquePages}. Page partagée, ignorée : ${summary.sharedEvents}. Sans lien : ${summary.noUrl}.`
  );
  const batch = summary.unique.slice(0, 80);
  if (summary.unique.length > batch.length) {
    await appendLog(db, runId, `${summary.unique.length - batch.length} page(s) restent pour le prochain passage. Chaque lancement reprend les pages les plus anciennes.`);
  }
  let found = 0;
  for (const item of batch) {
    throwIfStopped();
    try {
      const page = await fetchPublicPage(item.url, runSignal());
      if (!page.image) {
        await appendLog(db, runId, `${item.event.title} : pas d’affiche sur sa page.`);
      } else {
        const proposed = await proposeImage(db, item.event.id, page.image, page.pageUrl || item.url);
        if (proposed) {
          found += 1;
          await appendLog(db, runId, `${item.event.title} : affiche proposée.`);
        }
      }
    } catch (error) {
      if (isStop(error)) throw error;
      await appendLog(db, runId, `${item.event.title} : ${error.message}`);
    }
    await markImagesChecked(db, [item.event.id]);
    await sleep(300);
  }
  return found;
}

function quotaStop(error) {
  return /quota|rate limit|high demand/i.test(error.message || "");
}

async function collectVenues(db, runId, model) {
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
        const saved = await saveVenue(db, raw);
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
  if (model.provider === "cursor") {
    return parsePayload(await model.cursor.reply(`${instruction}\n${question}`));
  }
  const body = await geminiGenerate(model.model, {
    key: model.key,
    payload: {
      systemInstruction: { parts: [{ text: instruction }] },
      contents: [{ role: "user", parts: [{ text: question }] }],
      tools: [{ google_search: {} }],
      generationConfig: generationConfig(model.model, { maxOutputTokens: 512 }),
    },
  });
  return parsePayload(visibleText(body));
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
        await appendLog(db, runId, "Quota Gemini atteint. Les horaires restants reprennent au prochain passage.");
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
  try {
    throwIfStopped();
    await db.query(
      `UPDATE agent_runs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runId]
    );
    const provider = await llmProvider(db);
    const run = await db.query("SELECT trigger_name FROM agent_runs WHERE id = $1", [runId]);
    const triggerNames = { schedule: "quotidien", library: "mensuel", ratings: "mensuel" };
    const trigger = triggerNames[run.rows[0]?.trigger_name] || "manuel";
    if (bounds.task === "images") {
      await appendLog(db, runId, `Déclenchement ${trigger}. Compléter les affiches manquantes. Les agendas ne sont pas relus.`);
      const found = await completeMissingImages(db, runId);
      await db.query(
        `UPDATE agent_runs
         SET status = 'done', created_count = $2, updated_count = 0, finished_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, found]
      );
      await appendLog(
        db,
        runId,
        `Terminé. ${found} affiche(s) proposée(s). Rien n’est publié sans toi.`
      );
      return;
    }
    if (bounds.task === "duplicates") {
      await appendLog(db, runId, `Déclenchement ${trigger}. Regrouper les doublons. Les agendas ne sont pas relus.`);
      const result = await regroupDuplicates(db, (line) => appendLog(db, runId, line));
      await db.query(
        `UPDATE agent_runs
         SET status = 'done', created_count = $2, updated_count = $3, finished_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, result.removed, result.groups]
      );
      await appendLog(
        db,
        runId,
        `Terminé. ${result.groups} fiche(s) complétée(s), ${result.removed} doublon(s) retiré(s).`
      );
      return;
    }
    if (bounds.task === "times") {
      const key = await geminiKey(db, secret);
      if (!key) throw new Error("Clé Gemini absente. Enregistre-la dans Clés API.");
      const name = await geminiModel(db);
      await appendLog(db, runId, `Déclenchement ${trigger}. ${name}. Horaires manquants. Les agendas ne sont pas relus.`);
      const filled = await completeMissingTimes(db, runId, { provider: "gemini", key, model: name }, 12);
      await db.query(
        `UPDATE agent_runs
         SET status = 'done', created_count = 0, updated_count = $2, finished_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, filled]
      );
      await appendLog(db, runId, `Terminé. ${filled} horaire(s) ajouté(s).`);
      return;
    }
    const { minDay, maxDay } = bounds;
    const spanNote = bounds.custom ? "essai" : "30 jours";
    let geminiKeyValue = "";
    let geminiModelName = "";
    if (provider === "cursor") {
      const key = await cursorKey(db, secret);
      if (!key) throw new Error("Clé Cursor absente. Enregistre-la dans Clés API.");
      const model = await cursorModel(db);
      cursor = createCursorSession({ key, model, signal: runSignal() });
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
      const result = placesTask
        ? await collectVenues(db, runId, model)
        : await collectBookings(db, runId, model);
      await db.query(
        `UPDATE agent_runs
         SET status = 'done', created_count = $2, updated_count = $3, finished_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, result.created, result.updated || 0]
      );
      await appendLog(
        db,
        runId,
        placesTask
          ? `Terminé. ${result.created} lieu(x) proposé(s). Rien n’est publié sans toi.`
          : `Terminé. ${result.created} réservation(s) proposée(s). Rien n’est publié sans toi.`
      );
      return;
    }
    if (bounds.task === "libraries" || bounds.task === "ratings") {
      const engine = provider === "cursor" ? "Cursor" : geminiModelName;
      await appendLog(db, runId, `Déclenchement ${trigger}. ${engine}.`);
      const result = bounds.task === "libraries"
        ? await collectLibraries(db, runId, bounds, model)
        : await collectRatings(db, runId, model);
      await db.query(
        `UPDATE agent_runs
         SET status = 'done', created_count = $2, updated_count = $3, finished_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, result.created, result.updated]
      );
      await appendLog(
        db,
        runId,
        bounds.task === "libraries"
          ? `Terminé. ${result.created} lieu(x) nouveau(x), ${result.updated} horaire(s) revu(s). Les nouveaux restent en brouillon.`
          : `Terminé. ${result.kept} note(s) gardée(s), ${result.skipped} sans assez d’avis, ${result.cleared} écartée(s).`
      );
      return;
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
    const timeKey = geminiKeyValue || await geminiKey(db, secret);
    const timeModel = geminiKeyValue ? geminiModelName : (timeKey ? await geminiModel(db) : "");
    if (timeKey) {
      const filled = await completeMissingTimes(db, runId, { provider: "gemini", key: timeKey, model: timeModel }, 6);
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
    await db.query(
      `UPDATE agent_runs
       SET status = 'done', created_count = $2, updated_count = $3, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runId, created, updated]
    );
    await appendLog(
      db,
      runId,
      `Terminé. ${created} nouveau(x), ${updated} mis à jour, ${flagged} absence(s) à vérifier. Les nouveaux restent en brouillon. Rien n'est supprimé sans toi.`
    );
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
        const mail = await deliverScanMail(ctx, runId, "Résultat de la collecte automatique.");
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

async function queueRun(ctx, trigger, windowOverride) {
  if (runInProgress()) return null;
  const bounds = trigger === "schedule" ? collectionWindow() : collectionWindow(windowOverride || {});
  const asked = windowOverride?.task;
  if (trigger === "library") bounds.task = "libraries";
  else if (trigger === "ratings") bounds.task = "ratings";
  else if (trigger !== "schedule" && ["images", "libraries", "ratings", "duplicates", "times", "venues", "bookings"].includes(asked)) bounds.task = asked;
  else bounds.task = "discover";
  const id = crypto.randomUUID();
  const name = ["schedule", "library", "ratings"].includes(trigger) ? trigger : "manual";
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
