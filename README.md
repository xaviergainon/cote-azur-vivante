# Côte d'Azur Vivante

Carte interactive **jour par jour** des spectacles, festivals, conférences, concerts et petites salles dans les **Alpes-Maritimes**.

Ouvre `index.html` (ou un petit serveur local), glisse, zoome, choisis un jour : chaque point mène à une salle ou un événement, avec lien vers la source.

## Lancer en local

1. Copie `js/config.example.js` vers `js/config.js`.
2. Colle ta clé **Maps JavaScript API** (Google Cloud Console).
3. Restreins la clé aux référents HTTP (`http://localhost:*`, ton domaine GitHub Pages).
4. Ouvre le fichier, ou (recommandé, Google Maps refuse souvent `file://`) :

```bash
npx --yes serve .
```

Puis va sur l’URL affichée (souvent `http://localhost:3000`).

## Données

Les événements sont agrégés à la main dans `js/events-data.js` à partir des agendas publics :

- [JDS](https://www.jds.fr/alpes-maritimes/agenda/)
- [Ville de Nice](https://www.nice.fr)
- [Ville de Cannes](https://www.cannes.com)
- [anthéa](https://www.anthea-antibes.fr)
- [Théâtre National de Nice](https://www.tnn.fr)
- [Théâtre de Grasse](https://www.theatredegrasse.com)
- [Sortir06](https://www.sortir06.fr)
- [Département 06](https://www.departement06.fr)
- [Agenda culturel 06](https://06.agendaculturel.fr)

Ce n’est **pas** un flux live : les petites assos, bars et salles privées manquent souvent. Pour actualiser, édite `js/events-data.js` (dates ISO, `lat` / `lng` du lieu).

## Publier sur GitHub Pages

1. Crée le dépôt `cote-azur-vivante` sous ton compte (ex. `xaviergainon`).
2. Pousse `main`, puis **Settings → Pages → Deploy from branch `main` / `/ (root)`**.
3. Dans Google Cloud, restreins la clé aux URL `https://xaviergainon.github.io/*` et `http://localhost:*`.

## Sécurité de la clé Google Maps

Ne commite **pas** `js/config.js` (déjà dans `.gitignore`). Active uniquement l’API **Maps JavaScript**. Si une clé a été collée dans un chat ou un dépôt public, **régénère-la** dans Google Cloud.
