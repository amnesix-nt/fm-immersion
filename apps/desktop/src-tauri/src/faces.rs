//! Module « Visages photoréalistes » : état du pack de portraits dans FM27, installation en un clic
//! (`faces_pack`), avancement de la génération dans l'atelier (`faces_progress`) et réglage du plugin
//! AgeSwap (portraits selon l'âge, BepInEx).
//!
//! Écritures uniquement sur clic du joueur, jeu fermé : bundle et catalogue des portraits, réglage d'AgeSwap.

use crate::faces_pack::{self, CatalogState, PackError, Paths};
use crate::faces_progress;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Taille du bundle d'origine de FM27 (version du 29/10/2026).
pub const ORIGINAL_SIZE: u64 = faces_pack::ORIG_SIZE as u64;
/// Taille du bundle du pack photoréaliste v1.0 (release GitHub du 01/11/2026).
pub const PHOTOREAL_V1_SIZE: u64 = faces_pack::V1_SIZE as u64;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FacesState {
    /// Dossier de FM27 introuvable.
    NoGame,
    /// FM27 trouvé, mais pas de bundle de portraits.
    Missing,
    /// Portraits d'origine du jeu.
    Original,
    /// Pack photoréaliste v1.0 installé.
    PhotorealV1,
    /// Pack construit dans l'atelier et installé par FM Immersion.
    PhotorealCustom,
    /// Bundle modifié par autre chose (autre version, autre mod) ou jeu mis à jour.
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacesStatus {
    pub state: FacesState,
    pub size: Option<u64>,
    pub running: bool,
    /// Une sauvegarde des fichiers d'origine existe (désinstallation possible).
    pub backup: bool,
    /// Pack installé mais catalogue remis d'origine (mise à jour Steam) : le jeu affiche des carrés blancs.
    pub catalog_mismatch: bool,
    /// Portraits d'origine inconnus (nouvelle version de FM27 ou autre mod) : installation bloquée.
    pub catalog_unknown: bool,
    /// Avec un de nos packs (fait pour l'ancienne version) encore en place : Steam doit le remplacer.
    pub stale_pack: bool,
}

pub fn bundle_path(game: &Path) -> std::path::PathBuf {
    game.join("fm_Data").join("StreamingAssets").join("AddrData").join(faces_pack::BUNDLE)
}

pub fn state_for_size(size: u64) -> FacesState {
    match size {
        s if faces_pack::is_original_size(s) => FacesState::Original,
        PHOTOREAL_V1_SIZE => FacesState::PhotorealV1,
        _ => FacesState::Unknown,
    }
}

fn game_found(game: &Path) -> bool {
    game.is_absolute() && game.join("fm.exe").is_file()
}

/// État d'après la taille du bundle, précisé par le catalogue (CRC) quand il est lisible.
pub fn status_with(game: &Path, paths: Option<&Paths>) -> FacesStatus {
    let running = crate::fm_bridge::game_running(game);
    if !game_found(game) {
        return FacesStatus { state: FacesState::NoGame, size: None, running, backup: false, catalog_mismatch: false, catalog_unknown: false, stale_pack: false };
    }
    let backup = paths.is_some_and(faces_pack::has_bundle_backup);
    let Ok(m) = std::fs::metadata(bundle_path(game)) else {
        return FacesStatus { state: FacesState::Missing, size: None, running, backup, catalog_mismatch: false, catalog_unknown: false, stale_pack: false };
    };
    let by_size = state_for_size(m.len());
    let catalog_mismatch = paths.is_some_and(|p| faces_pack::catalog_mismatch(p, m.len()));
    let unknown = paths.and_then(|p| faces_pack::catalog_unknown(p, m.len()));
    let state = match (by_size, paths.and_then(faces_pack::catalog_state)) {
        (FacesState::Unknown, Some(CatalogState::Custom)) => FacesState::PhotorealCustom,
        (s, _) => s,
    };
    FacesStatus { state, size: Some(m.len()), running, backup, catalog_mismatch, catalog_unknown: unknown.is_some(), stale_pack: unknown == Some(true) }
}

#[cfg(test)]
pub fn status(game: &Path) -> FacesStatus {
    status_with(game, None)
}

/// Chemins du jeu, du cache Addressables (`LocalLow`) et de la sauvegarde (`Documents\FM27-Photoreal-Backup`,
/// le même dossier que les .bat du pack).
/// Les packs construits dans l'atelier (`workshop`) sont reconnus même installés sans l'app (bascule V2).
pub(crate) fn paths(app: &tauri::AppHandle, game: &Path, workshop: Option<&str>) -> Option<Paths> {
    let home = app.path().home_dir().ok()?;
    let docs = app.path().document_dir().unwrap_or_else(|_| home.join("Documents"));
    let cache = home.join("AppData").join("LocalLow").join("Sports Interactive").join("Football Manager 27").join("com.unity.addressables");
    let known = workshop.filter(|w| !w.trim().is_empty()).map(|w| faces_pack::workshop_packs(Path::new(w.trim()))).unwrap_or_default();
    Some(Paths::new(game, cache, docs.join("FM27-Photoreal-Backup")).with_known(known))
}

#[tauri::command]
pub fn faces_status(app: tauri::AppHandle, game_dir: String, workshop_dir: Option<String>) -> FacesStatus {
    let game = PathBuf::from(&game_dir);
    status_with(&game, paths(&app, &game, workshop_dir.as_deref()).as_ref())
}

fn now_iso() -> String {
    // Date UTC sans dépendance : secondes depuis 1970 → AAAA-MM-JJTHH:MM:SSZ (algorithme des jours civils).
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn checked_paths(app: &tauri::AppHandle, game_dir: &str, workshop: Option<&str>) -> Result<(PathBuf, Paths), PackError> {
    let game = PathBuf::from(game_dir);
    if !game_found(&game) {
        return Err(PackError::NoGame);
    }
    if crate::fm_bridge::game_running(&game) {
        return Err(PackError::GameRunning);
    }
    let p = paths(app, &game, workshop).ok_or(PackError::NoGame)?;
    Ok((game, p))
}

/// Installe le pack (bundle choisi par le joueur : v1.0 décompressée ou pack de l'atelier). FM27 doit être fermé.
#[tauri::command]
pub async fn faces_install(
    app: tauri::AppHandle,
    game_dir: String,
    pack: String,
    workshop_dir: Option<String>,
    version: Option<String>,
) -> Result<faces_pack::InstallReport, PackError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, p) = checked_paths(&app, &game_dir, workshop_dir.as_deref())?;
        faces_pack::install(&p, Path::new(pack.trim().trim_matches('"')), &now_iso(), version.as_deref())
    })
    .await
    .map_err(|e| PackError::Check(e.to_string()))?
}

/// Remet les portraits d'origine. FM27 doit être fermé.
#[tauri::command]
pub async fn faces_uninstall(app: tauri::AppHandle, game_dir: String, workshop_dir: Option<String>) -> Result<bool, PackError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, p) = checked_paths(&app, &game_dir, workshop_dir.as_deref())?;
        faces_pack::uninstall(&p)
    })
    .await
    .map_err(|e| PackError::Check(e.to_string()))?
}

#[tauri::command]
pub fn faces_progress(workshop_dir: String) -> faces_progress::Progress {
    faces_progress::read(Path::new(&workshop_dir))
}

#[tauri::command]
pub fn faces_default_workshop() -> Option<String> {
    faces_progress::default_workshop().map(|p| p.display().to_string())
}

// ------------------------------------------------------------------ AgeSwap (portraits selon l'âge)

const AGESWAP_DLL: &str = "FM27Faces.AgeSwap.dll";
const AGESWAP_CFG: &str = "fr.fm27faces.ageswap.cfg";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgeSwapStatus {
    pub bepinex: bool,
    pub installed: bool,
    pub version: Option<String>,
    /// None : le réglage n'existe pas encore (FM27 pas relancé depuis l'installation du plugin).
    pub enabled: Option<bool>,
    pub variants_dir: Option<String>,
    pub running: bool,
}

fn ageswap_dll(game: &Path) -> PathBuf {
    game.join("BepInEx").join("plugins").join("FM27Faces").join(AGESWAP_DLL)
}

fn ageswap_cfg(game: &Path) -> PathBuf {
    game.join("BepInEx").join("config").join(AGESWAP_CFG)
}

/// Valeur d'une clé `Nom = valeur` du fichier de réglages BepInEx.
pub fn cfg_value<'a>(cfg: &'a str, key: &str) -> Option<&'a str> {
    cfg.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        (!l.trim_start().starts_with('#') && k.trim() == key).then(|| v.trim())
    })
}

/// « ## Settings file was created by plugin FM27 Faces AgeSwap v0.3.0 » → « 0.3.0 ».
pub fn cfg_version(cfg: &str) -> Option<String> {
    let l = cfg.lines().find(|l| l.contains("created by plugin"))?;
    Some(l.rsplit_once(" v")?.1.trim().to_owned())
}

/// Réglage `ReplaceEnabled` changé, tout le reste du fichier gardé tel quel.
pub fn cfg_with_enabled(cfg: Option<&str>, enabled: bool) -> String {
    let value = if enabled { "true" } else { "false" };
    match cfg {
        Some(c) if cfg_value(c, "ReplaceEnabled").is_some() => {
            let eol = if c.contains("\r\n") { "\r\n" } else { "\n" };
            let mut out: Vec<String> = c
                .lines()
                .map(|l| match l.split_once('=') {
                    Some((k, _)) if !l.trim_start().starts_with('#') && k.trim() == "ReplaceEnabled" => format!("ReplaceEnabled = {value}"),
                    _ => l.to_owned(),
                })
                .collect();
            if c.ends_with('\n') {
                out.push(String::new());
            }
            out.join(eol)
        }
        // Pas encore de fichier (ou clé absente) : BepInEx complète le reste au prochain lancement.
        Some(c) if c.contains("[General]") => c.replacen("[General]", &format!("[General]\nReplaceEnabled = {value}"), 1),
        Some(c) => format!("{c}\n[General]\nReplaceEnabled = {value}\n"),
        None => format!("[General]\n\nReplaceEnabled = {value}\n"),
    }
}

pub fn ageswap_status(game: &Path) -> AgeSwapStatus {
    let cfg = std::fs::read_to_string(ageswap_cfg(game)).ok();
    AgeSwapStatus {
        bepinex: game.join("BepInEx").is_dir(),
        installed: ageswap_dll(game).is_file(),
        version: cfg.as_deref().and_then(cfg_version),
        enabled: cfg.as_deref().and_then(|c| cfg_value(c, "ReplaceEnabled")).map(|v| v.eq_ignore_ascii_case("true")),
        variants_dir: cfg.as_deref().and_then(|c| cfg_value(c, "VariantsDir")).map(str::to_owned),
        running: crate::fm_bridge::game_running(game),
    }
}

#[tauri::command]
pub fn faces_ageswap_status(game_dir: String) -> AgeSwapStatus {
    ageswap_status(Path::new(&game_dir))
}

/// Active ou coupe le remplacement par âge. Pris en compte au prochain lancement de FM27.
#[tauri::command]
pub fn faces_ageswap_set(game_dir: String, enabled: bool) -> Result<AgeSwapStatus, String> {
    let game = PathBuf::from(&game_dir);
    if !ageswap_dll(&game).is_file() {
        return Err("plugin AgeSwap absent du dossier BepInEx\\plugins\\FM27Faces".into());
    }
    let path = ageswap_cfg(&game);
    let existing = std::fs::read_to_string(&path).ok();
    let text = cfg_with_enabled(existing.as_deref(), enabled);
    std::fs::create_dir_all(path.parent().unwrap_or(&game)).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("cfg.tmp");
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| e.to_string())?;
    Ok(ageswap_status(&game))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnait_les_bundles_par_leur_taille() {
        assert_eq!(state_for_size(ORIGINAL_SIZE), FacesState::Original);
        assert_eq!(state_for_size(PHOTOREAL_V1_SIZE), FacesState::PhotorealV1);
        assert_eq!(state_for_size(42), FacesState::Unknown);
    }

    #[test]
    fn dossier_sans_fm27() {
        let dir = std::env::temp_dir().join(format!("fmi-faces-vide-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(status(&dir).state, FacesState::NoGame);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fm27_sans_bundle_puis_avec_bundle() {
        let dir = std::env::temp_dir().join(format!("fmi-faces-jeu-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fm.exe"), b"").unwrap();
        assert_eq!(status(&dir).state, FacesState::Missing);
        let bundle = bundle_path(&dir);
        std::fs::create_dir_all(bundle.parent().unwrap()).unwrap();
        std::fs::write(&bundle, b"abc").unwrap();
        let s = status(&dir);
        assert_eq!(s.state, FacesState::Unknown);
        assert_eq!(s.size, Some(3));
        std::fs::remove_dir_all(&dir).ok();
    }

    const CFG: &str = "## Settings file was created by plugin FM27 Faces AgeSwap v0.3.0\r\n## Plugin GUID: fr.fm27faces.ageswap\r\n\r\n[General]\r\n\r\n## true : remplace\r\n# Default value: false\r\nReplaceEnabled = true\r\n\r\nVariantsDir = D:\\FM27-PhotoReal\\age_variants\r\n";

    #[test]
    fn lit_et_change_le_reglage_ageswap() {
        assert_eq!(cfg_version(CFG).as_deref(), Some("0.3.0"));
        assert_eq!(cfg_value(CFG, "ReplaceEnabled"), Some("true"));
        assert_eq!(cfg_value(CFG, "VariantsDir"), Some("D:\\FM27-PhotoReal\\age_variants"));
        let off = cfg_with_enabled(Some(CFG), false);
        assert_eq!(cfg_value(&off, "ReplaceEnabled"), Some("false"));
        assert_eq!(off.replace("ReplaceEnabled = false", "ReplaceEnabled = true"), CFG);
        let fresh = cfg_with_enabled(None, true);
        assert_eq!(cfg_value(&fresh, "ReplaceEnabled"), Some("true"));
    }

    #[test]
    fn statut_ageswap() {
        let dir = std::env::temp_dir().join(format!("fmi-ageswap-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("BepInEx").join("config")).unwrap();
        assert!(!ageswap_status(&dir).installed);
        assert!(faces_ageswap_set(dir.display().to_string(), true).is_err());
        std::fs::create_dir_all(ageswap_dll(&dir).parent().unwrap()).unwrap();
        std::fs::write(ageswap_dll(&dir), b"dll").unwrap();
        std::fs::write(ageswap_cfg(&dir), CFG).unwrap();
        let s = faces_ageswap_set(dir.display().to_string(), false).unwrap();
        assert!(s.installed && s.bepinex);
        assert_eq!(s.enabled, Some(false));
        assert_eq!(s.version.as_deref(), Some("0.3.0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn date_iso() {
        let d = now_iso();
        assert_eq!(d.len(), 20);
        assert!(d.starts_with("20") && d.ends_with('Z'));
    }
}
