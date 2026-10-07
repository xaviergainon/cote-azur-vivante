# Décisions

Choix faits pour l’agent interne, sans les redemander.

## Déclenchement

- Une collecte par jour, à **06:15 heure de Paris**.
- L’horaire tourne dans le processus web. Au démarrage, s’il est déjà passé et qu’aucune collecte quotidienne n’a abouti ce jour-là, elle part tout de suite. Une collecte déjà réussie n’est pas relancée. Une collecte en erreur est retentée, trois fois au plus dans la journée.
- Gemini 3 répond avec un budget de réflexion. L’agent demande le niveau `low`, ignore les parties « thought », et ne fixe pas `temperature` : sur ces modèles une température basse coupe la réponse.
- Si Gemini répond « quota » ou « high demand », l’agent attend le délai indiqué (quatre essais au plus) au lieu d’abandonner la source. Les appels sont espacés de 13 secondes pour rester sous le quota gratuit de 5 requêtes par minute.
- L’admin peut changer l’heure, couper l’automatisme, ou lancer une collecte tout de suite. Les sources et les recherches se règlent dans `/admin`.

## Ce que l’agent lit

- D’abord les recherches Google configurées (trois par défaut, cinq au maximum), via Gemini avec l’outil de recherche Google.
- Ensuite les pages d’agenda activées dans Sources, douze au maximum.
- Jusqu’à quatre pages citées par la recherche sont ouvertes en plus, si elles sont publiques. Les adresses privées sont refusées.

## Ce qui entre dans la base

- Seulement les événements dont une date tombe entre hier et **aujourd’hui + 30 jours**, en calendrier de Paris, dans les Alpes-Maritimes. Les recherches ne s’arrêtent pas à la semaine en cours : chaque lecture demande toute cette fenêtre, et une plage de dates est développée jour par jour.
- Un lancement manuel peut fixer un début et une fin, pour un essai, sur 92 jours au plus. Sans ces dates, et pour la collecte automatique, la fenêtre reste les 30 jours.
- Les jours déjà parcourus par une collecte terminée sont relus en dernier. La consigne change : d’abord les sorties nouvelles, ensuite celles déjà en base. Si une sortie n’est plus annoncée, elle apparaît dans « À vérifier ». L’admin la note annulée ou la supprime. Rien n’est retiré tout seul.
- Les nouveaux restent en **brouillon**. Un événement déjà publié n’est pas réécrit.
- Rien n’est publié sans action dans l’admin.

## Clés

- Gemini est le moteur par défaut de la collecte. Google Maps sert uniquement à la carte.
- Cursor peut remplacer Gemini depuis l’admin. Sa clé lance un agent cloud sans dépôt : il ne modifie pas le code et il est supprimé à la fin de la collecte. Le choix reste sur Gemini tant qu’on ne le change pas.
- Les clés se saisissent dans l’admin et restent chiffrées. Elles ne sont pas dans Git.

## Carte, liste, agenda

- Sur téléphone, la carte est en plein écran. Le jour se choisit sur une barre de temps qui couvre hier et les 30 jours suivants, même quand un jour n’a aucune sortie. Les filtres (ville, envie, gratuit, recherche) s’ouvrent dans un volet. La liste et le calendrier sont deux autres vues, avec la même barre.
- Une carte « prochaine sortie » propose l’événement le plus proche. L’ouvrir donne l’itinéraire, l’ajout à l’agenda, et le retour sur la carte.
- « Dans mon agenda » télécharge un fichier `.ics` (Apple, Google, Outlook) : le jour affiché depuis la carte ou la liste, le mois affiché depuis le calendrier, ou un seul événement.
- Sur grand écran, la carte reste visible. La liste et le calendrier sont un panneau à droite. La fiche événement reste dans la colonne de gauche, au-dessus du logo Google.
- Le thème suit le réglage du client (`prefers-color-scheme`) : papier clair ou nuit, carte comprise. Pas de bouton dans l’application.
- L’illustration vient de l’affiche de la page de l’événement (`og:image`). Une page qui liste plusieurs sorties ne partage pas son image de site. Une image trop petite, un logo, une bannière ou une icône est écarté. S’il n’y a pas d’affiche propre à la sortie, aucune image n’est proposée. Un passage « affiches manquantes » ouvre seulement le lien des sorties sans image, 40 pages au plus. Sur une fiche, « Chercher l’affiche » fait la même chose pour une seule sortie et n’enregistre rien tant que tu ne valides pas. Elle reste en proposition tant que l’admin ne la retient pas. Sur la carte, la fiche et l’admin, le cadre est le même 16:9, recadré au centre. Le bandeau de la carte en montre un carré.
