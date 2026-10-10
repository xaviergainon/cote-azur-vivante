const test = require("node:test");
const assert = require("node:assert/strict");
const { openDates, acceptWebRating, blendRating } = require("./ratings");

test("openDates ne garde que les jours d’ouverture", () => {
  const days = openDates([6, 7], "2026-10-10", "2026-10-12");
  assert.deepEqual(days, ["2026-10-10", "2026-10-11"]);
});

test("une note sans assez d’avis n’est pas publiée", () => {
  const thin = acceptWebRating({
    keep: true,
    samePlace: true,
    score: 4.6,
    count: 2,
    source: "Google",
    reason: "Peu d’avis.",
  });
  assert.equal(thin.action, "skip");
  const enough = acceptWebRating({
    keep: true,
    samePlace: true,
    score: 4.6,
    count: 3,
    source: "Google",
    reason: "Moyenne de la salle.",
  });
  assert.equal(enough.action, "keep");
  assert.equal(enough.score, 4.6);
  const wrong = acceptWebRating({
    keep: true,
    samePlace: false,
    score: 5,
    count: 40,
    source: "Google",
    reason: "Un autre théâtre.",
  });
  assert.equal(wrong.action, "clear");
  const kept = acceptWebRating({
    keep: true,
    samePlace: true,
    score: 4.24,
    count: 86,
    source: "Google",
    reason: "Moyenne du lieu.",
  });
  assert.equal(kept.action, "keep");
  assert.equal(kept.score, 4.2);
});

test("les avis de l’application pèsent avec la note du web", () => {
  const web = blendRating({ status: "kept", score: 4, count: 10, source: "Google", votes: [2, 2] });
  assert.equal(web.score, 3.7);
  assert.equal(web.source, "Google");
  const alone = blendRating({ status: "discarded", score: null, count: 0, source: "", votes: [5, 5] });
  assert.equal(alone, null);
  const readers = blendRating({ status: null, score: null, count: 0, source: "", votes: [4, 4, 5, 5, 3] });
  assert.equal(readers.source, "lecteurs");
  assert.equal(readers.score, 4.2);
});
