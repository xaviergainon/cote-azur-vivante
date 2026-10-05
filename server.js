const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const ROOT = path.resolve(__dirname);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function mapsConfigSource() {
  const key = process.env.GOOGLE_MAPS_API_KEY || "";
  const mapId = process.env.GOOGLE_MAPS_MAP_ID || null;
  return `window.MAPS_CONFIG = ${JSON.stringify({
    googleMapsApiKey: key,
    mapId,
  })};\n`;
}

function resolvePublicFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  if (rel === "/") rel = "/index.html";

  const file = path.resolve(ROOT, `.${rel}`);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (file !== ROOT && !file.startsWith(rootWithSep)) return null;
  if (path.basename(file).startsWith(".")) return null;
  return file;
}

function send(res, status, body, headers, method) {
  res.writeHead(status, headers);
  if (method === "HEAD") res.end();
  else res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed", { "Content-Type": "text/plain; charset=utf-8" }, req.method);
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname === "/health") {
    send(res, 200, "ok", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, req.method);
    return;
  }

  if (url.pathname === "/js/config.js") {
    const localConfig = path.join(ROOT, "js", "config.js");
    const useEnv = Boolean(process.env.GOOGLE_MAPS_API_KEY);
    if (!useEnv && fs.existsSync(localConfig)) {
      fs.readFile(localConfig, (err, data) => {
        if (err) {
          send(res, 500, "config unreadable", { "Content-Type": "text/plain; charset=utf-8" }, req.method);
          return;
        }
        send(
          res,
          200,
          data,
          { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
          req.method
        );
      });
      return;
    }

    send(
      res,
      200,
      mapsConfigSource(),
      { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
      req.method
    );
    return;
  }

  const file = resolvePublicFile(url.pathname);
  if (!file) {
    send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" }, req.method);
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" }, req.method);
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=300" });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Côte d'Azur Vivante listening on ${HOST}:${PORT}`);
});
