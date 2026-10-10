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

function summarizeMissing(rows) {
  const withLink = rows.filter(hasLink);
  const grouped = new Map();
  for (const row of withLink) {
    const key = pageKey(row.url);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const unique = [];
  let shared = 0;
  for (const [url, events] of grouped) {
    if (events.length === 1) unique.push({ url, event: events[0] });
    else shared += events.length;
  }
  unique.sort((left, right) => checkedTime(left.event) - checkedTime(right.event));
  return {
    missing: rows.length,
    noUrl: rows.length - withLink.length,
    uniquePages: unique.length,
    sharedEvents: shared,
    uncheckedPages: unique.filter((item) => !item.event.image_checked_at).length,
    unique,
  };
}

async function listMissingImages(db) {
  const result = await db.query(
    `SELECT id, title, url, status, image_checked_at
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
  summarizeMissing,
  listMissingImages,
  imageBacklog,
  markImagesChecked,
  resetImageChecks,
};
