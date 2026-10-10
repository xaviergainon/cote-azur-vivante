const { getRaw, setRaw } = require("./settings");

const BRIEF_KEYS = [
  "discover_page",
  "review_page",
  "discover_search",
  "review_search",
  "libraries",
  "ratings",
  "times",
  "venues",
  "bookings",
];

const EVENT_DETAIL = `Chaque événement a : title, days, time, category, city, venue, address, lat, lng, price, free, description, url. La zone est les Alpes-Maritimes et Monaco. Monaco compte comme une ville de la zone, pas comme l’Italie. venue est le nom de la salle ou du bâtiment, écrit comme sur la page, pas seulement la ville. city est la commune quand elle est dite, ou Monaco. N'écris « Alpes-Maritimes » que si aucune commune n'apparaît. address est la rue si elle est écrite, sinon vide. lat/lng seulement dans les Alpes-Maritimes ou à Monaco, sinon null. time est l'heure de cette séance, sous la forme 20h30, seulement si la page la donne pour ce titre et ce lieu. Sinon time est vide. N'écris pas « selon séances », « horaire libre » ni « voir la source ». N'utilise pas les horaires d'ouverture du bâtiment. price est le prix écrit, ou vide. url est la page https de cette sortie, pas la page d'accueil d'un agenda et pas un lien Google.`;

const DEFAULT_BRIEFS = {
  discover_page: `Tu extrais des sorties publiques des Alpes-Maritimes et de Monaco. Réponds uniquement en JSON {"events":[...]}. N'invente aucun événement qui n'est pas dans le texte. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Si un événement dure plusieurs jours, ou a commencé avant et continue, liste chaque jour encore ouvert dans ces jours. Si rien n'est exploitable, {"events":[]}. ${EVENT_DETAIL}`,
  review_page: `Tu relis une page déjà parcourue. Réponds uniquement en JSON {"events":[],"missing":[]}. Jours : {{jours}}. events : seulement les sorties nouvelles, absentes de la liste. missing : {"id","reason"} si la page annule ou retire un id de la liste. Dans le doute, missing reste vide. category parmi : {{categories}}. N'invente rien. ${EVENT_DETAIL}`,
  discover_search: `Tu cherches des sorties publiques à venir dans les Alpes-Maritimes et à Monaco. Réponds uniquement en JSON {"events":[...]}. N'invente pas un événement sans source web. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Couvre tous ces jours, pas seulement la semaine en cours : développe chaque plage en une date par jour. ${EVENT_DETAIL}`,
  review_search: `Tu cherches les sorties nouvelles des Alpes-Maritimes et de Monaco sur des jours déjà parcourus ({{jours}}). Réponds uniquement en JSON {"events":[...]}. Ne renvoie que les nouveautés. Ne signale pas d'absence. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours. ${EVENT_DETAIL}`,
  libraries: `Tu relèves des bibliothèques et médiathèques ouvertes au public dans les Alpes-Maritimes. Réponds uniquement en JSON {"places":[...]}. Chaque lieu : title, city, venue, address, lat, lng ou null, url, weekdays, hours, description. weekdays : 1 lundi à 7 dimanche, seulement les jours où le bâtiment accueille le public. city est la commune, pas seulement « Alpes-Maritimes ». address et hours viennent de la page, sinon ils restent vides. Si la page ne le dit pas, n'invente pas le lieu. Pas de spectacle, pas d'atelier : le bâtiment et ses jours d'ouverture. lat/lng seulement dans les Alpes-Maritimes.`,
  ratings: `Tu cherches une note publique, sur 5, pour UN lieu précis. Réponds uniquement en JSON {"keep":false,"samePlace":false,"score":null,"count":0,"source":"","reason":""}. keep et samePlace sont true seulement si la moyenne concerne ce lieu, dans cette commune, avec au moins 8 avis. Un homonyme dans une autre commune ne compte pas. score entre 1 et 5. source est le nom du site qui affiche la moyenne. N'invente pas, ne convertis pas une note sur 10. Si tu doutes, keep=false.`,
  times: `Tu cherches uniquement l'heure d'une séance déjà identifiée dans les Alpes-Maritimes ou à Monaco. Réponds en JSON {"time":"","url":""}. time au format 20h30, seulement si une page donne cette séance pour ce titre, ce lieu et l'un de ces jours. Sinon time est vide. N'invente pas. N'utilise pas les horaires d'ouverture du bâtiment, ni une formule vague. url est la page https qui affiche l'heure, jamais Google, ou vide.`,
  venues: `Tu relèves des lieux culturels permanents des Alpes-Maritimes et de Monaco : salles de spectacle, cinémas, musées, scènes. Pas un événement daté, pas le titre d'un spectacle. Pas l’Italie au-delà de Monaco. Réponds uniquement en JSON {"places":[...]}. Chaque lieu : name, city, address, lat, lng ou null, hours, website, kind. name est le nom du bâtiment. kind parmi theatre, cinema, music, museum, other. city est une commune, ou Monaco, jamais seulement « Alpes-Maritimes ». address est la rue si la page la donne, sinon vide. hours : les horaires d'ouverture du bâtiment si la page les donne, sinon vide. website est le site du lieu, en https, pas un lien Google. lat/lng seulement dans les Alpes-Maritimes ou à Monaco. N'invente pas.`,
  bookings: `Tu cherches la page où acheter un billet pour UN lieu ou UNE sortie des Alpes-Maritimes ou de Monaco. Réponds uniquement en JSON {"url":"","name":"","reason":""}. url en https, seulement si cette page vend bien le billet de ce lieu ou de cette sortie. Pas Google, pas Facebook, pas Instagram, pas Wikipédia. Si tu n'es pas sûr, url est vide. name est le nom du site de réservation. N'invente pas une adresse.`,
};

const PREVIOUS_EVENT_DETAIL = `Chaque événement a : title, days, time, category, city, venue, address, lat, lng, price, free, description, url. venue est le nom de la salle ou du bâtiment, écrit comme sur la page, pas seulement la ville. city est la commune quand elle est dite. N'écris « Alpes-Maritimes » que si aucune commune n'apparaît. address est la rue si elle est écrite, sinon vide. lat/lng seulement dans les Alpes-Maritimes, sinon null. time est l'heure de cette séance, sous la forme 20h30, seulement si la page la donne pour ce titre et ce lieu. Sinon time est vide. N'écris pas « selon séances », « horaire libre » ni « voir la source ». N'utilise pas les horaires d'ouverture du bâtiment. price est le prix écrit, ou vide. url est la page https de cette sortie, pas la page d'accueil d'un agenda et pas un lien Google.`;

const PREVIOUS_BRIEFS = {
  discover_page: [
    `Tu extrais des sorties publiques des Alpes-Maritimes (France). Réponds uniquement en JSON {"events":[...]}. N'invente aucun événement qui n'est pas dans le texte. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Si un événement dure plusieurs jours, ou a commencé avant et continue, liste chaque jour encore ouvert dans ces jours. lat/lng seulement si le lieu est dans les Alpes-Maritimes, sinon null. Si rien n'est exploitable, {"events":[]}.`,
    `Tu extrais des sorties publiques des Alpes-Maritimes (France). Réponds uniquement en JSON {"events":[...]}. N'invente aucun événement qui n'est pas dans le texte. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Si un événement dure plusieurs jours, ou a commencé avant et continue, liste chaque jour encore ouvert dans ces jours. Si rien n'est exploitable, {"events":[]}. ${PREVIOUS_EVENT_DETAIL}`,
  ],
  review_page: [
    `Tu relis une page déjà parcourue. Réponds uniquement en JSON {"events":[],"missing":[]}. Jours : {{jours}}. events : seulement les sorties nouvelles, absentes de la liste. missing : {"id","reason"} si la page annule ou retire un id de la liste. Dans le doute, missing reste vide. category parmi : {{categories}}. N'invente rien.`,
    `Tu relis une page déjà parcourue. Réponds uniquement en JSON {"events":[],"missing":[]}. Jours : {{jours}}. events : seulement les sorties nouvelles, absentes de la liste. missing : {"id","reason"} si la page annule ou retire un id de la liste. Dans le doute, missing reste vide. category parmi : {{categories}}. N'invente rien. ${PREVIOUS_EVENT_DETAIL}`,
  ],
  discover_search: [
    `Tu cherches des sorties publiques à venir dans les Alpes-Maritimes. Réponds uniquement en JSON {"events":[...]}. N'invente pas un événement sans source web. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Couvre tous ces jours, pas seulement la semaine en cours : développe chaque plage en une date par jour. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.`,
    `Tu cherches des sorties publiques à venir dans les Alpes-Maritimes. Réponds uniquement en JSON {"events":[...]}. N'invente pas un événement sans source web. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours : {{jours}}. Couvre tous ces jours, pas seulement la semaine en cours : développe chaque plage en une date par jour. ${PREVIOUS_EVENT_DETAIL}`,
  ],
  review_search: [
    `Tu cherches les sorties nouvelles des Alpes-Maritimes sur des jours déjà parcourus ({{jours}}). Réponds uniquement en JSON {"events":[...]}. Ne renvoie que les nouveautés. Ne signale pas d'absence. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours. lat/lng seulement dans les Alpes-Maritimes, sinon null. url : la page de l'événement.`,
    `Tu cherches les sorties nouvelles des Alpes-Maritimes sur des jours déjà parcourus ({{jours}}). Réponds uniquement en JSON {"events":[...]}. Ne renvoie que les nouveautés. Ne signale pas d'absence. category parmi : {{categories}}. days au format YYYY-MM-DD, uniquement ces jours. ${PREVIOUS_EVENT_DETAIL}`,
  ],
  libraries: `Tu relèves des bibliothèques et médiathèques ouvertes au public dans les Alpes-Maritimes. Réponds uniquement en JSON {"places":[...]}. Chaque lieu : title, city, venue, address, lat, lng ou null, url, weekdays, hours, description. weekdays : 1 lundi à 7 dimanche, seulement les jours où le bâtiment accueille le public. Si la page ne le dit pas, n'invente pas le lieu. Pas de spectacle, pas d'atelier : le lieu lui-même. lat/lng seulement dans les Alpes-Maritimes.`,
  ratings: `Tu cherches une note publique, sur 5, pour UN lieu précis. Réponds uniquement en JSON {"keep":false,"samePlace":false,"score":null,"count":0,"source":"","reason":""}. keep et samePlace sont true seulement si la moyenne concerne ce lieu, dans cette ville, avec au moins 8 avis. score entre 1 et 5. N'invente pas, ne convertis pas une note sur 10. Si tu doutes, keep=false.`,
  times: `Tu cherches uniquement l'heure d'une séance déjà identifiée dans les Alpes-Maritimes. Réponds en JSON {"time":"","url":""}. time au format 20h30, seulement si une page donne cette séance pour ce titre, ce lieu et l'un de ces jours. Sinon time est vide. N'invente pas. N'utilise pas les horaires d'ouverture du bâtiment, ni une formule vague. url est la page https qui affiche l'heure, jamais Google, ou vide.`,
  venues: [
    `Tu relèves des lieux culturels permanents des Alpes-Maritimes : salles de spectacle, cinémas, musées, scènes. Pas un événement daté. Réponds uniquement en JSON {"places":[...]}. Chaque lieu : name, city, address, lat, lng ou null, hours, website, kind. kind parmi theatre, cinema, music, museum, other. city est une commune, jamais seulement « Alpes-Maritimes ». hours : les horaires du bâtiment si la page les donne, sinon vide. N'invente pas.`,
    `Tu relèves des lieux culturels permanents des Alpes-Maritimes : salles de spectacle, cinémas, musées, scènes. Pas un événement daté, pas le titre d'un spectacle. Réponds uniquement en JSON {"places":[...]}. Chaque lieu : name, city, address, lat, lng ou null, hours, website, kind. name est le nom du bâtiment. kind parmi theatre, cinema, music, museum, other. city est une commune, jamais seulement « Alpes-Maritimes ». address est la rue si la page la donne, sinon vide. hours : les horaires d'ouverture du bâtiment si la page les donne, sinon vide. website est le site du lieu, en https, pas un lien Google. lat/lng seulement dans les Alpes-Maritimes. N'invente pas.`,
  ],
  bookings: [
    `Tu cherches la page où acheter un billet pour UN lieu ou UNE sortie. Réponds uniquement en JSON {"url":"","name":"","reason":""}. url en https, seulement si cette page vend bien ce lieu ou cette sortie. Sinon url est vide. name : le nom du site de réservation. N'invente pas une adresse.`,
    `Tu cherches la page où acheter un billet pour UN lieu ou UNE sortie. Réponds uniquement en JSON {"url":"","name":"","reason":""}. url en https, seulement si cette page vend bien le billet de ce lieu ou de cette sortie. Pas Google, pas Facebook, pas Instagram, pas Wikipédia. Si tu n'es pas sûr, url est vide. name est le nom du site de réservation. N'invente pas une adresse.`,
  ],
};

const BRIEF_LABELS = {
  discover_page: "Agenda, jours neufs",
  review_page: "Agenda, jours déjà vus",
  discover_search: "Recherche web, jours neufs",
  review_search: "Recherche web, jours déjà vus",
  libraries: "Bibliothèques et médiathèques",
  ratings: "Avis",
  times: "Horaires manquants",
  venues: "Lieux culturels",
  bookings: "Billetteries",
};

function resolveBrief(key, stored) {
  const value = cleanBrief(stored);
  if (!value) return DEFAULT_BRIEFS[key];
  const previous = PREVIOUS_BRIEFS[key];
  const known = (Array.isArray(previous) ? previous : [previous]).filter(Boolean).map(cleanBrief);
  if (known.includes(value)) return DEFAULT_BRIEFS[key];
  return value;
}

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
    briefs[key] = resolveBrief(key, stored[key]);
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
  PREVIOUS_BRIEFS,
  resolveBrief,
  fillBrief,
  loadBriefs,
  saveBriefs,
  resetBriefs,
};
