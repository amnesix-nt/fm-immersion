//! Installation de BepInEx 6 (IL2CPP) dans le dossier de FM27, sur clic du joueur, jeu fermé.
//!
//! BepInEx est le chargeur de plugins dont ont besoin le plugin FM27 (Archivix Bridge) et AgeSwap. FM Immersion
//! télécharge une version épinglée depuis le serveur de builds officiel de BepInEx (`builds.bepinex.dev`), vérifie
//! sa taille et son empreinte SHA-256, puis l'extrait à côté de `fm.exe` (racine Steam, ou dossier `Content` du
//! Game Pass : c'est le dossier choisi dans « Plugin et réglages »).
//!
//! Règles :
//! - jamais par-dessus un BepInEx déjà là (installé à la main ou par un autre mod, par exemple « FM27 Real 3D
//!   Faces ») : s'il marche, on n'y touche pas ;
//! - aucun fichier existant n'est écrasé : si l'un des fichiers de l'archive est déjà présent, rien n'est écrit ;
//! - la liste des fichiers posés est gardée dans `BepInEx/fm-immersion-bepinex.json` : la désinstallation n'enlève
//!   que ceux-là (et les dossiers que BepInEx fabrique au premier lancement), jamais `BepInEx/plugins` ni
//!   `BepInEx/config`, qui restent pour une réinstallation.

use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Même version que celle avec laquelle le plugin est compilé et testé (FM27 27.1.0, 17/11/2026).
pub const VERSION: &str = "6.0.0-be.791+b782da4";
const URL: &str = "https://builds.bepinex.dev/projects/bepinex_be/791/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.791%2Bb782da4.zip";
const SIZE: u64 = 34_336_890;
const SHA256: &str = "bb1c510909b69522733791f3a0817a487379a52da6468a492f1c9c19b3ec6f9a";
/// Garde-fous : taille de l'archive téléchargée, taille totale extraite (~76 Mo attendus).
const MAX_DOWNLOAD: u64 = 48 * 1024 * 1024;
const MAX_EXTRACTED: u64 = 160 * 1024 * 1024;
const MARKER: &str = "fm-immersion-bepinex.json";
/// Ce que BepInEx fabrique lui-même au premier lancement du jeu (enlevé avec lui).
const GENERATED: [&str; 5] = ["interop", "unity-libs", "cache", "LogOutput.log", "ErrorLog.log"];

#[derive(Debug, thiserror::Error)]
pub enum BepinexError {
    #[error("dossier de FM27 introuvable (fm.exe absent)")]
    NoGame,
    #[error("FM27 est lancé : ferme le jeu d'abord")]
    GameRunning,
    #[error("BepInEx est déjà installé dans FM27 (par toi ou un autre mod) : FM Immersion n'y touche pas")]
    AlreadyPresent,
    #[error("le fichier {0} existe déjà dans le dossier de FM27 : rien n'a été écrit")]
    Conflict(String),
    #[error("ce BepInEx n'a pas été installé par FM Immersion : désinstalle-le comme tu l'as installé")]
    NotOurs,
    #[error("fichier téléchargé corrompu (taille ou empreinte SHA-256) : rien n'a été écrit")]
    BadChecksum,
    #[error("archive de BepInEx illisible : {0}")]
    BadArchive(String),
    #[error("réseau : {0}")]
    Network(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for BepinexError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    pub version: String,
    /// Fichiers posés, relatifs au dossier du jeu, séparés par « / ».
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BepinexStatus {
    pub game_found: bool,
    /// Un BepInEx (ou son chargeur `winhttp.dll`) est dans le dossier du jeu.
    pub present: bool,
    /// Installé par FM Immersion (désinstallable d'ici).
    pub ours: bool,
    /// Version installée, d'après notre fichier ou le journal de BepInEx.
    pub version: Option<String>,
    /// BepInEx n'a pas encore tourné une fois : le prochain lancement de FM27 sera long (quelques minutes).
    pub first_launch: bool,
    /// Version que FM Immersion sait installer.
    pub pinned: String,
}

fn bx(game: &Path) -> PathBuf {
    game.join("BepInEx")
}

fn read_marker(game: &Path) -> Option<Marker> {
    serde_json::from_str(&std::fs::read_to_string(bx(game).join(MARKER)).ok()?).ok()
}

/// « 6.0.0-be.791 » d'après la première ligne du journal : `[Message: Preloader] BepInEx 6.0.0-be.791 - fm (…)`.
pub fn version_in_log(text: &str) -> Option<String> {
    let line = text.lines().take(5).find(|l| l.contains("Preloader] BepInEx "))?;
    let rest = line.split("Preloader] BepInEx ").nth(1)?;
    rest.split_whitespace().next().map(str::to_owned)
}

fn log_version(game: &Path) -> Option<String> {
    let mut head = String::new();
    std::fs::File::open(bx(game).join("LogOutput.log")).ok()?.take(4096).read_to_string(&mut head).ok()?;
    version_in_log(&head)
}

pub fn status(game: &Path) -> BepinexStatus {
    let game_found = game.is_absolute() && game.join("fm.exe").is_file();
    let present = game_found && (bx(game).join("core").is_dir() || game.join("winhttp.dll").is_file());
    let marker = if game_found { read_marker(game) } else { None };
    BepinexStatus {
        game_found,
        present,
        ours: present && marker.is_some(),
        version: if present { marker.map(|m| m.version).or_else(|| log_version(game)) } else { None },
        first_launch: present && !bx(game).join("interop").is_dir(),
        pinned: VERSION.to_owned(),
    }
}

/// Chemin relatif sûr d'une entrée d'archive (ni absolu, ni « .. »), ou None.
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

pub fn checksum_ok(bytes: &[u8]) -> bool {
    bytes.len() as u64 == SIZE && hex(&Sha256::digest(bytes)) == SHA256
}

fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn download() -> Result<Vec<u8>, BepinexError> {
    let resp = ureq::get(URL).set("User-Agent", "FM Immersion").call().map_err(|e| BepinexError::Network(e.to_string()))?;
    let mut buf = Vec::new();
    resp.into_reader().take(MAX_DOWNLOAD).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Extrait l'archive (déjà vérifiée) dans `game`. Refuse avant toute écriture si un fichier existe déjà ; en cas
/// d'erreur en cours de route, retire ce qui a été posé. Renvoie la liste des fichiers posés.
pub fn extract(zip_bytes: &[u8], game: &Path) -> Result<Vec<String>, BepinexError> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| BepinexError::BadArchive(e.to_string()))?;
    let mut plan = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| BepinexError::BadArchive(e.to_string()))?;
        if f.is_dir() {
            continue;
        }
        let rel = safe_relative(f.name()).ok_or_else(|| BepinexError::BadArchive(format!("chemin refusé : {}", f.name())))?;
        total += f.size();
        if total > MAX_EXTRACTED {
            return Err(BepinexError::BadArchive("archive trop grande".into()));
        }
        if game.join(&rel).exists() {
            return Err(BepinexError::Conflict(rel.to_string_lossy().into_owned()));
        }
        plan.push((i, rel));
    }
    let mut written: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<(), BepinexError> {
        for (i, rel) in &plan {
            let mut f = zip.by_index(*i).map_err(|e| BepinexError::BadArchive(e.to_string()))?;
            let dest = game.join(rel);
            if let Some(dir) = dest.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut out = std::fs::File::create(&dest)?;
            written.push(rel.clone());
            std::io::copy(&mut (&mut f).take(MAX_EXTRACTED), &mut out)?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        for rel in &written {
            std::fs::remove_file(game.join(rel)).ok();
        }
        remove_empty_dirs(game, &written);
        return Err(e);
    }
    // Dossiers vides prévus par BepInEx (plugins, patchers) : créés aussi.
    std::fs::create_dir_all(bx(game).join("plugins"))?;
    std::fs::create_dir_all(bx(game).join("patchers"))?;
    Ok(written.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect())
}

/// Retire les dossiers devenus vides parmi les parents des fichiers donnés (du plus profond au moins profond),
/// sans jamais remonter au-dessus de `game`.
fn remove_empty_dirs(game: &Path, files: &[PathBuf]) {
    let mut dirs: Vec<PathBuf> = files.iter().flat_map(|f| f.ancestors().skip(1).filter(|a| !a.as_os_str().is_empty()).map(Path::to_path_buf).collect::<Vec<_>>()).collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    dirs.dedup();
    for d in dirs {
        std::fs::remove_dir(game.join(d)).ok(); // échoue sans rien faire si le dossier n'est pas vide
    }
}

pub fn install_from(zip_bytes: &[u8], game: &Path) -> Result<BepinexStatus, BepinexError> {
    let st = status(game);
    if !st.game_found {
        return Err(BepinexError::NoGame);
    }
    if st.present {
        return Err(BepinexError::AlreadyPresent);
    }
    if !checksum_ok(zip_bytes) {
        return Err(BepinexError::BadChecksum);
    }
    let files = extract(zip_bytes, game)?;
    let marker = Marker { version: VERSION.to_owned(), files };
    std::fs::write(bx(game).join(MARKER), serde_json::to_vec_pretty(&marker).map_err(|e| BepinexError::BadArchive(e.to_string()))?)?;
    Ok(status(game))
}

pub fn install(game: &Path) -> Result<BepinexStatus, BepinexError> {
    let st = status(game);
    if !st.game_found {
        return Err(BepinexError::NoGame);
    }
    if st.present {
        return Err(BepinexError::AlreadyPresent);
    }
    if crate::fm_memory::game_process_running() {
        return Err(BepinexError::GameRunning);
    }
    install_from(&download()?, game)
}

pub fn uninstall(game: &Path) -> Result<BepinexStatus, BepinexError> {
    if !(game.is_absolute() && game.join("fm.exe").is_file()) {
        return Err(BepinexError::NoGame);
    }
    if crate::fm_memory::game_process_running() {
        return Err(BepinexError::GameRunning);
    }
    let marker = read_marker(game).ok_or(BepinexError::NotOurs)?;
    let mut removed = Vec::new();
    for f in &marker.files {
        let Some(rel) = safe_relative(f) else { continue };
        // Jamais dans les plugins ni les réglages du joueur, même si la liste le disait.
        if rel.starts_with("BepInEx/plugins") || rel.starts_with("BepInEx/config") {
            continue;
        }
        std::fs::remove_file(game.join(&rel)).ok();
        removed.push(rel);
    }
    for g in GENERATED {
        let p = bx(game).join(g);
        if p.is_dir() {
            std::fs::remove_dir_all(&p).ok();
        } else {
            std::fs::remove_file(&p).ok();
        }
    }
    std::fs::remove_file(bx(game).join(MARKER))?;
    remove_empty_dirs(game, &removed);
    std::fs::remove_dir(bx(game).join("patchers")).ok();
    std::fs::remove_dir(bx(game).join("plugins")).ok();
    std::fs::remove_dir(bx(game)).ok();
    Ok(status(game))
}

#[tauri::command]
pub async fn bepinex_status(game_dir: String) -> BepinexStatus {
    let dir = game_dir.clone();
    tauri::async_runtime::spawn_blocking(move || status(Path::new(&dir))).await.unwrap_or_else(|_| status(Path::new("")))
}

#[tauri::command]
pub async fn bepinex_install(game_dir: String) -> Result<BepinexStatus, BepinexError> {
    tauri::async_runtime::spawn_blocking(move || install(Path::new(&game_dir))).await.map_err(|e| BepinexError::Network(e.to_string()))?
}

#[tauri::command]
pub async fn bepinex_uninstall(game_dir: String) -> Result<BepinexStatus, BepinexError> {
    tauri::async_runtime::spawn_blocking(move || uninstall(Path::new(&game_dir))).await.map_err(|e| BepinexError::Network(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fake_game() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fmi-bepinex-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fm.exe"), b"").unwrap();
        dir
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    fn fake_zip() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            z.add_directory("BepInEx/", o).unwrap();
            z.add_directory("BepInEx/plugins/", o).unwrap();
            for (name, body) in [("winhttp.dll", "w"), ("doorstop_config.ini", "d"), ("BepInEx/core/BepInEx.Core.dll", "c"), ("dotnet/coreclr.dll", "n")] {
                z.start_file(name, o).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn version_lue_dans_le_journal() {
        let log = "[Message: Preloader] BepInEx 6.0.0-be.791 - fm (29/10/2026 19:19:53)\n[Info   :   BepInEx] Running under Unity 6000.3.18f1\n";
        assert_eq!(version_in_log(log).as_deref(), Some("6.0.0-be.791"));
        assert_eq!(version_in_log("rien"), None);
    }

    #[test]
    fn chemins_d_archive() {
        assert_eq!(safe_relative("BepInEx/core/a.dll"), Some(PathBuf::from("BepInEx/core/a.dll")));
        assert_eq!(safe_relative("../fm.exe"), None);
        assert_eq!(safe_relative("/etc/passwd"), None);
        assert_eq!(safe_relative(""), None);
    }

    #[test]
    fn archive_non_verifiee_refusee() {
        let game = fake_game();
        assert!(matches!(install_from(&fake_zip(), &game), Err(BepinexError::BadChecksum)));
        assert!(!game.join("winhttp.dll").exists());
        std::fs::remove_dir_all(game).ok();
    }

    #[test]
    fn extraction_puis_desinstallation() {
        let game = fake_game();
        let files = extract(&fake_zip(), &game).unwrap();
        assert_eq!(files.len(), 4);
        assert!(game.join("BepInEx/core/BepInEx.Core.dll").is_file());
        std::fs::write(bx(&game).join(MARKER), serde_json::to_vec(&Marker { version: VERSION.into(), files }).unwrap()).unwrap();
        let st = status(&game);
        assert!(st.present && st.ours && st.first_launch);
        assert_eq!(st.version.as_deref(), Some(VERSION));
        // Ce que le joueur et BepInEx ont ajouté ensuite.
        std::fs::create_dir_all(bx(&game).join("plugins/Archivix")).unwrap();
        std::fs::write(bx(&game).join("plugins/Archivix/ArchivixBridge.dll"), b"p").unwrap();
        std::fs::create_dir_all(bx(&game).join("config")).unwrap();
        std::fs::write(bx(&game).join("config/BepInEx.cfg"), b"c").unwrap();
        std::fs::create_dir_all(bx(&game).join("interop")).unwrap();
        std::fs::write(bx(&game).join("interop/Assembly-CSharp.dll"), b"i").unwrap();
        std::fs::write(bx(&game).join("LogOutput.log"), b"l").unwrap();
        assert!(!status(&game).first_launch);

        let st = uninstall(&game).unwrap();
        assert!(!st.present && !st.ours);
        assert!(!game.join("winhttp.dll").exists() && !game.join("dotnet").exists() && !bx(&game).join("core").exists());
        assert!(!bx(&game).join("interop").exists() && !bx(&game).join("LogOutput.log").exists());
        // Plugins et réglages du joueur gardés.
        assert!(bx(&game).join("plugins/Archivix/ArchivixBridge.dll").is_file());
        assert!(bx(&game).join("config/BepInEx.cfg").is_file());
        assert!(game.join("fm.exe").is_file());
        std::fs::remove_dir_all(game).ok();
    }

    #[test]
    fn jamais_par_dessus_un_autre_bepinex() {
        let game = fake_game();
        std::fs::write(game.join("winhttp.dll"), b"autre mod").unwrap();
        let st = status(&game);
        assert!(st.present && !st.ours);
        assert!(matches!(install_from(&fake_zip(), &game), Err(BepinexError::AlreadyPresent)));
        assert!(matches!(uninstall(&game), Err(BepinexError::NotOurs)));
        assert_eq!(std::fs::read(game.join("winhttp.dll")).unwrap(), b"autre mod");
        std::fs::remove_dir_all(game).ok();
    }

    #[test]
    fn aucun_fichier_ecrase() {
        let game = fake_game();
        std::fs::create_dir_all(game.join("dotnet")).unwrap();
        std::fs::write(game.join("dotnet/coreclr.dll"), b"existant").unwrap();
        assert!(matches!(extract(&fake_zip(), &game), Err(BepinexError::Conflict(_))));
        assert!(!game.join("winhttp.dll").exists());
        assert_eq!(std::fs::read(game.join("dotnet/coreclr.dll")).unwrap(), b"existant");
        std::fs::remove_dir_all(game).ok();
    }

    /// Archive réelle (34 Mo), si elle a été téléchargée à côté : `FMI_BEPINEX_ZIP=… cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn archive_officielle() {
        let path = std::env::var("FMI_BEPINEX_ZIP").expect("FMI_BEPINEX_ZIP");
        let bytes = std::fs::read(path).unwrap();
        assert!(checksum_ok(&bytes));
        let game = fake_game();
        let st = install_from(&bytes, &game).unwrap();
        assert!(st.ours && st.first_launch);
        assert!(game.join("winhttp.dll").is_file() && game.join("BepInEx/core/BepInEx.Unity.IL2CPP.dll").is_file());
        let st = uninstall(&game).unwrap();
        assert!(!st.present);
        let left: Vec<_> = std::fs::read_dir(&game).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("fm.exe")]);
        std::fs::remove_dir_all(game).ok();
    }
}
