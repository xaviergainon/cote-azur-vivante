# Décisions

Choix faits pour l’agent interne, sans les redemander.

## Déclenchement

- Une collecte par jour, à **06:15 heure de Paris**.
- L’horaire tourne dans le processus web. Au démarrage, s’il est déjà passé et qu’aucune collecte quotidienne n’a abouti ce jour-là, elle part tout de suite. Une collecte déjà réussie n’est pas relancée. Une collecte en erreur est retentée, trois fois au plus dans la journée.
- Gemini 3 répond avec un budget de réflexion. L’agent demande le niveau `low`, ignore les parties « thought », et ne fixe pas `temperature` : sur ces modèles une température basse coupe la réponse.
- Si Gemini répond « quota » ou « high demand », l’agent attend le délai indiqué (quatre essais au plus) au lieu d’abandonner la source. Les appels sont espacés de 13 secondes pour rester sous le quota gratuit de 5 requêtes par minute.
- Le planning donne une ligne à chaque agent : sorties, affiches, horaires, doublons, lieux, réservations, bibliothèques, avis. Chacun peut être arrêté, quotidien, hebdomadaire ou mensuel, à une heure de Paris. Une seule tâche part à la fois. Sans réglage enregistré, les sorties restent quotidiennes, et les bibliothèques comme les avis une fois par mois. L’admin peut changer ces réglages, lancer une collecte tout de suite, ou l’interrompre. L’interruption s’arrête à l’appel en cours. Ce qui est déjà enregistré reste. Une collecte interrompue n’est pas relancée toute seule. Les sources, les recherches et les consignes des agents se règlent dans `/admin`, page Collecte. Les consignes d’origine restent le texte de départ. `{{jours}}`, `{{categories}}` et `{{aujourdhui}}` sont remplis au lancement.
- Les consignes de collecte demandent l’heure de la séance (20h30, sinon vide), le nom de la salle, la commune, la rue si elle est écrite, et la page de la sortie. La consigne des horaires manquants, celle des lieux et celle des billetteries sont dans la même page. Une consigne encore égale à l’ancien texte d’origine est remplacée. Une consigne déjà modifiée à la main est gardée.

## Ce que l’agent lit

- D’abord les recherches Google configurées (trois par défaut, cinq au maximum), via Gemini avec l’outil de recherche Google.
- Ensuite les pages d’agenda activées dans Sources, douze au maximum.
- Jusqu’à quatre pages citées par la recherche sont ouvertes en plus, si elles sont publiques. Les adresses privées sont refusées.

## Ce qui entre dans la base

- Seulement les événements dont une date tombe entre hier et **aujourd’hui + 30 jours**, en calendrier de Paris, dans les Alpes-Maritimes ou à Monaco. Monaco est dans la zone culturelle, pas l’Italie au-delà. Les recherches ne s’arrêtent pas à la semaine en cours : chaque lecture demande toute cette fenêtre, et une plage de dates est développée jour par jour.
- Un lancement manuel peut fixer un début et une fin, pour un essai, sur 92 jours au plus. Sans ces dates, et pour la collecte automatique, la fenêtre reste les 30 jours.
- Les jours déjà parcourus par une collecte terminée sont relus en dernier. La consigne change : d’abord les sorties nouvelles, ensuite celles déjà en base. Si une sortie n’est plus annoncée, elle apparaît dans « À vérifier ». L’admin la note annulée ou la supprime. Rien n’est retiré tout seul.
- Les nouveaux restent en **brouillon**. Un événement déjà publié n’est pas réécrit, sauf quand c’est le même spectacle : la collecte ajoute les dates et complète seulement les champs vides.
- Le passage « Regrouper les doublons » réunit les fiches au même titre, dans la même ville. Un sous-titre (« de Raymond Queneau ») ne fait pas une autre sortie. Il additionne les dates, garde le texte déjà rempli, complète l’adresse, le lieu ou le lien manquant, puis retire la fiche en trop. Deux villes différentes restent deux sorties. Deux salles qui ne se ressemblent pas aussi. Les bibliothèques ne sont pas regroupées ici.
- Chaque collecte reprend ensuite jusqu’à six sorties des 30 jours qui n’ont pas d’heure. Le passage « Compléter les horaires » en traite douze. L’heure n’est écrite que si une page la donne pour ce titre et ce lieu. « Selon séances » ne compte pas. Le lendemain, le passage prend les suivantes.
- Les lieux culturels ont leur propre base : nom, commune, adresse, point, horaires du bâtiment, site. Les recherches de sorties, de lieux et de billetteries incluent Monaco. Le passage « Relever les lieux culturels » est manuel et utilise le moteur choisi dans Collecte, Cursor ou Gemini. Avec Cursor, la recherche se fait sur le web public. Il propose au plus douze lieux, en brouillon. Un lieu validé n’est pas réécrit par un passage suivant. Chaque lecture d’agenda rattache les sorties nouvelles et celles qui n’ont encore aucun lieu, quand le nom de la salle correspond sans ambiguïté à un lieu validé, dans la même commune. L’adresse et le point ne remplissent que les champs vides. Un lieu sans latitude ni longitude est placé depuis son adresse, dans les Alpes-Maritimes ou à Monaco. S’y rendre utilise le point de la sortie, et celui du lieu validé si la sortie n’en a pas. Un point sans rue ne fabrique pas l’adresse tout seul : le passage « fiches » la déduit du point, propose le bâtiment s’il n’existe pas encore, et propose le lien de réservation de la sortie. Huit fiches par passage, d’abord celles jamais vérifiées, puis les plus anciennes. Une fiche revue n’est pas relue avant 14 jours. Le lieu nouveau reste en brouillon. Le billet reste une proposition. Les avis restent sur leur passage, qui a déjà sa date de vérification. Le passage des horaires reste sur Gemini, parce qu’il interroge Google.
- Les pages de réservation sont proposées à part, pour un lieu validé ou pour une sortie. Le passage « Trouver les réservations » est manuel. Le bouton Réserver n’apparaît que lorsqu’une proposition est acceptée. Le lien d’une sortie prime sur celui de son lieu.
- Rien n’est publié sans action dans l’admin.
- Dans Événements, la recherche porte sur le titre, la ville, le lieu et l’adresse. « Même point » liste les sorties qui partagent des coordonnées : l’anneau sur la carte les écarte pour les rendre visibles, ce n’est pas leur adresse. « Sans adresse » et « Sans coordonnées » isolent les fiches incomplètes. L’adresse se corrige sur la fiche.

## Clés

- Gemini est le moteur par défaut de la collecte. Google Maps sert uniquement à la carte.
- Cursor peut remplacer Gemini depuis l’admin. Sa clé lance un agent cloud sans dépôt : il ne modifie pas le code et il est supprimé à la fin de la collecte. Le choix reste sur Gemini tant qu’on ne le change pas.
- Les clés se saisissent dans l’admin et restent chiffrées. Elles ne sont pas dans Git.

## Carte, liste, calendrier

- L’accueil est une couverture de saison : « À l’affiche », les disciplines, et trois sorties du week-end. Elle reste affichée à chaque ouverture. « Ouvrir le programme » entre sur la carte.
- À l’ouverture, et avec le bouton Recadrer, la carte montre les Alpes-Maritimes, de la côte aux montagnes. Un filtre de période ou d’envie resserre ensuite le cadre sur les sorties retenues.
- Les marqueurs sont des pastilles rondes. Le cercle garde la couleur de la catégorie. Le signe blanc dit la famille : spectacle (masque), musique (note), cinéma (clap), expo (cadre), famille (deux silhouettes), lecture (livre), table (fourchette), plein air (soleil). La pastille choisie est un peu plus grande, cerclée de blanc.
- Sur téléphone, la carte est en plein écran. On cherche d’abord une envie (théâtre, concert, cinéma, famille, expo) et une période : aujourd’hui, le week-end, les 7 prochains jours, ou le mois en cours. Le défaut est les 7 jours. Sur la carte, ces choix sont repliés : le bouton Jours les ouvre et Réduire les referme. « Un jour » ouvre la barre des jours. Les autres envies, la ville et le gratuit restent dans le volet. La liste garde les choix ouverts et regroupe les sorties par jour. Le calendrier sert à viser une date.
- La fiche d’une sortie propose l’itinéraire. Elle s’ouvre depuis la liste ou un marqueur.
- Sur grand écran, la carte reste visible. La liste et le calendrier sont un panneau à droite. La fiche événement reste dans la colonne de gauche, au-dessus du logo Google.
- Le thème suit le réglage du client (`prefers-color-scheme`) : papier clair ou nuit, carte comprise. Pas de bouton dans l’application.
- L’illustration vient de l’affiche de la page de l’événement (`og:image`). Une page qui liste plusieurs sorties ne partage pas son image de site : le passage suit le lien du spectacle sur cette page, et n’ouvre une recherche que si ce lien manque, par groupes de huit, 24 fois au plus. Si l’agent est encore occupé, ces pages reprennent au passage suivant. Une image trop petite, un logo, une bannière ou une icône est écarté. S’il n’y a pas d’affiche propre à la sortie, aucune image n’est proposée. Le passage « affiches manquantes » concerne les brouillons et les sorties publiées, 80 sorties au plus, les plus proches d’abord. Le suivant reprend celles qui restent. « Depuis le début » efface cette mémoire. Sur une fiche, « Chercher l’affiche » fait la même chose pour une seule sortie et n’enregistre rien tant que tu ne valides pas. Elle reste en proposition tant que l’admin ne la retient pas. Sur la carte, la fiche et l’admin, le cadre est le même 16:9, recadré au centre. Le bandeau de la carte en montre un carré.

## Bibliothèques et avis

- Les bibliothèques et médiathèques sont une rubrique à part, catégorie Bibliothèque. Le passage mensuel lit leurs pages et leurs recherches, puis retient les jours d’ouverture du mois. Il ne fait pas partie de la collecte du matin. Les nouveaux lieux restent en brouillon. L’affiche est cherchée sur la page du lieu, jamais partagée entre plusieurs adresses.
- Les avis sont une autre compétence, lancée à part, une fois par mois, sur douze sorties au plus. Elle peut s’appuyer sur Google et sur des pages d’avis choisies dans Sources, les mêmes ou d’autres. Une note sur 5 n’est publiée que si elle vise le bon lieu et compte au moins 8 avis. Sinon elle est écartée, et une note déjà juste n’est pas effacée par un passage trop mince.
- Plus tard, une note laissée dans l’application comptera avec celle du web : le web pèse au plus comme 40 avis, chaque note de l’application pèse 1. Cinq notes de lecteurs peuvent s’afficher seules. En dessous, sans note web retenue, rien n’est montré.

## Rapport et courriel

- L’admin s’ouvre sur un rapport : volumes, brouillons, publiés, affiches, types, villes, et le calendrier d’hier aux 30 jours suivants.
- Après chaque collecte automatique, ce rapport part par courriel. L’adresse par défaut est xavier.gainon@gmail.com. L’envoi passe par Resend : la clé se colle dans le rapport et reste chiffrée. Sans clé, la collecte se termine quand même et le journal le dit.
