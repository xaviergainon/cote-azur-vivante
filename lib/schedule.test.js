const test = require("node:test");
const assert = require("node:assert/strict");
const { isDue, nextTaskDate, normalizeTasks, defaultTasks } = require("./schedule");

test("une tâche hebdomadaire ne part que son jour, après l’heure", () => {
  const monday = new Date("2026-10-12T08:00:00Z");
  const task = { enabled: true, every: "week", time: "06:15", weekDay: 1, monthDay: 1 };
  assert.equal(isDue(task, monday), true);
  assert.equal(isDue(task, new Date("2026-10-13T08:00:00Z")), false);
  assert.equal(isDue({ ...task, enabled: false }, monday), false);
  assert.equal(isDue(task, new Date("2026-10-12T03:00:00Z")), false);
});

test("le mois rattrape un jour déjà passé", () => {
  const task = { enabled: true, every: "month", time: "06:15", weekDay: 1, monthDay: 1 };
  const october = new Date("2026-10-10T10:00:00Z");
  assert.equal(isDue(task, october), true);
  const next = nextTaskDate(task, october, true);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(next);
  assert.equal(parts, "2026-11-01");
});

test("sans planning enregistré, seules les sorties, les bibliothèques et les avis sont actifs", () => {
  const tasks = defaultTasks(true, "06:15");
  assert.equal(tasks.find((task) => task.id === "discover").enabled, true);
  assert.equal(tasks.find((task) => task.id === "libraries").enabled, true);
  assert.equal(tasks.find((task) => task.id === "images").enabled, false);
  assert.equal(tasks.find((task) => task.id === "pilot").enabled, false);
  const saved = normalizeTasks([{ id: "images", enabled: true, every: "week", time: "09:05", weekDay: 2, monthDay: 4 }]);
  const images = saved.find((task) => task.id === "images");
  assert.equal(images.enabled, true);
  assert.equal(images.every, "week");
  assert.equal(images.time, "09:05");
  assert.equal(images.weekDay, 2);
});
