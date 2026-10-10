const CATEGORIES = {
  theatre: { label: "Théâtre", color: "#F0A06A", icon: "Th" },
  humour: { label: "Humour", color: "#F4C95F", icon: "Hu" },
  danse: { label: "Danse", color: "#E8A0BF", icon: "Da" },
  concert: { label: "Concert", color: "#7EC8E3", icon: "Co" },
  festival: { label: "Festival", color: "#5EEAD4", icon: "Fe" },
  conference: { label: "Conférence", color: "#9BB8C9", icon: "Cf" },
  cinema: { label: "Cinéma", color: "#E89AA8", icon: "Ci" },
  sport: { label: "Sport", color: "#86EFAC", icon: "Sp" },
  famille: { label: "Famille", color: "#FDBA74", icon: "Fa" },
  expo: { label: "Expo / marché", color: "#94A3B8", icon: "Ex" },
  soiree: { label: "Soirée", color: "#FB7185", icon: "So" },
  gastronomie: { label: "Gastronomie", color: "#FCD34D", icon: "Ga" },
  lecture: { label: "Bibliothèque", color: "#A78BFA", icon: "Bi" },
  livre: { label: "Livre", color: "#C47B4A", icon: "Li" },
  ecologie: { label: "Écologie", color: "#4ADE80", icon: "Ec" },
};

const DEFAULT_SOURCES = [
  { name: "JDS Agenda", url: "https://www.jds.fr/alpes-maritimes/agenda/" },
  { name: "Ville de Nice", url: "https://www.nice.fr" },
  { name: "Ville de Cannes", url: "https://www.cannes.com" },
  { name: "anthéa Antibes", url: "https://www.anthea-antibes.fr" },
  { name: "Théâtre National de Nice", url: "https://www.tnn.fr" },
  { name: "Théâtre de Grasse", url: "https://www.theatredegrasse.com" },
  { name: "Univ. Côte d'Azur", url: "https://univ-cotedazur.fr" },
  { name: "Festival du Livre", url: "https://www.lefestivaldulivre.fr" },
  { name: "Mouans-Sartoux", url: "https://www.mouans-sartoux.net" },
  { name: "Sortir06", url: "https://www.sortir06.fr" },
  { name: "Département 06", url: "https://www.departement06.fr" },
  { name: "Agenda culturel 06", url: "https://06.agendaculturel.fr" },
];

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

const PREVIOUS_QUERIES = [
  "agenda spectacles concerts théâtre Alpes-Maritimes 30 prochains jours",
  "festivals expositions Nice Cannes Antibes Grasse Menton prochaines semaines",
  "sorties gratuites famille Alpes-Maritimes ce mois-ci",
];

const MONACO_QUERIES = [
  "agenda spectacles concerts théâtre Alpes-Maritimes Monaco 30 prochains jours",
  "festivals expositions Nice Cannes Antibes Grasse Menton Monaco prochaines semaines",
  "sorties gratuites famille Alpes-Maritimes Monaco ce mois-ci",
];

const DEFAULT_QUERIES = [
  ...MONACO_QUERIES,
  "rencontres dédicaces présentations d'auteurs librairies Alpes-Maritimes Monaco",
  "sorties écologie environnement climat nature Alpes-Maritimes Monaco",
];

function upgradeQueries(list) {
  const clean = (Array.isArray(list) ? list : []).map((line) => String(line).trim()).filter(Boolean);
  if (!clean.length) return DEFAULT_QUERIES.slice();
  const known = [PREVIOUS_QUERIES, MONACO_QUERIES].some((set) => (
    set.length === clean.length && set.every((line, index) => line === clean[index])
  ));
  if (known) return DEFAULT_QUERIES.slice();
  const merged = clean.slice();
  for (const line of DEFAULT_QUERIES.slice(MONACO_QUERIES.length)) {
    if (!merged.includes(line) && merged.length < 5) merged.push(line);
  }
  return merged;
}

const DEFAULT_LIBRARY_SOURCES = [
  { name: "Bibliothèques de Nice", url: "https://bmvr.nice.fr/default/horaires.aspx?_lg=fr-FR" },
  { name: "Médiathèques de Cannes", url: "https://www.cannes.com/fr/culture/mediatheques-et-bibliotheques/informations-pratiques/horaires-et-acces.html" },
];

const DEFAULT_LIBRARY_QUERIES = [
  "horaires bibliothèques médiathèques Alpes-Maritimes Nice Cannes Antibes Grasse Menton",
];

const CATEGORY_KEYS = Object.keys(CATEGORIES);

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  DEFAULT_SOURCES,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_QUERIES,
  PREVIOUS_QUERIES,
  upgradeQueries,
  DEFAULT_LIBRARY_SOURCES,
  DEFAULT_LIBRARY_QUERIES,
};
