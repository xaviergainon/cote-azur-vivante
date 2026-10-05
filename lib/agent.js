const crypto = require("node:crypto");
const { CATEGORY_KEYS, DEFAULT_QUERIES } = require("./defaults");
const { fetchPublicPage, assertPublicHttpUrl } = require("./fetch-page");
const { geminiKey, geminiModel, getRaw } = require("./settings");

const BBOX = { latMin: 43.4, latMax: 44.2, lngMin: 6.5, lngMax: 7.8 };
const active = new Set();

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

function normalizeEvent(raw, source) {
  const title = clip(raw.title, 180);
  if (title.length < 3) return null;
  const today = new Date();
  const min = new Date(today);
  min.setDate(min.getDate() - 1);
  const max = new Date(today);
  max.setDate(max.getDate() + 30);
  const minDay = min.toISOString().slice(0, 10);
  const maxDay = max.toISOString().slice(0, 10);
  const days = asArray(raw.days)
    .map((day) => String(day).slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= minDay && day <= maxDay);
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

async function askGemini({ key, model, source, text }) {
  const today = new Date().toISOString().slice(0, 10);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: `Tu extrais des sorties publiques des Alpes-Maritimes (France). Réponds uniquement en JSON {"events":[...]}. N'invente aucun événement qui n'est pas dans le texte. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD. lat/lng seulement si le lieu est dans les Alpes-Maritimes, sinon null. Si rien n'est exploitable, {"events":[]}.`,
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Nous sommes le ${today}. Source : ${source.name} (${source.url}).\nTexte :\n${text}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message || `Gemini HTTP ${response.status}`;
    throw new Error(message);
  }
  const raw = (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  return {
    events: parseEventsJson(raw),
    urls: groundingUrls(body),
  };
}

function parseEventsJson(raw) {
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Réponse Gemini illisible");
  const parsed = JSON.parse(body.slice(start, end + 1));
  return Array.isArray(parsed.events) ? parsed.events : [];
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

async function searchWeb({ key, model, query }) {
  const today = new Date().toISOString().slice(0, 10);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: `Tu cherches des sorties publiques à venir dans les Alpes-Maritimes. Réponds uniquement en JSON {"events":[...]}. N'invente pas un événement sans source web. category parmi : ${CATEGORY_KEYS.join(", ")}. days au format YYYY-MM-DD, dans les 30 prochains jours. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.`,
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `Nous sommes le ${today}. Recherche Google : ${query}` }],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1 },
      }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `Gemini HTTP ${response.status}`);
  }
  const raw = (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  return { events: parseEventsJson(raw), urls: groundingUrls(body) };
}

async function keepEvents(db, found, source) {
  let created = 0;
  let updated = 0;
  let kept = 0;
  for (const raw of found.slice(0, 40)) {
    const event = normalizeEvent(raw, source);
    if (!event) continue;
    const result = await saveEvent(db, event);
    if (result === "created") created += 1;
    else if (result === "updated") updated += 1;
    kept += 1;
  }
  return { created, updated, kept };
}

async function saveEvent(db, event) {
  const existing = await db.query("SELECT id, status FROM events WHERE id = $1", [event.id]);
  if (existing.rows[0]?.status === "published") return "kept";
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
  return "updated";
}

async function executeRun(ctx, runId) {
  const { db, appSecret } = ctx;
  let created = 0;
  let updated = 0;
  try {
    await db.query(
      `UPDATE agent_runs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runId]
    );
    const key = await geminiKey(db, appSecret);
    if (!key) throw new Error("Clé Gemini absente. Enregistre-la dans Clés API.");
    const model = await geminiModel(db);
    const run = await db.query("SELECT trigger_name FROM agent_runs WHERE id = $1", [runId]);
    const trigger = run.rows[0]?.trigger_name === "schedule" ? "quotidien" : "manuel";
    await appendLog(db, runId, `Déclenchement ${trigger}. Modèle ${model}.`);

    const seen = new Set();
    const queries = await loadQueries(db);
    let extraPages = 0;
    for (const query of queries) {
      await appendLog(db, runId, `Recherche Google : ${query}`);
      try {
        const found = await searchWeb({ key, model, query });
        const saved = await keepEvents(db, found.events, { name: "Recherche Google", url: "" });
        created += saved.created;
        updated += saved.updated;
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
            const text = await fetchPublicPage(url);
            const page = await askGemini({
              key,
              model,
              source: { name: new URL(url).hostname, url },
              text,
            });
            const pageSaved = await keepEvents(db, page.events, { name: new URL(url).hostname, url });
            created += pageSaved.created;
            updated += pageSaved.updated;
            await appendLog(db, runId, `${new URL(url).hostname} : ${pageSaved.kept} événement(s) retenu(s).`);
          } catch (error) {
            await appendLog(db, runId, `${url} : ${error.message}`);
          }
        }
      } catch (error) {
        await appendLog(db, runId, `Recherche « ${query} » : ${error.message}`);
      }
    }

    const sources = await db.query(
      "SELECT id, name, url FROM sources WHERE enabled = TRUE ORDER BY name ASC"
    );
    const list = sources.rows.slice(0, 12);
    if (sources.rows.length > list.length) {
      await appendLog(db, runId, `${sources.rows.length - list.length} source(s) ignorée(s) : limite de 12 par collecte.`);
    }
    for (const source of list) {
      await appendLog(db, runId, `Lecture de ${source.name}…`);
      try {
        const text = await fetchPublicPage(source.url);
        const found = await askGemini({ key, model, source, text });
        const saved = await keepEvents(db, found.events, source);
        created += saved.created;
        updated += saved.updated;
        await appendLog(db, runId, `${source.name} : ${saved.kept} événement(s) retenu(s).`);
      } catch (error) {
        await appendLog(db, runId, `${source.name} : ${error.message}`);
      }
    }
    await db.query(
      `UPDATE agent_runs
       SET status = 'done', created_count = $2, updated_count = $3, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runId, created, updated]
    );
    await appendLog(db, runId, `Terminé. ${created} nouveau(x), ${updated} mis à jour. Les nouveaux restent en brouillon.`);
  } catch (error) {
    await db.query(
      `UPDATE agent_runs
       SET status = 'error', error = $2, created_count = $3, updated_count = $4, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runId, error.message, created, updated]
    );
    await appendLog(db, runId, `Échec : ${error.message}`);
  } finally {
    active.delete(runId);
  }
}

async function queueRun(ctx, trigger) {
  if (runInProgress()) return null;
  const id = crypto.randomUUID();
  const name = trigger === "schedule" ? "schedule" : "manual";
  await ctx.db.query(
    "INSERT INTO agent_runs (id, status, log, started_at, trigger_name) VALUES ($1, 'queued', '', CURRENT_TIMESTAMP, $2)",
    [id, name]
  );
  if (!startRun(ctx, id)) {
    await ctx.db.query("DELETE FROM agent_runs WHERE id = $1", [id]);
    return null;
  }
  return id;
}

function startRun(ctx, runId) {
  if (active.size) return false;
  active.add(runId);
  setImmediate(() => {
    executeRun(ctx, runId).catch((error) => {
      console.error(error);
      active.delete(runId);
    });
  });
  return true;
}

function runInProgress() {
  return active.size > 0;
}

module.exports = { startRun, runInProgress, queueRun };
