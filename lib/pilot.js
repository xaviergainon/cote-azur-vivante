const PILOT_STEPS = [
  { id: "discover", task: "discover", trigger: "schedule", every: "day", label: "sorties" },
  { id: "duplicates", task: "duplicates", trigger: "duplicates", every: "day", label: "doublons" },
  { id: "details", task: "details", trigger: "details", every: "day", label: "fiches", backlog: "details" },
  { id: "images", task: "images", trigger: "images", every: "day", label: "affiches", backlog: "images" },
  { id: "times", task: "times", trigger: "times", every: "day", label: "horaires", backlog: "times", needsGemini: true },
  { id: "venues", task: "venues", trigger: "venues", every: "week", label: "lieux" },
  { id: "bookings", task: "bookings", trigger: "bookings", every: "week", label: "réservations" },
  { id: "libraries", task: "libraries", trigger: "library", every: "month", label: "bibliothèques" },
  { id: "ratings", task: "ratings", trigger: "ratings", every: "month", label: "avis" },
];

function parisParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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

function weekId(date = new Date()) {
  const parts = parisParts(date);
  const utc = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function inPeriod(every, startedAt, now) {
  if (!startedAt) return false;
  const left = new Date(startedAt);
  if (Number.isNaN(left.getTime())) return false;
  if (every === "week") return weekId(left) === weekId(now);
  if (every === "month") return parisMonth(left) === parisMonth(now);
  return parisDay(left) === parisDay(now);
}

function stepDone(step, runs, now) {
  return runs.some((row) => row.trigger_name === step.trigger
    && ["done", "stopped", "error"].includes(row.status)
    && inPeriod(step.every, row.started_at, now));
}

function pilotHalted(runs, now = new Date()) {
  return runs.some((row) => row.trigger_name === "pilot"
    && row.status === "stopped"
    && inPeriod("day", row.started_at, now));
}

function healthSentence(backlog = {}) {
  const details = Number(backlog.details || 0);
  const images = Number(backlog.images || 0);
  const times = Number(backlog.times || 0);
  return `Santé : ${details} fiche(s) incomplète(s), ${images} sans affiche, ${times} sans horaire.`;
}

function planPilotSteps({ now = new Date(), runs = [], backlog = {}, gemini = false } = {}) {
  const steps = [];
  for (const step of PILOT_STEPS) {
    if (stepDone(step, runs, now)) continue;
    const waiting = step.backlog ? Number(backlog[step.backlog] || 0) : null;
    if (waiting === 0) continue;
    if (step.needsGemini && !gemini) continue;
    const count = waiting > 0 ? `, ${waiting} en attente` : "";
    steps.push({
      id: step.id,
      task: step.task,
      trigger: step.trigger,
      label: step.label,
      waiting: waiting > 0 ? waiting : 0,
      reason: `Pilote. ${step.label}${count}.`,
    });
  }
  return steps;
}

function choosePilotStep(input) {
  return planPilotSteps(input)[0] || null;
}

module.exports = {
  PILOT_STEPS,
  choosePilotStep,
  planPilotSteps,
  healthSentence,
  pilotHalted,
  inPeriod,
  parisDay,
};
