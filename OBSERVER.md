# Observation du comportement

L'observateur demarre automatiquement avec `node index.js localhost 25565 SpeedBot`.
Il lit l'etat du joueur une fois par seconde, sans lui envoyer de commandes.

Un rapport est ecrit toutes les 30 secondes :

- `.bot-state/observer/SpeedBot.txt` : dernier rapport lisible.
- `.bot-state/observer/SpeedBot.json` : etat, mesures, alertes et evenements.
- `.bot-state/observer/SpeedBot.history.jsonl` : rapports precedents, une ligne JSON par rapport.

Le nom du fichier suit le pseudo du bot. L'historique tourne a 5 Mo avec un fichier precedent.
Les mesures portent sur la derniere minute ; les morts sont comptees depuis le lancement.
Les changements de controle, de tache, d'etape, les degats et les morts sont enregistres.
Le rapport detaille aussi l'inventaire, les mobs proches et les blocs sous/autour du joueur.

Pour lire le rapport dans PowerShell :

```powershell
Get-Content .bot-state/observer/SpeedBot.txt
```

Les alertes detectent une immobilite, une tache inchangee sans progression d'inventaire,
des deplacements dans une petite zone, des interruptions de survie repetees, une faim
ou une vie critique. Elles constituent des indices a confronter aux logs et au terrain :
une attente volontaire ou un long trajet ne prouve pas un bug.

L'observateur seul ne modifie pas le code. Le superviseur ci-dessous peut automatiser
le cycle d'analyse, correction, tests et verification en jeu.

## Corrections automatiques

Le superviseur possede son propre processus Minecraft. Arreter un bot lance separement
avant de demarrer le superviseur avec le meme pseudo.

```powershell
npm.cmd run autopilot
npm.cmd run autopilot:status
npm.cmd run autopilot:stop
```

Trois rapports distincts doivent signaler le meme objectif bloque. Le superviseur lance
alors `codex exec` avec `gpt-6-sol`, sur une copie contenant le code actuel non commite,
les rapports et les logs. Il reutilise la connexion Codex locale et consomme ses quotas.
Il utilise le sandbox `workspace-write`, sans approbation interactive ni contournement
du sandbox. Le mode Windows `elevated` doit etre configure sur la machine et est
selectionne explicitement pour eviter une degradation en lecture seule.
Une action necessitant une autorisation supplementaire sera refusee.

Seules les corrections de source et de nouveaux tests peuvent etre appliquees : pas de
suppression, modification des tests existants, dependances, fichiers de lancement,
observateur ou superviseur. Au maximum huit fichiers et 150 Ko par correction.
Les fichiers modifies pendant l'analyse par une autre session ne sont pas ecrases.

Les tests de la copie doivent passer. Le superviseur sauvegarde ensuite les anciennes
versions, applique la correction, relance son bot et observe pendant deux minutes.
Une progression d'etape, d'inventaire, de recuperation ou de deplacement sans alerte
ni mort valide l'essai. Sinon les fichiers precedents sont restaures et le bot relance.
Cette verification constitue un indicateur de progression, pas une preuve que le jeu
sera termine ni que tous les bugs sont corriges.

Un delai minimal de cinq minutes et un maximum de trois essais par heure evitent les
relances permanentes. Un appel Codex est limite a dix minutes. Le superviseur continue
apres la fin de la conversation tant que son processus, Minecraft et la connexion sont actifs.

Fichiers dans `.bot-state/autopilot/` :

- `status.json` : phase actuelle et derniere correction.
- `config.json` : connexion, modele, delais ; `enabled: false` suspend les corrections.
- `commands.jsonl` : commandes lancees automatiquement.
- `events.jsonl` : analyses, application, validation ou restauration.
- `bot.log` : logs du joueur supervise.
- `attempt-*/` : preuves, commandes et reponse Codex, tests, sauvegarde des fichiers.

Les modifications de `enabled` sont lues pendant l'execution ; les autres reglages
necessitent une relance. `autopilot:stop` arrete egalement le joueur supervise.
