const { foldText } = require("./duplicates");

function pageKey(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return String(raw || "");
  }
}

function hasLink(row) {
  return /^https?:\/\//i.test(row.url || "");
}

function checkedTime(row) {
  if (!row.image_checked_at) return 0;
  const time = new Date(row.image_checked_at).getTime();
  return Number.isFinite(time) ? time : 0;
}

function samePage(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function textMentions(text, title) {
  const wanted = foldText(title);
  return wanted.length >= 8 && foldText(text).includes(wanted);
}

function dedicatedLink(links, title, listingUrl) {
  const wanted = foldText(title);
  if (wanted.length < 8) return "";
  const hrefs = new Set();
  for (const link of links || []) {
    if (!textMentions(link.text, title)) continue;
    if (!link.href || samePage(link.href, listingUrl)) continue;
    if (/google\.|gstatic|facebook\.com|instagram\.com|wikipedia\.org|youtube\.com|youtu\.be/i.test(link.href)) continue;
    hrefs.add(link.href);
  }
  return hrefs.size === 1 ? [...hrefs][0] : "";
}

function summarizeMissing(rows) {
  const withLink = rows.filter(hasLink);
  const grouped = new Map();
  for (const row of withLink) {
    const key = pageKey(row.url);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const unique = [];
  const shared = [];
  for (const [url, events] of grouped) {
    if (events.length === 1) unique.push({ url, event: events[0], shared: false });
    else {
      for (const event of events) shared.push({ url, event, shared: true });
    }
  }
  return {
    missing: rows.length,
    noUrl: rows.length - withLink.length,
    uniquePages: unique.length,
    sharedEvents: shared.length,
    uncheckedPages: unique.filter((item) => !item.event.image_checked_at).length,
    uncheckedShared: shared.filter((item) => !item.event.image_checked_at).length,
    unique,
    shared,
  };
}

function firstDay(event) {
  let days = event.days;
  if (typeof days === "string") {
    try {
      days = JSON.parse(days);
    } catch {
      days = [];
    }
  }
  if (!Array.isArray(days) || !days.length) return "9999-99-99";
  return days.map((day) => String(day).slice(0, 10)).sort()[0];
}

function queueMissing(summary) {
  return [...summary.unique, ...summary.shared].sort((left, right) => {
    const leftChecked = checkedTime(left.event);
    const rightChecked = checkedTime(right.event);
    if (!leftChecked !== !rightChecked) return leftChecked ? 1 : -1;
    if (!leftChecked && left.shared !== right.shared) return left.shared ? 1 : -1;
    if (!leftChecked) return firstDay(left.event).localeCompare(firstDay(right.event));
    return leftChecked - rightChecked;
  });
}

async function listMissingImages(db) {
  const result = await db.query(
    `SELECT id, title, venue, city, url, status, image_checked_at, days
     FROM events
     WHERE status IN ('draft', 'published')
       AND COALESCE(image_url, '') = ''`
  );
  return result.rows;
}

async function imageBacklog(db) {
  const summary = summarizeMissing(await listMissingImages(db));
  return {
    missing: summary.missing,
    noUrl: summary.noUrl,
    uniquePages: summary.uniquePages,
    sharedEvents: summary.sharedEvents,
    uncheckedPages: summary.uncheckedPages,
    uncheckedShared: summary.uncheckedShared,
  };
}

async function markImagesChecked(db, ids) {
  for (const id of ids) {
    await db.query(
      "UPDATE events SET image_checked_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );
  }
}

async function resetImageChecks(db) {
  await db.query(
    `UPDATE events
     SET image_checked_at = NULL
     WHERE status IN ('draft', 'published')
       AND COALESCE(image_url, '') = ''`
  );
}

module.exports = {
  pageKey,
  dedicatedLink,
  textMentions,
  summarizeMissing,
  queueMissing,
  listMissingImages,
  imageBacklog,
  markImagesChecked,
  resetImageChecks,
};
