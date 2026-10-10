const { CATEGORIES } = require("./defaults");
const { imageBacklog } = require("./images");
const { getRaw } = require("./settings");

const DEFAULT_NOTIFY_EMAIL = "xavier.gainon@gmail.com";
const DEFAULT_NOTIFY_FROM = "Côte d'Azur Vivante <onboarding@resend.dev>";

function parisDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftIsoDay(iso, delta) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

function countMap(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(row[key], Number(row.total || 0));
  return map;
}

async function buildReport(db) {
  const today = parisDay();
  const minDay = shiftIsoDay(today, -1);
  const maxDay = shiftIsoDay(today, 30);
  const [statuses, images, categories, cities, days, lastRun, backlog, notifyEmail, notifyFrom] = await Promise.all([
    db.query("SELECT status, COUNT(*) AS total FROM events GROUP BY status"),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE(image_url, '') <> '') AS with_image,
         COUNT(*) FILTER (WHERE COALESCE(image_url, '') = '') AS without_image,
         COUNT(*) FILTER (WHERE image_status = 'proposed' AND COALESCE(image_url, '') <> '') AS proposed,
         COUNT(*) FILTER (WHERE image_status = 'approved' AND COALESCE(image_url, '') <> '') AS approved,
         COUNT(*) FILTER (WHERE free) AS free_count
       FROM events
       WHERE status IN ('draft', 'published')`
    ),
    db.query(
      `SELECT category, COUNT(*) AS total
       FROM events
       WHERE status IN ('draft', 'published')
       GROUP BY category`
    ),
    db.query(
      `SELECT city, COUNT(*) AS total
       FROM events
       WHERE status IN ('draft', 'published') AND COALESCE(city, '') <> ''
       GROUP BY city
       ORDER BY total DESC, city ASC
       LIMIT 8`
    ),
    db.query(
      `SELECT day, COUNT(*) AS total
       FROM (
         SELECT jsonb_array_elements_text(days) AS day
         FROM events
         WHERE status IN ('draft', 'published')
       ) listed
       WHERE day >= $1 AND day <= $2
       GROUP BY day`,
      [minDay, maxDay]
    ),
    db.query(
      `SELECT status, trigger_name, created_count, updated_count, error, started_at, finished_at,
              LEFT(log, 700) AS log
       FROM agent_runs
       WHERE COALESCE(log, '') <> 'Compté dans le pilote.\n'
       ORDER BY started_at DESC NULLS LAST
       LIMIT 1`
    ),
    imageBacklog(db),
    getRaw(db, "notify_email"),
    getRaw(db, "notify_from"),
  ]);
  const byStatus = countMap(statuses.rows, "status");
  const byCategory = countMap(categories.rows, "category");
  const byDay = countMap(days.rows, "day");
  const picture = images.rows[0] || {};
  const active = (byStatus.get("draft") || 0) + (byStatus.get("published") || 0);
  const withImage = Number(picture.with_image || 0);
  const series = [];
  for (let day = minDay; day <= maxDay; day = shiftIsoDay(day, 1)) {
    series.push({ day, total: byDay.get(day) || 0 });
  }
  return {
    generatedAt: new Date().toISOString(),
    today,
    window: { minDay, maxDay },
    totals: {
      all: [...byStatus.values()].reduce((sum, value) => sum + value, 0),
      active,
      draft: byStatus.get("draft") || 0,
      published: byStatus.get("published") || 0,
      cancelled: byStatus.get("cancelled") || 0,
      free: Number(picture.free_count || 0),
    },
    images: {
      withImage,
      withoutImage: Number(picture.without_image || 0),
      proposed: Number(picture.proposed || 0),
      approved: Number(picture.approved || 0),
      coverage: active ? Math.round((withImage / active) * 100) : 0,
      ...backlog,
    },
    categories: Object.entries(CATEGORIES).map(([key, meta]) => ({
      key,
      label: meta.label,
      color: meta.color,
      total: byCategory.get(key) || 0,
    })),
    cities: cities.rows.map((row) => ({ city: row.city, total: Number(row.total || 0) })),
    days: series,
    lastRun: lastRun.rows[0] || null,
    notify: {
      email: notifyEmail || DEFAULT_NOTIFY_EMAIL,
      from: notifyFrom || DEFAULT_NOTIFY_FROM,
    },
  };
}

module.exports = {
  buildReport,
  parisDay,
  DEFAULT_NOTIFY_EMAIL,
  DEFAULT_NOTIFY_FROM,
};
