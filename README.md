# Blind Test Party

Blind test multijoueur dans le navigateur : 1 owner + jusqu'à 10 joueurs.

## Lancer en local
    node server.js
puis ouvrir http://localhost:3000 (Node 18 ou plus, aucun paquet à installer).

## Mettre en ligne gratuitement (Render, ~5 minutes)
1. Crée un dépôt GitHub (ex. `blind-test-party`) et envoie-y tout le contenu de ce dossier
   (sur github.com : "Add file" → "Upload files", glisse les fichiers, "Commit").
2. Va sur https://render.com, connecte-toi avec GitHub.
3. "New +" → "Blueprint" → choisis ton dépôt → "Apply". (`render.yaml` configure tout, plan Free.)
   Sans Blueprint : "New +" → "Web Service" → ton dépôt → Runtime Node, Start Command `node server.js`, Instance Type Free.
4. Au bout de 1 à 2 minutes tu as une adresse du type `https://blind-test-party.onrender.com`.
   Partage-la : les joueurs saisissent le code du salon (ou ouvrent le lien copié depuis le lobby).

Limites du plan gratuit :
- Le site se met en veille après ~15 min sans visiteur ; le 1er chargement suivant prend ~30 à 60 s. Ouvre-le un peu avant de jouer.
- Les salons sont en mémoire : un redémarrage du serveur les efface.
- Le disque est temporaire : l'XP (data/xp.json) est remise à zéro à chaque redémarrage/redéploiement.
  Pour une XP permanente il faudrait une base de données (ex. Supabase gratuit) : à ajouter si tu veux.

## Règles
- L'owner crée le salon, choisit un pack (20 génériques) et le nombre de manches (1, 2, 4 ou 5), puis lance. Il ne joue pas.
- Il lance chaque générique ; les joueurs buzzent (bouton ou barre Espace). Le 1er à buzzer a 5 secondes pour répondre à voix haute.
- L'owner voit la réponse et valide (+200) ou refuse (−100). Un refus, ou les 5 s écoulées, valent −100 : le joueur est bloqué
  sur ce générique, qui reprend pour les autres.
- Entre deux manches : récap des scores. À la fin : classement + XP (20 de participation + score/10 + bonus podium 50/30/15,
  200 XP = 1 niveau).

## Réponse à la voix
- Quand un joueur buzze, son navigateur écoute sa réponse (reconnaissance vocale de Chrome/Edge, en français) et l'affiche en direct chez tout le monde.
- Si la réponse correspond à une réponse acceptée du générique, elle est validée automatiquement (+200). L'owner peut désactiver ça dans le lobby
  (« Validation automatique par la voix ») et peut toujours valider ou refuser à la main. Une réponse non reconnue n'est jamais refusée toute seule.
- Le joueur doit autoriser le micro (bouton « Tester mon micro » dans le lobby). Firefox/Safari : pas de reconnaissance vocale, l'owner valide à l'oreille.
- Chrome envoie l'audio aux serveurs de Google pour le transcrire ; ça marche sur localhost et en https (Render).

## Musique
- Chaque générique est cherché automatiquement (API gratuite iTunes) : un extrait de 30 s, joué en boucle chez tous les joueurs. Aucun lien à coller.
- Si la piste n'est pas la bonne, l'owner clique sur « Autre piste » (jusqu'à 10 candidates). Il voit le titre de la piste, pas les joueurs.
- Aucune piste trouvée ? L'owner peut coller un lien YouTube (lecteur intégré) ou jouer le son lui-même.
- Aucun fichier audio n'est hébergé dans le jeu (droits d'auteur).

## Créer ses packs (owner)
Dans le lobby : « Mes packs » → « Créer un pack ». Un morceau par ligne :
    Réponse à deviner | recherche musique (artiste + titre)
    Réponse à deviner | https://www.youtube.com/watch?v=...   (lien YouTube fixé une fois pour toutes)
« Tester les pistes » vérifie ce que le jeu va trouver pour chaque ligne. Les packs sont enregistrés dans le navigateur de l'owner
et envoyés au salon avec « Utiliser » (60 morceaux max).

## Ajouter un pack permanent
Copie un bloc de `packs.json` (id, name, emoji, items avec title + search).

## Modes de jeu
- **Classique** : jusqu'à 10 joueurs, tout le monde joue dans la même salle, manches et récap.
- **Tournoi** : jusqu'à 16 joueurs.
  1. **Sélections** : les joueurs sont répartis au hasard en salles de 4 max (16 joueurs = 4 salles : quarts de finale ; 5 à 8 = 2 salles ; 9 à 12 = 3 salles). Les salles jouent **en même temps**, chacune avec ses propres génériques.
  2. L'owner voit **toutes les salles sur un seul écran** (scores, buzz, réponse transcrite, boutons Valider / Refuser par salle). Quand un joueur buzze dans une salle, **les autres salles se mettent en pause** (musique coupée, buzz bloqué) puis reprennent après la validation ou le refus. Les génériques s'enchaînent tout seuls : l'owner n'a que les validations à faire.
  3. Le vainqueur de chaque salle (meilleur score, à égalité le premier à avoir trouvé) va en **finale**. Les autres regardent.
  4. **Finale** : les vainqueurs rejouent à 0 point sur les génériques restants. Classement final : finalistes d'abord, puis les autres selon leur score de sélection.
  Avec 4 joueurs ou moins, il n'y a pas de sélection : finale directe. Côté owner, le bouton « Écouter » d'une salle joue son extrait (par défaut l'owner n'entend rien).
Le mode se choisit sur l'accueil avant de créer le salon.

## Pack « Génériques d'animés » : tes propres mp3
1. Copie tes mp3 dans le dossier `media/` du jeu (ou dans `media/anime/`), en gardant leurs noms d'origine, pas besoin de les renommer.
2. Relance le jeu (ou clique à nouveau sur le pack dans le lobby) : le pack « 🎌 Génériques d'animés » (tes fichiers) apparaît avec les génériques trouvés.
Chaque fichier est reconnu par un mot-clé de son nom (`attack on titan`, `cowboy bebop`, `naruto`, `kitadani` pour One Piece…). La liste des mots-clés et des réponses acceptées est dans `packs.json`, pack `anime-local` : modifie-la pour ajouter d'autres animés. Un fichier vide ou corrompu (moins de 20 Ko) est ignoré, et la console du serveur le signale. Aucune recherche iTunes n'est faite pour ce pack : c'est ton fichier qui est joué.

## Pack « Génériques de jeux vidéo » : tes mp3
Même principe que les animés : copie tes mp3 dans `media/` (ou `media/jeux/`), noms d'origine conservés. Chaque fichier est reconnu par un mot de son nom : mario, zelda, tetris, sonic, minecraft, pac man, undertale, final fantasy, dragonborn (Skyrim), gta, halo, kingdom hearts, witcher, doom, metal gear, animal crossing, wii sports, mortal kombat, street fighter, red dead. Le pack apparaît dès qu'au moins un fichier est trouvé ; les jeux sans fichier sont simplement écartés. Pour ajouter un jeu, ajoute une ligne dans `packs.json` (pack `jeux-local`).

## Compte (login)
Bouton **Login** en haut à droite : création de compte (pseudo + e-mail + mot de passe) ou connexion.
Une fois connecté, ton pseudo est verrouillé et ton XP / niveau / victoires sont rattachés à ton compte (sur tous tes appareils).
Les comptes sont stockés dans `data/accounts.json` (mots de passe hachés, jamais en clair). Aucun e-mail n'est envoyé.
⚠️ Sur l'hébergement gratuit (Render), le dossier `data/` est effacé à chaque redéploiement : pour garder les comptes durablement, il faudra une base externe gratuite.

## Juge IA des réponses vocales
Quand un joueur buzze et répond à voix haute, le jeu juge seul sa réponse (si « Juge automatique » est activé dans le lobby) :
- bonne réponse reconnue → +200 tout de suite ;
- phrase terminée et mauvaise réponse → −100 et le joueur est bloqué (les « euh », « hum »… sont ignorés).
Par défaut le jugement est **local** : gratuit, sans limite, sans compte. Il compare les mots, les fautes de frappe et la **prononciation** (« pokémone » = « pokemon », « dragonne bol » = « dragon ball »).
Option IA gratuite : crée une clé gratuite (sans carte bancaire) chez Google AI Studio (`GEMINI_API_KEY`) ou Groq (`GROQ_API_KEY`) et ajoute-la en variable d'environnement (Render : Environment). L'IA n'est consultée que quand le juge local dit « non » ; si sa limite gratuite est atteinte, le jeu retombe sur le juge local.

## Nouveautés
- **Partie rapide (matchmaking)** : bouton ⚡ du menu. Rejoint une partie publique en attente (2 joueurs minimum, départ 20 s après le 2e joueur, ou 3 s quand tout le monde est « prêt »). Pas d'owner : 10 génériques d'un pack tiré au sort, le jeu juge les réponses vocales tout seul.
- **Mode Équipes** 🔴🔵 : 2 équipes, scores additionnés, l'équipe gagnante remporte la victoire.
- **Salon privé** : mot de passe facultatif à la création.
- **Série de bonnes réponses** : 3 d'affilée = +50, 4 = +100, 5 et plus = +150 de bonus.
- **Générique en or** : 1 générique sur 5, points doublés (gains et pénalités).
- **Indice automatique** : après 20 s d'écoute, premières lettres + longueur du titre (variable `HINT_AT`).
- **Réactions** 👏😂🔥😮❤️🎉, **chat** et bouton **prêt** dans le lobby.
- **Mix aléatoire** : pack de 20 génériques tirés dans tous les packs.
- **Profil, succès, classement de la semaine**, **personnage à débloquer** (casque niv. 2, lunettes noires niv. 3, crête niv. 4, couronne niv. 5).
- **Volume / muet** en bas à gauche, **bannière de reconnexion** si la connexion saute.

## Modération et packs
- **Exclure un joueur** : bouton 🚫 à côté de son nom dans le lobby, ou « 🛡️ Modération » pendant la partie (classique et équipes ; en tournoi, avant le lancement). Un joueur exclu ne peut pas revenir (ni avec le même pseudo).
- **Filtre de gros mots** : les pseudos (menu, compte, partie rapide) sont refusés, les messages du chat sont masqués par des étoiles. Liste modifiable en haut de `server.js` (`BAD_WORDS`, `BAD_SUBSTR`).
- **Nouveaux packs** (recherche iTunes automatique) : Musiques de films 🎬, Chansons Disney 🏰, Rap français 🎤, Tubes des années 2000 📻. Si une piste est mauvaise, l'owner a « 🔁 Autre piste », ou colle un lien YouTube. Les titres se modifient dans `packs.json`.

- **Décompte de 3 secondes** avant chaque générique (tous les modes). Réglable avec la variable `COUNTDOWN_MS` (0 pour le désactiver).

## Source audio : YouTube
Les packs (séries, films, Disney, rap, années 2000…) cherchent maintenant leur musique sur YouTube, plus sur iTunes. Le serveur cherche la vidéo, écarte les covers, remix, lives et vidéos non intégrables, puis la joue en audio seul (la vidéo reste cachée). Pour les packs Rap français et Années 2000, l'artiste ET le titre doivent apparaître dans la vidéo, sinon le générique est sauté. L'owner peut changer de vidéo avec « Autre piste ». Quand il colle un lien YouTube et clique « Utiliser et enregistrer », les autres pistes de ce générique sont supprimées et le lien est enregistré dans `data/liens.json` : il sera repris à chaque partie. Champ vide + « Utiliser » = oublier le lien et revenir à la recherche automatique (hors packs perso, qui ne sont pas enregistrés). Pour revenir à iTunes : variable `AUDIO_SOURCE=itunes`.

## Vérification des packs
Quand le jeu tourne, double-clique sur `verifier-packs.bat` (ou `node verifier-packs.js rap-fr`) : il liste, pour chaque générique, la vidéo YouTube trouvée (lien cliquable) et écrit `verification.txt`. Les lignes KO seront sautées en partie.

## Rôle de fondateur, pause et choix des pistes
- **Fondateur 👑** : un seul rôle, réservé au compte de Tom (badge « 👑 FONDATEUR » dans le salon et en haut à droite). Seul le fondateur enregistre les liens YouTube collés ; pour les autres owners, le lien est joué pour ce générique seulement. Le compte fondateur est reconnu par l'empreinte de son e-mail (`FOUNDER_EMAIL` pour changer). Crée ton compte avec cet e-mail dès la mise en ligne.
- **Pause musique** : pendant un générique, l'owner a « ⏸ Pause musique » / « ▶ Reprendre ». Les buzzers sont bloqués pendant la pause.
- **Choisir la piste avant de lancer** : l'owner voit la liste des vidéos trouvées, peut les écouter (lui seul) et choisir celle qui sera jouée.

## Mise en ligne
`media/` n'est pas envoyé sur GitHub (mp3 protégés, fichiers lourds). En ligne, les packs animés et jeux vidéo cherchent donc leurs musiques sur YouTube ; en local, tes mp3 restent prioritaires. Sur Render gratuit, `data/` (comptes, scores, liens enregistrés) est effacé à chaque redéploiement.
