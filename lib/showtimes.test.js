const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptTime, listingPage } = require("./showtimes");

test("une heure précise est gardée", () => {
  assert.equal(acceptTime("20h30"), "20h30");
  assert.equal(acceptTime("20:30"), "20h30");
  assert.equal(acceptTime("18h"), "18h");
  assert.equal(acceptTime("18h00"), "18h");
});

test("une formule vague n'est pas une heure", () => {
  assert.equal(acceptTime("Selon séances"), "");
  assert.equal(acceptTime("Voir la source"), "");
  assert.equal(acceptTime("10h-18h"), "");
  assert.equal(acceptTime(""), "");
});

test("une page d'accueil n'est pas la page du spectacle", () => {
  assert.equal(listingPage("https://06.agendaculturel.fr"), true);
  assert.equal(listingPage("https://www.anthea-antibes.fr/fr/calendrier"), false);
});
