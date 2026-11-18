//! Photos de situation : téléchargement du moteur d'images (ComfyUI portable, Qwen Image Edit 2511, OWLv2).
//!
//! Rien n'est téléchargé sans clic du joueur. Le manifeste est embarqué dans l'exe (`photos-manifest.json`) :
//! chaque fichier a une adresse épinglée (révision Hugging Face ou tag GitHub), sa taille et son SHA-256.
//! Réseau : seulement les dépôts listés dans `ALLOWED_PREFIXES`. Un téléchargement interrompu reprend où il
//! s'était arrêté (en-tête `Range` sur le fichier `.part`) ; le SHA-256 est contrôlé avant de garder le fichier ;
//! l'ensemble (~34 Go) se supprime en un clic. L'extraction de ComfyUI et le lancement viennent à l'étape suivante.

use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{Emitter, Manager};

const MANIFEST_JSON: &str = include_str!("../photos-manifest.json");

/// Seules adresses acceptées : les dépôts dont le manifeste épingle une révision.
pub const ALLOWED_PREFIXES: &[&str] = &[
    "https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/",
    "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/",
    "https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/",
    "https://huggingface.co/google/owlv2-base-patch16-ensemble/resolve/",
    "https://github.com/Comfy-Org/ComfyUI/releases/download/",
];

/// Garde-fou : aucun fichier du manifeste ne dépasse 24 Go.
const MAX_FILE: u64 = 24 * 1024 * 1024 * 1024;
/// Sous-dossier de `%LOCALAPPDATA%\app.fmimmersion.desktop`.
pub const DIR_NAME: &str = "photos";

static CANCEL: AtomicBool = AtomicBool::new(false);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub name: String,
    /// « comfyui », « qwen » ou « owlv2 ».
    pub component: String,
    pub url: String,
    /// Chemin relatif au dossier des photos (séparateur `/`).
    pub dest: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    pub comfyui_version: String,
    pub files: Vec<ManifestFile>,
}

impl Manifest {
    pub fn total(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PhotosError {
    #[error("réseau : {0}")]
    Network(String),
    #[error("manifeste : {0}")]
    Manifest(String),
    #[error("fichier corrompu ({0}) : il a été supprimé, relance le téléchargement")]
    Corrupt(String),
    #[error("téléchargement arrêté")]
    Cancelled,
    #[error("un téléchargement est déjà en cours")]
    Busy,
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for PhotosError {
    fn from(e: std::io::Error) -> Self {
        PhotosError::Io(e.to_string())
    }
}

impl Serialize for PhotosError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn net(e: impl std::fmt::Display) -> PhotosError {
    PhotosError::Network(e.to_string())
}

pub fn parse_manifest(text: &str) -> Result<Manifest, PhotosError> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| PhotosError::Manifest(e.to_string()))?;
    for f in &m.files {
        if !url_allowed(&f.url) {
            return Err(PhotosError::Manifest(format!("adresse refusée : {}", f.url)));
        }
        if f.size == 0 || f.size > MAX_FILE {
            return Err(PhotosError::Manifest(format!("taille invalide : {}", f.name)));
        }
        if f.sha256.len() != 64 || !f.sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(PhotosError::Manifest(format!("empreinte invalide : {}", f.name)));
        }
        if !dest_ok(&f.dest) {
            return Err(PhotosError::Manifest(format!("chemin refusé : {}", f.dest)));
        }
    }
    Ok(m)
}

/// Manifeste embarqué dans l'exe, lu une fois.
pub fn manifest() -> &'static Manifest {
    static M: OnceLock<Manifest> = OnceLock::new();
    M.get_or_init(|| parse_manifest(MANIFEST_JSON).expect("photos-manifest.json invalide (contrôlé par les tests)"))
}

pub fn url_allowed(url: &str) -> bool {
    ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p)) && !url.contains("..") && !url.contains('@') && !url.contains('?')
}

/// Chemin relatif sûr : pas d'absolu, pas de `..`, pas d'antislash, pas de segment vide.
pub fn dest_ok(dest: &str) -> bool {
    !dest.is_empty()
        && !dest.starts_with('/')
        && !dest.contains('\\')
        && !dest.contains(':')
        && dest.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

pub fn dest_path(dir: &Path, f: &ManifestFile) -> PathBuf {
    let mut p = dir.to_path_buf();
    for seg in f.dest.split('/') {
        p.push(seg);
    }
    p
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

// ------------------------------------------------------------------ état

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub name: String,
    pub component: String,
    pub size: u64,
    /// Octets déjà sur le disque (fichier complet ou `.part`).
    pub on_disk: u64,
    /// « ready », « partial » ou « missing ».
    pub state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub dir: String,
    pub manifest_version: String,
    pub comfyui_version: String,
    pub total: u64,
    pub on_disk: u64,
    /// Tous les fichiers du manifeste sont complets.
    pub ready: bool,
    pub downloading: bool,
    pub files: Vec<FileStatus>,
}

fn file_status(dir: &Path, f: &ManifestFile) -> FileStatus {
    // L'archive de ComfyUI est supprimée une fois extraite : le marqueur d'installation vaut fichier complet.
    if f.component == "comfyui" && crate::photos_engine::layout(dir).is_some() {
        return FileStatus { name: f.name.clone(), component: f.component.clone(), size: f.size, on_disk: f.size, state: "ready" };
    }
    let dest = dest_path(dir, f);
    let (on_disk, state) = match std::fs::metadata(&dest).map(|m| m.len()) {
        Ok(len) if len == f.size => (f.size, "ready"),
        _ => match std::fs::metadata(part_path(&dest)).map(|m| m.len()) {
            Ok(len) if len > 0 && len < f.size => (len, "partial"),
            _ => (0, "missing"),
        },
    };
    FileStatus { name: f.name.clone(), component: f.component.clone(), size: f.size, on_disk, state }
}

pub fn status(dir: &Path, m: &Manifest) -> Status {
    let files: Vec<FileStatus> = m.files.iter().map(|f| file_status(dir, f)).collect();
    Status {
        dir: dir.display().to_string(),
        manifest_version: m.version.clone(),
        comfyui_version: m.comfyui_version.clone(),
        total: m.total(),
        on_disk: files.iter().map(|f| f.on_disk).sum(),
        ready: files.iter().all(|f| f.state == "ready"),
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        files,
    }
}

// ------------------------------------------------------------------ téléchargement

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(20))
        .timeout_read(std::time::Duration::from_secs(60))
        .timeout_write(std::time::Duration::from_secs(60))
        .user_agent("FM Immersion")
        .build()
}

fn sha256_file(path: &Path) -> Result<String, PhotosError> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Contrôle le `.part` complet (taille et SHA-256) puis le renomme en fichier final. En cas d'écart, le `.part`
/// est supprimé pour repartir de zéro.
fn finish_part(part: &Path, dest: &Path, f: &ManifestFile) -> Result<(), PhotosError> {
    let len = std::fs::metadata(part)?.len();
    if len != f.size {
        std::fs::remove_file(part).ok();
        return Err(PhotosError::Corrupt(format!("{} : taille {len} au lieu de {}", f.name, f.size)));
    }
    if sha256_file(part)? != f.sha256 {
        std::fs::remove_file(part).ok();
        return Err(PhotosError::Corrupt(format!("{} : empreinte SHA-256 différente", f.name)));
    }
    std::fs::remove_file(dest).ok();
    std::fs::rename(part, dest)?;
    Ok(())
}

/// Télécharge un fichier du manifeste dans `dir`, en reprenant un `.part` existant. `progress(reçu, total)`.
pub fn download_file(dir: &Path, f: &ManifestFile, progress: &dyn Fn(u64, u64)) -> Result<(), PhotosError> {
    if !url_allowed(&f.url) {
        return Err(PhotosError::Manifest("adresse de téléchargement refusée".into()));
    }
    download_file_from(dir, f, &f.url, progress)
}

/// Même chose sans le contrôle d'adresse (les tests servent les octets depuis un serveur local).
fn download_file_from(dir: &Path, f: &ManifestFile, url: &str, progress: &dyn Fn(u64, u64)) -> Result<(), PhotosError> {
    let dest = dest_path(dir, f);
    if std::fs::metadata(&dest).map(|m| m.len()).ok() == Some(f.size) {
        progress(f.size, f.size);
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = part_path(&dest);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have >= f.size {
        // Un .part complet d'une session précédente, ou plus gros que prévu : on le contrôle ou on repart.
        if have == f.size {
            return finish_part(&part, &dest, f);
        }
        std::fs::remove_file(&part).ok();
        have = 0;
    }

    let agent = agent();
    // Deux essais au plus : le second si le serveur ignore la reprise (réponse 200 au lieu de 206).
    for _attempt in 0..2 {
        let mut req = agent.get(url).set("Accept", "application/octet-stream, */*");
        if have > 0 {
            req = req.set("Range", &format!("bytes={have}-"));
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(416, _)) => {
                // Plage impossible : le .part ne correspond plus au fichier distant.
                std::fs::remove_file(&part).ok();
                have = 0;
                continue;
            }
            Err(e) => return Err(net(e)),
        };
        let resumed = resp.status() == 206;
        if have > 0 && !resumed {
            std::fs::remove_file(&part).ok();
            have = 0;
        }
        // Taille annoncée : Content-Range (reprise) ou Content-Length (début).
        let announced = if resumed {
            resp.header("Content-Range").and_then(|v| v.rsplit('/').next()).and_then(|t| t.parse::<u64>().ok())
        } else {
            resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok())
        };
        if let Some(t) = announced {
            if t != f.size {
                return Err(PhotosError::Manifest(format!("{} : le serveur annonce {t} octets au lieu de {}", f.name, f.size)));
            }
        }

        let mut out = std::io::BufWriter::new(std::fs::OpenOptions::new().create(true).append(true).open(&part)?);
        let mut reader = resp.into_reader().take(f.size - have);
        let mut buf = vec![0u8; 1 << 20];
        let mut last = have;
        progress(have, f.size);
        loop {
            if CANCEL.load(Ordering::SeqCst) {
                out.flush()?;
                return Err(PhotosError::Cancelled);
            }
            let n = match reader.read(&mut buf) {
                Ok(n) => n,
                Err(e) => {
                    // Connexion coupée : le .part reste pour reprendre plus tard.
                    out.flush()?;
                    return Err(net(e));
                }
            };
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            have += n as u64;
            if have - last >= 4 << 20 {
                last = have;
                progress(have, f.size);
            }
        }
        out.flush()?;
        drop(out);
        if have < f.size {
            return Err(PhotosError::Network(format!("{} : connexion interrompue à {have} octets", f.name)));
        }
        progress(have, f.size);
        return finish_part(&part, &dest, f);
    }
    Err(PhotosError::Network("reprise impossible".into()))
}

/// Télécharge tout ce qui manque, dans l'ordre du manifeste. `progress(fichier, reçu pour ce fichier, déjà sur
/// le disque au total)`.
pub fn download_all(dir: &Path, m: &Manifest, progress: &dyn Fn(&ManifestFile, u64, u64)) -> Result<(), PhotosError> {
    let mut done: u64 = m.files.iter().filter(|f| file_status(dir, f).state == "ready").map(|f| f.size).sum();
    for f in &m.files {
        if file_status(dir, f).state == "ready" {
            continue;
        }
        download_file(dir, f, &|received, _| progress(f, received, done + received))?;
        done += f.size;
    }
    Ok(())
}

/// Supprime tout le moteur (archive, modèles, fichiers partiels).
pub fn remove(dir: &Path) -> Result<(), PhotosError> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ commandes Tauri

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub name: String,
    pub component: String,
    pub received: u64,
    pub size: u64,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

// ------------------------------------------------------------------ emplacement du dossier

/// Fichier texte à côté du dossier par défaut : le chemin choisi par le joueur (34 Go, souvent sur un autre disque).
pub const LOCATION_FILE: &str = "photos-dir.txt";

/// Dossier des photos à partir du dossier de données de l'appli : celui du fichier d'emplacement s'il est
/// renseigné et absolu, sinon `photos/` à côté.
pub fn resolve_dir(app_data: &Path) -> PathBuf {
    if let Ok(text) = std::fs::read_to_string(app_data.join(LOCATION_FILE)) {
        let chosen = text.trim();
        if !chosen.is_empty() {
            let p = PathBuf::from(chosen);
            if p.is_absolute() {
                return p;
            }
        }
    }
    app_data.join(DIR_NAME)
}

/// Un dossier est « à nous » s'il est vide, absent, ou contient déjà un dossier du moteur.
fn is_ours(dir: &Path) -> std::io::Result<bool> {
    if !dir.exists() {
        return Ok(true);
    }
    if !dir.is_dir() {
        return Ok(false);
    }
    if std::fs::read_dir(dir)?.next().is_none() {
        return Ok(true);
    }
    Ok(["models", "comfyui", "library", "scripts"].iter().any(|d| dir.join(d).is_dir()) || dir.join("comfyui.log").is_file())
}

/// Vérifie le dossier demandé : absolu, pas la racine d'un disque, vide ou déjà à nous (il sera supprimé
/// entièrement par « Tout supprimer »). Renvoie le chemin nettoyé.
pub fn validate_target(dir: &str) -> Result<PathBuf, PhotosError> {
    let p = PathBuf::from(dir.trim().trim_end_matches(['\\', '/']));
    if !p.is_absolute() || p.parent().is_none() || p.file_name().is_none() {
        return Err(PhotosError::Io("dossier invalide : donne un chemin complet, pas la racine d'un disque (par exemple D:\\FM Immersion\\photos)".into()));
    }
    if !is_ours(&p)? {
        return Err(PhotosError::Io("ce dossier n'est pas vide : choisis un dossier vide ou nouveau".into()));
    }
    Ok(p)
}

fn dir_size(dir: &Path) -> std::io::Result<u64> {
    let mut total = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        total += if meta.is_dir() { dir_size(&entry.path())? } else { meta.len() };
    }
    Ok(total)
}

fn copy_tree(from: &Path, to: &Path, done: &mut u64, total: u64, progress: &dyn Fn(u64, u64)) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst, done, total, progress)?;
            continue;
        }
        let mut r = std::fs::File::open(&src)?;
        let mut w = std::io::BufWriter::new(std::fs::File::create(&dst)?);
        let mut buf = vec![0u8; 4 << 20];
        let mut last = *done;
        loop {
            let n = r.read(&mut buf)?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n])?;
            *done += n as u64;
            if *done - last >= 64 << 20 {
                last = *done;
                progress(*done, total);
            }
        }
        w.flush()?;
    }
    Ok(())
}

/// Déplace le dossier des photos : renommage quand c'est le même disque, sinon copie fichier par fichier
/// (`progress(octets copiés, total)`) puis suppression de l'ancien. Sans ancien dossier, crée le nouveau.
pub fn move_dir(from: &Path, to: &Path, progress: &dyn Fn(u64, u64)) -> std::io::Result<()> {
    if from == to {
        return Ok(());
    }
    if !from.is_dir() {
        return std::fs::create_dir_all(to);
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if to.exists() && std::fs::read_dir(to)?.next().is_none() {
        std::fs::remove_dir(to)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let total = dir_size(from)?;
    let mut done = 0;
    copy_tree(from, to, &mut done, total, progress)?;
    progress(total, total);
    std::fs::remove_dir_all(from)
}

/// Dossier des photos sur ce PC (voir `resolve_dir`).
pub fn photos_dir(app: &tauri::AppHandle) -> Result<PathBuf, PhotosError> {
    Ok(resolve_dir(&app.path().app_local_data_dir().map_err(|e| PhotosError::Io(e.to_string()))?))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveProgress {
    pub done: u64,
    pub total: u64,
}

/// Change le dossier du moteur (sur clic du joueur) et y déplace ce qui est déjà téléchargé. Émet « photos-move ».
#[tauri::command]
pub async fn photos_set_dir(app: tauri::AppHandle, dir: String) -> Result<Status, PhotosError> {
    if DOWNLOADING.load(Ordering::SeqCst) || crate::photos_pipeline::is_busy() {
        return Err(PhotosError::Busy);
    }
    let app_data = app.path().app_local_data_dir().map_err(|e| PhotosError::Io(e.to_string()))?;
    let from = resolve_dir(&app_data);
    let to = validate_target(&dir)?;
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::photos_engine::stop();
        move_dir(&from, &to, &|done, total| {
            emitter.emit("photos-move", MoveProgress { done, total }).ok();
        })?;
        std::fs::create_dir_all(&app_data)?;
        let location = app_data.join(LOCATION_FILE);
        if to == app_data.join(DIR_NAME) {
            std::fs::remove_file(&location).ok();
        } else {
            std::fs::write(&location, to.to_string_lossy().as_bytes())?;
        }
        Ok(status(&to, manifest()))
    })
    .await
    .map_err(|e| PhotosError::Io(e.to_string()))?
}

#[tauri::command]
pub async fn photos_remote_status(app: tauri::AppHandle) -> Result<Status, PhotosError> {
    let dir = photos_dir(&app)?;
    Ok(status(&dir, manifest()))
}

/// Télécharge ce qui manque (sur clic du joueur). Émet « photos-download » au fil des octets.
#[tauri::command]
pub async fn photos_remote_download(app: tauri::AppHandle) -> Result<Status, PhotosError> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err(PhotosError::Busy);
    }
    CANCEL.store(false, Ordering::SeqCst);
    let dir = photos_dir(&app)?;
    let emitter = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let m = manifest();
        let total = m.total();
        download_all(&dir, m, &|f, received, done| {
            emitter
                .emit(
                    "photos-download",
                    DownloadProgress {
                        name: f.name.clone(),
                        component: f.component.clone(),
                        received,
                        size: f.size,
                        done_bytes: done,
                        total_bytes: total,
                    },
                )
                .ok();
        })
        .map(|_| status(&dir, m))
    })
    .await
    .map_err(|e| PhotosError::Io(e.to_string()));
    DOWNLOADING.store(false, Ordering::SeqCst);
    result?
}

/// Arrête le téléchargement en cours ; le fichier partiel est gardé pour reprendre.
#[tauri::command]
pub async fn photos_remote_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn photos_remote_remove(app: tauri::AppHandle) -> Result<Status, PhotosError> {
    if DOWNLOADING.load(Ordering::SeqCst) {
        return Err(PhotosError::Busy);
    }
    let dir = photos_dir(&app)?;
    crate::photos_engine::stop();
    remove(&dir)?;
    Ok(status(&dir, manifest()))
}

// ------------------------------------------------------------------ vérification avant téléchargement

/// Vérification faite avant de lancer les ~34 Go (sur clic du joueur) : place libre sur le disque du dossier choisi et
/// carte graphique (nvidia-smi). Ne bloque rien : l'écran Photos montre les problèmes et le joueur décide.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Precheck {
    pub dir: String,
    /// Octets libres sur le disque du dossier (None si illisible).
    pub free_bytes: Option<u64>,
    /// Octets encore à écrire : téléchargement restant + extraction de ComfyUI.
    pub needed_bytes: u64,
    /// Nom et mémoire (Mio) de la carte NVIDIA qui en a le plus ; None sans carte NVIDIA lisible.
    pub gpu_name: Option<String>,
    pub vram_mib: Option<u64>,
}

/// Place nécessaire : ce qui reste à télécharger, plus ComfyUI une fois extrait s'il ne l'est pas encore (environ trois
/// fois la taille de l'archive : ~2 Go compressés, ~6 Go extraits).
pub fn needed_bytes(files: &[FileStatus], extracted: bool) -> u64 {
    let remaining: u64 = files.iter().map(|f| f.size.saturating_sub(f.on_disk)).sum();
    let extract: u64 = if extracted { 0 } else { files.iter().filter(|f| f.component == "comfyui").map(|f| f.size * 3).sum() };
    remaining + extract
}

/// Premier dossier existant en remontant depuis `dir` (le dossier du moteur n'existe pas avant le téléchargement).
fn existing_ancestor(dir: &Path) -> Option<&Path> {
    dir.ancestors().find(|p| p.is_dir())
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let base = existing_ancestor(dir)?;
    let wide: Vec<u16> = base.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_space(dir: &Path) -> Option<u64> {
    existing_ancestor(dir).map(|_| u64::MAX)
}

#[tauri::command]
pub async fn photos_precheck(app: tauri::AppHandle) -> Result<Precheck, PhotosError> {
    let dir = photos_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let s = status(&dir, manifest());
        let gpu = crate::photos_engine::gpu_info();
        Precheck {
            dir: s.dir.clone(),
            free_bytes: free_space(&dir),
            needed_bytes: needed_bytes(&s.files, crate::photos_engine::layout(&dir).is_some()),
            gpu_name: gpu.as_ref().map(|g| g.0.clone()),
            vram_mib: gpu.map(|g| g.1),
        }
    })
    .await
    .map_err(|e| PhotosError::Io(e.to_string()))
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    fn tmp(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fmi-photos-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn fichier(data: &[u8], dest: &str) -> ManifestFile {
        ManifestFile {
            name: "essai.bin".into(),
            component: "qwen".into(),
            url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/abc/essai.bin".into(),
            dest: dest.into(),
            size: data.len() as u64,
            sha256: hex(data),
        }
    }

    #[test]
    fn place_necessaire() {
        let f = |component: &str, size: u64, on_disk: u64| FileStatus { name: "x".into(), component: component.into(), size, on_disk, state: "partial" };
        let files = vec![f("comfyui", 2_000, 500), f("qwen", 10_000, 4_000), f("owlv2", 1_000, 1_000)];
        // restant 1 500 + 6 000 + 0, extraction de ComfyUI 3 x 2 000
        assert_eq!(needed_bytes(&files, false), 13_500);
        assert_eq!(needed_bytes(&files, true), 7_500);
        assert_eq!(existing_ancestor(&std::env::temp_dir().join("fmi-absent").join("photos")), Some(std::env::temp_dir().as_path()));
    }

    #[test]
    fn manifeste_embarque_valide() {
        let m = manifest();
        assert_eq!(m.files.len(), 13);
        assert!(m.total() > 33_000_000_000 && m.total() < 35_000_000_000, "total {}", m.total());
        let mut dests: Vec<&str> = m.files.iter().map(|f| f.dest.as_str()).collect();
        dests.sort();
        dests.dedup();
        assert_eq!(dests.len(), m.files.len(), "destinations en double");
        for f in &m.files {
            assert!(["comfyui", "qwen", "owlv2"].contains(&f.component.as_str()), "{}", f.component);
            assert!(f.url.ends_with(f.dest.rsplit('/').next().unwrap()), "{} / {}", f.url, f.dest);
        }
    }

    #[test]
    fn refuse_un_manifeste_douteux() {
        let base = r#"{"version":"x","comfyuiVersion":"v","files":[{"name":"a","component":"qwen","url":"URL","dest":"DEST","size":10,"sha256":"SHA"}]}"#;
        let ok_sha = "a".repeat(64);
        let bon = base
            .replace("URL", "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/abc/a")
            .replace("DEST", "models/a")
            .replace("SHA", &ok_sha);
        assert!(parse_manifest(&bon).is_ok());
        let mauvaise_adresse = bon.replace("huggingface.co/Comfy-Org", "huggingface.co/autre");
        assert!(matches!(parse_manifest(&mauvaise_adresse), Err(PhotosError::Manifest(_))));
        let mauvais_chemin = bon.replace("models/a", "../a");
        assert!(matches!(parse_manifest(&mauvais_chemin), Err(PhotosError::Manifest(_))));
        let mauvaise_empreinte = bon.replace(&ok_sha, "ABC");
        assert!(matches!(parse_manifest(&mauvaise_empreinte), Err(PhotosError::Manifest(_))));
    }

    #[test]
    fn adresses_autorisees() {
        assert!(url_allowed("https://github.com/Comfy-Org/ComfyUI/releases/download/v0.44.0/x.7z"));
        assert!(url_allowed("https://huggingface.co/google/owlv2-base-patch16-ensemble/resolve/cfd3/config.json"));
        assert!(!url_allowed("https://huggingface.co/quelquun/Qwen-Image_ComfyUI/resolve/abc/a"));
        assert!(!url_allowed("http://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/abc/a"));
        assert!(!url_allowed("https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/../x"));
        assert!(!url_allowed("https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/abc/a?download=1"));
    }

    #[test]
    fn chemins_de_destination_surs() {
        assert!(dest_ok("models/vae/qwen_image_vae.safetensors"));
        assert!(!dest_ok("/etc/passwd"));
        assert!(!dest_ok("C:/x"));
        assert!(!dest_ok("models/../x"));
        assert!(!dest_ok("models\\x"));
        assert!(!dest_ok("models//x"));
        assert!(!dest_ok(""));
    }

    #[test]
    fn statut_pret_partiel_manquant() {
        let dir = tmp("statut");
        let data = vec![7u8; 5000];
        let m = Manifest {
            version: "t".into(),
            comfyui_version: "v".into(),
            files: vec![fichier(&data, "a/complet.bin"), fichier(&data, "a/partiel.bin"), fichier(&data, "a/absent.bin")],
        };
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("a/complet.bin"), &data).unwrap();
        std::fs::write(dir.join("a/partiel.bin.part"), &data[..1200]).unwrap();
        let s = status(&dir, &m);
        assert_eq!(s.files.iter().map(|f| f.state).collect::<Vec<_>>(), vec!["ready", "partial", "missing"]);
        assert_eq!(s.on_disk, 5000 + 1200);
        assert_eq!(s.total, 15000);
        assert!(!s.ready);
        remove(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn emplacement_choisi_ou_par_defaut() {
        let base = tmp("emplacement");
        assert_eq!(resolve_dir(&base), base.join(DIR_NAME));
        std::fs::write(base.join(LOCATION_FILE), "   \n").unwrap();
        assert_eq!(resolve_dir(&base), base.join(DIR_NAME));
        std::fs::write(base.join(LOCATION_FILE), "relatif/photos").unwrap();
        assert_eq!(resolve_dir(&base), base.join(DIR_NAME));
        let ailleurs = base.join("ailleurs");
        std::fs::write(base.join(LOCATION_FILE), format!("{}\n", ailleurs.display())).unwrap();
        assert_eq!(resolve_dir(&base), ailleurs);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dossier_cible_controle() {
        let base = tmp("cible");
        assert!(validate_target("relatif").is_err());
        assert!(validate_target("/").is_err());
        // Nouveau dossier : accepté, barre finale retirée.
        let neuf = base.join("neuf");
        assert_eq!(validate_target(&format!("{}/", neuf.display())).unwrap(), neuf);
        // Dossier plein qui n'est pas à nous : refusé.
        let plein = base.join("plein");
        std::fs::create_dir_all(&plein).unwrap();
        std::fs::write(plein.join("perso.txt"), b"x").unwrap();
        assert!(validate_target(&plein.display().to_string()).is_err());
        // Dossier du moteur déjà là : accepté.
        std::fs::create_dir_all(plein.join("models")).unwrap();
        assert!(validate_target(&plein.display().to_string()).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn deplacement_renomme_ou_copie() {
        let base = tmp("deplacer");
        let from = base.join("a");
        std::fs::create_dir_all(from.join("models").join("x")).unwrap();
        std::fs::write(from.join("models").join("x").join("m.bin"), vec![7u8; 3000]).unwrap();
        std::fs::write(from.join("comfyui.log"), b"log").unwrap();
        let to = base.join("b").join("photos");
        move_dir(&from, &to, &|_, _| {}).unwrap();
        assert!(!from.exists());
        assert_eq!(std::fs::read(to.join("models").join("x").join("m.bin")).unwrap().len(), 3000);
        // Copie fichier par fichier : même résultat.
        let c = base.join("c");
        let mut done = 0;
        let total = dir_size(&to).unwrap();
        assert_eq!(total, 3003);
        copy_tree(&to, &c, &mut done, total, &|_, _| {}).unwrap();
        assert_eq!(done, 3003);
        assert_eq!(std::fs::read(c.join("comfyui.log")).unwrap(), b"log");
        // Sans ancien dossier : le nouveau est créé vide.
        let d = base.join("d");
        move_dir(&base.join("absent"), &d, &|_, _| {}).unwrap();
        assert!(d.is_dir());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn un_part_corrompu_est_supprime() {
        let dir = tmp("corrompu");
        let data = vec![1u8; 3000];
        let f = fichier(&data, "x.bin");
        let dest = dest_path(&dir, &f);
        let part = part_path(&dest);
        std::fs::write(&part, vec![2u8; 3000]).unwrap();
        assert!(matches!(finish_part(&part, &dest, &f), Err(PhotosError::Corrupt(_))));
        assert!(!part.exists() && !dest.exists());
        std::fs::write(&part, &data).unwrap();
        finish_part(&part, &dest, &f).unwrap();
        assert!(dest.exists() && !part.exists());
        remove(&dir).unwrap();
    }

    /// Petit serveur HTTP : sert `data`, avec ou sans prise en compte de l'en-tête Range. Note chaque requête.
    fn serveur(data: Vec<u8>, honore_range: bool, requetes: usize) -> (String, std::thread::JoinHandle<Vec<Option<u64>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let mut vues = Vec::new();
            for _ in 0..requetes {
                let (mut stream, _) = listener.accept().unwrap();
                let mut range = None;
                {
                    let mut r = BufReader::new(&stream);
                    loop {
                        let mut line = String::new();
                        if r.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                        if let Some(v) = line.strip_prefix("Range: bytes=") {
                            range = v.trim().trim_end_matches('-').parse::<u64>().ok();
                        }
                    }
                }
                vues.push(range);
                let total = data.len();
                let (status, body, extra) = match range {
                    Some(from) if honore_range => (
                        "206 Partial Content",
                        &data[from as usize..],
                        format!("Content-Range: bytes {from}-{}/{total}\r\n", total - 1),
                    ),
                    _ => ("200 OK", &data[..], String::new()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            }
            vues
        });
        (format!("http://127.0.0.1:{port}/"), h)
    }

    fn fichier_local(data: &[u8], url: &str) -> ManifestFile {
        let mut f = fichier(data, "m/reprise.bin");
        f.url = url.to_string();
        f
    }

    /// Les adresses de test sont locales : on appelle la fonction interne, sans le contrôle d'adresse.
    fn telecharger(dir: &Path, f: &ManifestFile) -> Result<(), PhotosError> {
        download_file_from(dir, f, &f.url, &|_, _| {})
    }

    #[test]
    fn refuse_une_adresse_hors_liste() {
        let dir = tmp("adresse");
        let f = fichier_local(b"abc", "https://exemple.org/x.bin");
        assert!(matches!(download_file(&dir, &f, &|_, _| {}), Err(PhotosError::Manifest(_))));
        remove(&dir).unwrap();
    }

    #[test]
    fn reprend_un_telechargement_interrompu() {
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let (url, serveur) = serveur(data.clone(), true, 1);
        let dir = tmp("reprise");
        let f = fichier_local(&data, &format!("{url}reprise.bin"));
        let dest = dest_path(&dir, &f);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(part_path(&dest), &data[..100_000]).unwrap();
        telecharger(&dir, &f).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert_eq!(serveur.join().unwrap(), vec![Some(100_000)]);
        remove(&dir).unwrap();
    }

    #[test]
    fn repart_de_zero_si_le_serveur_ignore_la_reprise() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 13) as u8).collect();
        let (url, serveur) = serveur(data.clone(), false, 1);
        let dir = tmp("sans-range");
        let f = fichier_local(&data, &format!("{url}reprise.bin"));
        let dest = dest_path(&dir, &f);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(part_path(&dest), vec![9u8; 50_000]).unwrap();
        telecharger(&dir, &f).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert_eq!(serveur.join().unwrap(), vec![Some(50_000)]);
        remove(&dir).unwrap();
    }

    #[test]
    fn refuse_un_fichier_dont_l_empreinte_differe() {
        let data = vec![4u8; 70_000];
        let (url, serveur) = serveur(data.clone(), true, 1);
        let dir = tmp("faux");
        let mut f = fichier_local(&data, &format!("{url}reprise.bin"));
        f.sha256 = "0".repeat(64);
        assert!(matches!(telecharger(&dir, &f), Err(PhotosError::Corrupt(_))));
        assert!(!dest_path(&dir, &f).exists() && !part_path(&dest_path(&dir, &f)).exists());
        serveur.join().unwrap();
        remove(&dir).unwrap();
    }
}
