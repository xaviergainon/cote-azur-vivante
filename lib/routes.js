const crypto = require("node:crypto");
const { CATEGORY_KEYS } = require("./defaults");
const { readSession, setSession, clearSession } = require("./auth");
const { hashPassword, verifyPassword, hint } = require("./secrets");
const { getRaw, setRaw, setSecret, publicSettings, geminiKey, geminiModel, cursorKey, mapsKey } = require("./settings");
const { cursorAccount } = require("./cursor");
const { ensureSources, sourceId } = require("./seed");
const { assertPublicHttpUrl, fetchPublicPage } = require("./fetch-page");
const { mapEvent, publicAgenda, httpUrl } = require("./agenda");
const { queueRun, runInProgress, interruptRun, generationConfig, visibleText } = require("./agent");
const { imageBacklog, resetImageChecks, dedicatedLink, textMentions } = require("./images");
const { buildReport } = require("./report");
const { notifyConfig, saveNotify, sendReportNow } = require("./mail");
const { schedulePayload, saveSchedule } = require("./schedule");
const { BRIEF_LABELS, DEFAULT_BRIEFS, loadBriefs, saveBriefs, resetBriefs } = require("./briefs");
const { saveVenue, attachKnownPlaces, copyPlacePoint, locateMissingPlaces, geocodeAddress, ensurePlacePoint, PLACE_KINDS } = require("./venues");
const { publicAds, readAds, saveAds } = require("./ads");

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
  const value = String(id || "");
  return /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : "";
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
  const status = body.status === "published" || body.status === "cancelled" ? body.status : "draft";
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
    const payload = await publicAgenda(db);
    const ads = await publicAds(db);
    if (ads) payload.ads = ads;
    res.json(payload);
  }));

  app.put("/api/admin/ads", auth, wrap(async (req, res) => {
    try {
      res.json(await saveAds(db, req.body || {}));
    } catch (error) {
      if (error.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
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

  async function settingsPayload() {
    const settings = await publicSettings(db, secret);
    settings.ads = await readAds(db);
    return settings;
  }

  app.get("/api/admin/settings", auth, wrap(async (req, res) => {
    res.json(await settingsPayload());
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
    res.json(await settingsPayload());
  }));

  app.post("/api/admin/settings/clear", auth, wrap(async (req, res) => {
    const which = req.body?.which;
    if (which === "maps") await db.query("DELETE FROM settings WHERE key = 'google_maps_api_key'");
    else if (which === "gemini") await db.query("DELETE FROM settings WHERE key = 'gemini_api_key'");
    else if (which === "cursor") await db.query("DELETE FROM settings WHERE key = 'cursor_api_key'");
    else {
      res.status(400).json({ error: "Clé inconnue." });
      return;
    }
    res.json(await settingsPayload());
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
    const result = await db.query("SELECT id, name, url, enabled, kind FROM sources ORDER BY name ASC");
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
    const kind = ["agenda", "library", "reviews"].includes(req.body?.kind) ? req.body.kind : "agenda";
    const id = sourceId(name) || crypto.randomUUID();
    await db.query(
      `INSERT INTO sources (id, name, url, enabled, kind)
       VALUES ($1, $2, $3, TRUE, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, kind = EXCLUDED.kind`,
      [id, name, url, kind]
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
    const image = req.query.image === "proposed" || req.query.image === "missing" ? req.query.image : null;
    const flag = req.query.flag === "missing" ? "missing" : null;
    const status = ["draft", "published", "cancelled"].includes(req.query.status) ? req.query.status : null;
    const place = ["no-address", "shared", "no-point"].includes(req.query.place) ? req.query.place : null;
    const term = String(req.query.q || "").replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    const where = [];
    const params = [];
    if (image === "proposed") where.push("events.image_status = 'proposed'");
    else if (image === "missing") where.push("events.status IN ('draft', 'published') AND COALESCE(events.image_url, '') = ''");
    else if (flag) where.push("events.flag_status = 'missing' AND events.status <> 'cancelled'");
    else if (status) {
      params.push(status);
      where.push(`events.status = $${params.length}`);
    }
    if (place === "no-address") where.push("events.status <> 'cancelled' AND COALESCE(BTRIM(events.address), '') = ''");
    if (place === "no-point") where.push("events.status <> 'cancelled' AND (events.lat IS NULL OR events.lng IS NULL)");
    if (place === "shared") {
      where.push(`events.status <> 'cancelled' AND events.lat IS NOT NULL AND events.lng IS NOT NULL AND EXISTS (
        SELECT 1 FROM events other
        WHERE other.id <> events.id
          AND other.status <> 'cancelled'
          AND other.lat IS NOT NULL AND other.lng IS NOT NULL
          AND ABS(other.lat - events.lat) < 0.0002
          AND ABS(other.lng - events.lng) < 0.0002
      )`);
    }
    if (term) {
      params.push(`%${term}%`);
      const slot = `$${params.length}`;
      where.push(`(events.title ILIKE ${slot} OR events.city ILIKE ${slot} OR COALESCE(events.venue, '') ILIKE ${slot} OR COALESCE(events.address, '') ILIKE ${slot})`);
    }
    const order = image === "missing"
      ? "events.image_checked_at ASC NULLS FIRST, events.updated_at ASC"
      : "events.updated_at DESC";
    const limit = term || place ? 800 : 300;
    const result = await db.query(
      `SELECT events.*, places.name AS place_name,
         places.lat AS place_lat, places.lng AS place_lng, places.address AS place_address, (
         SELECT COUNT(*)::int FROM events other
         WHERE other.id <> events.id
           AND other.status <> 'cancelled'
           AND events.lat IS NOT NULL AND events.lng IS NOT NULL
           AND other.lat IS NOT NULL AND other.lng IS NOT NULL
           AND ABS(other.lat - events.lat) < 0.0002
           AND ABS(other.lng - events.lng) < 0.0002
       ) AS place_share
       FROM events
       LEFT JOIN places ON places.id = events.place_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${order}
       LIMIT ${limit}`,
      params
    );
    res.json({ events: result.rows.map((row) => mapEvent(row, { includeStatus: true })) });
  }));

  app.get("/api/admin/places", auth, wrap(async (req, res) => {
    const status = ["draft", "published"].includes(req.query.status) ? req.query.status : "draft";
    const result = await db.query(
      "SELECT * FROM places WHERE status = $1 ORDER BY city ASC, name ASC LIMIT 300",
      [status]
    );
    res.json({ places: result.rows });
  }));

  app.post("/api/admin/places", auth, wrap(async (req, res) => {
    const saved = await saveVenue(db, req.body || {});
    if (saved.action === "skipped") {
      res.status(400).json({ error: "Nom et commune précise requis. Le point, s’il est indiqué, doit être dans les Alpes-Maritimes ou à Monaco." });
      return;
    }
    res.json(saved);
  }));

  app.patch("/api/admin/places/:id", auth, wrap(async (req, res) => {
    const id = cleanId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    const body = req.body || {};
    const kind = PLACE_KINDS.includes(body.kind) ? body.kind : "other";
    let lat = body.lat === "" || body.lat == null ? null : Number(body.lat);
    let lng = body.lng === "" || body.lng == null ? null : Number(body.lng);
    let address = clip(body.address, 180);
    lat = Number.isFinite(lat) ? lat : null;
    lng = Number.isFinite(lng) ? lng : null;
    if (((lat == null || lng == null) && address) || (lat != null && lng != null && !address)) {
      try {
        const key = await mapsKey(db, secret);
        const filled = await ensurePlacePoint({ lat, lng, address, city: clip(body.city, 80) }, key);
        lat = filled.lat;
        lng = filled.lng;
        address = filled.address || address;
      } catch (error) {
        if (error.code !== "REQUEST_DENIED" && error.code !== "OVER_QUERY_LIMIT") throw error;
      }
    }
    const result = await db.query(
      `UPDATE places SET
        name = $2, city = $3, address = $4, lat = $5, lng = $6, hours = $7, website = $8, kind = $9,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id`,
      [
        id,
        clip(body.name, 140),
        clip(body.city, 80),
        address,
        lat,
        lng,
        clip(body.hours, 180),
        clip(body.website, 400),
        kind,
      ]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: "Lieu introuvable." });
      return;
    }
    const copied = await copyPlacePoint(db, { id, lat, lng, address });
    res.json({ ok: true, copied });
  }));

  app.post("/api/admin/places/locate", auth, wrap(async (req, res) => {
    const key = await mapsKey(db, secret);
    if (!key) {
      res.status(400).json({ error: "Clé Google Maps absente." });
      return;
    }
    try {
      res.json(await locateMissingPlaces(db, key));
    } catch (error) {
      if (error.code === "REQUEST_DENIED" || error.code === "OVER_QUERY_LIMIT") {
        res.status(502).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/admin/places/:id/decision", auth, wrap(async (req, res) => {
    const id = cleanId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    if (req.body?.decision === "publish") {
      const updated = await db.query(
        "UPDATE places SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'draft' RETURNING id",
        [id]
      );
      if (!updated.rows.length) {
        res.status(404).json({ error: "Brouillon introuvable." });
        return;
      }
      const place = (await db.query("SELECT id, address, city, lat, lng FROM places WHERE id = $1", [id])).rows[0];
      if (place && (place.lat == null || place.lng == null)) {
        try {
          const key = await mapsKey(db, secret);
          const point = await geocodeAddress(key, place.address, place.city);
          if (point) {
            await db.query(
              "UPDATE places SET lat = $2, lng = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
              [id, point.lat, point.lng]
            );
          }
        } catch (error) {
          if (error.code !== "REQUEST_DENIED" && error.code !== "OVER_QUERY_LIMIT") throw error;
        }
      }
      const linked = await attachKnownPlaces(db);
      res.json({ ok: true, attached: linked.attached });
      return;
    }
    if (req.body?.decision === "reject") {
      await db.query("UPDATE events SET place_id = NULL WHERE place_id = $1", [id]);
      await db.query("DELETE FROM booking_links WHERE target_type = 'place' AND target_id = $1 AND status = 'proposed'", [id]);
      const removed = await db.query("DELETE FROM places WHERE id = $1 AND status = 'draft' RETURNING id", [id]);
      if (!removed.rows.length) {
        res.status(404).json({ error: "Brouillon introuvable." });
        return;
      }
      res.json({ ok: true });
      return;
    }
    res.status(400).json({ error: "Décision inconnue." });
  }));

  app.get("/api/admin/bookings", auth, wrap(async (req, res) => {
    const status = ["proposed", "approved", "rejected"].includes(req.query.status) ? req.query.status : "proposed";
    const result = await db.query(
      `SELECT booking_links.*,
        CASE WHEN booking_links.target_type = 'place' THEN places.name ELSE events.title END AS target_name,
        CASE WHEN booking_links.target_type = 'place' THEN places.city ELSE events.city END AS target_city
       FROM booking_links
       LEFT JOIN places ON booking_links.target_type = 'place' AND places.id = booking_links.target_id
       LEFT JOIN events ON booking_links.target_type = 'event' AND events.id = booking_links.target_id
       WHERE booking_links.status = $1
       ORDER BY booking_links.created_at DESC
       LIMIT 200`,
      [status]
    );
    res.json({ bookings: result.rows });
  }));

  app.post("/api/admin/bookings/:id/decision", auth, wrap(async (req, res) => {
    const id = cleanId(req.params.id);
    const status = req.body?.decision === "approve" ? "approved" : req.body?.decision === "reject" ? "rejected" : "";
    if (!id || !status) {
      res.status(400).json({ error: "Décision inconnue." });
      return;
    }
    const updated = await db.query(
      "UPDATE booking_links SET status = $2 WHERE id = $1 AND status = 'proposed' RETURNING id",
      [id, status]
    );
    if (!updated.rows.length) {
      res.status(404).json({ error: "Proposition introuvable." });
      return;
    }
    res.json({ ok: true });
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

  app.post("/api/admin/events/:id/flag", auth, wrap(async (req, res) => {
    if (!cleanId(req.params.id)) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    const current = await db.query("SELECT id FROM events WHERE id = $1", [req.params.id]);
    if (!current.rows.length) {
      res.status(404).json({ error: "Événement introuvable." });
      return;
    }
    const decision = String(req.body?.decision || "");
    if (decision === "delete") {
      await db.query("DELETE FROM events WHERE id = $1", [req.params.id]);
      res.json({ ok: true });
      return;
    }
    if (decision === "cancel") {
      await db.query(
        `UPDATE events
         SET status = 'cancelled', flag_status = NULL, flag_note = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [req.params.id]
      );
      res.json({ ok: true });
      return;
    }
    if (decision === "keep") {
      await db.query(
        "UPDATE events SET flag_status = NULL, flag_note = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [req.params.id]
      );
      res.json({ ok: true });
      return;
    }
    res.status(400).json({ error: "Décision inconnue." });
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

  app.get("/api/admin/briefs", auth, wrap(async (req, res) => {
    res.json({ briefs: await loadBriefs(db), defaults: DEFAULT_BRIEFS, labels: BRIEF_LABELS });
  }));

  app.put("/api/admin/briefs", auth, wrap(async (req, res) => {
    try {
      res.json({ briefs: await saveBriefs(db, req.body || {}), defaults: DEFAULT_BRIEFS, labels: BRIEF_LABELS });
    } catch (error) {
      if (error.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/admin/briefs/reset", auth, wrap(async (req, res) => {
    res.json({ briefs: await resetBriefs(db), defaults: DEFAULT_BRIEFS, labels: BRIEF_LABELS });
  }));

  app.post("/api/admin/events/:id/find-image", auth, wrap(async (req, res) => {
    if (!cleanId(req.params.id)) {
      res.status(400).json({ error: "Identifiant invalide." });
      return;
    }
    const current = await db.query("SELECT id, title, url FROM events WHERE id = $1", [req.params.id]);
    if (!current.rows.length) {
      res.status(404).json({ error: "Événement introuvable." });
      return;
    }
    const pageUrl = httpUrl(current.rows[0].url);
    if (!pageUrl) {
      res.status(400).json({ error: "Cette sortie n’a pas de lien." });
      return;
    }
    const page = await fetchPublicPage(pageUrl);
    const link = dedicatedLink(page.links, current.rows[0].title, page.pageUrl || pageUrl);
    if (link) {
      const own = await fetchPublicPage(link);
      if (own.image && textMentions(own.text, current.rows[0].title)) {
        res.json({ image: own.image, pageUrl: own.pageUrl || link });
        return;
      }
    }
    if (!page.image) {
      res.status(404).json({ error: link ? "Aucune affiche sur la page du spectacle." : "Aucune affiche sur cette page." });
      return;
    }
    res.json({ image: page.image, pageUrl: page.pageUrl || pageUrl });
  }));

  app.get("/api/admin/report", auth, wrap(async (req, res) => {
    const report = await buildReport(db);
    const config = await notifyConfig(db, secret);
    report.notify.resend = { configured: Boolean(config.key), hint: hint(config.key) };
    res.json(report);
  }));

  app.put("/api/admin/notify", auth, wrap(async (req, res) => {
    try {
      await saveNotify(db, secret, req.body || {});
      const report = await buildReport(db);
      const config = await notifyConfig(db, secret);
      report.notify.resend = { configured: Boolean(config.key), hint: hint(config.key) };
      res.json(report);
    } catch (error) {
      if (error.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/admin/notify/test", auth, wrap(async (req, res) => {
    try {
      res.json(await sendReportNow(ctx, "Rapport demandé depuis l’administration."));
    } catch (error) {
      if (error.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/admin/images/reset", auth, wrap(async (req, res) => {
    await resetImageChecks(db);
    res.json(await imageBacklog(db));
  }));

  app.get("/api/admin/runs", auth, wrap(async (req, res) => {
    const result = await db.query(
      "SELECT id, status, log, created_count, updated_count, error, started_at, finished_at, trigger_name FROM agent_runs WHERE COALESCE(log, '') <> 'Compté dans le pilote.\n' ORDER BY started_at DESC NULLS LAST LIMIT 8"
    );
    const backlog = await imageBacklog(db);
    res.json({
      runs: result.rows,
      busy: runInProgress(),
      missingImages: backlog.missing,
      imageBacklog: backlog,
    });
  }));

  app.post("/api/admin/runs/stop", auth, wrap(async (req, res) => {
    const id = interruptRun();
    if (id) {
      res.status(202).json({ id, stopping: true });
      return;
    }
    const updated = await db.query(
      `UPDATE agent_runs
       SET status = 'stopped', finished_at = CURRENT_TIMESTAMP
       WHERE status IN ('queued', 'running') AND finished_at IS NULL
       RETURNING id`
    );
    if (!updated.rows.length) {
      res.status(409).json({ error: "Aucune collecte en cours." });
      return;
    }
    res.json({ stopping: false, ids: updated.rows.map((row) => row.id) });
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
