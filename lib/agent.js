const { CATEGORY_KEYS } = require("./defaults");
const { fetchPublicPage } = require("./fetch-page");
const { geminiKey, geminiModel } = require("./settings");

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
  const days = asArray(raw.days)
    .map((day) => String(day).slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day));
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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Réponse Gemini illisible");
  }
  return Array.isArray(parsed.events) ? parsed.events : [];
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
    await appendLog(db, runId, `Modèle ${model}.`);
    const sources = await db.query(
      "SELECT id, name, url FROM sources WHERE enabled = TRUE ORDER BY name ASC"
    );
    const list = sources.rows.slice(0, 12);
    if (sources.rows.length > list.length) {
      await appendLog(db, runId, `${sources.rows.length - list.length} source(s) ignorée(s) : limite de 12 par collecte.`);
    }
    if (!list.length) throw new Error("Aucune source activée.");
    for (const source of list) {
      await appendLog(db, runId, `Lecture de ${source.name}…`);
      try {
        const text = await fetchPublicPage(source.url);
        const found = await askGemini({ key, model, source, text });
        let kept = 0;
        for (const raw of found.slice(0, 40)) {
          const event = normalizeEvent(raw, source);
          if (!event) continue;
          const result = await saveEvent(db, event);
          if (result === "created") created += 1;
          else updated += 1;
          kept += 1;
        }
        await appendLog(db, runId, `${source.name} : ${kept} événement(s) retenu(s).`);
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

module.exports = { startRun, runInProgress };
