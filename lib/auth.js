const crypto = require("node:crypto");

const COOKIE = "cav_session";
const WEEK = 7 * 24 * 60 * 60;

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(req, secret) {
  const header = req.headers.cookie || "";
  const part = header
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${COOKIE}=`));
  if (!part) return null;
  const token = decodeURIComponent(part.slice(COOKIE.length + 1));
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSession(res, req, secret) {
  const token = sign({ exp: Date.now() + WEEK * 1000, v: 1 }, secret);
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${WEEK}`,
  ];
  if (secure) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

module.exports = { readSession, setSession, clearSession };
