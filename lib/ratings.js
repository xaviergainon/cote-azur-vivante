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

function acceptWebRating(raw) {
  const reason = clip(raw?.reason, 240);
  const source = clip(raw?.source, 80);
  if (raw?.samePlace === false) {
    return { action: "clear", reason: reason || "Ce n’est pas le bon lieu." };
  }
  const score = Number(raw?.score);
  const count = Number(raw?.count);
  const scoreOk = Number.isFinite(score) && score >= 1 && score <= 5;
  const countOk = Number.isInteger(count) && count >= 8;
  const sourceOk = source.length >= 3 && !/inconnu|aucune|introuvable|non trouv/i.test(source);
  if (raw?.keep === true && raw?.samePlace === true && scoreOk && countOk && sourceOk) {
    return {
      action: "keep",
      score: Math.round(score * 10) / 10,
      count,
      source,
      reason,
    };
  }
  return { action: "skip", reason: reason || "Pas assez d’avis pour publier une note." };
}

function blendRating({ status, score, count, source, votes }) {
  const webScore = Number(score);
  const webCount = Number(count);
  const webOk = status === "kept" && webScore >= 1 && webScore <= 5 && Number.isInteger(webCount) && webCount >= 8;
  const app = (Array.isArray(votes) ? votes : [])
    .map((value) => Number(value))
    .filter((value) => value >= 1 && value <= 5);
  if (!webOk && app.length < 5) return null;
  let weight = 0;
  let sum = 0;
  if (webOk) {
    const block = Math.min(webCount, 40);
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
    count: (webOk ? webCount : 0) + app.length,
    source: webOk ? clip(source, 80) : "lecteurs",
  };
}

module.exports = { openDates, acceptWebRating, blendRating };
