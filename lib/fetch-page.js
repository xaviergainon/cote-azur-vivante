const dns = require("node:dns").promises;
const net = require("node:net");

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

async function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL invalide");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Seuls les liens http et https sont acceptés");
  }
  if (url.username || url.password) throw new Error("URL refusée");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Hôte refusé");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Adresse privée refusée");
    return url;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error("Hôte introuvable");
  if (records.some((record) => isPrivateIp(record.address))) {
    throw new Error("Adresse privée refusée");
  }
  return url;
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPublicPage(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop < 3; hop += 1) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "text/html, text/plain;q=0.9",
        "User-Agent": "CoteAzurVivante/1.0 (collecte d'agendas publics)",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirection sans cible");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      throw new Error(`Contenu ignoré (${type.split(";")[0] || "inconnu"})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 800000) throw new Error("Page trop volumineuse");
    const text = htmlToText(bytes.toString("utf8"));
    if (text.length < 180) throw new Error("Page trop courte, souvent un site rendu seulement en JavaScript");
    return text.slice(0, 22000);
  }
  throw new Error("Trop de redirections");
}

module.exports = { assertPublicHttpUrl, fetchPublicPage };
