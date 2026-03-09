# Minecraft Speedrun Bot

Ce bot est conçu pour tenter de speedrun Minecraft.
Actuellement, il gère la phase de préparation (Early Game) :
1. Récolte de bois.
2. Craft de l'établi.
3. Craft des outils en bois.
4. Minage de pierre.
5. Craft des outils en pierre.

## Comment l'utiliser

1. Lancez Minecraft **version 1.21.1**.
2. Créez un nouveau monde.
3. Faites "Open to LAN" (Ouvrir au LAN) et autorisez les cheats.
3. Notez le PORT affiché dans le chat.
4. Lancez le bot avec la commande suivante :

```bash
node index.js localhost <PORT> BotName
```

Exemple :
```bash
node index.js localhost 12345 RunnerBot
```

## Structure du code

- `src/brain.js` : Le cerveau qui décide de l'action suivante (State Machine).
- `src/behaviors/` : Contient les scripts pour couper du bois, miner, crafter.
- `src/bot.js` : Configuration du bot Mineflayer.

## Prochaines étapes (à implémenter)

- Acquisition de nourriture (Chasse).
- Minage de fer et craft (Seau, Pioche fer).
- Recherche de lave pour le portail du Nether.
- Navigation dans le Nether (Forteresse).
- Stronghold et Dragon.
