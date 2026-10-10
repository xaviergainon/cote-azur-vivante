const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_BRIEFS, PREVIOUS_BRIEFS, resolveBrief } = require("./briefs");

test("une consigne d'origine est remplacée par le texte complet", () => {
  const stored = PREVIOUS_BRIEFS.discover_page[1];
  const next = resolveBrief("discover_page", stored);
  assert.match(next, /Monaco/);
  assert.match(next, /20h30/);
  assert.equal(resolveBrief("times", ""), DEFAULT_BRIEFS.times);
});

test("une consigne modifiée à la main est gardée", () => {
  const custom = "Cherche seulement le théâtre à Nice.";
  assert.equal(resolveBrief("discover_page", custom), custom);
});
