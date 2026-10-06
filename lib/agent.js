const crypto = require("node:crypto");
const { CATEGORY_KEYS, DEFAULT_QUERIES } = require("./defaults");
const { fetchPublicPage, assertPublicHttpUrl } = require("./fetch-page");
const { geminiKey, geminiModel, cursorKey, cursorModel, llmProvider, getRaw, setRaw } = require("./settings");
const { createCursorSession } = require("./cursor");

const BBOX = { latMin: 43.4, latMax: 44.2, lngMin: 6.5, lngMax: 7.8 };
const HORIZON_DAYS = 30;
const active = new Set();

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
    time: clip(raw.time, 40),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastGeminiCall = 0;

async function geminiGenerate(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const gap = lastGeminiCall + 13000 - Date.now();
    if (gap > 0) await sleep(gap);
    lastGeminiCall = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": body.key,
      },
      signal: AbortSignal.timeout(60000),
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

async function askGemini({ key, model, source, text, window = collectionWindow(), task = "discover", known = [] }) {
  const { today } = window;
  const phrase = boundsPhrase(window);
  const review = task === "review";
  const body = await geminiGenerate(model, {
    key,
    payload: {
      systemInstruction: {
        parts: [
          {
            text: review
              ? `Tu relis une page déjà parcourue. Réponds uniquement en JSON {"events":[],"missing":[]}. Jours : ${phrase}. events : seulement les sorties nouvelles, absentes de la liste. missing : {"id","reason"} si la page annule ou retire un id de la liste. Dans le doute, missing reste vide. category parmi : ${CATEGORY_KEYS.join(", ")}. N'invente rien.`
              : `Tu extrais des sorties publiques des Alpes-Maritimes (France). Réponds uniquement en JSON {"events":[...]}. N'invente aucun événement qui n'est pas dans le texte. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD, uniquement ces jours : ${phrase}. Si un événement dure plusieurs jours, ou a commencé avant et continue, liste chaque jour encore ouvert dans ces jours. lat/lng seulement si le lieu est dans les Alpes-Maritimes, sinon null. Si rien n'est exploitable, {"events":[]}.`,
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

function extractionPrompt(extra, bounds = collectionWindow()) {
  const phrase = boundsPhrase(bounds);
  return `Nous sommes le ${bounds.today} (Paris). Jours : ${phrase}.
Réponds uniquement par un JSON {"events":[...],"pages":[...]}.
N'invente aucun événement absent de la source. category parmi : ${CATEGORY_KEYS.join(", ")}.
days au format YYYY-MM-DD, uniquement ces jours. Une plage devient une date par jour.
lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.
pages : jusqu'à 4 URL https de pages d'événements, jamais un lien Google.
N'ouvre aucun dépôt, n'écris aucun fichier, ne crée aucune pull request.
Question indépendante des précédentes.
${extra}`;
}

function reviewPrompt(extra, bounds, known) {
  return `Nous sommes le ${bounds.today} (Paris). Jours déjà parcourus : ${boundsPhrase(bounds)}.
Réponds uniquement par un JSON {"events":[],"missing":[],"pages":[]}.
events : uniquement les sorties nouvelles, absentes de la liste, sur ces jours. category parmi : ${CATEGORY_KEYS.join(", ")}.
days au format YYYY-MM-DD. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.
missing : {"id","reason"} pour un id de la liste, seulement si cette page dit que la sortie est annulée, supprimée ou absente. Dans le doute, ne mets rien.
pages : jusqu'à 4 URL https, jamais un lien Google.
N'ouvre aucun dépôt, n'écris aucun fichier, ne crée aucune pull request.
Question indépendante des précédentes.
Déjà en base :
${knownLines(known)}
${extra}`;
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
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String).slice(0, 5);
  } catch {
    return DEFAULT_QUERIES;
  }
  return DEFAULT_QUERIES;
}

async function searchWeb({ key, model, query, window = collectionWindow(), task = "discover" }) {
  const { today } = window;
  const phrase = boundsPhrase(window);
  const review = task === "review";
  const body = await geminiGenerate(model, {
    key,
    payload: {
      systemInstruction: {
        parts: [
          {
            text: review
              ? `Tu cherches les sorties nouvelles des Alpes-Maritimes sur des jours déjà parcourus (${phrase}). Réponds uniquement en JSON {"events":[...]}. Ne renvoie que les nouveautés. Ne signale pas d'absence. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD, uniquement ces jours. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.`
              : `Tu cherches des sorties publiques à venir dans les Alpes-Maritimes. Réponds uniquement en JSON {"events":[...]}. N'invente pas un événement sans source web. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD, uniquement ces jours : ${phrase}. Couvre tous ces jours, pas seulement la semaine en cours : développe chaque plage en une date par jour. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.`,
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

async function proposeImage(db, id, image, pageUrl) {
  if (!image) return false;
  const result = await db.query(
    `UPDATE events
     SET image_url = $2, image_page = $3, image_status = 'proposed', updated_at = CURRENT_TIMESTAMP
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
    event.image = page.image || "";
    event.imagePage = page.pageUrl || source.url || "";
    const result = await saveEvent(db, event);
    if (result === "created") created += 1;
    else if (result === "updated") updated += 1;
    ids.push(event.id);
    kept += 1;
  }
  return { created, updated, kept, ids };
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
  const existing = await db.query("SELECT id, status FROM events WHERE id = $1", [event.id]);
  if (existing.rows[0]?.status === "published") {
    await proposeImage(db, event.id, event.image, event.imagePage);
    return "kept";
  }
  if (!existing.rows.length) {
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
    return "created";
  }
  await db.query(
    `UPDATE events SET
      title = $2, days = $3::jsonb, time_label = $4, category = $5, city = $6,
      venue = $7, address = $8, lat = $9, lng = $10, price = $11, free = $12,
      description = $13, source_name = $14, url = $15, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
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
  return "updated";
}

async function executeRun(ctx, runId, bounds = collectionWindow()) {
  const { db, secret } = ctx;
  let created = 0;
  let updated = 0;
  let cursor = null;
  try {
    await db.query(
      `UPDATE agent_runs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runId]
    );
    const provider = await llmProvider(db);
    const run = await db.query("SELECT trigger_name FROM agent_runs WHERE id = $1", [runId]);
    const trigger = run.rows[0]?.trigger_name === "schedule" ? "quotidien" : "manuel";
    const { minDay, maxDay } = bounds;
    const spanNote = bounds.custom ? "essai" : "30 jours";
    let geminiKeyValue = "";
    let geminiModelName = "";
    if (provider === "cursor") {
      const key = await cursorKey(db, secret);
      if (!key) throw new Error("Clé Cursor absente. Enregistre-la dans Clés API.");
      const model = await cursorModel(db);
      cursor = createCursorSession({ key, model });
      await appendLog(
        db,
        runId,
        `Déclenchement ${trigger}. Cursor ${model || "Auto"}, sans dépôt. Fenêtre ${minDay} → ${maxDay} (${spanNote}).`
      );
    } else {
      geminiKeyValue = await geminiKey(db, secret);
      if (!geminiKeyValue) throw new Error("Clé Gemini absente. Enregistre-la dans Clés API.");
      geminiModelName = await geminiModel(db);
      await appendLog(db, runId, `Déclenchement ${trigger}. Modèle ${geminiModelName}. Fenêtre ${minDay} → ${maxDay} (${spanNote}).`);
    }

    const scanned = await loadScannedDays(db);
    const plan = splitWindow(bounds, scanned);
    const catalog = await loadCatalog(db);
    const touched = new Set();
    const seen = new Set();
    const pageCache = new Map();
    const queries = await loadQueries(db);
    let extraPages = 0;
    let flagged = 0;
    const sources = await db.query(
      "SELECT id, name, url FROM sources WHERE enabled = TRUE ORDER BY name ASC"
    );
    const list = sources.rows.slice(0, 12);
    if (sources.rows.length > list.length) {
      await appendLog(db, runId, `${sources.rows.length - list.length} source(s) ignorée(s) : limite de 12 par collecte.`);
    }

    const fetchCached = (url) => {
      if (!pageCache.has(url)) pageCache.set(url, fetchPublicPage(url));
      return pageCache.get(url);
    };

    const askPage = async (source, text, phase, known) => {
      if (provider === "cursor") {
        const prompt = phase === "review"
          ? reviewPrompt(`Source : ${source.name} (${source.url}).\nTexte :\n${text}`, phase === "review" ? phaseBounds(bounds, plan.known) : bounds, known)
          : extractionPrompt(`Jours pas encore parcourus : ${boundsPhrase(phaseBounds(bounds, plan.fresh))}.\nSource : ${source.name} (${source.url}).\nTexte :\n${text}`, phaseBounds(bounds, plan.fresh));
        const raw = await cursor.reply(prompt);
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
        window: phaseBounds(bounds, phase === "review" ? plan.known : plan.fresh),
        task: phase,
        known,
      });
    };

    const search = async (query, phase) => {
      const phaseWindow = phaseBounds(bounds, phase === "review" ? plan.known : plan.fresh);
      const phrase = boundsPhrase(phaseWindow);
      if (provider === "cursor") {
        const asked = String(query).replace(/cette semaine|prochains jours/gi, phrase);
        const intro = phase === "review"
          ? `Jours déjà parcourus : ${phrase}. Cherche seulement les sorties nouvelles. Ne propose aucune suppression.`
          : `Jours pas encore parcourus : ${phrase}.`;
        const raw = await cursor.reply(extractionPrompt(`${intro}\nCherche sur le web des sorties des Alpes-Maritimes : ${asked}`, phaseWindow));
        return { events: parseEventsJson(raw), urls: pageUrls(raw), missing: [] };
      }
      return searchWeb({ key: geminiKeyValue, model: geminiModelName, query, window: phaseWindow, task: phase });
    };

    const walk = async (phase, days) => {
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
        await appendLog(db, runId, `${phase === "review" ? "Vérification" : "Recherche"} : ${query}`);
        try {
          const found = await search(query, phase);
          const saved = await keepEvents(db, found.events, { name: "Recherche Google", url: "" }, {}, phaseWindow);
          created += saved.created;
          updated += saved.updated;
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
              pageSaved.ids.forEach((id) => touched.add(id));
              const noted = phase === "review" ? await noteAbsences(page.missing, known) : 0;
              await appendLog(
                db,
                runId,
                `${pageSource.name} : ${pageSaved.kept} événement(s) retenu(s)${noted ? `, ${noted} absence(s) à vérifier` : ""}.`
              );
            } catch (error) {
              await appendLog(db, runId, `${url} : ${error.message}`);
            }
          }
        } catch (error) {
          await appendLog(db, runId, `Recherche « ${query} » : ${error.message}`);
        }
      }
      for (const source of list) {
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
          saved.ids.forEach((id) => touched.add(id));
          const noted = phase === "review" ? await noteAbsences(found.missing, known) : 0;
          await appendLog(
            db,
            runId,
            `${source.name} : ${saved.kept} événement(s) retenu(s)${noted ? `, ${noted} absence(s) à vérifier` : ""}.`
          );
        } catch (error) {
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
    await db.query(
      `UPDATE agent_runs
       SET status = 'error', error = $2, created_count = $3, updated_count = $4, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runId, error.message, created, updated]
    );
    await appendLog(db, runId, `Échec : ${error.message}`);
  } finally {
    if (cursor) await cursor.close();
    active.delete(runId);
  }
}

async function queueRun(ctx, trigger, windowOverride) {
  if (runInProgress()) return null;
  const bounds = trigger === "schedule" ? collectionWindow() : collectionWindow(windowOverride || {});
  const id = crypto.randomUUID();
  const name = trigger === "schedule" ? "schedule" : "manual";
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
  active.add(runId);
  setImmediate(() => {
    executeRun(ctx, runId, bounds).catch((error) => {
      console.error(error);
      active.delete(runId);
    });
  });
  return true;
}

function runInProgress() {
  return active.size > 0;
}

module.exports = {
  startRun,
  runInProgress,
  queueRun,
  generationConfig,
  visibleText,
  horizon,
  collectionWindow,
  splitWindow,
  daysPhrase,
  parseMissing,
  eventsForSource,
};
