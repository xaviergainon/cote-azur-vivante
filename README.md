# Côte d'Azur Vivante

Carte des spectacles, festivals, conférences et concerts des **Alpes-Maritimes**. Les événements sont dans Postgres. L’admin sert à déposer les clés **Gemini** et **Google Maps**, et à lancer un agent qui lit les agendas publics.

## Lancer en local

```bash
npm install
npm start
```

Ouvre `http://localhost:3000`. Sans `DATABASE_URL`, une base locale est créée dans `.data/`. Le premier passage sur `/admin` choisit le mot de passe.

La clé Maps peut rester dans `js/config.js` (non versionné) : au premier démarrage elle est copiée dans la base. Sinon, saisis-la dans **Administration → Clés API**.

## Déployer sur Railway

1. **New Project → Deploy from GitHub repo** → `xaviergainon/cote-azur-vivante`.
2. Ajoute **PostgreSQL** dans le même projet.
3. Sur le service web, variables :
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_SECRET` = une longue chaîne aléatoire (elle chiffre les clés API)
   - `ADMIN_PASSWORD` = mot de passe de l’admin, **avant** d’exposer le domaine
4. Génère le domaine public.
5. Ouvre `https://<ton-domaine>/admin`, vérifie les clés Gemini et Google Maps.
6. Dans Google Cloud, restreins la clé Maps aux référents `https://<ton-domaine>/*` et `http://localhost:*`.

`APP_SECRET` ne doit plus changer : les clés déjà enregistrées deviendraient illisibles.

## Admin

- **Clés API** — Gemini (collecte) et Google Maps (carte). Bouton pour tester Gemini.
- **Sources** — pages d’agenda que l’agent a le droit de lire.
- **Collecte** — lit chaque source activée, demande à Gemini d’en extraire les sorties du 06, enregistre le résultat en **brouillon**.
- **Événements** — corriger, publier ou supprimer. Seuls les événements publiés apparaissent sur la carte.

L’agent ignore les adresses privées, limite la taille des pages, et ne publie rien tout seul. Les sites qui ne rendent leur agenda qu’en JavaScript renvoient souvent une page vide : il faut alors une URL HTML.

## Données de départ

`js/events-data.js` sert de jeu initial, importé une seule fois si la table est vide. Ensuite, la carte lit `/api/agenda`.
