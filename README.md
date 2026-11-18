# FM Immersion

Le logiciel compagnon de tes parties de **Football Manager 27** : visages photoréalistes, assistant FM Coach,
et outils pour rendre ta carrière plus vivante. Application Windows gratuite et open source.

> FM Immersion est un projet indépendant, sans lien avec Sports Interactive ni SEGA.
> Football Manager et FM sont des marques de leurs propriétaires.

## Modules

| Module | État |
|---|---|
| **FM Coach** : effectif, tactique, entraînement, mercato, adversaire, finances (lecture de ta partie) | disponible |
| **Plugin en jeu** (Archivix Bridge, BepInEx) : installation et mise à jour | disponible |
| **Visages photoréalistes** : installation en un clic, réinstallation après une mise à jour Steam | disponible |
| **Gazette** de la semaine : résultats, classement, blessures, transferts, centre de formation | disponible |
| **Live Discord** : direct de tes matchs et gazette (à la main ou automatique) dans ton salon (webhook) | disponible (solo) |
| **Défis** : De zéro à héros, Invincibles, Génération U19, Que des locaux, Ancienne Génération, Vikings, Sir Alex Ferguson, Économiste, Dunkerque… vérifiés par ta partie, certificat à partager | disponible |
| **Monde partagé** (multijoueur asynchrone) | à venir |

## Site

Le site de présentation est dans [`site/`](./site) (HTML et CSS statiques, sans script ni cookie), publié sur GitHub Pages.

## Installer

Télécharge le dernier `FM.Immersion_x.y.z_x64-setup.exe` dans les [releases](https://github.com/amnesix-nt/fm-immersion/releases/latest).
L'installation se fait dans ton profil Windows, sans droits administrateur. Ensuite, FM Immersion se met à jour
tout seul au démarrage quand une nouvelle version est publiée.

Désinstaller : Paramètres Windows › Applications › FM Immersion › Désinstaller.
Tes données sont dans `%APPDATA%\app.fmimmersion.desktop\fm-immersion.db` : supprime ce dossier pour tout effacer.

## Confidentialité

FM Immersion ne collecte, ne stocke à distance ni n'envoie aucune donnée personnelle. Tes parties restent dans
une base SQLite sur ton PC. FM Immersion ne se connecte qu'à GitHub (`github.com/amnesix-nt/fm-immersion/releases`) :
pour chercher ses mises à jour au démarrage et, seulement si tu le demandes, pour télécharger le plugin FM27.
L'écran Visages lit aussi le petit manifeste des packs de visages publiés au fil de la génération
(`github.com/amnesix-nt/FM27-Photorealistic-Faces/releases`, release « v2-progression ») ; le pack lui-même (~500 Mo)
n'est téléchargé que si tu cliques sur « Télécharger et installer », vérifié par SHA-256 avant l'installation.
Les photos de situation (joueurs et staff mis en scène pour les dépêches, le direct et la gazette) sont créées sur ton PC par un
moteur d'images que tu télécharges une fois, seulement si tu cliques sur « Télécharger le moteur » : ComfyUI portable depuis
`github.com/Comfy-Org/ComfyUI/releases` et les modèles Qwen Image Edit 2511 et OWLv2 depuis `huggingface.co` (dépôts Comfy-Org,
lightx2v et google, adresses fixes épinglées à une révision, ~34 Go, chaque fichier vérifié par SHA-256). Aucune image ni donnée
de ta partie ne leur est envoyée ; Hugging Face voit alors ton adresse IP, comme GitHub. Une fois installé, ComfyUI tourne
sur ton PC seulement (`127.0.0.1`, mode hors ligne, sans nœud tiers) et s'arrête avec l'appli.
Le labo de tactiques (Tactique › Plus › Labo de tactiques) utilise FM Tactics Lab, outil indépendant que tu télécharges une fois,
seulement si tu cliques sur « Télécharger FM Tactics Lab » : l'EXE officiel depuis `github.com/lqf0624/fm-tactics-lab/releases`
(version épinglée, ~23 Mo, vérifié par SHA-256). Il fait jouer tes tactiques avec le moteur de match de ton jeu installé, sur ton PC
seulement (`127.0.0.1`), n'écrit rien dans le jeu ni dans tes sauvegardes, et s'arrête avec l'appli.
Si tu relies un salon Discord (lien webhook, écran Live Discord), seul ce salon reçoit des messages, et seulement ce que tu as choisi : la gazette quand tu cliques sur « Envoyer sur Discord » ou, si tu coches « Envoyer ma gazette automatiquement chaque semaine », dès qu'une semaine de jeu est finie ; les dépêches (recrue, départ d'un titulaire, blessure longue, affiche des grands matchs) quand tu cliques sur « Envoyer la dépêche » ou, si tu coches « Envoyer les dépêches automatiquement », le jour où le plugin les voit ; le direct de tes matchs (un encart modifié à chaque temps fort) si tu coches « Raconter mes matchs en direct sur Discord » ; un certificat de défi (pseudo choisi, clubs, résultats des matchs, âges et nationalités des joueurs alignés) seulement quand tu cliques sur « Partager sur Discord ».
GitHub voit alors ton adresse IP, comme pour toute visite de son site.

**Rédaction par IA (désactivée par défaut).** Si tu l'actives (écran Plugin et réglages), la gazette et les commentaires du
direct sont écrits par l'IA que tu choisis :
- **Ollama**, installé sur ton PC : la demande va à `http://127.0.0.1:11434` et ne quitte pas ton ordinateur ;
- ou un fournisseur avec **ta propre clé API** (Mistral `api.mistral.ai`, Anthropic `api.anthropic.com` ou Google
  `generativelanguage.googleapis.com`) : les faits de la semaine ou du match (noms des clubs et des joueurs, scores,
  brèves calculées par l'appli) lui sont envoyés à chaque rédaction, jamais tes fichiers de sauvegarde. Ta clé est
  rangée dans le coffre de Windows (Gestionnaire d'identification) et n'est envoyée qu'à ce fournisseur, dont la
  politique de confidentialité s'applique.

## Politique de signature du code

Les versions publiées seront signées gratuitement grâce à SignPath, une fois le projet accepté par
la SignPath Foundation. La mention officielle sera alors :
*Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).*

Seuls les binaires construits par GitHub Actions à partir de ce dépôt sont signés, et chaque signature
est approuvée manuellement. Le plugin FM27 (`modules/fm/bridge`) n'en fait pas partie : il se compile contre des
fichiers du jeu qui ne peuvent pas être publiés, il est donc compilé en local et distribué à part, non signé,
avec une empreinte SHA-256 vérifiée par FM Immersion avant installation.

| Rôle | Membres |
|---|---|
| Auteurs (committers) | [@amnesix-nt](https://github.com/amnesix-nt) |
| Relecteurs | [@amnesix-nt](https://github.com/amnesix-nt) |
| Approbateurs | [@amnesix-nt](https://github.com/amnesix-nt) |

## Développer

Prérequis : Node 22, pnpm 9 (`corepack enable`), Rust stable, et sous Windows WebView2 (déjà présent sur Windows 10/11).

```bash
pnpm install
pnpm app            # lance l'application en mode développement
pnpm test           # tests TypeScript
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # tests Rust
```

Voir [CLAUDE.md](./CLAUDE.md) pour l'architecture et les conventions.

## Licence

[MIT](./LICENSE)
