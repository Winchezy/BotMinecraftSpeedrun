# Corrections locales AltoClef MiranCZ 0.19

Les sources modifiées sont dans `.bot-state/altoclef-source-019/altoclef-0.19`.
Une copie des fichiers modifiés et de la licence est conservée dans `tools/altoclef-local/overlay`.
Cette copie se met à jour avec `node tools/altoclef-local/save-overlay.cjs`.
Base : archive du tag 0.19 de https://github.com/MiranCZ/altoclef (licence MIT conservée).
Aucun push, aucune publication, aucune pull request.

Modifications :
- place pour une perle ou un bâton de blaze vérifiée avant une nouvelle chasse ;
- place pour l'objet au sol vérifiée avant de l'approcher ;
- une pile de matériaux peut être jetée si exactement 64 blocs restent réservés ;
- une pile de 15 perles peut recevoir la seizième, et les autres piles peuvent également être remplies exactement ;
- attente au spawner réévaluée après 45 secondes, déplacement vers un point avec sol stable
  et à moins de 12 blocs en distance 3D du centre du spawner ;
- chasse et poursuite d'endermen refusées lorsque le sol proche présente un trou, de la lave,
  du feu ou des blocs dangereux. Marge de deux blocs autour de la position de combat ;
- marche arrière automatique du combat désactivée contre les endermen ;
- bouclier automatique évite de bloquer le déplacement de repli au bord d'une falaise ;
- cache de recherche d'une position de repli, limité à une seconde si la position ne change pas.

Compilation locale : `powershell -NoProfile -ExecutionPolicy Bypass -File tools/altoclef-local/build.ps1`.
Tests ciblés : `powershell -NoProfile -ExecutionPolicy Bypass -File tools/altoclef-local/test.ps1`.
L'option d'exécution ne s'applique qu'à ces processus PowerShell et ne change pas la configuration du système.
Elle exécute uniquement `:1.18.2:build`, jamais une tâche de publication.
Installation après compilation et fermeture de Minecraft : `node tools/altoclef-local/install.cjs`.
Le script conserve l'ancien JAR hors du dossier mods et vérifie l'empreinte du nouveau JAR installé.
Le JAR cible est `altoclef-1.18.2-0.19-local.3.jar` ; sa vérification est enregistrée dans
`.bot-state/altoclef-downloads/local-jar-validation.json`. La compilation finale réussit,
et 1 589 classes ont été vérifiées compatibles avec Java 17. Le journal de cette compilation
est `.bot-state/altoclef-downloads/local-build-lava.log`.
Le préprocesseur ReplayMod est compilé depuis sa révision c2041a3, car son artefact JitPack répond 404.
Son code et sa licence sont conservés dans `.bot-state/build-tools/preprocessor-source`.
Le convertisseur Java reçoit également le JAR Minecraft avec les noms internes « intermediary »
pour éviter les erreurs de résolution de classes constatées dans la première compilation.
Le JDK 21 téléchargé localement a été vérifié avec l'empreinte SHA-256 fournie par Adoptium.

Collecte de liquide (local.3) :
- garde la source choisie pendant la tentative, même si le scanner change temporairement
  son estimation de l'accessibilité ; les contrôles du liquide et des dangers restent actifs ;
- mesure le déplacement et le minage réels au lieu de réinitialiser le compteur dès qu'un
  trajet est actif ; une tentative sans progrès abandonne la source et lance un déplacement
  de récupération de cinq blocs avant de chercher une autre source ;
- correction motivée par le journal `lava-oscillation-local2.log`, qui montre plusieurs
  alternances par seconde entre exploration et destruction au-dessus des mêmes sources.

Défense contre les Wither squelettes (local.2, conservée dans local.3) :
- intervient à pleine vie dès qu'une menace visible se trouve à moins de dix blocs ;
- préfère un plafond bas existant ou ferme le haut d'un couloir aux côtés déjà fermés ;
- tente ensuite une tour de trois blocs si le sol est stable, le joueur centré, la hauteur
  libre suffisante, trois blocs solides disponibles et l'ennemi encore à au moins sept blocs ;
- interdit la construction en présence d'un tireur visible ou d'un autre hostile proche ;
- fuite immédiate après un coup, en cas d'effet Wither, de faible santé, de construction trop
  lente ou si l'abri ne permet pas d'infliger des dégâts pendant dix secondes ;
- conserve sa position pour attaquer depuis l'abri, sans poursuite au corps à corps.

Validation : `local-tests/LocalSafetyPolicyTest.java` comporte onze vérifications du terrain,
de la portée du spawner et de la capacité des piles ; `WitherDefensePolicyTest.java` ajoute onze
vérifications des choix abri/tour/fuite et de la distance de sécurité. Ces vérifications ne prouvent pas que le bot finira le jeu ou survivra
à tous les combats. Le terrain doit être suffisamment large ; un couloir étroit peut être refusé.
Le déplacement d'attente ne garantit pas une apparition si d'autres conditions du spawner empêchent celle-ci.
