const { queueRun, runInProgress } = require("./agent");
const { getRaw, setRaw } = require("./settings");
const { DEFAULT_QUERIES, PREVIOUS_QUERIES, DEFAULT_LIBRARY_QUERIES } = require("./defaults");

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

const PLAN_TASKS = [
  { id: "discover", trigger: "schedule", label: "Sorties", detail: "Lit les agendas sur 30 jours. Les nouveautés restent en brouillon.", every: "day", time: "06:15", weekDay: 1, monthDay: 1 },
  { id: "images", trigger: "images", label: "Affiches", detail: "Ouvre jusqu’à 80 pages, les plus proches d’abord. Un agenda partagé mène à la page du spectacle.", every: "day", time: "07:00", weekDay: 1, monthDay: 1 },
  { id: "times", trigger: "times", label: "Horaires", detail: "Douze séances sans heure. Gemini cherche l’heure. La collecte du matin en reprend déjà six.", every: "day", time: "07:20", weekDay: 1, monthDay: 1 },
  { id: "duplicates", trigger: "duplicates", label: "Doublons", detail: "Réunit les fiches du même titre dans la même ville.", every: "week", time: "07:40", weekDay: 1, monthDay: 1 },
  { id: "venues", trigger: "venues", label: "Lieux", detail: "Propose des salles, douze au plus, avec le moteur choisi dans Collecte.", every: "week", time: "08:00", weekDay: 1, monthDay: 1 },
  { id: "bookings", trigger: "bookings", label: "Réservations", detail: "Cherche une page de billet pour six lieux, puis six sorties.", every: "week", time: "08:20", weekDay: 3, monthDay: 1 },
  { id: "libraries", trigger: "library", label: "Bibliothèques", detail: "Une fois dans le mois, retient les jours d’ouverture. Les nouveaux lieux restent en brouillon.", every: "month", time: "06:15", weekDay: 1, monthDay: 1 },
  { id: "ratings", trigger: "ratings", label: "Avis", detail: "Une fois dans le mois, douze sorties. Une note n’est gardée qu’avec au moins 8 avis.", every: "month", time: "06:15", weekDay: 1, monthDay: 1 },
];

function parisWeekday(date = new Date()) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", weekday: "short" }).format(date);
  return { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] || 1;
}

function weekId(date = new Date()) {
  const parts = parisParts(date);
  const utc = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function samePeriod(task, left, right) {
  if (task.every === "week") return weekId(left) === weekId(right);
  if (task.every === "month") return parisMonth(left) === parisMonth(right);
  return parisDay(left) === parisDay(right);
}

function defaultTasks(enabled = true, time = "06:15") {
  return PLAN_TASKS.map((task) => {
    if (task.id === "discover") return { ...task, enabled: Boolean(enabled), time };
    if (task.id === "libraries" || task.id === "ratings") return { ...task, enabled: true, time };
    return { ...task, enabled: false };
  });
}

function normalizeTasks(input, fallbackTime = "06:15") {
  const rows = new Map((Array.isArray(input) ? input : []).map((row) => [row?.id, row]));
  return PLAN_TASKS.map((base) => {
    const row = rows.get(base.id) || {};
    const every = ["day", "week", "month"].includes(row.every) ? row.every : base.every;
    const time = parseTime(row.time) ? row.time : (parseTime(base.time) ? base.time : fallbackTime);
    const weekDay = Number(row.weekDay);
    const monthDay = Number(row.monthDay);
    return {
      ...base,
      enabled: row.enabled === true || row.enabled === "1" || row.enabled === "true",
      every,
      time,
      weekDay: weekDay >= 1 && weekDay <= 7 ? weekDay : base.weekDay,
      monthDay: monthDay >= 1 && monthDay <= 28 ? monthDay : base.monthDay,
    };
  });
}

function isDue(task, now = new Date()) {
  if (!task?.enabled) return false;
  const parsed = parseTime(task.time);
  if (!parsed) return false;
  const parts = parisParts(now);
  const past = Number(parts.hour) * 60 + Number(parts.minute) >= parsed.hour * 60 + parsed.minute;
  if (!past) return false;
  if (task.every === "week" && parisWeekday(now) !== Number(task.weekDay)) return false;
  if (task.every === "month" && Number(parts.day) < Number(task.monthDay)) return false;
  return true;
}

function nextTaskDate(task, from = new Date(), skipCurrent = false) {
  if (!task?.enabled) return null;
  const parsed = parseTime(task.time) || { hour: 6, minute: 15 };
  const target = parsed.hour * 60 + parsed.minute;
  let cursor = from.getTime() + 60000;
  for (let guard = 0; guard < 80; guard += 1) {
    const candidate = new Date(cursor);
    const parts = parisParts(candidate);
    const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (nowMinutes !== target) {
      let jump = target - nowMinutes;
      if (jump <= 0) jump += 24 * 60;
      cursor += jump * 60000;
      continue;
    }
    const fitsWeek = task.every !== "week" || parisWeekday(candidate) === Number(task.weekDay);
    const fitsMonth = task.every !== "month" || Number(parts.day) >= Number(task.monthDay);
    const fitsPeriod = !skipCurrent || !samePeriod(task, candidate, from);
    if (fitsWeek && fitsMonth && fitsPeriod) return candidate;
    cursor += 24 * 60 * 60000;
  }
  return null;
}

async function readSchedule(db) {
  const enabledRaw = await getRaw(db, "agent_enabled");
  const storedTime = await getRaw(db, "agent_time");
  const time = parseTime(storedTime) ? storedTime : "06:15";
  const storedQueries = readQueryList(await getRaw(db, "agent_queries"), DEFAULT_QUERIES);
  const queries = storedQueries.length === PREVIOUS_QUERIES.length
    && storedQueries.every((line, index) => line === PREVIOUS_QUERIES[index])
    ? DEFAULT_QUERIES
    : storedQueries;
  const libraryQueries = readQueryList(await getRaw(db, "library_queries"), DEFAULT_LIBRARY_QUERIES);
  let tasks = defaultTasks(enabledRaw !== "0", time);
  const rawPlan = await getRaw(db, "agent_plan");
  if (rawPlan) {
    try {
      const parsed = JSON.parse(rawPlan);
      if (Array.isArray(parsed)) tasks = normalizeTasks(parsed, time);
    } catch {
      tasks = defaultTasks(enabledRaw !== "0", time);
    }
  }
  const discover = tasks.find((task) => task.id === "discover");
  return {
    enabled: discover ? discover.enabled : enabledRaw !== "0",
    time: discover?.time || time,
    queries: queries.length ? queries : DEFAULT_QUERIES,
    libraryQueries,
    tasks,
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

async function periodDone(db, task, now = new Date()) {
  const result = await db.query(
    "SELECT started_at, status FROM agent_runs WHERE trigger_name = $1 ORDER BY started_at DESC NULLS LAST LIMIT 8",
    [task.trigger]
  );
  const rows = result.rows.filter((row) => row.started_at && samePeriod(task, new Date(row.started_at), now));
  if (rows.some((row) => row.status === "done" || row.status === "running" || row.status === "stopped")) return true;
  return rows.filter((row) => row.status === "error").length >= 3;
}

function startScheduler(ctx) {
  let timer = null;
  async function tick() {
    if (timer) clearTimeout(timer);
    let delay = 30 * 60 * 1000;
    try {
      const schedule = await readSchedule(ctx.db);
      const now = new Date();
      if (runInProgress()) {
        delay = 20000;
      } else {
        for (const task of schedule.tasks) {
          if (!isDue(task, now) || await periodDone(ctx.db, task, now)) continue;
          await queueRun(ctx, task.trigger);
          delay = 20000;
          break;
        }
      }
      if (delay > 20000) {
        const upcoming = schedule.tasks
          .map((task) => nextTaskDate(task, now, false))
          .filter(Boolean)
          .map((date) => date.getTime() - now.getTime());
        if (upcoming.length) delay = Math.min(delay, ...upcoming);
      }
    } catch (error) {
      console.error("scheduler", error.message);
    }
    timer = setTimeout(tick, Math.max(20000, Math.min(delay, 30 * 60 * 1000)));
  }
  timer = setTimeout(tick, 20000);
}

async function schedulePayload(db) {
  const schedule = await readSchedule(db);
  const now = new Date();
  const tasks = [];
  for (const task of schedule.tasks) {
    const done = await periodDone(db, task, now);
    const last = await db.query(
      "SELECT status, started_at FROM agent_runs WHERE trigger_name = $1 ORDER BY started_at DESC NULLS LAST LIMIT 1",
      [task.trigger]
    );
    const next = nextTaskDate(task, now, done);
    tasks.push({
      ...task,
      done,
      nextRun: next ? next.toISOString() : null,
      lastStatus: last.rows[0]?.status || "",
      lastAt: last.rows[0]?.started_at || null,
    });
  }
  const discover = tasks.find((task) => task.id === "discover");
  return {
    ...schedule,
    tasks,
    nextRun: discover?.nextRun || nextRunDate(schedule.time).toISOString(),
  };
}

async function saveSchedule(db, body) {
  if (body.queries != null) {
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
    await setRaw(db, "agent_queries", JSON.stringify(queries));
  }
  if (body.libraryQueries != null) {
    const libraryQueries = String(body.libraryQueries)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((line) => line.slice(0, 160));
    await setRaw(db, "library_queries", JSON.stringify(libraryQueries));
  }
  if (Array.isArray(body.tasks)) {
    const tasks = normalizeTasks(body.tasks);
    await setRaw(db, "agent_plan", JSON.stringify(tasks.map((task) => ({
      id: task.id,
      enabled: task.enabled,
      every: task.every,
      time: task.time,
      weekDay: task.weekDay,
      monthDay: task.monthDay,
    }))));
    const discover = tasks.find((task) => task.id === "discover");
    if (discover) {
      await setRaw(db, "agent_enabled", discover.enabled ? "1" : "0");
      await setRaw(db, "agent_time", discover.time);
    }
  } else if (body.time) {
    const parsed = parseTime(String(body.time || ""));
    if (!parsed) {
      const error = new Error("Heure invalide. Utilise HH:MM.");
      error.status = 400;
      throw error;
    }
    await setRaw(db, "agent_enabled", body.enabled === false || body.enabled === "0" ? "0" : "1");
    await setRaw(db, "agent_time", formatTime(parsed));
  }
  return schedulePayload(db);
}

module.exports = {
  startScheduler,
  schedulePayload,
  saveSchedule,
  formatTime,
  isDue,
  nextTaskDate,
  normalizeTasks,
  defaultTasks,
  PLAN_TASKS,
};
