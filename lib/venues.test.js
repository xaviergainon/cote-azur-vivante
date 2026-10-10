const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeVenue, matchEventPlace, acceptBookingUrl } = require("./venues");

test("un lieu sans ville précise est écarté", () => {
  assert.equal(normalizeVenue({ name: "Théâtre", city: "Alpes-Maritimes" }), null);
  const place = normalizeVenue({
    name: "anthéa",
    city: "Antibes",
    address: "260 av. Jules Grec",
    website: "https://www.anthea-antibes.fr",
    kind: "theatre",
  });
  assert.equal(place.city, "Antibes");
  assert.equal(place.kind, "theatre");
});

test("une salle validée se rattache au spectacle du même nom", () => {
  const places = [
    { id: "anthea", name: "anthéa", city: "Antibes", status: "published" },
    { id: "bellecour", name: "Théâtre Bellecour", city: "Nice", status: "published" },
  ];
  const hit = matchEventPlace({ venue: "Théâtre Anthéa", city: "Antibes" }, places);
  assert.equal(hit.id, "anthea");
  assert.equal(matchEventPlace({ venue: "Nice", city: "Nice" }, places), null);
  assert.equal(matchEventPlace({ venue: "Théâtre Anthéa", city: "Nice" }, places), null);
  const twins = [
    { id: "a", name: "Théâtre National", city: "Nice", status: "published" },
    { id: "b", name: "Théâtre National de Nice", city: "Nice", status: "published" },
  ];
  assert.equal(matchEventPlace({ venue: "Théâtre National de Nice", city: "Nice" }, twins), null);
});

test("une page google n'est pas une billetterie", () => {
  assert.equal(acceptBookingUrl("https://www.anthea-antibes.fr/fr/calendrier"), "https://www.anthea-antibes.fr/fr/calendrier");
  assert.equal(acceptBookingUrl("https://www.google.com/search?q=billet"), "");
  assert.equal(acceptBookingUrl("pas une url"), "");
});
