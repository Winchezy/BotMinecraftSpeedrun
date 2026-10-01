# Minecraft Speedrun Bot

Bot de speedrun Minecraft construit avec [Mineflayer](https://github.com/PrismarineJS/mineflayer) qui joue automatiquement, du spawn jusqu'à la défaite de l'Ender Dragon.

Le bot combine une **machine à états** pour la progression par étapes et plusieurs **réseaux de neurones** (Synaptic) entraînés localement pour des sous-tâches spécifiques.

## Prérequis

- [Node.js](https://nodejs.org/) v18 ou supérieur
- Minecraft Java Edition (version auto-détectée)

## Installation

```bash
git clone <url-du-repo>
cd botMinecraftSpeedrun
npm install
```

## Comment l'utiliser

1. Lancez Minecraft et créez un nouveau monde.
2. Dans le menu pause, cliquez sur **"Open to LAN"** et activez les cheats.
3. Notez le **PORT** affiché dans le chat.
4. Lancez le bot :

```bash
node index.js localhost <PORT> [BotName]
```

Exemple :
```bash
node index.js localhost 12345 RunnerBot
```

Sur Windows, vous pouvez aussi utiliser `run_bot.bat <PORT> [BotName]` — il relance automatiquement le bot en cas de crash.

## Commandes de chat en jeu

| Commande | Description |
|---|---|
| `!status` | Santé, nourriture et tâche en cours |
| `!inv` / `!inventory` | Contenu de l'inventaire |
| `!pos` | Position actuelle du bot |

## Progression du speedrun

Le bot progresse automatiquement à travers ces étapes :

1. **EARLY_GAME** — Bois → Table de craft → Outils en bois → Pierre → Outils en pierre
2. **IRON** — Minerai de fer → Fonte → Pioche en fer
3. **DIAMOND** — Creuser jusqu'à Y=-54 → Diamants → Pioche en diamant
4. **NETHER** — Obsidienne → Portail → Blazes (6 bâtons) → Endermen (12 perles)
5. **STRONGHOLD** — Eyes of Ender → Localisation du stronghold → Portail de l'End
6. **END** — Combat contre l'Ender Dragon

## Architecture IA

Le bot dispose de plusieurs niveaux de décision :

### Machine à états (`src/Agent.js`)
Logique principale. Gère la progression par étapes et prend la majorité des décisions de manière déterministe.

### Réseaux de neurones locaux (Synaptic)
Entraînés localement depuis des données générées automatiquement pendant le jeu :

| Module | Rôle | Modèle |
|---|---|---|
| `src/lib/WoodBrain.js` | Stratégie de coupe d'arbres (3 actions) | `data/wood_model.json` |
| `src/lib/SurvivalBrain.js` | Décisions de survie (7 actions) | `data/survival_model.json` |
| `src/lib/MovementBrain.js` | Stratégie de déplacement | `data/movement_model.json` |
| `src/LocalBrain.js` | Décisions générales de progression | `data/model.json` |

## Entraînement des modèles

### Mode collecte automatique (WoodBrain)

Lance le bot en mode collecte de données pour le WoodBrain :

```bash
node index.js localhost <PORT> BotName --train-wood
```

Le bot boucle sur GetWood jusqu'à 30 exemples, puis affiche le message pour lancer l'entraînement.

### Mode imitation learning (données générales)

Connecte le bot en mode "professeur humain" — vous lui donnez des ordres via le chat pour générer un dataset :

```bash
node recorder.js localhost <PORT>
```

Commandes disponibles dans le chat :
```
!do GetWood
!do CraftTask oak_planks 8
!do MineBlock stone 3
!do MoveToSurface
!do status     → affiche l'état sans enregistrer
!undo          → supprime le dernier exemple
```

### Entraîner les modèles

Une fois les données collectées dans `data/` :

```bash
node scripts/train.js           # modèle général (LocalBrain)
node scripts/train_wood.js      # WoodBrain
node scripts/train_survival.js  # SurvivalBrain
node scripts/train_digdown.js   # DigDown
node scripts/train_surface.js   # MoveToSurface
```

## Visualisation des logs

Les logs sont enregistrés dans `bot.log` et `bot_debug.log`.

Pour les visualiser dans une interface web :
```bash
node log_viewer.js
```
Ou lancez `start_log_viewer.bat` (Windows), puis ouvrez `log_viewer.html` dans votre navigateur.

## Structure du code

```
src/
├── Agent.js          # Machine à états centrale (progression par étapes)
├── bot.js            # Configuration et initialisation Mineflayer
├── LocalBrain.js     # Fallback IA local (réseau de neurones Synaptic)
├── Recorder.js       # Mode imitation learning (collecte manuelle de données)
├── lib/
│   ├── Task.js           # Classe de base pour toutes les tâches
│   ├── Survival.js       # Survie autonome (combat, fuite de l'eau, nourriture)
│   ├── WoodBrain.js      # Réseau de neurones — stratégie de coupe d'arbres
│   ├── SurvivalBrain.js  # Réseau de neurones — décisions de survie
│   └── MovementBrain.js  # Réseau de neurones — stratégie de déplacement
└── tasks/
    ├── GetWood.js             # Récolte de bois
    ├── MineBlock.js           # Minage de blocs (fer, charbon, diamants...)
    ├── CraftTask.js           # Craft d'objets
    ├── SmeltTask.js           # Fonte dans un fourneau
    ├── FightMob.js            # Chasse de mobs (Blazes, Endermen)
    ├── BuildNetherPortal.js   # Construction du portail du Nether
    ├── DigDown.js             # Creuser jusqu'à un niveau Y cible
    ├── MoveToSurface.js       # Retour en surface
    ├── FindStronghold.js      # Localisation du stronghold via Eyes of Ender
    └── FightDragon.js         # Combat final contre l'Ender Dragon

scripts/
├── train.js           # Entraîne le modèle général (LocalBrain)
├── train_wood.js      # Entraîne WoodBrain
├── train_survival.js  # Entraîne SurvivalBrain
├── train_digdown.js   # Entraîne le modèle DigDown
└── train_surface.js   # Entraîne le modèle MoveToSurface

data/                  # Datasets et modèles générés
```
