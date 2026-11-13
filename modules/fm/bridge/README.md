# Archivix Bridge — plugin FM27

Plugin **BepInEx 6 (Unity IL2CPP)** pour Football Manager 27, en **lecture seule** : il lit l'effectif, la tactique,
le club et le prochain match via le système de bindings de l'interface du jeu, puis écrit
`archivix-snapshot.json` (format `archivix/1`) que le module `fm` de FM Immersion importe.

- Jamais d'écriture dans la mémoire du jeu ni dans les sauvegardes, jamais d'action de jeu (`SendEvent`, `ActionID`).
- Un instantané au chargement d'une partie, puis à chaque nouveau jour de jeu (au plus tard toutes les 60 s).
- `archivix-status.json` (date de jeu et club) suit le jeu toutes les 10 s depuis 0.5.3 : un instantané complet prend
  1 à 2 minutes et garde la date de son début, FM Immersion affiche donc la date de ce fichier quand elle est plus récente.
- Écriture atomique (`.tmp` puis renommage) ; jamais d'instantané vide.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/Plugin.cs` | Point d'entrée BepInEx, boucle d'instantanés, serveur local facultatif `http://localhost:8727` (sonde, coupé par défaut) |
| `src/FmBindingReader.cs` | Lecture groupée des bindings (chemins texte, ex. `game.GameCurrentManagerClubTeam/Club/Squad`) |
| `src/PressWindow.cs` | Conférence de presse FM Immersion affichée par-dessus FM27 (UI Toolkit), réponses écrites pour l'appli |
| `src/Probe.cs` | Sonde de découverte (`/api/probe`, `/api/properties`, `/api/refprops`) et file du thread principal |
| `config/chemins.json` | **Données supplémentaires sans recompiler** : chemins lus à chaque instantané (bloc `custom`) |

## Réglage

`BepInEx\config\fr.archivix.bridge.cfg`, clé `Dossier` : dossier où écrire les instantanés.
Par défaut `Documents\Sports Interactive\Football Manager 27\archivix`. FM Immersion le renseigne à l'installation.

Autres clés : `LireTactique` (non par défaut), `LireEfficacite` (oui par défaut depuis 0.5.5),
`LireCompo` (non par défaut, expérimental : joueur à chaque poste), `LireJoueursEtendus` (non par défaut, expérimental : moral, hiérarchie, étoiles du staff), `LireCibles` (non par défaut, expérimental : cibles du mercato), `Decouverte` (oui par défaut : rapport
`archivix\config\decouverte.json`), `ServeurLocal` (non par défaut depuis 0.4.5 : serveur `http://localhost:8727`, sans
en-tête CORS, inutile pour FM Immersion ; un port déjà pris n'empêche plus le plugin de démarrer), `RelectureSecondes` (300 par défaut, 60 au minimum : relecture complète même sans
changement de date).

## Match en direct (0.5.0)

Clé `LireMatchDirect` (oui par défaut). Toutes les 20 s, le plugin demande au jeu si un match est en cours
(`IsDuringMatch`) ; pendant le match, il relit toutes les 15 s le match du manager
(`GameCurrentManager/LatestScoresHumanFixtures/#0`) et écrit `archivix-live.json` (format `archivix-live/1`) :
`home`, `away`, `homeScore`, `awayScore`, `result`, `minute` (« 19 min. », « FDM » à la fin), `final`, `scorers`
(texte du jeu), `homeEvents`/`awayEvents` (`type` 0 but, 2 penalty ; `time`), `gameDate`, `inMatch`, `updatedAt`.
Le fichier garde le dernier état jusqu'au match suivant. FM Immersion s'en sert pour le direct Discord.
Chemins validés en jeu le 07/11/2026 (sonde Carnet, 66 relevés sans gêne) ; remplacements et statistiques ne sont pas
exposés par cette liste.

**Rapport de match (0.5.4)** : à la fin du match (dernière lecture, ou `HasFinalResult`), le relevé est complété depuis
`GameCurrentManagerClubTeam/LastFixture`, le seul endroit où le jeu renseigne le détail (sonde Carnet du 08/11/2026 :
pendant le match, `HomeLineup`/`AwayLineup` du match en cours sont vides et le passeur n'est pas encore écrit) :
`homeEvents`/`awayEvents` reprennent `HomeEventInfosLong`/`AwayEventInfosLong` avec `player` (buteur) et `assist`
(passeur, `Player2`, null sans passe décisive) ; `homeLineup`/`awayLineup` listent `{name, rating, events}` par joueur
(`PlayerEvents` du jeu, laissés bruts : leur type n'est pas encore connu, les cartons devraient y être). Même match
vérifié par les noms des équipes. FM Immersion en tire les passeurs décisifs du résumé final sur Discord.
Penalty : le jeu préfixe la minute du buteur (« pen 36' », événement de type 2) ; un penalty manqué n'apparaît pas.

**0.5.6** : pendant le match, chaque événement reçoit `player` (`HomeEventInfos/#n/Player/Name`, null si le jeu ne le
donne pas). Type 3 = expulsion (vu en jeu le 08/11/2026 : « expulsé 74' ») ; les cartons jaunes ne sont pas dans cette
liste. Le rapport de match, absent du relevé final quand `LastFixture` désigne encore le match précédent au coup de
sifflet, est retenté toutes les 15 s pendant 3 minutes, et le relevé réécrit dès qu'il est lu.

**0.5.7** : lecture incomplète. Le 09/11/2026, cinq instantanés de suite ont perdu toutes les stats des joueurs et
les consignes de la tactique (bloc `custom`) : les 4 500 requêtes de `chemins.json` partent dans la même frame, et en 8 s
le jeu n'avait rendu que les réponses immédiates. Désormais, à chaque niveau, on attend tant que des réponses arrivent
(jusqu'à trois fois le délai), puis les requêtes restées sans réponse (20 ou plus) repartent par paquets de 300.
`collecte.chemins` donne le compte (« lue : 3 950/4 470 valeurs, … récupérées par paquets ») et le journal BepInEx un
avertissement. Une lecture restée incomplète (aucune valeur pour les joueurs, ou section `tactique` vide) est refaite une
minute plus tard, trois fois au plus par jour de jeu, et ne remplace jamais une lecture complète du même jour.

**0.5.8** : relecture du 10/11/2026 (journal BepInEx et instantanés d'une partie en cours). Pendant un match, un paquet
entier de 300 requêtes restait parfois sans réponse : trois ou quatre joueurs sans aucune stat dans un instantané
pourtant marqué « lue ». Un paquet resté entièrement muet est maintenant renvoyé une fois avec un délai double, et un
seul joueur sans aucune valeur suffit à marquer la lecture incomplète (donc à la refaire une minute plus tard).
Direct : une réponse manquée à « un match est-il en cours ? » ne déclare plus le match fini (état gardé, quatre lectures
au plus). Montants : l'affichage anglais du jeu (« €1.2K p/w », « €1,250 ») et les milliards (« Md », « B ») sont lus
correctement ; avant, un salaire affiché en anglais valait 1 €. `chemins.json` de cette version contient la lecture de la
boîte de réception du coach (clés `boite00…29`, FM Immersion 0.1.129). Plus de lecture complète pendant un match
(le jeu ramait) : elle part dès le coup de sifflet final, le direct continue.

**0.5.9** : fluidité. Les requêtes d'une lecture partaient toutes dans la même image du jeu (plus de 5 000 pour
`chemins.json`), d'où un à-coup à chaque jour de jeu. Le plugin ne prend plus que 3 ms par image au thread du jeu et
envoie ses requêtes par tranches de 50 ; le reste attend l'image suivante. `collecte.duree` et le journal BepInEx donnent
la durée de chaque lecture et le temps pris au thread du jeu (total, et pire image). Quatre lectures qui ne répondaient
jamais sont retirées de `chemins.json` (`pretEntrant`, `equipeTypeBrut`, `equipeContexte`, `resultatsImposes`).

**0.6.1** : partie commencée sans emploi. Au début d'une partie sans club, le jeu renvoie une équipe vide (sans nom ni
joueurs) : le plugin la prenait pour un club, attendait un effectif qui ne venait pas et n'écrivait ni instantané ni
`archivix-status.json`. FM Immersion restait sur l'ancienne sauvegarde. Une équipe sans nom compte maintenant comme
« sans club » (état écrit avec `club: null`).

## Garde-fou « écran Tactique » (0.3.0)

Toute lecture liée à la tactique (`LireTactique`, `LireEfficacite`, `LireCompo`, section `tactique` de `chemins.json`,
sondes `/api/probe` et `/api/squad`) est **sautée tant que l'écran Tactique de FM27 est ouvert**, ou si son état est
inconnu. L'état est lu dans le fil d'événements de l'interface que le jeu tient pour son rapporteur de plantage
(`LocalLow\Sports Interactive\Football Manager 27\backtrace\bt-breadcrumbs-*`, événements `Panel Opened/Closed` de
`TacticalPlannerTool` du lancement en cours) : aucune requête au jeu. L'instantané indique ce qui a été lu ou sauté
dans `collecte` (ex. `{"tactique": "sautée : écran Tactique ouvert"}`).

## Propriétés « de contexte »

Syntaxe de chemin `Propriete{Contexte=valeur,Autre=valeur}`, utilisable aussi dans `chemins.json`. Une valeur est un
nombre, `true`/`false`, ou une référence : `@team` (équipe du club humain), `@human` (manager humain), `@person`
(joueur courant, section `joueur`). Exemples :
`"joueurPoste3": "PlayerFromTeamSelectionIndex{TeamSelectionIndex=3}/Name"` (section `tactique`),
`"moral": "Morale{team=@team,human=@human}"` (section `joueur`).
Le rapport `decouverte.json` liste, pour les principaux types de référence, chaque propriété et les contextes qu'elle
exige (`null` = aucun), ainsi que tous les noms de contexte connus du jeu. Il est écrit une fois par lancement, à partir
des tables statiques de l'interface (aucune requête au jeu).

## Instantané : blocs ajoutés en 0.3.0

- `lineup` (si `LireCompo`, 0.3.1) : `[{ "index": 0-10, "playerId", "playerName", "positionIP", "positionOOP",
  "ipRole", "oopRole", "roleOverride", "personalisedIP", "personalisedOOP" }]` ; codes de poste et de rôle :
  masques `PositionMask`, `InPossessionRole`, `OutOfPossessionRole` (voir `codes-roles-tactique.json`). `null` si le jeu
  ne répond pas.
- `playersExtended` (si `LireJoueursEtendus`, 0.3.1) : par id de joueur `{ morale, moraleText, happinessClub,
  happinessManagement, happinessPlayingTime, happinessTraining, hierarchy, currentStars, potentialStars, personality,
  mediaHandling, currentAbility, potentialAbility }` (champs absents si le jeu ne répond pas).
- Efficacité tactique (si `LireEfficacite`) : désormais lue avec son contexte `{human}`.
- 0.5.5 : la tactique (bloc `tactic`, section `tactique` de `chemins.json`, efficacité) est celle que renvoie l'équipe,
  `GameCurrentManagerClubTeam/Tactic{Boolean=true}`. La référence construite à la main tombait sur un « 4-4-2 » par
  défaut, sans efficacité ; avec la bonne, le jeu répond (08/11/2026 : « 4-1-5 MD 2MO… », efficacité 43 %).
- `collecte` : `{ "tactique" | "efficacite" | "compo": "lue" | "désactivée (réglage)" | "sautée : …" | "erreur : …" }`.

## Cibles du mercato (0.4.0, réglage `LireCibles`)

Joueurs d'autres clubs que le joueur suit, pour la page « Cibles du mercato » de FM Immersion. Sources (propriétés trouvées
dans `decouverte.json`, remplaçables sans recompiler par la section `cibles` de `chemins.json`) :

- `selection` : `GameCurrentManager/HumanPersonSearch{team=@team,Type=0}/PersonList` (joueurs de la sélection, Recrutement > Sélections). **Le jeu ne remplit cette liste que pendant que l'écran Sélections est affiché** : ailleurs elle revient vide, et le plugin garde alors la dernière liste lue (0.4.3). `HumanSelectedShortlist` ne donne que la fiche de la sélection (nom, nombre) ;
- `cibles` : `GameCurrentManagerClubTeam/Club/PlayerTargetsList{human=@human}` (cibles du recrutement).

Une source peut renvoyer une liste de joueurs, une liste de fiches qui contiennent un joueur, ou une fiche qui contient
la liste : le plugin garde les joueurs (40 au plus, par paquets de 10). Pour chacun : les champs de `players`
(attributs en fourchette selon la connaissance du recrutement), plus `club`, `sources` et `scout` (étoiles du staff et
des recruteurs, connaissance, recommandation, meilleur poste et rôles vus par le recrutement, fourchettes de valeur et de
salaire, clubs intéressés, statut de transfert, personnalité). Écrit dans le bloc `shortlist` de l'instantané ; relu à
chaque nouveau jour de jeu, ou dès que le nombre de joueurs d'une liste change (0.4.1). `targetSources` indique, par source, le nombre de joueurs trouvés et, si aucun,
la forme de la réponse du jeu (pour corriger le chemin). Aucune lecture liée à la tactique.

## État courant (0.4.2)

À chaque instantané, le plugin écrit aussi `archivix-status.json` dans son dossier :
`{"schema":"archivix-status/1","gameDate":"yyyy-MM-dd","club":"Nom"}`. Les valeurs viennent de l'instantané, sans lecture
de plus. FM Immersion s'en sert pour savoir quelle partie est chargée et si le manager a un club.
Sans équipe chargée depuis 45 s (manager sans club), le plugin lit seulement `game.CurrentGameDate`, une fois par
minute au plus, et écrit le même fichier avec `"club": null`. La date du menu (1900-01-01) est ignorée.

## Requêtes au jeu : règles

- **Pas de lecture pendant un chargement (0.4.2).** Après le chargement d'une partie, le plugin attend 45 s de partie
  chargée sans interruption avant le premier instantané, et il vérifie entre chaque bloc de lecture que la partie est
  toujours chargée, avec le même club. Sinon il abandonne l'instantané. Depuis 0.4.6, un jour qui passe pendant la
  lecture ne l'arrête plus (avant, rien n'était écrit tant que le joueur avançait dans le calendrier). Un contexte vide (`@team` non résolu) n'est jamais
  envoyé au jeu. Cela fait suite au plantage du 01/11 à 18h02 : une lecture avait démarré 2 s après un chargement, puis
  le joueur avait quitté la partie.
- Chaque requête de binding est **désinscrite** dès sa réponse, même tardive, et **au délai dépassé** (0.2.2).
  Avant, une requête sans réponse restait active dans le jeu et s'ajoutait à chaque instantané : cause probable des gels
  de l'écran Tactique du 31/10 (FM27 figé ou arrêté pendant que des lectures de la tactique attendaient).
- Certaines propriétés sont « de contexte » : le jeu ne les résout que si la requête fournit un contexte
  (`BindingUtils.BuildRequest(...).AddContext(nom, valeur).BindOneShot(propriété, …)` ;
  `BindingUtils.RequiresContext(référence, propriété)` permet de le savoir). Sans contexte, elles ne répondent jamais.
  C'est le cas des pistes pour la compo (joueur par poste, rôles « Personnalisée ») : `PlayerFromTeamSelectionIndex`,
  `PositionFromTeamSelectionIndex`, `PlayerTeamSelectionIndex`, `TeamSelection`… À tester avec un contexte d'index de
  sélection, jamais pendant que l'écran Tactique est ouvert.

## Mises à jour

1. **Données à lire** : modifier `config/chemins.json`. FM Immersion le redéploie avec le plugin ; le plugin le relit à chaque
   instantané (pas de recompilation, pas de redémarrage du jeu).
2. **Code du plugin** : le plugin se compile contre les DLL d'interop générées par BepInEx dans le dossier du jeu.
   Elles appartiennent à l'éditeur : elles ne sont **ni versionnées ni publiées**, et la CI ne peut pas compiler le plugin.
   Il n'est donc **pas embarqué dans l'installeur FM Immersion** (construit par la CI, sans composant propriétaire,
   condition de la signature SignPath). Il est publié à part :

   ```powershell
   # version identique dans ArchivixBridge.csproj (<Version>) et Plugin.Version
   .\publier.ps1 -FMDir "G:\Steam\steamapps\common\Football Manager 27"
   ```

   Le script compile en local, calcule les empreintes SHA-256 et crée la release `fm-bridge-vX.Y.Z`
   (`ArchivixBridge.dll`, `chemins.json`, `fm-bridge.json`) **sans la marquer « latest »** : ce statut reste à la
   release de l'appli, que `tauri-plugin-updater` lit.
3. **Côté joueur** : carte « Plugin FM27 » dans une partie Football Manager. FM Immersion compare la version installée
   à la dernière release, télécharge, vérifie les empreintes, puis installe — seulement sur demande et jeu fermé
   (`src-tauri/src/fm_bridge.rs`).

## Prérequis côté joueur

BepInEx 6 « bleeding edge » pour Unity IL2CPP win-x64 dézippé à côté de `fm.exe`, puis un premier lancement du jeu
pour générer `BepInEx\interop`. FM Immersion n'installe pas BepInEx lui-même.

## Compiler en local

```powershell
dotnet build -c Release -p:FMDir="G:\Steam\steamapps\common\Football Manager 27"
```

`FMDir` peut aussi venir de la variable d'environnement `FM27_DIR`.

## Compiler sans le jeu (CI)

```bash
dotnet build -c Release -p:Stubs=true
```

GitHub compile le plugin à chaque PR de cette façon (job `plugin` de `.github/workflows/ci.yml`) et garde
`ArchivixBridge.dll` en artefact. BepInEx et Il2CppInterop viennent de NuGet (logiciels libres,
`nuget.bepinex.dev`, même version que chez le joueur : BepInEx 6.0.0-be.791, Il2CppInterop 1.5.3). Les DLL
d'interop du jeu, elles, sont remplacées par des **modèles de compilation** écrits pour le dépôt (`stubs/`) :
seulement les noms et signatures des types et membres que le plugin appelle, sans aucun code du jeu (chaque corps
lève une exception). En jeu, ce sont toujours les vraies DLL générées par BepInEx qui sont chargées.

- Vérifié le 10/11/2026 : compilé avec les modèles ou avec les vraies DLL du jeu, le plugin 0.5.9 référence
  exactement les mêmes types, membres et assemblages (DLL de même taille, seuls l'identifiant de module et les
  dates diffèrent).
- Si le plugin appelle un nouveau membre du jeu, la compilation sans le jeu échoue : ajouter sa signature au
  modèle de l'assemblage concerné, en la recopiant de la vraie DLL d'interop (même nom, mêmes types de paramètres
  et de retour, même `static`/`virtual`/`new`), puis compiler les deux façons.
- Les modèles ne sont **jamais** livrés : seule `ArchivixBridge.dll` part en artefact ou en release.
- La publication (`publier.ps1`) et le test en jeu restent sur le PC du joueur, avec les vraies DLL. La cartographie des données du jeu
(chemins, types, limites connues) est décrite dans le rapport `cartographie.md` produit pendant le développement.

## Centre de données (chemins.json, 01/11/2026, complété le 03/11/2026)

Toutes les statistiques de match de la saison de chaque joueur (écran Centre de données, toutes compétitions :
temps de jeu, victoires et points, xG, tirs, passes, centres, occasions, ballons perdus et récupérés, pressings,
tacles, interceptions, duels aériens, distance, gardien, fautes et cartons) sont lues par les clés `stat_<Propriété>`
de la section `joueur` de `config/chemins.json` (70 propriétés de `PersonReference` sans contexte, relevées dans
`decouverte.json`), en profond (`{ PropertyValue, Count }`). Surtout des totaux : FM Immersion en déduit les valeurs par 90
et les pourcentages. Aucune recompilation ; aucune lecture liée à la tactique. Import : `modules/fm/src/stats.ts`,
page Effectif > Centre de données.

**0.6.2** : conférence de presse dans le jeu. FM Immersion dépose la conférence du moment dans
`<Dossier>\fmimmersion-presse.json` (format `fmi-presse/1` : `key`, `title`, `subtitle`, `questions[{id, by, text,
answers[{tone, label, text}]}]`, `ui` ; tous les textes déjà rédigés dans la langue du joueur) et le retire quand il n'y a
plus de conférence. Le plugin le relit toutes les 5 s sur un thread à part ; une nouvelle conférence ouvre la fenêtre
(jamais pendant un match), F8 l'ouvre ou la ferme. Une question à la fois : trois réponses proposées, texte libre,
« Question suivante », « Pas de commentaire » (refus de toute la conférence), « Plus tard ». Les réponses vont dans
`<Dossier>\fmimmersion-presse-reponse.json` (`fmi-presse-reponse/1` : `key`, `declined`, `answers[{question, tone, text}]`,
écriture atomique), que FM Immersion enregistre pour la gazette et Discord. La fenêtre n'envoie rien au jeu : aucun effet
sur le moral ni la réputation. Clé `ConferenceEnJeu` (oui par défaut) pour la couper.
Affichage : FM27 n'a plus IMGUI (`OnGUI` lève « Method unstripping failed », test du 11/11/2026) ; la fenêtre est faite en
UI Toolkit, dans un panneau à nous (réglages copiés du panneau FM le plus haut, ordre +100) avec une police SDF du jeu
(sans police, aucun texte ne s'affiche). Validé en jeu le 11/11/2026 avec un plugin de test.

**0.6.3** : match plus fluide. Une lecture complète lancée juste avant le coup d'envoi continuait pendant le match
(journal du 13/11/2026 : lecture de 63 s pendant le match, 9,5 s prises au thread du jeu, images jusqu'à 108 ms ; « le
match 3D rame »). Le direct tient maintenant l'état « match en cours » (`Plugin.InMatch`), regardé toutes les 5 s pendant
une lecture complète ; dès qu'un match commence, la lecture s'arrête (tranches déjà en file comprises) et repart après
le coup de sifflet final. Le direct et les petites questions (date, match en cours ?) ne sont pas concernés.

**0.6.4** : compo et tactique presque en direct. La lecture complète ne repart qu'à chaque nouveau jour de jeu (ou toutes
les `RelectureSecondes`), si bien qu'un changement de onze ou de tactique dans FM27 mettait plusieurs minutes à arriver
dans FM Immersion. `SelectionLoop` relit toutes les 10 s les 11 lignes de la compo et le nom de la tactique active
(une centaine de petites requêtes, par tranches comme le reste) ; si l'un des deux a changé, la tactique est relue et
`archivix-snapshot.json` (et le fichier daté) réécrit avec la nouvelle compo, le reste de l'instantané gardé tel quel
(`collecte.compoRapide` donne l'heure). Jamais pendant un match, une lecture complète, ou tant que l'écran Tactique est
ouvert : le changement arrive une dizaine de secondes après avoir quitté cet écran. Les consignes d'équipe lues par
`chemins.json` attendent toujours la lecture complète.
