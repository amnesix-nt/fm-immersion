//! Lecture de l'instantané Football Manager écrit par le plugin BepInEx.
//!
//! Le plugin (lecture seule dans le jeu) dépose `archivix-snapshot.json` dans un
//! dossier `archivix` à côté des sauvegardes. Ce module se contente de lire ce fichier,
//! jamais la sauvegarde. Seule écriture dans ce dossier : `photo-coach.png`, la photo du coach choisie
//! par le joueur, que le plugin CoachPhoto affiche dans FM27 à la place du portrait 3D. La lecture directe de la base
//! du jeu en mémoire (à la demande du joueur, lecture seule) est dans `fm_memory.rs`.

use serde::{Serialize, Serializer};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Nom fixe : la commande ne peut lire aucun autre fichier.
pub const SNAPSHOT_FILE: &str = "archivix-snapshot.json";
/// État du manager écrit par le plugin à chaque relecture : club entraîné, ou aucun quand il est sans club.
pub const STATUS_FILE: &str = "archivix-status.json";
pub const LIVE_FILE: &str = "archivix-live.json";
/// Demande envoyée depuis FM27 par le bouton FM Immersion de la fiche joueur (plugin FM Immersion Fiche).
pub const REQUEST_FILE: &str = "fmimmersion-demande.json";
/// Repères de rôles et de styles fournis par le joueur (facultatif) : ils remplacent les repères maison.
pub const REFERENCE_FILE: &str = "simloom-roles.json";
/// Un effectif complet pèse quelques centaines de Ko ; au-delà, ce n'est pas notre fichier.
const MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FmError {
    #[error("dossier invalide")]
    InvalidFolder,
    #[error("aucun instantané dans ce dossier")]
    NotFound,
    #[error("fichier trop volumineux")]
    TooLarge,
    #[error("ce n'est pas une image PNG")]
    NotPng,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for FmError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub fn read_snapshot(folder: &Path) -> Result<String, FmError> {
    read_fixed(folder, SNAPSHOT_FILE)
}

fn read_fixed(folder: &Path, name: &str) -> Result<String, FmError> {
    if !folder.is_absolute() {
        return Err(FmError::InvalidFolder);
    }
    let path = folder.join(name);
    let meta = std::fs::metadata(&path).map_err(|_| FmError::NotFound)?;
    if meta.len() > MAX_BYTES {
        return Err(FmError::TooLarge);
    }
    Ok(std::fs::read_to_string(path)?)
}

/// Lecture de fichier hors du fil principal : la fenêtre ne se fige jamais pendant qu'un gros fichier est lu.
async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, FmError> + Send + 'static) -> Result<T, FmError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| FmError::Io(std::io::Error::other(e.to_string())))?
}

/// Contenu brut de l'instantané ; il est validé côté interface (schéma zod du module fm).
#[tauri::command]
pub async fn fm_read_snapshot(folder: String) -> Result<String, FmError> {
    off_main(move || read_snapshot(Path::new(&folder))).await
}

/// Repère d'un fichier (taille et date de modification) : il change dès que le plugin le réécrit.
fn stamp_of(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}-{}", meta.len(), modified.as_nanos()))
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SnapshotRead {
    /// Repère du fichier lu (à renvoyer au passage suivant).
    pub stamp: Option<String>,
    /// Contenu, ou rien si le fichier n'a pas changé depuis `since`.
    pub text: Option<String>,
}

/// L'instantané seulement s'il a changé depuis le repère donné : relu toutes les 10 s pendant que FM27 tourne, il
/// pèse plusieurs centaines de Ko et n'est réécrit qu'une fois par jour de jeu (ou toutes les 5 minutes).
pub fn read_snapshot_since(folder: &Path, since: Option<&str>) -> Result<SnapshotRead, FmError> {
    if !folder.is_absolute() {
        return Err(FmError::InvalidFolder);
    }
    let path = folder.join(SNAPSHOT_FILE);
    let before = stamp_of(&path).ok_or(FmError::NotFound)?;
    if since == Some(before.as_str()) {
        return Ok(SnapshotRead { stamp: Some(before), text: None });
    }
    let text = read_snapshot(folder)?;
    // Réécrit pendant la lecture : pas de repère, le fichier sera relu au passage suivant.
    let after = stamp_of(&path);
    Ok(SnapshotRead { stamp: (after.as_deref() == Some(before.as_str())).then_some(before), text: Some(text) })
}

#[tauri::command]
pub async fn fm_read_snapshot_since(folder: String, since: Option<String>) -> Result<SnapshotRead, FmError> {
    off_main(move || read_snapshot_since(Path::new(&folder), since.as_deref())).await
}

/// Repères locaux (`simloom-roles.json` dans le dossier du plugin), ou rien s'il n'y en a pas.
#[tauri::command]
pub fn fm_read_reference(folder: String) -> Result<Option<String>, FmError> {
    match read_fixed(Path::new(&folder), REFERENCE_FILE) {
        Ok(s) => Ok(Some(s)),
        Err(FmError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// État du manager (club entraîné ou sans club), ou rien si le plugin ne l'écrit pas encore.
#[tauri::command]
pub async fn fm_read_status(folder: String) -> Result<Option<String>, FmError> {
    off_main(move || match read_fixed(Path::new(&folder), STATUS_FILE) {
        Ok(s) => Ok(Some(s)),
        Err(FmError::NotFound) => Ok(None),
        Err(e) => Err(e),
    })
    .await
}

/// Match en cours écrit par le plugin toutes les 15 s (`archivix-live.json`, plugin 0.5.0), ou rien.
#[tauri::command]
pub fn fm_read_live(folder: String) -> Result<Option<String>, FmError> {
    match read_fixed(Path::new(&folder), LIVE_FILE) {
        Ok(s) => Ok(Some(s)),
        Err(FmError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Dernière demande faite depuis FM27 (bouton FM Immersion de la fiche joueur), ou rien. Lecture seule : l'appli
/// retient l'identifiant de la dernière demande traitée, le fichier reste tel quel.
#[tauri::command]
pub fn fm_read_request(folder: String) -> Result<Option<String>, FmError> {
    match read_fixed(Path::new(&folder), REQUEST_FILE) {
        Ok(s) => Ok(Some(s)),
        Err(FmError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Photo du coach pour le plugin CoachPhoto : nom fixe, la commande ne peut écrire aucun autre fichier.
pub const COACH_PHOTO_FILE: &str = "photo-coach.png";
/// La photo est recadrée en PNG de quelques dizaines de Ko par l'interface ; au-delà, ce n'est pas elle.
const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;

pub fn write_coach_photo(folder: &Path, png: Option<&[u8]>) -> Result<(), FmError> {
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(FmError::InvalidFolder);
    }
    let path = folder.join(COACH_PHOTO_FILE);
    match png {
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
        Some(bytes) => {
            if bytes.len() > MAX_PHOTO_BYTES {
                return Err(FmError::TooLarge);
            }
            if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err(FmError::NotPng);
            }
            if std::fs::read(&path).map(|old| old == bytes).unwrap_or(false) {
                return Ok(()); // déjà à jour : le plugin ne recharge pas la photo pour rien
            }
            // Écriture atomique : le plugin ne lit jamais une image à moitié écrite.
            let tmp = folder.join(format!("{COACH_PHOTO_FILE}.tmp"));
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, &path)?;
            Ok(())
        }
    }
}

/// Écrit (ou retire, `png` vide) la photo du coach dans le dossier du plugin.
#[tauri::command]
pub fn fm_write_coach_photo(folder: String, png: Option<Vec<u8>>) -> Result<(), FmError> {
    write_coach_photo(Path::new(&folder), png.as_deref())
}

/// Conférence de presse à afficher dans FM27 (plugin 0.6.0) : nom fixe, la commande ne peut écrire aucun autre fichier.
pub const PRESS_FILE: &str = "fmimmersion-presse.json";
/// Réponses du coach données dans FM27, écrites par le plugin.
pub const PRESS_ANSWER_FILE: &str = "fmimmersion-presse-reponse.json";
/// Une conférence de trois questions pèse quelques Ko ; au-delà, ce n'est pas elle.
const MAX_PRESS_BYTES: usize = 256 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum PressFileError {
    #[error("dossier invalide")]
    InvalidFolder,
    #[error("conférence trop volumineuse")]
    TooLarge,
    #[error("conférence illisible : {0}")]
    BadJson(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for PressFileError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Écrit (ou retire, `json` vide) la conférence du moment dans le dossier du plugin. Rien n'est réécrit si le
/// contenu n'a pas changé (le plugin ne rouvre pas la fenêtre pour rien).
pub fn write_press(folder: &Path, json: Option<&str>) -> Result<(), PressFileError> {
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(PressFileError::InvalidFolder);
    }
    let path = folder.join(PRESS_FILE);
    match json {
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
        Some(text) => {
            if text.len() > MAX_PRESS_BYTES {
                return Err(PressFileError::TooLarge);
            }
            let v: serde_json::Value = serde_json::from_str(text).map_err(|e| PressFileError::BadJson(e.to_string()))?;
            if v.get("format").and_then(|f| f.as_str()) != Some("fmi-presse/1") {
                return Err(PressFileError::BadJson("format".into()));
            }
            if std::fs::read_to_string(&path).map(|old| old == text).unwrap_or(false) {
                return Ok(());
            }
            let tmp = folder.join(format!("{PRESS_FILE}.tmp"));
            std::fs::write(&tmp, text)?;
            std::fs::rename(&tmp, &path)?;
            Ok(())
        }
    }
}

#[tauri::command]
pub fn fm_write_press(folder: String, json: Option<String>) -> Result<(), PressFileError> {
    write_press(Path::new(&folder), json.as_deref())
}

/// Réponses données dans FM27 (`fmimmersion-presse-reponse.json`), ou rien.
#[tauri::command]
pub fn fm_read_press_answer(folder: String) -> Result<Option<String>, FmError> {
    match read_fixed(Path::new(&folder), PRESS_ANSWER_FILE) {
        Ok(s) => Ok(Some(s)),
        Err(FmError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Instantané daté gardé par le plugin (`archivix-AAAA-MM-JJ.json`, un par jour de jeu) : date, club, taille.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FmHistoryFile {
    pub game_date: String,
    pub club: Option<String>,
    pub bytes: u64,
}

/// Date d'un nom `archivix-AAAA-MM-JJ.json`, ou rien pour tout autre fichier.
fn history_date(name: &str) -> Option<&str> {
    let date = name.strip_prefix("archivix-")?.strip_suffix(".json")?;
    let b = date.as_bytes();
    let ok = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    ok.then_some(date)
}

/// Club écrit en tête de l'instantané (`"club": "…"`), lu dans les premiers octets sans tout analyser.
fn header_club(head: &str) -> Option<String> {
    let at = head.find("\"club\"")? + 6;
    let rest = head[at..].trim_start().strip_prefix(':')?.trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let mut escaped = false;
    for (i, c) in rest.char_indices().skip(1) {
        match c {
            '\\' if !escaped => escaped = true,
            '"' if !escaped => return serde_json::from_str(&rest[..=i]).ok(),
            _ => escaped = false,
        }
    }
    None
}

/// Club lu en tête de chaque fichier daté, gardé tant que le fichier ne change pas (même taille, même date) : la liste
/// est relue chaque minute et le dossier compte un fichier par jour de jeu, on n'ouvre plus que les nouveaux.
type HeaderCache = std::collections::HashMap<PathBuf, (u64, Option<std::time::SystemTime>, Option<String>)>;
static HEADERS: std::sync::OnceLock<std::sync::Mutex<HeaderCache>> = std::sync::OnceLock::new();

/// Instantanés datés du dossier du plugin, du plus ancien au plus récent.
pub fn list_history(folder: &Path) -> Result<Vec<FmHistoryFile>, FmError> {
    use std::io::Read;
    if !folder.is_absolute() {
        return Err(FmError::InvalidFolder);
    }
    let mut cache = HEADERS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<FmHistoryFile> = std::fs::read_dir(folder)?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let game_date = history_date(&name)?.to_string();
            let meta = e.metadata().ok()?;
            if !meta.is_file() || meta.len() > MAX_BYTES {
                return None;
            }
            let path = e.path();
            let modified = meta.modified().ok();
            seen.insert(path.clone());
            let club = match cache.get(&path) {
                Some((len, m, club)) if *len == meta.len() && *m == modified && modified.is_some() => club.clone(),
                _ => {
                    let mut head = vec![0u8; 4096];
                    let n = std::fs::File::open(&path).and_then(|mut f| f.read(&mut head)).ok()?;
                    let club = header_club(&String::from_utf8_lossy(&head[..n]));
                    cache.insert(path, (meta.len(), modified, club.clone()));
                    club
                }
            };
            Some(FmHistoryFile { game_date, club, bytes: meta.len() })
        })
        .collect();
    // Fichiers disparus de ce dossier : oubliés (les autres dossiers gardent les leurs).
    cache.retain(|p, _| p.parent() != Some(folder) || seen.contains(p));
    out.sort_by(|a, b| a.game_date.cmp(&b.game_date));
    Ok(out)
}

/// Historique gardé par le plugin : la liste des jours, pour reprendre une carrière déjà suivie.
#[tauri::command]
pub async fn fm_history_list(folder: String) -> Result<Vec<FmHistoryFile>, FmError> {
    off_main(move || list_history(Path::new(&folder))).await
}

/// Contenu brut de l'instantané d'un jour (`archivix-AAAA-MM-JJ.json`) ; aucun autre fichier n'est lisible.
#[tauri::command]
pub async fn fm_history_read(folder: String, game_date: String) -> Result<String, FmError> {
    let name = format!("archivix-{game_date}.json");
    if history_date(&name).is_none() {
        return Err(FmError::NotFound);
    }
    off_main(move || read_fixed(Path::new(&folder), &name)).await
}

/// Dossier par défaut : celui réglé dans le plugin s'il est installé, sinon
/// Documents\Sports Interactive\Football Manager 27\archivix.
/// Le joueur peut le changer s'il a déplacé ses données de jeu (autre disque…).
#[tauri::command]
pub fn fm_default_folder(app: tauri::AppHandle) -> Option<String> {
    if let Some(dir) = crate::fm_bridge::find_game_dir().and_then(|g| crate::fm_bridge::plugin_data_dir(&g)) {
        return Some(dir);
    }
    let docs: PathBuf = app.path().document_dir().ok()?;
    Some(
        docs.join("Sports Interactive")
            .join("Football Manager 27")
            .join("archivix")
            .to_string_lossy()
            .into_owned(),
    )
}

/// Fichier de sauvegarde FM27 (`.fm`) : seulement son nom et ses métadonnées, jamais son contenu.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FmSaveFile {
    pub name: String,
    /// Dernière écriture par le jeu, en millisecondes depuis 1970.
    pub modified_ms: Option<u64>,
    pub bytes: u64,
}

/// Dossier des sauvegardes : `games`, à côté du dossier `archivix` du plugin
/// (ex. D:\Sports Interactive\Football Manager 27\games).
pub fn games_dir(plugin_folder: &Path) -> Option<PathBuf> {
    if !plugin_folder.is_absolute() {
        return None;
    }
    Some(plugin_folder.parent()?.join("games"))
}

/// Liste les sauvegardes `.fm`, la plus récente d'abord.
pub fn list_saves(games: &Path) -> Vec<FmSaveFile> {
    let Ok(entries) = std::fs::read_dir(games) else { return Vec::new() };
    let mut out: Vec<FmSaveFile> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            let is_fm = Path::new(&name).extension().is_some_and(|x| x.eq_ignore_ascii_case("fm"));
            if !meta.is_file() || !is_fm {
                return None;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            Some(FmSaveFile { name, modified_ms, bytes: meta.len() })
        })
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.name.cmp(&b.name)));
    out
}

/// Sauvegardes FM27 du joueur, pour lier une partie FM Immersion à l'une d'elles.
#[tauri::command]
pub fn fm_list_saves(folder: String) -> Vec<FmSaveFile> {
    games_dir(Path::new(&folder)).map(|g| list_saves(&g)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecrit_et_retire_la_photo_du_coach() {
        let dir = std::env::temp_dir().join(format!("fmi-photo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = b"\x89PNG\r\n\x1a\nreste";
        write_coach_photo(&dir, Some(png)).unwrap();
        assert_eq!(std::fs::read(dir.join(COACH_PHOTO_FILE)).unwrap(), png);
        assert!(matches!(write_coach_photo(&dir, Some(b"GIF89a")), Err(FmError::NotPng)));
        assert!(matches!(write_coach_photo(Path::new("relatif"), Some(png)), Err(FmError::InvalidFolder)));
        write_coach_photo(&dir, None).unwrap();
        assert!(!dir.join(COACH_PHOTO_FILE).exists());
        write_coach_photo(&dir, None).unwrap(); // déjà retirée : pas d'erreur
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ecrit_et_retire_la_conference_de_presse() {
        let dir = std::env::temp_dir().join(format!("fmi-presse-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let json = r#"{"format":"fmi-presse/1","key":"post|A|B|2026-08-01","questions":[]}"#;
        write_press(&dir, Some(json)).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(PRESS_FILE)).unwrap(), json);
        assert!(matches!(write_press(&dir, Some("pas du json")), Err(PressFileError::BadJson(_))));
        assert!(matches!(write_press(&dir, Some(r#"{"format":"autre"}"#)), Err(PressFileError::BadJson(_))));
        assert!(matches!(write_press(Path::new("relatif"), Some(json)), Err(PressFileError::InvalidFolder)));
        assert_eq!(fm_read_press_answer(dir.to_string_lossy().into_owned()).unwrap(), None);
        std::fs::write(dir.join(PRESS_ANSWER_FILE), r#"{"key":"k"}"#).unwrap();
        assert_eq!(fm_read_press_answer(dir.to_string_lossy().into_owned()).unwrap().as_deref(), Some(r#"{"key":"k"}"#));
        write_press(&dir, None).unwrap();
        assert!(!dir.join(PRESS_FILE).exists());
        write_press(&dir, None).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lit_le_fichier_du_plugin() {
        let dir = std::env::temp_dir().join(format!("fmi-fm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SNAPSHOT_FILE), r#"{"schema":"archivix/1"}"#).unwrap();
        assert_eq!(read_snapshot(&dir).unwrap(), r#"{"schema":"archivix/1"}"#);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuse_un_dossier_relatif_ou_vide() {
        assert!(matches!(read_snapshot(Path::new("archivix")), Err(FmError::InvalidFolder)));
        let dir = std::env::temp_dir().join("fmi-fm-vide");
        assert!(matches!(read_snapshot(&dir), Err(FmError::NotFound)));
    }

    #[test]
    fn reperes_locaux_facultatifs() {
        let dir = std::env::temp_dir().join(format!("fmi-fm-ref-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let folder = dir.to_string_lossy().into_owned();
        assert_eq!(fm_read_reference(folder.clone()).unwrap(), None);
        std::fs::write(dir.join(REFERENCE_FILE), r#"{"roles":[],"styles":[]}"#).unwrap();
        assert_eq!(fm_read_reference(folder).unwrap().as_deref(), Some(r#"{"roles":[],"styles":[]}"#));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn liste_les_sauvegardes_a_cote_du_dossier_du_plugin() {
        let root = std::env::temp_dir().join(format!("fmi-fm-saves-{}", std::process::id()));
        let games = root.join("games");
        std::fs::create_dir_all(&games).unwrap();
        std::fs::write(games.join("Vänersborgs.fm"), b"x").unwrap();
        std::fs::write(games.join("Autre.FM"), b"xy").unwrap();
        std::fs::write(games.join("notes.txt"), b"").unwrap();
        std::fs::create_dir_all(games.join("dossier.fm")).unwrap();
        let folder = root.join("archivix").to_string_lossy().into_owned();
        let mut names: Vec<String> = fm_list_saves(folder).into_iter().map(|s| s.name).collect();
        names.sort();
        assert_eq!(names, vec!["Autre.FM".to_string(), "Vänersborgs.fm".to_string()]);
        assert!(fm_list_saves("archivix".into()).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn historique_date_et_club() {
        assert_eq!(history_date("archivix-2027-04-18.json"), Some("2027-04-18"));
        assert_eq!(history_date("archivix-snapshot.json"), None);
        assert_eq!(history_date("archivix-2027-4-18.json"), None);
        assert_eq!(history_date("archivix-../../x.json"), None);
        assert_eq!(header_club("{\n  \"schema\": \"archivix/1\",\n  \"club\": \"Mal\\u017eenice\",").as_deref(), Some("Malženice"));
        assert_eq!(header_club(r#"{"club":"Club \"A\""}"#).as_deref(), Some("Club \"A\""));
        assert_eq!(header_club(r#"{"club":null}"#), None);

        let dir = std::env::temp_dir().join(format!("fmi-hist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("archivix-2027-04-02.json"), r#"{"club":"B","gameDate":"2027-04-02"}"#).unwrap();
        std::fs::write(dir.join("archivix-2027-04-01.json"), r#"{"club":"A"}"#).unwrap();
        std::fs::write(dir.join(SNAPSHOT_FILE), "{}").unwrap();
        let list = list_history(&dir).unwrap();
        assert_eq!(list.iter().map(|f| (f.game_date.as_str(), f.club.as_deref())).collect::<Vec<_>>(), vec![("2027-04-01", Some("A")), ("2027-04-02", Some("B"))]);
        let d = dir.to_string_lossy().into_owned();
        let block = tauri::async_runtime::block_on;
        assert!(block(fm_history_read(d.clone(), "2027-04-02".into())).unwrap().contains("\"B\""));
        assert!(matches!(block(fm_history_read(d, "../x".into())), Err(FmError::NotFound)));
        // Fichier réécrit (autre taille) : son en-tête est relu malgré le cache ; fichier retiré : il disparaît.
        std::fs::write(dir.join("archivix-2027-04-01.json"), r#"{"club":"Club C"}"#).unwrap();
        std::fs::remove_file(dir.join("archivix-2027-04-02.json")).unwrap();
        let list = list_history(&dir).unwrap();
        assert_eq!(list.iter().map(|f| (f.game_date.as_str(), f.club.as_deref())).collect::<Vec<_>>(), vec![("2027-04-01", Some("Club C"))]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn instantane_relu_seulement_s_il_change() {
        let dir = std::env::temp_dir().join(format!("fmi-since-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(read_snapshot_since(&dir, None), Err(FmError::NotFound)));
        assert!(matches!(read_snapshot_since(Path::new("relatif"), None), Err(FmError::InvalidFolder)));
        std::fs::write(dir.join(SNAPSHOT_FILE), r#"{"club":"A"}"#).unwrap();
        let first = read_snapshot_since(&dir, None).unwrap();
        assert_eq!(first.text.as_deref(), Some(r#"{"club":"A"}"#));
        let stamp = first.stamp.clone().expect("repère");
        // Même fichier : rien n'est relu.
        assert_eq!(read_snapshot_since(&dir, Some(&stamp)).unwrap(), SnapshotRead { stamp: Some(stamp.clone()), text: None });
        // Réécrit par le plugin : relu.
        std::fs::write(dir.join(SNAPSHOT_FILE), r#"{"club":"AB"}"#).unwrap();
        let again = read_snapshot_since(&dir, Some(&stamp)).unwrap();
        assert_eq!(again.text.as_deref(), Some(r#"{"club":"AB"}"#));
        assert_ne!(again.stamp, Some(stamp));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
