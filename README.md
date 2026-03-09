# Minecraft Speedrun Bot

Bot de speedrun Minecraft construit avec [Mineflayer](https://github.com/PrismarineJS/mineflayer) qui joue automatiquement, du spawn jusqu'à la défaite de l'Ender Dragon.

## Prérequis

- [Node.js](https://nodejs.org/) v18 ou supérieur
- Minecraft Java Edition **1.21.1**

## Installation

```bash
git clone <url-du-repo>
cd botMinecraftSpeedrun
npm install
```

## Comment l'utiliser

1. Lancez Minecraft **version 1.21.1** et créez un nouveau monde.
2. Dans le menu pause, cliquez sur **"Open to LAN"** et activez les cheats.
3. Notez le **PORT** affiché dans le chat.
4. Lancez le bot :

```bash
node index.js localhost <PORT> BotName
```

Exemple :
```bash
node index.js localhost 12345 RunnerBot
```

Ou utilisez le script `run_bot.bat` (Windows).

## Commandes de chat en jeu

Pendant que le bot tourne, vous pouvez envoyer ces commandes dans le chat :

| Commande | Description |
|---|---|
| `!status` | Santé, nourriture et tâche en cours |
| `!inv` / `!inventory` | Contenu de l'inventaire |
| `!pos` | Position actuelle du bot |

## Progression du speedrun

Le bot progresse automatiquement à travers ces étapes :

1. **EARLY_GAME** — Bois → Table de craft → Outils en bois → Pierre → Outils en pierre
2. **IRON** — Minerai de fer → Fonte → Pioche et épée en fer
3. **DIAMOND** — Creuser jusqu'à Y=-54 → Diamants → Pioche en diamant
4. **NETHER** — Obsidienne → Portail → Blazes (6 bâtons) → Endermen (12 perles)
5. **STRONGHOLD** — Eyes of Ender → Localisation du stronghold → Portail de l'End
6. **END** — Combat contre l'Ender Dragon

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
├── Agent.js         # Machine à états centrale (progression par étapes)
├── bot.js           # Configuration et initialisation du bot Mineflayer
├── lib/
│   ├── Survival.js  # Survie autonome (combat, fuite de l'eau, nourriture)
│   └── Task.js      # Classe de base pour toutes les tâches
└── tasks/
    ├── GetWood.js          # Récolte de bois
    ├── MineBlock.js        # Minage de blocs (fer, charbon, diamants...)
    ├── CraftTask.js        # Craft d'objets
    ├── SmeltTask.js        # Fonte dans un fourneau
    ├── FightMob.js         # Chasse de mobs (Blazes, Endermen)
    ├── BuildNetherPortal.js# Construction du portail du Nether
    ├── DigDown.js          # Creuser jusqu'à un niveau Y cible
    ├── MoveToSurface.js    # Retour en surface
    ├── FindStronghold.js   # Localisation du stronghold
    └── FightDragon.js      # Combat final contre l'Ender Dragon
```
