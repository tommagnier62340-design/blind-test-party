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
- Il lance chaque générique ; les joueurs buzzent (bouton ou barre Espace). Le 1er à buzzer a 15 secondes pour répondre à voix haute.
- L'owner voit la réponse et valide (+200) ou refuse (−100). Un refus, ou les 15 s écoulées, valent −100 : le joueur est bloqué
  sur ce générique, qui reprend pour les autres.
- Entre deux manches : récap des scores. À la fin : classement + XP (20 de participation + score/10 + bonus podium 50/30/15,
  200 XP = 1 niveau).

## Ajouter du son
Les packs sont dans `packs.json` (champ `media` vide par défaut : aucun audio fourni).
- Lien YouTube dans `media` d'un générique, ou collé par l'owner pendant la partie : le son est joué chez tous les joueurs.
- Ou un fichier dans `media/` (ex. `media/dbz.mp3`) relié avec `"/media/dbz.mp3"`.
- Sinon l'owner joue le son de son côté (Discord, enceinte…) : le bouton "Chercher" ouvre YouTube.

## Ajouter un pack
Copie un bloc de `packs.json` (id, name, emoji, items avec title/media).
