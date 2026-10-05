# Décisions

Choix faits pour l’agent interne, sans les redemander.

## Déclenchement

- Une collecte par jour, à **06:15 heure de Paris**.
- L’horaire tourne dans le processus web. Au démarrage, s’il est déjà passé et qu’aucune collecte quotidienne n’a abouti ce jour-là, elle part tout de suite. Une collecte déjà réussie n’est pas relancée. Une collecte en erreur est retentée, trois fois au plus dans la journée.
- Gemini 3 répond avec un budget de réflexion. L’agent demande le niveau `low`, ignore les parties « thought », et ne fixe pas `temperature` : sur ces modèles une température basse coupe la réponse.
- Si Gemini répond « quota » ou « high demand », l’agent attend le délai indiqué (trois essais au plus) au lieu d’abandonner la source.
- L’admin peut changer l’heure, couper l’automatisme, ou lancer une collecte tout de suite. Les sources et les recherches se règlent dans `/admin`.

## Ce que l’agent lit

- D’abord les recherches Google configurées (trois par défaut, cinq au maximum), via Gemini avec l’outil de recherche Google.
- Ensuite les pages d’agenda activées dans Sources, douze au maximum.
- Jusqu’à quatre pages citées par la recherche sont ouvertes en plus, si elles sont publiques. Les adresses privées sont refusées.

## Ce qui entre dans la base

- Seulement les événements dont une date tombe entre hier et les **30 prochains jours**, dans les Alpes-Maritimes.
- Les nouveaux restent en **brouillon**. Un événement déjà publié n’est pas réécrit.
- Rien n’est publié sans action dans l’admin.

## Clés

- Gemini est obligatoire pour la collecte. Google Maps sert uniquement à la carte.
- Les deux se saisissent dans l’admin et restent chiffrées. Elles ne sont pas dans Git.
