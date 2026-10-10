const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_QUERIES, PREVIOUS_QUERIES, upgradeQueries, CATEGORY_KEYS } = require("./defaults");

test("les recherches d’origine gagnent la librairie et l’écologie", () => {
  const next = upgradeQueries(PREVIOUS_QUERIES);
  assert.equal(next.length, 5);
  assert.match(next[3], /librairies/);
  assert.match(next[4], /écologie/);
  assert.deepEqual(upgradeQueries(DEFAULT_QUERIES.slice(0, 3)), DEFAULT_QUERIES);
});

test("une liste déjà modifiée garde ses lignes et ajoute les deux recherches s’il reste de la place", () => {
  const custom = ["agenda jazz Nice"];
  const next = upgradeQueries(custom);
  assert.equal(next[0], "agenda jazz Nice");
  assert.equal(next.length, 3);
  assert.ok(CATEGORY_KEYS.includes("livre"));
  assert.ok(CATEGORY_KEYS.includes("ecologie"));
});
