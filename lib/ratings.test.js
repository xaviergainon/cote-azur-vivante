const test = require("node:test");
const assert = require("node:assert/strict");
const { openDates, acceptWebRating, blendRating } = require("./ratings");

test("openDates ne garde que les jours d’ouverture", () => {
  const days = openDates([6, 7], "2026-10-10", "2026-10-12");
  assert.deepEqual(days, ["2026-10-10", "2026-10-11"]);
});

test("une moyenne de la salle est gardée dès un avis", () => {
  const thin = acceptWebRating({
    keep: false,
    samePlace: true,
    score: "4,6",
    count: "2 avis",
    source: "Google",
    reason: "Moyenne de la salle.",
  });
  assert.equal(thin.action, "keep");
  assert.equal(thin.score, 4.6);
  assert.equal(thin.count, 2);
  const alone = acceptWebRating({
    score: 4.2,
    count: 1,
    source: "Google",
  });
  assert.equal(alone.action, "keep");
  const outOfTen = acceptWebRating({
    keep: true,
    samePlace: true,
    score: "8/10",
    count: 20,
    source: "Allociné",
  });
  assert.equal(outOfTen.action, "skip");
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
  const one = blendRating({ status: "kept", score: 4.6, count: 1, source: "Google", votes: [] });
  assert.equal(one.score, 4.6);
  assert.equal(one.count, 1);
  const readers = blendRating({ status: null, score: null, count: 0, source: "", votes: [4, 4, 5, 5, 3] });
  assert.equal(readers.source, "lecteurs");
  assert.equal(readers.score, 4.2);
});
