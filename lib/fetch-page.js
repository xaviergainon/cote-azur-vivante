const dns = require("node:dns").promises;
const net = require("node:net");

function v4FromGroups(hiText, loText) {
  const hi = Number.parseInt(hiText, 16);
  const lo = Number.parseInt(loText, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 0xffff || lo > 0xffff) return "";
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function embeddedV4(lower) {
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const groups = lower.match(/^(?:::ffff:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    || lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  return groups ? v4FromGroups(groups[1], groups[2]) : "";
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (parts.some((part) => !Number.isInteger(part) || part > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const embedded = embeddedV4(lower);
    if (embedded) return isPrivateIp(embedded);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("ff")
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
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host === "metadata.google.internal"
    || host.endsWith(".internal")
    || /^\d+$/.test(host)
    || /^0x[0-9a-f.]+$/i.test(host)
  ) {
    throw new Error("Hôte refusé");
  }
  if (/^(\d+\.)+\d+$/.test(host)) {
    const parts = host.split(".");
    const odd = parts.length !== 4 || parts.some((part) => Number(part) > 255 || (part.length > 1 && part.startsWith("0")));
    if (odd) throw new Error("Hôte refusé");
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

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function metaContents(html, key) {
  const found = [];
  const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`(?:property|name)\\s*=\\s*["']${escaped}["']`, "i");
  for (const tag of tags) {
    if (!keyRe.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (content) found.push(decodeEntities(content[1]));
  }
  return found;
}

function posterFromHtml(html, baseUrl) {
  const images = metaContents(html, "og:image");
  const widths = metaContents(html, "og:image:width").map((value) => Number(value) || 0);
  const heights = metaContents(html, "og:image:height").map((value) => Number(value) || 0);
  const candidates = images.map((url, index) => ({
    url,
    width: widths[index] || 0,
    height: heights[index] || 0,
  }));
  for (const url of [
    ...metaContents(html, "og:image:secure_url"),
    ...metaContents(html, "twitter:image"),
    ...metaContents(html, "twitter:image:src"),
  ]) {
    candidates.push({ url, width: 0, height: 0 });
  }
  for (const candidate of candidates) {
    const poster = usablePoster(candidate.url, baseUrl, candidate);
    if (poster) return poster;
  }
  return "";
}

function usablePoster(raw, baseUrl, declared = {}) {
  let url;
  try {
    url = new URL(String(raw || "").trim(), baseUrl);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const path = `${url.hostname}${url.pathname}`.toLowerCase();
  if (/\.(svg|gif|ico)($|\?)/.test(url.pathname.toLowerCase())) return "";
  if (/logo|favicon|sprite|pixel|spacer|1x1|tracking|badge|avatar|emoji/.test(path)) return "";
  if (/banner|hero|slider|slide-|placeholder|default-share|partage|social-card|og-default|site-banner|accueil/.test(path)) return "";
  if (/google\.|gstatic|gravatar|facebook\.com\/tr|doubleclick/.test(path)) return "";
  const width = Number(url.searchParams.get("w") || url.searchParams.get("width") || declared.width || 0);
  const height = Number(url.searchParams.get("h") || url.searchParams.get("height") || declared.height || 0);
  if ((width && width < 320) || (height && height < 180)) return "";
  return url.href.slice(0, 500);
}

function anchorLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = re.exec(String(html));
  while (match) {
    const href = decodeEntities(match[1]).trim();
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    match = re.exec(String(html));
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    links.push({ href: url.href, text: text.slice(0, 240) });
  }
  return links;
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

async function fetchPublicPage(startUrl, signal) {
  let current = startUrl;
  for (let hop = 0; hop < 3; hop += 1) {
    if (signal?.aborted) throw signal.reason || new Error("Collecte interrompue.");
    await assertPublicHttpUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "text/html, text/plain;q=0.9",
        "User-Agent": "CoteAzurVivante/1.0 (collecte d'agendas publics)",
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
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
    const html = bytes.toString("utf8");
    const text = htmlToText(html);
    if (text.length < 180) throw new Error("Page trop courte, souvent un site rendu seulement en JavaScript");
    return {
      text: text.slice(0, 22000),
      image: posterFromHtml(html, current),
      pageUrl: current,
      links: anchorLinks(html, current),
    };
  }
  throw new Error("Trop de redirections");
}

module.exports = { assertPublicHttpUrl, fetchPublicPage, posterFromHtml, usablePoster, anchorLinks };
