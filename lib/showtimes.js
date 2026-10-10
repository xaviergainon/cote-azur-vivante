function acceptTime(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 12) return "";
  if (/\d\s*(?:h|:)?\s*[-–/]\s*\d/i.test(raw)) return "";
  const match = raw.toLowerCase().replace(/\s+/g, "").match(/^(\d{1,2})(?:h|:)(\d{2})?$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minutes = match[2] || "";
  if (hour > 23) return "";
  if (minutes && Number(minutes) > 59) return "";
  if (!minutes || minutes === "00") return `${hour}h`;
  return `${hour}h${minutes}`;
}

function listingPage(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.pathname === "/" || parsed.pathname === "";
  } catch {
    return false;
  }
}

module.exports = { acceptTime, listingPage };
