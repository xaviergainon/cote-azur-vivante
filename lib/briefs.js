const { getRaw, setRaw } = require("./settings");

const BRIEF_KEYS = [
  "discover_page",
  "review_page",
  "discover_search",
  "review_search",
  "libraries",
  "ratings",
  "venues",
  "bookings",
];

const DEFAULT_BRIEFS = {
  discover_page: `Tu extrais des sorties publiques des Alpes-Maritimes (France). Réponds uniquement en JSON {"events":[...]}. N'invente aucun événement qui n'est pas dans le texte. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Si un événement dure plusieurs jours, ou a commencé avant et continue, liste chaque jour encore ouvert dans ces jours. lat/lng seulement si le lieu est dans les Alpes-Maritimes, sinon null. Si rien n'est exploitable, {"events":[]}.`,
  review_page: `Tu relis une page déjà parcourue. Réponds uniquement en JSON {"events":[],"missing":[]}. Jours : {{jours}}. events : seulement les sorties nouvelles, absentes de la liste. missing : {"id","reason"} si la page annule ou retire un id de la liste. Dans le doute, missing reste vide. category parmi : {{categories}}. N'invente rien.`,
  discover_search: `Tu cherches des sorties publiques à venir dans les Alpes-Maritimes. Réponds uniquement en JSON {"events":[...]}. N'invente pas un événement sans source web. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Couvre tous ces jours, pas seulement la semaine en cours : développe chaque plage en une date par jour. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.`,
  review_search: `Tu cherches les sorties nouvelles des Alpes-Maritimes sur des jours déjà parcourus ({{jours}}). Réponds uniquement en JSON {"events":[...]}. Ne renvoie que les nouveautés. Ne signale pas d'absence. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.`,
  libraries: `Tu relèves des bibliothèques et médiathèques ouvertes au public dans les Alpes-Maritimes. Réponds uniquement en JSON {"places":[...]}. Chaque lieu : title, city, venue, address, lat, lng ou null, url, weekdays, hours, description. weekdays : 1 lundi à 7 dimanche, seulement les jours où le bâtiment accueille le public. Si la page ne le dit pas, n'invente pas le lieu. Pas de spectacle, pas d'atelier : le lieu lui-même. lat/lng seulement dans les Alpes-Maritimes.`,
  ratings: `Tu cherches une note publique, sur 5, pour UN lieu précis. Réponds uniquement en JSON {"keep":false,"samePlace":false,"score":null,"count":0,"source":"","reason":""}. keep et samePlace sont true seulement si la moyenne concerne ce lieu, dans cette ville, avec au moins 8 avis. score entre 1 et 5. N'invente pas, ne convertis pas une note sur 10. Si tu doutes, keep=false.`,
  venues: `Tu relèves des lieux culturels permanents des Alpes-Maritimes : salles de spectacle, cinémas, musées, scènes. Pas un événement daté. Réponds uniquement en JSON {"places":[...]}. Chaque lieu : name, city, address, lat, lng ou null, hours, website, kind. kind parmi theatre, cinema, music, museum, other. city est une commune, jamais seulement « Alpes-Maritimes ». hours : les horaires du bâtiment si la page les donne, sinon vide. N'invente pas.`,
  bookings: `Tu cherches la page où acheter un billet pour UN lieu ou UNE sortie. Réponds uniquement en JSON {"url":"","name":"","reason":""}. url en https, seulement si cette page vend bien ce lieu ou cette sortie. Sinon url est vide. name : le nom du site de réservation. N'invente pas une adresse.`,
};

const BRIEF_LABELS = {
  discover_page: "Agenda, jours neufs",
  review_page: "Agenda, jours déjà vus",
  discover_search: "Recherche web, jours neufs",
  review_search: "Recherche web, jours déjà vus",
  libraries: "Bibliothèques et médiathèques",
  ratings: "Avis",
  venues: "Lieux culturels",
  bookings: "Billetteries",
};

function fillBrief(template, vars = {}) {
  return String(template || "").replace(/\{\{(jours|categories|aujourdhui)\}\}/g, (_, key) => vars[key] ?? "");
}

function cleanBrief(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

async function loadBriefs(db) {
  const raw = await getRaw(db, "agent_briefs");
  let stored = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") stored = parsed;
    } catch {
      stored = {};
    }
  }
  const briefs = {};
  for (const key of BRIEF_KEYS) {
    const value = cleanBrief(stored[key]);
    briefs[key] = value || DEFAULT_BRIEFS[key];
  }
  return briefs;
}

async function saveBriefs(db, body = {}) {
  const briefs = {};
  for (const key of BRIEF_KEYS) {
    const value = cleanBrief(body[key]);
    if (!value) {
      const error = new Error("Chaque consigne doit rester écrite.");
      error.status = 400;
      throw error;
    }
    if (value.length > 4000) {
      const error = new Error("Une consigne dépasse 4000 signes.");
      error.status = 400;
      throw error;
    }
    briefs[key] = value;
  }
  await setRaw(db, "agent_briefs", JSON.stringify(briefs));
  return briefs;
}

async function resetBriefs(db) {
  await db.query("DELETE FROM settings WHERE key = 'agent_briefs'");
  return { ...DEFAULT_BRIEFS };
}

module.exports = {
  BRIEF_KEYS,
  BRIEF_LABELS,
  DEFAULT_BRIEFS,
  fillBrief,
  loadBriefs,
  saveBriefs,
  resetBriefs,
};
