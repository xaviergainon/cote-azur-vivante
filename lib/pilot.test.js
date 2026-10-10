const test = require("node:test");
const assert = require("node:assert/strict");
const { choosePilotStep, pilotHalted } = require("./pilot");

const now = new Date("2026-10-10T10:00:00Z");

function run(trigger, status, started) {
  return { trigger_name: trigger, status, started_at: started };
}

test("la journée commence par les sorties", () => {
  const choice = choosePilotStep({
    now,
    backlog: { details: 4, images: 10, times: 2 },
    gemini: true,
  });
  assert.equal(choice.task, "discover");
  assert.equal(choice.trigger, "schedule");
});

test("après les sorties, les doublons passent avant les fiches", () => {
  const choice = choosePilotStep({
    now,
    runs: [run("schedule", "done", "2026-10-10T04:20:00Z")],
    backlog: { details: 8, images: 3, times: 1 },
    gemini: true,
  });
  assert.equal(choice.task, "duplicates");
});

test("une étape vide est sautée, les horaires attendent Gemini", () => {
  const choice = choosePilotStep({
    now,
    runs: [
      run("schedule", "done", "2026-10-10T04:20:00Z"),
      run("duplicates", "done", "2026-10-10T05:00:00Z"),
    ],
    backlog: { details: 0, images: 12, times: 4 },
    gemini: false,
  });
  assert.equal(choice.task, "images");
  assert.match(choice.reason, /12 en attente/);
});

test("les lieux ne repartent pas dans la même semaine", () => {
  const choice = choosePilotStep({
    now,
    runs: [
      run("schedule", "done", "2026-10-10T04:20:00Z"),
      run("duplicates", "done", "2026-10-10T05:00:00Z"),
      run("details", "done", "2026-10-10T05:20:00Z"),
      run("images", "done", "2026-10-10T06:00:00Z"),
      run("times", "error", "2026-10-10T07:00:00Z"),
      run("venues", "done", "2026-10-06T06:00:00Z"),
    ],
    backlog: { details: 2, images: 2, times: 2 },
    gemini: true,
  });
  assert.equal(choice.task, "bookings");
});

test("une interruption dans la journée arrête la chaîne", () => {
  assert.equal(pilotHalted([run("images", "stopped", "2026-10-10T08:00:00Z")], now), true);
  assert.equal(pilotHalted([run("images", "stopped", "2026-10-09T08:00:00Z")], now), false);
});

test("quand tout est couvert, le pilote ne choisit rien", () => {
  const runs = [
    run("schedule", "done", "2026-10-10T04:20:00Z"),
    run("duplicates", "done", "2026-10-10T05:00:00Z"),
    run("details", "done", "2026-10-10T05:20:00Z"),
    run("images", "done", "2026-10-10T06:00:00Z"),
    run("times", "done", "2026-10-10T07:00:00Z"),
    run("venues", "done", "2026-10-06T06:00:00Z"),
    run("bookings", "done", "2026-10-07T06:00:00Z"),
    run("library", "done", "2026-10-02T04:20:00Z"),
    run("ratings", "done", "2026-10-02T05:00:00Z"),
  ];
  assert.equal(choosePilotStep({ now, runs, backlog: { details: 1, images: 1, times: 1 }, gemini: true }), null);
});
