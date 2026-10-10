const { queueRun, runInProgress } = require("./agent");
const { getRaw, setRaw } = require("./settings");
const { DEFAULT_QUERIES, DEFAULT_LIBRARY_QUERIES } = require("./defaults");

function parisParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return Object.fromEntries(
    fmt.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
}

function parisDay(date = new Date()) {
  const parts = parisParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parisMonth(date = new Date()) {
  const parts = parisParts(date);
  return `${parts.year}-${parts.month}`;
}

function readQueryList(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((line) => line.trim()).filter(Boolean).slice(0, 5);
  } catch {
    return fallback;
  }
  return fallback;
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function formatTime(parsed) {
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

async function readSchedule(db) {
  const enabledRaw = await getRaw(db, "agent_enabled");
  const storedTime = await getRaw(db, "agent_time");
  const time = parseTime(storedTime) ? storedTime : "06:15";
  const queries = readQueryList(await getRaw(db, "agent_queries"), DEFAULT_QUERIES);
  const libraryQueries = readQueryList(await getRaw(db, "library_queries"), DEFAULT_LIBRARY_QUERIES);
  return {
    enabled: enabledRaw !== "0",
    time,
    queries: queries.length ? queries : DEFAULT_QUERIES,
    libraryQueries,
  };
}

function nextRunDate(time, from = new Date()) {
  const parsed = parseTime(time) || { hour: 6, minute: 15 };
  const start = from.getTime();
  for (let minuteOffset = 1; minuteOffset <= 60 * 48; minuteOffset += 1) {
    const candidate = new Date(start + minuteOffset * 60000);
    const parts = parisParts(candidate);
    if (Number(parts.hour) === parsed.hour && Number(parts.minute) === parsed.minute) return candidate;
  }
  return new Date(start + 24 * 60 * 60 * 1000);
}

async function scheduledAlreadyToday(db) {
  const day = parisDay();
  const result = await db.query(
    "SELECT started_at, status FROM agent_runs WHERE trigger_name = 'schedule' ORDER BY started_at DESC NULLS LAST LIMIT 8"
  );
  const today = result.rows.filter(
    (row) => row.started_at && parisDay(new Date(row.started_at)) === day
  );
  if (today.some((row) => row.status === "done" || row.status === "running" || row.status === "stopped")) return true;
  return today.filter((row) => row.status === "error").length >= 3;
}

async function monthlyAlready(db, trigger) {
  const month = parisMonth();
  const result = await db.query(
    "SELECT started_at, status FROM agent_runs WHERE trigger_name = $1 ORDER BY started_at DESC NULLS LAST LIMIT 6",
    [trigger]
  );
  const rows = result.rows.filter(
    (row) => row.started_at && parisMonth(new Date(row.started_at)) === month
  );
  if (rows.some((row) => row.status === "done" || row.status === "running" || row.status === "stopped")) return true;
  return rows.filter((row) => row.status === "error").length >= 3;
}

function startScheduler(ctx) {
  let timer = null;
  async function tick() {
    if (timer) clearTimeout(timer);
    let schedule = { time: "06:15", enabled: true };
    try {
      schedule = await readSchedule(ctx.db);
      const parsed = parseTime(schedule.time) || { hour: 6, minute: 15 };
      const now = parisParts();
      const past = Number(now.hour) * 60 + Number(now.minute) >= parsed.hour * 60 + parsed.minute;
      if (!schedule.enabled || runInProgress()) {
        /* Le passage mensuel attend que le quotidien ait la place. */
      } else if (past && !(await scheduledAlreadyToday(ctx.db))) {
        await queueRun(ctx, "schedule");
      } else if (!(await monthlyAlready(ctx.db, "library"))) {
        await queueRun(ctx, "library");
      } else if (!(await monthlyAlready(ctx.db, "ratings"))) {
        await queueRun(ctx, "ratings");
      }
    } catch (error) {
      console.error("scheduler", error.message);
    }
    const delay = Math.max(20000, nextRunDate(schedule.time).getTime() - Date.now());
    timer = setTimeout(tick, Math.min(delay, 30 * 60 * 1000));
  }
  timer = setTimeout(tick, 20000);
}

async function schedulePayload(db) {
  const schedule = await readSchedule(db);
  return { ...schedule, nextRun: nextRunDate(schedule.time).toISOString() };
}

async function saveSchedule(db, body) {
  const parsed = parseTime(String(body.time || ""));
  if (!parsed) {
    const error = new Error("Heure invalide. Utilise HH:MM.");
    error.status = 400;
    throw error;
  }
  const queries = String(body.queries || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => line.slice(0, 160));
  if (!queries.length) {
    const error = new Error("Au moins une recherche Google.");
    error.status = 400;
    throw error;
  }
  await setRaw(db, "agent_enabled", body.enabled === false || body.enabled === "0" ? "0" : "1");
  await setRaw(db, "agent_time", formatTime(parsed));
  await setRaw(db, "agent_queries", JSON.stringify(queries));
  if (body.libraryQueries != null) {
    const libraryQueries = String(body.libraryQueries)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((line) => line.slice(0, 160));
    await setRaw(db, "library_queries", JSON.stringify(libraryQueries));
  }
  return schedulePayload(db);
}

module.exports = { startScheduler, schedulePayload, saveSchedule, formatTime };
