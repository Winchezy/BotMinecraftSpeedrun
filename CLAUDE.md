# CLAUDE.md

Ce fichier fournit des directives à Claude Code (claude.ai/code) lors du travail sur le code de ce dépôt.

## Vue d'ensemble du projet

Ceci est un bot de speedrun Minecraft construit avec Mineflayer qui joue automatiquement à Minecraft 1.20.4, tentant de compléter un speedrun complet du spawn jusqu'à la défaite de l'Ender Dragon. Le bot utilise une architecture de machine à états basée sur des étapes pour progresser à travers le early game, l'acquisition de fer/diamant, l'exploration du Nether, la recherche du stronghold, et le combat final contre le dragon.

## Exécution et tests

### Démarrer le bot

```bash
node index.js localhost <PORT> BotName
```

Le bot se connecte à un serveur Minecraft 1.21.1 local (note : le code spécifie 1.20.4 dans bot.js:14). Vous devez :
1. Créer un monde dans Minecraft 1.21.1
2. Ouvrir au LAN avec les cheats activés
3. Noter le numéro de port affiché dans le chat
4. Lancer le bot avec ce port

### Serveur de développement

Le répertoire `server/` contient une installation de serveur Minecraft (server.jar, données du monde, server.properties). Utilisez `start_server.bat` pour le lancer.

### Visualisation des logs

- `bot.log` et `bot_debug.log` contiennent les logs d'exécution
- `log_viewer.html` + `log_viewer.js` fournissent une interface web pour visualiser les logs
- Exécutez `start_log_viewer.bat` pour démarrer le serveur de visualisation des logs
- `read_log.bat` pour un accès rapide aux logs

### Commandes courantes

Pendant que le bot fonctionne, des commandes de chat sont disponibles :
- `!status` - Affiche la santé, la nourriture et la tâche actuelle
- `!inv` ou `!inventory` - Liste les objets de l'inventaire
- `!pos` - Affiche la position du bot

## Architecture

### Composants principaux

**Système Agent (`src/Agent.js`)**
- Machine à états centrale contrôlant la progression du bot à travers les étapes du speedrun
- Étapes : `EARLY_GAME`, `IRON`, `DIAMOND`, `NETHER`, `STRONGHOLD`, `END`
- Chaque étape a des méthodes de gestion dédiées (`handleEarlyGame`, `handleIronStage`, etc.)
- Suit les tâches échouées pour éviter les boucles infinies (`this.failedTasks`)
- Boucle principale : `tick()` exécute les tâches jusqu'à leur achèvement, puis appelle `decideNext()` pour sélectionner la tâche suivante

**Système de tâches (`src/lib/Task.js`)**
- Classe de base pour toutes les actions du bot
- Toutes les tâches doivent implémenter la méthode `async run()`
- Les tâches signalent leur achèvement via `complete()` ou `fail(reason)`
- Les tâches sont suivies comme terminées/échouées via `isDone()` et la propriété `hasFailed`

**Système de survie (`src/lib/Survival.js`)**
- Mécanismes de sécurité autonomes fonctionnant en arrière-plan
- Échappement de l'eau : Détecte l'eau, tente le pathfinding vers la terre, bloque les courants d'eau avec des blocs
- Défense au combat : Engage automatiquement les mobs hostiles avec des armes équipées, bat en retraite quand en infériorité numérique ou santé faible
- Surveillance de la santé : Mange automatiquement de la nourriture quand la santé < 5
- Blocs protégés : Suit les blocs placés pour contrôler l'eau (set `protectedBlocks`) pour ne jamais les miner
- Configuration du pathfinder : Évite l'eau/lave, préserve les tables de craft, empêche de creuser sous les pieds
- Suivi de position sûre : Sauvegarde la dernière position au sol connue pour les retours d'urgence

### Implémentations de tâches (`src/tasks/`)

Chaque tâche est une action autonome :

- `GetWood.js` - Trouve et collecte des logs d'arbres, met en liste noire les positions problématiques, gère le blocage dans les feuilles
- `CraftTask.js` - Gère le craft d'inventaire (planches, bâtons) et le craft sur table, place des tables si nécessaire
- `MineBlock.js` - Mine des types de blocs spécifiques (pierre, minerai de fer, charbon, diamants), utilise les outils appropriés
- `SmeltTask.js` - Trouve/utilise des fourneaux, gère le combustible, fait fondre les minerais en lingots
- `FightMob.js` - Chasse des mobs spécifiques (blazes, endermen) pour leurs drops
- `BuildNetherPortal.js` - Construit le cadre du portail du Nether et l'allume
- `DigDown.js` - Minage en escalier sécurisé jusqu'à un niveau Y spécifique pour les diamants
- `MoveToSurface.js` - Retourne à la surface (y >= 60) quand coincé sous terre
- `FindStronghold.js` - Utilise les Eyes of Ender pour localiser le stronghold
- `FightDragon.js` - Mécaniques du combat final

### Patterns clés

**Résolution des dépendances**
L'Agent utilise des méthodes auxiliaires pour assurer les prérequis :
- `ensureTable()` - Garantit la disponibilité d'une table de craft avant de crafter
- `ensurePickaxeRedundancy()` - Maintient une pioche de secours pour éviter de se retrouver bloqué
- Vérification des matériaux avec les helpers `has()` et `count()` (supporte les alias comme 'cobblestone' qui correspond à plusieurs variantes)

**Récupération après échec**
- Les tâches échouées incrémentent le compteur `this.failedTasks[taskName]`
- Après un seuil (ex : 5 échecs), l'agent adapte sa stratégie (ex : passer à l'étape suivante, aller à la surface)
- Les tâches utilisent des listes noires pour éviter de tenter à répétition des emplacements problématiques

**Intégration Combat et Survie**
- La boucle principale de l'agent vérifie `bot.isInCombat()` avant d'exécuter les tâches
- Le système de survie gère tout le combat/échappement de manière autonome sans intervention de l'agent
- Le système de combat équipe automatiquement la meilleure arme et bat en retraite des situations dangereuses

## Pathfinder et déplacement

Le bot utilise mineflayer-pathfinder avec des configurations personnalisées :
- L'eau/lave sont traités comme des murs infranchissables (pas de nage)
- Les tables de craft ne sont jamais cassées pendant le pathfinding
- Le mouvement peut creuser des blocs mais ne creusera pas sous les pieds
- Les blocs protégés (du contrôle de l'eau) sont préservés

## Gestion de l'inventaire

Les alias de matériaux sont critiques :
- 'cobblestone' correspond à : cobblestone, cobbled_deepslate, blackstone
- 'log' exclut les logs stripped
- Les recherches génériques comme `i.name.includes('sword')` correspondent à tous les types d'épées

## Problèmes connus et patterns

1. **Problèmes d'eau** : Le bot peut se retrouver coincé dans les courants d'eau. Le système de survie tente de bloquer les sources d'eau avec des blocs, puis de pathfind vers la terre. Si sous terre sans échappatoire, utilise la tâche `MoveToSurface`.

2. **Gestion des pioches** : Critique de maintenir une pioche de secours. L'agent vérifie la redondance avant le minage profond pour éviter de se retrouver bloqué avec un outil cassé.

3. **Dépendances de craft** : L'agent doit vérifier les matériaux avant de démarrer les tâches de craft. Les matériaux manquants devraient déclencher la collecte de ressources (GetWood, MineBlock) plutôt que d'échouer.

4. **Combustible pour la fonte** : L'agent vérifie le combustible (charbon, logs, planches, charcoal) avant de fondre. Si sous terre sans combustible, retourne à la surface pour du bois.

5. **Placement de table** : CraftTask peut placer des tables si nécessaire, même en créant de l'espace en creusant si nécessaire.

## Plugins Mineflayer

Le bot charge ces plugins (voir `src/bot.js`) :
- `pathfinder` - Pathfinding A* pour la navigation
- `collectBlock` - Collection automatique de blocs (casse le bloc, ramasse les drops)
- `tool` - Sélectionne automatiquement l'outil approprié pour les blocs
- `pvp` - Mécaniques de combat pour attaquer les entités
- `armorManager` - Équipe automatiquement la meilleure armure

## Logique de progression par étapes

**EARLY_GAME** : Bois → Planches → Table → Bâtons → Pioche en bois → Pierre → Pioche en pierre + Épée en pierre

**IRON** : Miner du minerai de fer → Fondre le fer → Crafter une pioche en fer (saute le bouclier pour éviter la boucle de bois)

**DIAMOND** : Creuser jusqu'à y=-54 → Miner des diamants → Crafter une pioche en diamant

**NETHER** : Miner de l'obsidienne → Obtenir du silex → Construire le portail → Chasser les Blazes (6 bâtons) → Chasser les Endermen (12 perles)

**STRONGHOLD** : Crafter des Eyes of Ender → Les utiliser pour localiser le stronghold → Trouver le portail de l'End

**END** : Combattre l'Ender Dragon

## Notes sur les versions

- Le code cible Minecraft 1.20.4 (voir bot.js:14)
- Le README mentionne 1.21.1 - peut nécessiter un ajustement de version pour la compatibilité
- Le serveur dans le répertoire `server/` est spécifique à une version

## Failles de logique identifiées

### 🔴 CRITIQUE

1. **Return prématuré dans handleIronStage (Agent.js:492)**
   - **Localisation** : `src/Agent.js:492`
   - **Problème** : Un `return` après le craft de la pioche en fer empêche l'exécution du code pour crafter l'épée en fer (lignes 495-518)
   - **Impact** : Le bot n'aura jamais d'épée en fer, restant vulnérable au combat
   - **Solution** : Retirer le `return` à la ligne 492 ou restructurer la logique conditionnelle

2. **Incohérence de version Minecraft**
   - **Localisation** : `src/bot.js:14` vs `README.md:13`
   - **Problème** : Le code spécifie version "1.20.4" mais la documentation dit 1.21.1
   - **Impact** : Incompatibilité potentielle de protocole causant des déconnexions ou comportements imprévisibles
   - **Solution** : Synchroniser la version entre le code et la documentation

3. **Absence de gestion de durabilité des outils**
   - **Localisation** : Tous les fichiers de tâches
   - **Problème** : Aucune vérification de la durabilité avant d'utiliser les outils, risque de casser la dernière pioche
   - **Impact** : Le bot peut se retrouver bloqué sans outil pour miner
   - **Solution** : Vérifier `item.durability` avant les opérations de minage et crafter/équiper un nouveau si < 10%

4. **Conflit potentiel Survival vs Agent**
   - **Localisation** : `src/lib/Survival.js` et `src/Agent.js:46-49`
   - **Problème** : Le système de survie peut déplacer le bot (water escape, combat) pendant qu'une tâche tente d'interagir avec des blocs
   - **Impact** : Erreurs de pathfinding, échecs de collecte de blocs, comportements erratiques
   - **Solution** : Ajouter un système de verrouillage partagé ou faire que Survival signale explicitement l'interruption

5. **Boucle infinie possible dans ensurePickaxeRedundancy**
   - **Localisation** : `src/Agent.js:698-772`
   - **Problème** : Si craft de pioche échoue de manière répétée (ex: pas de table), la fonction retourne `true` infiniment
   - **Impact** : Agent bloqué dans un état où il ne peut plus progresser
   - **Solution** : Ajouter un compteur d'échecs et fallback vers une tâche de récupération

### ⚠️ AVERTISSEMENT

1. **Timeout trop court dans GetWood**
   - **Localisation** : `src/tasks/GetWood.js:76-77`
   - **Problème** : Timeout de 15 secondes peut être insuffisant pour arbres éloignés ou zones difficiles
   - **Impact** : Blacklist prématurée d'arbres valides, wandering excessif
   - **Solution** : Augmenter à 30 secondes ou rendre dynamique selon distance

2. **Shield crafting désactivé**
   - **Localisation** : `src/Agent.js:329-360` (commenté)
   - **Problème** : Le bouclier n'est jamais crafté, laissant le bot vulnérable aux attaques à distance
   - **Impact** : Santé du bot réduite plus rapidement contre skeletons/blazes
   - **Solution** : Réactiver après avoir corrigé la boucle infinie GetWood mentionnée dans les commentaires

3. **Pas de vérification d'emplacement avant SmeltTask**
   - **Localisation** : `src/Agent.js:459-467`
   - **Problème** : Le code force un retour à la surface APRÈS avoir vérifié le fuel, mais SmeltTask pourrait échouer sous terre
   - **Impact** : Tentatives répétées de fonte échoueront si sous terre
   - **Solution** : Vérifier Y-level avant de démarrer SmeltTask, pas pendant

4. **Réinitialisation de blacklist dans GetWood**
   - **Localisation** : `src/tasks/GetWood.js:64`
   - **Problème** : La blacklist est effacée après wander, permettant de revisiter immédiatement les mêmes arbres problématiques
   - **Impact** : Cycles de wander-fail-wander potentiels
   - **Solution** : Implémenter une blacklist persistante avec expiration temporelle (ex: 5 minutes)

5. **Pas de priorité pour Iron Sword après Iron Pickaxe**
   - **Localisation** : `src/Agent.js:495-518`
   - **Problème** : Code pour l'épée en fer existe mais inaccessible à cause du return ligne 492
   - **Impact** : Combat difficile avec épée en pierre dans les étapes avancées
   - **Solution** : Corriger le flux de contrôle (voir CRITIQUE #1)

6. **Protection de crafting table limitée**
   - **Localisation** : `src/lib/Survival.js:943-947`
   - **Problème** : Seulement la table de craft est protégée, pas les fourneaux placés
   - **Impact** : Le bot peut détruire son propre fourneau pendant le pathfinding
   - **Solution** : Ajouter `furnace` à la liste `blocksCantBreak`

### ℹ️ BÉNIN

1. **Logs de debug verbeux**
   - **Localisation** : `src/Agent.js:52-54`, multiples endroits
   - **Problème** : Logs `[DEBUG]` nombreux polluent la sortie console
   - **Impact** : Difficulté à lire les logs importants
   - **Solution** : Implémenter un système de niveau de log (DEBUG/INFO/WARN/ERROR)

2. **Pas d'optimisation de distance pour GetWood**
   - **Localisation** : `src/tasks/GetWood.js:46-68`
   - **Problème** : Le bot cible le premier arbre "base" trouvé, pas forcément le plus proche
   - **Impact** : Temps de déplacement sous-optimal
   - **Solution** : Trier les logs par distance avant sélection

3. **Blacklist non partagée entre instances de tâches**
   - **Localisation** : `src/tasks/GetWood.js:10`
   - **Problème** : Chaque nouvelle instance de GetWood crée une blacklist vide
   - **Impact** : Perte de connaissance entre exécutions de tâche
   - **Solution** : Déplacer blacklist au niveau Agent ou utiliser une variable de module

4. **Pas de nettoyage des échecs de tâches**
   - **Localisation** : `src/Agent.js:17`
   - **Problème** : `this.failedTasks` n'est jamais réinitialisé, même après succès
   - **Impact** : Accumulation en mémoire, potentiellement mauvaises décisions basées sur anciens échecs
   - **Solution** : Réinitialiser les compteurs d'échecs après progression d'étape réussie

5. **isAccessible() non utilisé dans GetWood**
   - **Localisation** : `src/tasks/GetWood.js:94-116`
   - **Problème** : Méthode définie mais jamais appelée dans la logique de sélection d'arbre
   - **Impact** : Code mort, confusion sur la logique réelle
   - **Solution** : Intégrer `isAccessible()` dans la sélection de `targetLog` ou supprimer

6. **Pas de limite sur wandering**
   - **Localisation** : `src/tasks/GetWood.js:124-135`
   - **Problème** : Le bot peut wander indéfiniment sans limite de distance du spawn
   - **Impact** : Bot peut se perdre très loin, difficulté à revenir
   - **Solution** : Ajouter une limite de rayon depuis le spawn (ex: 500 blocs)

7. **Vérification de craft table redondante**
   - **Localisation** : `src/Agent.js:637-695`
   - **Problème** : `ensureTable()` est appelé plusieurs fois de suite dans certains flux
   - **Impact** : Appels inutiles, performance légèrement réduite
   - **Solution** : Mémoriser le résultat de ensureTable dans le tick actuel
