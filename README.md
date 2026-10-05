# Côte d'Azur Vivante

Carte interactive **jour par jour** des spectacles, festivals, conférences, concerts et petites salles dans les **Alpes-Maritimes**.

Ouvre `index.html` (ou un petit serveur local), glisse, zoome, choisis un jour : chaque point mène à une salle ou un événement, avec lien vers la source.

## Lancer en local

1. Copie `js/config.example.js` vers `js/config.js`.
2. Colle ta clé **Maps JavaScript API** (Google Cloud Console).
3. Restreins la clé aux référents HTTP (`http://localhost:*` et le domaine Railway).
4. Démarre le serveur :

```bash
npm start
```

Puis ouvre `http://localhost:3000`.

Si `GOOGLE_MAPS_API_KEY` est définie dans l’environnement, elle remplace `js/config.js`.

## Déployer sur Railway

Le dépôt est une app Node : Railway la détecte et lance `npm start` sur le port `PORT`.

1. Sur [Railway](https://railway.com/), **New Project → Deploy from GitHub repo** et choisis `xaviergainon/cote-azur-vivante`.
2. Dans les variables du service, ajoute `GOOGLE_MAPS_API_KEY` (ta clé Maps JavaScript API). `GOOGLE_MAPS_MAP_ID` est optionnel.
3. **Settings → Networking → Generate Domain**.
4. Dans Google Cloud, restreins la clé aux référents `https://<ton-domaine>.up.railway.app/*` et `http://localhost:*`.

La clé n’est pas dans Git. Le serveur l’injecte dans `/js/config.js` au moment de la requête.

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
