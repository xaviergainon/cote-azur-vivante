const crypto = require("node:crypto");
const { CATEGORY_KEYS } = require("./defaults");
const { readSession, setSession, clearSession } = require("./auth");
const { hashPassword, verifyPassword } = require("./secrets");
const { getRaw, setRaw, setSecret, publicSettings, geminiKey, geminiModel, cursorKey } = require("./settings");
const { cursorAccount } = require("./cursor");
const { ensureSources, sourceId } = require("./seed");
const { assertPublicHttpUrl } = require("./fetch-page");
const { mapEvent, publicAgenda, httpUrl } = require("./agenda");
const { queueRun, runInProgress, generationConfig, visibleText } = require("./agent");
const { schedulePayload, saveSchedule } = require("./schedule");

const attempts = new Map();

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || "local";
}

function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.reset < now) return false;
  return entry.count >= 8;
}

function markFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.reset < now) {
    attempts.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
    return;
  }
  entry.count += 1;
}

function clearFailures(ip) {
  attempts.delete(ip);
}

function requireAuth(secret) {
  return (req, res, next) => {
    if (!readSession(req, secret)) {
      res.status(401).json({ error: "Connexion requise." });
      return;
    }
    next();
  };
}

function cleanId(id) {
  return /^[a-zA-Z0-9_-]{1,120}$/.test(id || "");
}

function clip(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function saveEventFields(db, id, body, { creating = false } = {}) {
  const title = clip(body.title, 180);
  const city = clip(body.city, 80);
  const days = (Array.isArray(body.days) ? body.days : String(body.days || "").split(/[,\s]+/))
    .map((day) => String(day).slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day));
  if (title.length < 3) return { error: "Titre trop court." };
  if (!city) return { error: "Ville manquante." };
  if (!days.length) return { error: "Au moins une date AAAA-MM-JJ." };
  if (!CATEGORY_KEYS.includes(body.category)) return { error: "Catégorie inconnue." };
  const lat = body.lat === "" || body.lat == null ? null : Number(body.lat);
  const lng = body.lng === "" || body.lng == null ? null : Number(body.lng);
  if ((lat == null) !== (lng == null) || (lat != null && (!Number.isFinite(lat) || !Number.isFinite(lng)))) {
    return { error: "Latitude et longitude vont ensemble." };
  }
  const status = body.status === "published" ? "published" : "draft";
  const url = body.url ? clip(body.url, 400) : "";
  if (url && !/^https?:\/\//i.test(url)) return { error: "Le lien doit commencer par http ou https." };
  const values = [
    id,
    title,
    JSON.stringify(days),
    clip(body.time, 40),
    body.category,
    city,
    clip(body.venue, 140),
    clip(body.address, 180),
    lat,
    lng,
    clip(body.price, 80),
    Boolean(body.free),
    clip(body.description, 500),
    clip(body.source, 80),
    url,
    status,
  ];
  if (creating) {
    await db.query(
      `INSERT INTO events (
        id, title, days, time_label, category, city, venue, address,
        lat, lng, price, free, description, source_name, url, status
      ) VALUES (
        $1, $2, $3::jsonb, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16
      )`,
      values
    );
  } else {
    await db.query(
      `UPDATE events SET
        title = $2, days = $3::jsonb, time_label = $4, category = $5, city = $6,
        venue = $7, address = $8, lat = $9, lng = $10, price = $11, free = $12,
        description = $13, source_name = $14, url = $15, status = $16,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      values
    );
  }
  return { ok: true };
}

function mountRoutes(app, ctx) {
  const { db, secret } = ctx;
  const auth = requireAuth(secret);

  app.get("/api/agenda", wrap(async (req, res) => {
    res.json(await publicAgenda(db));
  }));

  app.get("/api/admin/session", wrap(async (req, res) => {
    const password = await getRaw(db, "admin_password_hash");
    res.json({
      needsSetup: !password,
      authenticated: Boolean(readSession(req, secret)),
    });
  }));

  app.post("/api/admin/setup", wrap(async (req, res) => {
    if (await getRaw(db, "admin_password_hash")) {
      res.status(409).json({ error: "Le mot de passe existe déjà." });
      return;
    }
    const password = String(req.body?.password || "");
    if (password.length < 8) {
      res.status(400).json({ error: "8 caractères minimum." });
      return;
    }
    await setRaw(db, "admin_password_hash", hashPassword(password));
    setSession(res, req, secret);
    res.json({ ok: true });
  }));

  app.post("/api/admin/login", wrap(async (req, res) => {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) {
      res.status(429).json({ error: "Trop d’essais. Réessaie dans quelques minutes." });
      return;
    }
    const stored = await getRaw(db, "admin_password_hash");
    if (!stored) {
      res.status(409).json({ error: "Choisis d’abord un mot de passe." });
      return;
    }
    if (!verifyPassword(String(req.body?.password || ""), stored)) {
      markFailure(ip);
      res.status(401).json({ error: "Mot de passe incorrect." });
      return;
    }
    clearFailures(ip);
    setSession(res, req, secret);
    res.json({ ok: true });
  }));

  app.post("/api/admin/logout", auth, (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  app.post("/api/admin/password", auth, wrap(async (req, res) => {
    const stored = await getRaw(db, "admin_password_hash");
    if (!verifyPassword(String(req.body?.current || ""), stored)) {
      res.status(401).json({ error: "Mot de passe actuel incorrect." });
      return;
    }
    const next = String(req.body?.next || "");
    if (next.length < 8) {
      res.status(400).json({ error: "8 caractères minimum." });
      return;
    }
    await setRaw(db, "admin_password_hash", hashPassword(next));
    res.json({ ok: true });
  }));

  app.get("/api/admin/settings", auth, wrap(async (req, res) => {
    res.json(await publicSettings(db, secret));
  }));

  app.put("/api/admin/settings", auth, wrap(async (req, res) => {
    const maps = clip(req.body?.googleMapsApiKey, 200);
    const gemini = clip(req.body?.geminiApiKey, 200);
    const model = clip(req.body?.model, 80);
    const cursor = clip(req.body?.cursorApiKey, 200);
    const hasProvider = req.body?.provider === "gemini" || req.body?.provider === "cursor";
    const hasCursorModel = typeof req.body?.cursorModel === "string";
    if (maps) await setSecret(db, secret, "google_maps_api_key", maps);
    if (gemini) await setSecret(db, secret, "gemini_api_key", gemini);
    if (cursor) await setSecret(db, secret, "cursor_api_key", cursor);
    if (model) await setRaw(db, "gemini_model", model);
    if (hasProvider) await setRaw(db, "llm_provider", req.body.provider);
    if (hasCursorModel) {
      const cursorModelName = clip(req.body.cursorModel, 80);
      if (cursorModelName) await setRaw(db, "cursor_model", cursorModelName);
      else await db.query("DELETE FROM settings WHERE key = 'cursor_model'");
    }
    if (!maps && !gemini && !cursor && !model && !hasProvider && !hasCursorModel) {
      res.status(400).json({ error: "Rien à enregistrer." });
      return;
    }
    res.json(await publicSettings(db, secret));
  }));

  app.post("/api/admin/settings/clear", auth, wrap(async (req, res) => {
    const which = req.body?.which;
    if (which === "maps") await db.query("DELETE FROM settings WHERE key = 'google_maps_api_key'");
    else if (which === "gemini") await db.query("DELETE FROM settings WHERE key = 'gemini_api_key'");
    else if (which === "cursor") {
      await db.query("DELETE FROM settings WHERE key = 'cursor_api_key'");
      await db.query("UPDATE settings SET value = 'gemini' WHERE key = 'llm_provider' AND value = 'cursor'");
    } else {
      res.status(400).json({ error: "Clé inconnue." });
      return;
    }
    res.json(await publicSettings(db, secret));
  }));

  app.post("/api/admin/settings/test-gemini", auth, wrap(async (req, res) => {
    const key = await geminiKey(db, secret);
    if (!key) {
      res.status(400).json({ error: "Enregistre d’abord la clé Gemini." });
      return;
    }
    const model = await geminiModel(db);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Réponds uniquement : OK" }] }],
          generationConfig: generationConfig(model, { maxOutputTokens: 256 }),
        }),
      }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.status(400).json({ error: body.error?.message || `Gemini HTTP ${response.status}` });
      return;
    }
    const text = visibleText(body).trim();
    res.json({ ok: true, model, reply: text.slice(0, 80) || "Réponse vide" });
  }));

  app.post("/api/admin/settings/test-cursor", auth, wrap(async (req, res) => {
    const key = await cursorKey(db, secret);
    if (!key) {
      res.status(400).json({ error: "Enregistre d’abord la clé Cursor." });
      return;
    }
    const account = await cursorAccount(key);
    res.json({ ok: true, name: account.apiKeyName || "Cursor" });
  }));

  app.get("/api/admin/sources", auth, wrap(async (req, res) => {
    const result = await db.query("SELECT id, name, url, enabled FROM sources ORDER BY name ASC");
    res.json({ sources: result.rows });
  }));

  app.post("/api/admin/sources", auth, wrap(async (req, res) => {
    const name = clip(req.body?.name, 80);
    const url = clip(req.body?.url, 400);
    if (name.length < 2) {
      res.status(400).json({ error: "Nom trop court." });
      return;
    }
    try {
      await assertPublicHttpUrl(url);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    const id = sourceId(name) || crypto.randomUUID();
    await db.query(
      `INSERT INTO sources (id, name, url, enabled)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url`,
      [id, name, url]
    );
    res.status(201).json({ id });
  }));

  app.post("/api/admin/sources/reset", auth, wrap(async (req, res) => {
    await ensureSources(db);
    res.json({ ok: true });
  }));

  app.patch("/api/admin/sources/:id", auth, wrap(async (req, res) => {
    if (!cleanId(req.params.id)) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    await db.query("UPDATE sources SET enabled = $2 WHERE id = $1", [req.params.id, Boolean(req.body?.enabled)]);
    res.json({ ok: true });
  }));

  app.delete("/api/admin/sources/:id", auth, wrap(async (req, res) => {
    if (!cleanId(req.params.id)) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    await db.query("DELETE FROM sources WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }));

  app.get("/api/admin/events", auth, wrap(async (req, res) => {
    const image = req.query.image === "proposed" ? "proposed" : null;
    const status = req.query.status === "draft" || req.query.status === "published" ? req.query.status : null;
    const result = image
      ? await db.query("SELECT * FROM events WHERE image_status = 'proposed' ORDER BY updated_at DESC LIMIT 300")
      : status
        ? await db.query("SELECT * FROM events WHERE status = $1 ORDER BY updated_at DESC LIMIT 300", [status])
        : await db.query("SELECT * FROM events ORDER BY updated_at DESC LIMIT 300");
    res.json({ events: result.rows.map((row) => mapEvent(row, { includeStatus: true })) });
  }));

  app.post("/api/admin/events/:id/image", auth, wrap(async (req, res) => {
    if (!cleanId(req.params.id)) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    const current = await db.query("SELECT id, url, image_url FROM events WHERE id = $1", [req.params.id]);
    if (!current.rows.length) {
      res.status(404).json({ error: "Événement introuvable." });
      return;
    }
    const decision = String(req.body?.decision || "");
    if (decision === "reject") {
      await db.query(
        "UPDATE events SET image_status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [req.params.id]
      );
    } else if (decision === "approve") {
      if (!httpUrl(current.rows[0].image_url)) {
        res.status(400).json({ error: "Aucune image à retenir." });
        return;
      }
      await db.query(
        "UPDATE events SET image_status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [req.params.id]
      );
    } else if (decision === "use") {
      const image = httpUrl(req.body?.url);
      if (!image) {
        res.status(400).json({ error: "L’adresse de l’image doit commencer par http ou https." });
        return;
      }
      await db.query(
        `UPDATE events
         SET image_url = $2, image_page = $3, image_status = 'approved', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [req.params.id, image, current.rows[0].url || image]
      );
    } else {
      res.status(400).json({ error: "Décision inconnue." });
      return;
    }
    const saved = await db.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
    res.json({ event: mapEvent(saved.rows[0], { includeStatus: true }) });
  }));

  app.post("/api/admin/events", auth, wrap(async (req, res) => {
    const id = sourceId(clip(req.body?.title, 80)) || crypto.randomUUID();
    const saved = await saveEventFields(db, id, req.body, { creating: true });
    if (saved.error) {
      res.status(400).json(saved);
      return;
    }
    res.status(201).json({ id });
  }));

  app.patch("/api/admin/events/:id", auth, wrap(async (req, res) => {
    if (!cleanId(req.params.id)) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    const current = await db.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
    if (!current.rows.length) {
      res.status(404).json({ error: "Événement introuvable." });
      return;
    }
    const merged = { ...mapEvent(current.rows[0], { includeStatus: true }), ...req.body };
    const saved = await saveEventFields(db, req.params.id, merged);
    if (saved.error) {
      res.status(400).json(saved);
      return;
    }
    res.json({ ok: true });
  }));

  app.post("/api/admin/events/publish-drafts", auth, wrap(async (req, res) => {
    const result = await db.query(
      "UPDATE events SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE status = 'draft'"
    );
    res.json({ count: result.rowCount || 0 });
  }));

  app.delete("/api/admin/events/:id", auth, wrap(async (req, res) => {
    if (!cleanId(req.params.id)) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    await db.query("DELETE FROM events WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }));

  app.get("/api/admin/schedule", auth, wrap(async (req, res) => {
    res.json(await schedulePayload(db));
  }));

  app.put("/api/admin/schedule", auth, wrap(async (req, res) => {
    try {
      res.json(await saveSchedule(db, req.body || {}));
    } catch (error) {
      if (error.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.get("/api/admin/runs", auth, wrap(async (req, res) => {
    const result = await db.query(
      "SELECT id, status, log, created_count, updated_count, error, started_at, finished_at, trigger_name FROM agent_runs ORDER BY started_at DESC NULLS LAST LIMIT 8"
    );
    res.json({ runs: result.rows, busy: runInProgress() });
  }));

  app.post("/api/admin/runs", auth, wrap(async (req, res) => {
    try {
      const id = await queueRun(ctx, "manual", req.body || {});
      if (!id) {
        res.status(409).json({ error: "Une collecte est déjà en cours." });
        return;
      }
      res.status(202).json({ id });
    } catch (error) {
      if (error.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));
}

module.exports = { mountRoutes };
