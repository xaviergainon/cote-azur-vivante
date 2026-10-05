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

const CATEGORY_KEYS = Object.keys(CATEGORIES);

module.exports = { CATEGORIES, CATEGORY_KEYS, DEFAULT_SOURCES, DEFAULT_GEMINI_MODEL };
