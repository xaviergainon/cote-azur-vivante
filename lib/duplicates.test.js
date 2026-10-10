const test = require("node:test");
const assert = require("node:assert/strict");
const { clusterShows, completeShow, pickKeeper, matchingShows } = require("./duplicates");

function show(fields) {
  return {
    id: fields.id,
    title: fields.title,
    city: fields.city || "",
    venue: fields.venue || "",
    days: fields.days || [],
    category: fields.category || "theatre",
    status: fields.status || "published",
    address: fields.address || "",
    lat: fields.lat ?? null,
    lng: fields.lng ?? null,
    description: fields.description || "",
    url: fields.url || "",
    time: fields.time || "",
    price: fields.price || "",
    free: Boolean(fields.free),
  };
}

test("le même titre dans deux villes reste deux sorties", () => {
  const groups = clusterShows([
    show({ id: "a", title: "Cinéma itinérant : L'Invitation", city: "Drap", venue: "Salle Jean Ferrat", days: ["2026-10-08"] }),
    show({ id: "b", title: "Cinéma itinérant : L'Invitation", city: "Saint-Vallier-de-Thiey", venue: "Espace de Thiey", days: ["2026-10-09"] }),
  ]);
  assert.equal(groups.length, 0);
});

test("le même spectacle à Nice et sans ville précise se regroupe", () => {
  const groups = clusterShows([
    show({ id: "a", title: "Nissa Slam", city: "Nice", venue: "Théâtre National de Nice", days: ["2026-12-23"] }),
    show({ id: "b", title: "Nissa Slam", city: "Alpes-Maritimes", days: ["2026-10-28"] }),
    show({ id: "c", title: "Nissa Slam", city: "Nice", venue: "Théâtre de Nice", days: ["2026-10-29"] }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});

test("deux salles vraiment différentes ne se mélangent pas", () => {
  const groups = clusterShows([
    show({ id: "a", title: "Une heure à t'attendre", city: "Cannes", venue: "Théâtre Palais Stéphanie JW Marriott", days: ["2026-10-10"] }),
    show({ id: "b", title: "Une heure à t'attendre", city: "Cannes", venue: "Palais des Festivals", days: ["2026-10-11"] }),
  ]);
  assert.equal(groups.length, 0);
});

test("les variantes d’un même théâtre additionnent les dates", () => {
  const keeper = show({
    id: "a",
    title: "Poussez-vous les mecs",
    city: "Antibes",
    venue: "anthéa",
    days: ["2026-10-06", "2026-10-07"],
    address: "",
  });
  const donor = show({
    id: "b",
    title: "Poussez-vous les mecs",
    city: "Antibes",
    venue: "Théâtre Anthéa",
    days: ["2026-10-08", "2026-10-09"],
    address: "260 av. Jules Grec, Antibes",
  });
  const groups = clusterShows([keeper, donor]);
  assert.equal(groups.length, 1);
  const next = completeShow(keeper, [donor]);
  assert.deepEqual(next.days, ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.equal(next.address, "260 av. Jules Grec, Antibes");
  assert.equal(next.venue, "Théâtre Anthéa");
});

test("la fiche la plus complète est gardée", () => {
  const thin = show({ id: "thin", title: "Saigon", city: "Nice", venue: "Théâtre de Nice", days: ["2026-10-09"] });
  const full = show({
    id: "full",
    title: "Saigon",
    city: "Nice",
    venue: "TNN — Salle de La Cuisine",
    days: ["2026-10-08", "2026-10-09"],
    address: "Promenade des Arts, Nice",
    description: "Création.",
  });
  assert.equal(pickKeeper([thin, full]).id, "full");
});

test("un sous-titre ne fait pas une autre sortie", () => {
  const groups = clusterShows([
    show({ id: "court", title: "Exercices de style", city: "Nice", venue: "Nice", days: ["2026-10-10"], time: "20h30" }),
    show({ id: "long", title: "Exercices de style, de Raymond Queneau", city: "Nice", venue: "Théâtre de la Traverse", days: ["2026-10-10"] }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test("une ville floue ne relie pas deux villes", () => {
  const shows = [
    show({ id: "nice", title: "Repair Café", city: "Nice", venue: "Le 109", days: ["2026-10-10"] }),
    show({ id: "cagnes", title: "Repair Café", city: "Cagnes-sur-Mer", venue: "Maison des associations", days: ["2026-10-11"] }),
    show({ id: "vague", title: "Repair Café", city: "Alpes-Maritimes", days: ["2026-10-12"] }),
  ];
  const groups = clusterShows(shows);
  assert.equal(groups.length, 0);
  assert.equal(matchingShows(shows, shows[2]).length, 0);
});
