const path = require("node:path");
const express = require("express");
const { initDb, ROOT } = require("./lib/db");
const { bootstrap } = require("./lib/seed");
const { mapsKey } = require("./lib/settings");
const { mountRoutes } = require("./lib/routes");
const { startScheduler } = require("./lib/schedule");
const { adsTxtBody } = require("./lib/ads");

function mapsConfigScript(key) {
  return `window.MAPS_CONFIG = ${JSON.stringify({
    googleMapsApiKey: key || "",
    mapId: null,
  })};\n`;
}

async function main() {
  const ctx = await initDb();
  await bootstrap(ctx.db, ctx.secret);

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  mountRoutes(app, ctx);

  app.get("/health", (req, res) => {
    res.type("text/plain").send("ok");
  });

  app.get("/ads.txt", async (req, res, next) => {
    try {
      const body = await adsTxtBody(ctx.db);
      res.set("Cache-Control", "public, max-age=300");
      res.type("text/plain").send(body);
    } catch (error) {
      next(error);
    }
  });

  app.get("/js/config.js", async (req, res, next) => {
    try {
      const key = await mapsKey(ctx.db, ctx.secret);
      res.set("Cache-Control", "no-store");
      res.type("application/javascript").send(mapsConfigScript(key));
    } catch (error) {
      next(error);
    }
  });

  app.get(["/admin", "/admin/"], (req, res) => {
    res.sendFile(path.join(ROOT, "admin", "index.html"));
  });

  app.get("/", (req, res) => {
    res.sendFile(path.join(ROOT, "index.html"));
  });

  app.use("/css", express.static(path.join(ROOT, "css"), { maxAge: "5m" }));
  app.use("/js", express.static(path.join(ROOT, "js"), { maxAge: "5m" }));

  app.use((req, res) => {
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: "Introuvable." });
      return;
    }
    res.status(404).type("text/plain").send("Introuvable");
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error(error);
    const message = error.name === "TimeoutError" ? "Délai dépassé." : "Erreur interne.";
    if (req.path.startsWith("/api") || req.path === "/js/config.js") {
      res.status(500).json({ error: message });
      return;
    }
    res.status(500).type("text/plain").send(message);
  });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, "0.0.0.0", () => {
    const where = ctx.db.kind === "postgres" ? "Postgres" : "base locale (.data)";
    console.log(`Côte d'Azur Vivante sur 0.0.0.0:${port} — ${where}`);
    startScheduler(ctx);
  });

  async function shutdown() {
    server.close();
    await ctx.db.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
