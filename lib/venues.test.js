const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeVenue, matchEventPlace, acceptBookingUrl, geocodeQuery, pointFromGeocode } = require("./venues");
const { mapEvent } = require("./agenda");

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
  const monaco = normalizeVenue({ name: "Opéra de Monte-Carlo", city: "Monaco", lat: 43.738, lng: 7.427, kind: "theatre" });
  assert.equal(monaco.city, "Monaco");
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

test("une adresse monégasque ne part pas vers la France", () => {
  assert.match(geocodeQuery("Place du Casino", "Monaco"), /Monaco/);
  assert.doesNotMatch(geocodeQuery("Place du Casino", "Monaco"), /Alpes-Maritimes/);
  assert.match(geocodeQuery("163 boulevard du Mercantour", "Nice"), /Alpes-Maritimes/);
});

test("un point hors zone est écarté", () => {
  const italy = pointFromGeocode({ results: [{ geometry: { location: { lat: 43.78, lng: 7.95 } } }] });
  assert.equal(italy, null);
  const nice = pointFromGeocode({
    results: [
      { geometry: { location: { lat: 43.78, lng: 7.95 } } },
      { geometry: { location: { lat: 43.695, lng: 7.272 } } },
    ],
  });
  assert.equal(nice.lat, 43.695);
});

test("une sortie sans point prend celui de son lieu", () => {
  const event = mapEvent({
    id: "shrek",
    title: "Shrek",
    days: ["2026-10-10"],
    category: "theatre",
    city: "Monaco",
    venue: "Grimaldi Forum",
    address: "",
    lat: null,
    lng: null,
    place_lat: 43.744,
    place_lng: 7.431,
    place_address: "10 avenue Princesse Grace",
  });
  assert.equal(event.lat, 43.744);
  assert.equal(event.lng, 7.431);
  assert.equal(event.address, "10 avenue Princesse Grace");
});

test("une page google n'est pas une billetterie", () => {
  assert.equal(acceptBookingUrl("https://www.anthea-antibes.fr/fr/calendrier"), "https://www.anthea-antibes.fr/fr/calendrier");
  assert.equal(acceptBookingUrl("https://www.google.com/search?q=billet"), "");
  assert.equal(acceptBookingUrl("pas une url"), "");
});
