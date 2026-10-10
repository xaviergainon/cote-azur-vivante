const test = require("node:test");
const assert = require("node:assert/strict");
const { dedicatedLink, queueMissing, readPosterPages, textMentions } = require("./images");

test("un agenda partagé mène à la page du spectacle", () => {
  const listing = "https://www.jds.fr/nice/agenda/agenda-du-jour/-aujourdhui_JPJ";
  const show = "https://www.jds.fr/nice/spectacles/spectacle-musical/la-dame-de-pierre-le-spectacle-musical-1775256_A";
  const links = [
    { href: listing, text: "Aujourd'hui" },
    { href: show, text: "La Dame de Pierre, le spectacle musical" },
    { href: show, text: "" },
    { href: "https://www.jds.fr/nice/salle-de-concert-spectacle/palais-nikaia-14902_L", text: "Palais Nikaïa - Nice" },
  ];
  assert.equal(dedicatedLink(links, "La Dame de Pierre", listing), show);
  assert.equal(dedicatedLink(links, "Pierre", listing), "");
  const showText = "Offenbach — Du rire aux rêves";
  const longer = "https://agenda.example/offenbach-long";
  assert.equal(dedicatedLink([
    { href: show, text: showText },
    { href: longer, text: `${showText}, au Palais des Festivals, toute la soirée` },
  ], showText, listing), show);
  assert.equal(readPosterPages({ pages: [{ id: "offenbach", url: "https://salle.example/offenbach" }] }).get("offenbach"), "https://salle.example/offenbach");
  assert.equal(readPosterPages({ url: "https://salle.example/offenbach" }), null);
  assert.equal(textMentions("La Dame de Pierre, le spectacle musical au Palais Nikaïa", "La Dame de Pierre"), true);
});

test("les sorties jamais vues sur un agenda passent après les pages propres", () => {
  const queue = queueMissing({
    unique: [
      { url: "https://salle.example/propre", event: { image_checked_at: null, days: ["2026-11-01"] }, shared: false },
    ],
    shared: [
      { url: "https://agenda.example/jour", event: { image_checked_at: null, days: ["2026-11-02"], title: "Plus tard" }, shared: true },
      { url: "https://agenda.example/jour", event: { image_checked_at: null, days: ["2026-10-10"], title: "La Dame de Pierre" }, shared: true },
      { url: "https://agenda.example/ancien", event: { image_checked_at: "2026-10-01T00:00:00Z", days: ["2026-10-09"] }, shared: true },
    ],
  });
  assert.equal(queue[0].url, "https://salle.example/propre");
  assert.equal(queue[1].event.title, "La Dame de Pierre");
  assert.equal(queue[2].event.title, "Plus tard");
  assert.equal(queue[3].url, "https://agenda.example/ancien");
});
