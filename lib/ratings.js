function shiftIsoDay(iso, delta) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

function weekdayNumber(iso) {
  const js = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return js === 0 ? 7 : js;
}

function openDates(weekdays, minDay, maxDay) {
  const wanted = new Set(
    (Array.isArray(weekdays) ? weekdays : [])
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  );
  if (!wanted.size || !minDay || !maxDay || minDay > maxDay) return [];
  const out = [];
  for (let day = minDay; day <= maxDay && out.length < 40; day = shiftIsoDay(day, 1)) {
    if (wanted.has(weekdayNumber(day))) out.push(day);
  }
  return out;
}

function clip(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function readScore(value) {
  const text = String(value ?? "").replace(",", ".").trim();
  if (!text || /\/\s*10\b/.test(text)) return null;
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const score = Number(match[1]);
  if (!Number.isFinite(score) || score < 1 || score > 5) return null;
  return Math.round(score * 10) / 10;
}

function readCount(value) {
  if (value == null || value === "") return 0;
  const match = String(value).replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const count = Math.round(Number(match[1]));
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function acceptWebRating(raw) {
  const reason = clip(raw?.reason, 240);
  const source = clip(raw?.source, 80);
  if (raw?.samePlace === false) {
    return { action: "clear", reason: reason || "Ce n’est pas le bon lieu." };
  }
  const score = readScore(raw?.score);
  const count = readCount(raw?.count);
  const sourceOk = source.length >= 3 && !/inconnu|aucune|introuvable|non trouv/i.test(source);
  if (score != null && sourceOk) {
    return { action: "keep", score, count, source, reason };
  }
  return { action: "skip", reason: reason || "Pas de note publique sur 5 pour cette salle." };
}

function blendRating({ status, score, count, source, votes }) {
  const webScore = readScore(score);
  const webCount = readCount(count);
  const webOk = status === "kept" && webScore != null && clip(source, 80).length >= 3;
  const app = (Array.isArray(votes) ? votes : [])
    .map((value) => Number(value))
    .filter((value) => value >= 1 && value <= 5);
  if (!webOk && app.length < 5) return null;
  let weight = 0;
  let sum = 0;
  if (webOk) {
    const block = webCount > 0 ? Math.min(webCount, 40) : 1;
    sum += webScore * block;
    weight += block;
  }
  for (const value of app) {
    sum += value;
    weight += 1;
  }
  if (!weight) return null;
  return {
    score: Math.round((sum / weight) * 10) / 10,
    count: (webOk && webCount > 0 ? webCount : 0) + app.length,
    source: webOk ? clip(source, 80) : "lecteurs",
  };
}

module.exports = { openDates, acceptWebRating, blendRating };
