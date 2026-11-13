//! Moteur des photos de situation : ComfyUI portable, extrait de l'archive téléchargée par `photos_remote`,
//! lancé en processus annexe sur un port local libre, piloté par son API HTTP (`/prompt`, `/history`).
//!
//! Tout reste sur le PC : ComfyUI est lancé avec `--listen 127.0.0.1`, `--offline`, sans nœud tiers, et son
//! dossier de base est celui des photos (`%LOCALAPPDATA%\app.fmimmersion.desktop\photos`) : les modèles y sont déjà
//! rangés par le téléchargeur (`models/diffusion_models`, `models/text_encoders`, `models/vae`, `models/loras`).
//! Le processus est arrêté à la fermeture de l'appli.

use crate::photos_remote::{self, PhotosError};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Sous-dossier du dossier des photos où l'archive est extraite.
pub const ENGINE_SUBDIR: &str = "comfyui";
/// Écrit à la fin d'une extraction réussie ; décrit où sont python et main.py.
pub const INSTALLED_MARKER: &str = "fm-immersion-installed.json";
const LOG_FILE: &str = "comfyui.log";
/// Garde-fou sur la taille totale décompressée (l'archive fait ~2 Go, ~6 Go une fois extraite).
const MAX_EXTRACTED: u64 = 24 * 1024 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(180);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(900);

static ENGINE: Mutex<Option<Running>> = Mutex::new(None);

struct Running {
    child: Child,
    port: u16,
}

/// Emplacement de ComfyUI après extraction (chemins relatifs au dossier `comfyui/`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub comfyui_version: String,
    pub python: String,
    pub main: String,
    pub extracted_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// Archive extraite, python et main.py trouvés.
    pub installed: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub comfyui_version: Option<String>,
    pub log: String,
}

fn io(e: impl std::fmt::Display) -> PhotosError {
    PhotosError::Io(e.to_string())
}

pub fn engine_dir(photos_dir: &Path) -> PathBuf {
    photos_dir.join(ENGINE_SUBDIR)
}

pub fn layout(photos_dir: &Path) -> Option<Layout> {
    let text = std::fs::read_to_string(engine_dir(photos_dir).join(INSTALLED_MARKER)).ok()?;
    let l: Layout = serde_json::from_str(&text).ok()?;
    let root = engine_dir(photos_dir);
    (root.join(&l.python).is_file() && root.join(&l.main).is_file()).then_some(l)
}

/// Chemin relatif sûr tiré d'un nom d'entrée d'archive : séparateurs normalisés, pas de `..`, d'absolu ni de lecteur.
pub fn safe_entry_path(name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.is_empty() || name.starts_with('/') || name.contains(':') {
        return None;
    }
    let mut p = PathBuf::new();
    for seg in name.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None,
            s => p.push(s),
        }
    }
    (!p.as_os_str().is_empty()).then_some(p)
}

/// Cherche `python_embeded/python.exe` et `ComfyUI/main.py` sous `root` (un seul niveau de dossier racine toléré).
fn find_layout(root: &Path) -> Option<(String, String)> {
    let mut bases = vec![PathBuf::new()];
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                bases.push(PathBuf::from(e.file_name()));
            }
        }
    }
    for b in bases {
        let python = b.join("python_embeded").join("python.exe");
        let main = b.join("ComfyUI").join("main.py");
        if root.join(&python).is_file() && root.join(&main).is_file() {
            return Some((python.to_string_lossy().replace('\\', "/"), main.to_string_lossy().replace('\\', "/")));
        }
    }
    None
}

/// Vide `dir` d'une extraction précédente en gardant `keep` : l'archive téléchargée est rangée dans ce même dossier
/// (`comfyui/…​.7z`), la supprimer avec le reste la rendait introuvable au moment de l'ouvrir.
fn clear_dir_except(dir: &Path, keep: &Path) -> std::io::Result<()> {
    let keep = keep.canonicalize().unwrap_or_else(|_| keep.to_path_buf());
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.canonicalize().map(|p| p == keep).unwrap_or(false) {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Extrait l'archive 7z dans `comfyui/` (vidé d'abord, archive gardée), puis écrit le marqueur. `progress(octets écrits, total)`.
pub fn extract(archive: &Path, photos_dir: &Path, comfyui_version: &str, progress: &dyn Fn(u64, u64)) -> Result<Layout, PhotosError> {
    let target = engine_dir(photos_dir);
    std::fs::create_dir_all(&target)?;
    clear_dir_except(&target, archive)?;

    let mut reader = sevenz_rust2::ArchiveReader::open(archive, sevenz_rust2::Password::empty()).map_err(|e| PhotosError::Corrupt(format!("archive ComfyUI illisible : {e}")))?;
    let total: u64 = reader.archive().files.iter().filter(|f| f.has_stream()).map(|f| f.size()).sum();
    if total == 0 || total > MAX_EXTRACTED {
        return Err(PhotosError::Corrupt(format!("archive ComfyUI : taille décompressée invalide ({total} octets)")));
    }
    let (mut written, mut last) = (0u64, 0u64);
    let mut buf = vec![0u8; 1 << 20];
    reader
        .for_each_entries(|entry, r| {
            let rel = safe_entry_path(entry.name()).ok_or_else(|| sevenz_rust2::Error::from(std::io::Error::other(format!("chemin refusé dans l'archive : {}", entry.name()))))?;
            let dest = target.join(rel);
            if entry.is_directory() {
                std::fs::create_dir_all(&dest)?;
                return Ok(true);
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::io::BufWriter::new(std::fs::File::create(&dest)?);
            loop {
                let n = r.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])?;
                written += n as u64;
                if written - last >= 8 << 20 {
                    last = written;
                    progress(written, total);
                }
            }
            out.flush()?;
            Ok(true)
        })
        .map_err(|e| PhotosError::Corrupt(format!("extraction de ComfyUI échouée : {e}")))?;
    progress(total, total);

    let (python, main) = find_layout(&target).ok_or_else(|| PhotosError::Corrupt("archive ComfyUI : python_embeded/python.exe ou ComfyUI/main.py introuvable".into()))?;
    let l = Layout {
        comfyui_version: comfyui_version.to_string(),
        python,
        main,
        extracted_at: chrono_now(),
    };
    std::fs::write(target.join(INSTALLED_MARKER), serde_json::to_string_pretty(&l).map_err(io)?)?;
    Ok(l)
}

/// Date ISO 8601 (UTC, à la seconde) sans dépendance supplémentaire.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Algorithme civil de Howard Hinnant.
    let days = (secs / 86400) as i64;
    let (h, m, s) = ((secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

// ------------------------------------------------------------------ processus

fn free_port() -> Result<u16, PhotosError> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

/// Arguments de lancement de ComfyUI : local, hors ligne, sans nœuds tiers, dossier de base = dossier des photos.
pub fn launch_args(main: &str, port: u16, photos_dir: &Path) -> Vec<String> {
    vec![
        "-s".into(),
        main.into(),
        "--listen".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--base-directory".into(),
        photos_dir.to_string_lossy().into_owned(),
        "--disable-auto-launch".into(),
        "--dont-print-server".into(),
        "--offline".into(),
        "--disable-assets".into(),
        "--disable-all-custom-nodes".into(),
        "--disable-metadata".into(),
        "--fast-disk".into(),
        "--disable-pinned-memory".into(),
    ]
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(30))
        .build()
}

fn alive(port: u16) -> bool {
    agent().get(&format!("http://127.0.0.1:{port}/system_stats")).call().is_ok()
}

fn log_tail(photos_dir: &Path) -> String {
    let text = std::fs::read_to_string(photos_dir.join(LOG_FILE)).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.len().saturating_sub(40);
    lines[from..].join("\n")
}

/// Lance ComfyUI s'il ne tourne pas déjà, attend qu'il réponde, renvoie son port.
pub fn start(photos_dir: &Path) -> Result<u16, PhotosError> {
    let mut guard = ENGINE.lock().map_err(|_| io("verrou du moteur"))?;
    if let Some(r) = guard.as_mut() {
        match r.child.try_wait() {
            Ok(None) if alive(r.port) => return Ok(r.port),
            _ => {
                r.child.kill().ok();
                *guard = None;
            }
        }
    }
    let l = layout(photos_dir).ok_or_else(|| PhotosError::Io("moteur non installé : télécharge puis installe-le d'abord".into()))?;
    let root = engine_dir(photos_dir);
    let port = free_port()?;
    for sub in ["input", "output", "temp", "user"] {
        std::fs::create_dir_all(photos_dir.join(sub))?;
    }
    let log = std::fs::File::create(photos_dir.join(LOG_FILE))?;
    let mut cmd = Command::new(root.join(&l.python));
    cmd.args(launch_args(&root.join(&l.main).to_string_lossy(), port, photos_dir))
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| PhotosError::Io(format!("lancement de ComfyUI impossible : {e}")))?;
    tie_to_app(&child);

    let started = Instant::now();
    loop {
        if alive(port) {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(PhotosError::Io(format!("ComfyUI s'est arrêté au démarrage ({status}).\n{}", log_tail(photos_dir))));
        }
        if started.elapsed() > READY_TIMEOUT {
            child.kill().ok();
            return Err(PhotosError::Io(format!("ComfyUI ne répond pas après {} s.\n{}", READY_TIMEOUT.as_secs(), log_tail(photos_dir))));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    *guard = Some(Running { child, port });
    Ok(port)
}

/// Lie ComfyUI à l'appli : il est rangé dans un « job » Windows fermé avec le processus de l'appli, si bien que
/// Windows l'arrête même quand l'appli est fermée brutalement (gestionnaire des tâches, plantage), là où
/// `RunEvent::Exit` n'est pas appelé.
#[cfg(windows)]
fn tie_to_app(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // Le job reste ouvert toute la vie de l'appli (jamais fermé à la main) : sa fermeture par Windows tue le moteur.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as usize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

#[cfg(not(windows))]
fn tie_to_app(_child: &std::process::Child) {}

/// Arrête ComfyUI s'il tourne (appelé aussi à la fermeture de l'appli).
pub fn stop() {
    if let Ok(mut guard) = ENGINE.lock() {
        if let Some(mut r) = guard.take() {
            r.child.kill().ok();
            r.child.wait().ok();
        }
    }
}

fn running_port() -> Option<u16> {
    ENGINE.lock().ok().and_then(|g| g.as_ref().map(|r| r.port))
}

pub fn status(photos_dir: &Path) -> EngineStatus {
    let l = layout(photos_dir);
    let port = running_port();
    EngineStatus {
        installed: l.is_some(),
        running: port.is_some(),
        port,
        comfyui_version: l.map(|l| l.comfyui_version),
        log: log_tail(photos_dir),
    }
}

// ------------------------------------------------------------------ graphe et exécution

/// Noms des fichiers de modèles, tels que rangés par le téléchargeur (voir `photos-manifest.json`).
pub struct Models {
    pub unet: String,
    pub clip: String,
    pub vae: String,
    pub lora: String,
}

pub fn models_from_manifest(m: &photos_remote::Manifest) -> Option<Models> {
    let name = |folder: &str| {
        m.files
            .iter()
            .find(|f| f.dest.starts_with(&format!("models/{folder}/")))
            .map(|f| f.dest.rsplit('/').next().unwrap_or_default().to_string())
    };
    Some(Models {
        unet: name("diffusion_models")?,
        clip: name("text_encoders")?,
        vae: name("vae")?,
        lora: name("loras")?,
    })
}

/// Graphe ComfyUI de Qwen Image Edit 2511 avec la LoRA Lightning (4 pas, cfg 1, euler/simple, shift 3,1, CFGNorm,
/// références en `index_timestep_zero`), réglages validés sur les séries de test. `images` : noms de fichiers du
/// dossier `input/`, dans l'ordre des « image 1 », « image 2 », « image 3 » de la consigne (3 au plus) ; sans image,
/// génération à partir du texte seul.
pub fn build_workflow(m: &Models, prompt: &str, images: &[&str], seed: u64, width: u32, height: u32, prefix: &str) -> serde_json::Value {
    use serde_json::json;
    let mut g = serde_json::Map::new();
    let mut node = |id: &str, class: &str, inputs: serde_json::Value| {
        g.insert(id.to_string(), json!({ "class_type": class, "inputs": inputs }));
    };
    node("1", "UNETLoader", json!({ "unet_name": m.unet, "weight_dtype": "default" }));
    node("2", "CLIPLoader", json!({ "clip_name": m.clip, "type": "qwen_image", "device": "default" }));
    node("3", "VAELoader", json!({ "vae_name": m.vae }));
    node("4", "LoraLoaderModelOnly", json!({ "model": ["1", 0], "lora_name": m.lora, "strength_model": 1.0 }));
    node("5", "ModelSamplingAuraFlow", json!({ "model": ["4", 0], "shift": 3.1 }));
    node("6", "CFGNorm", json!({ "model": ["5", 0], "strength": 1.0 }));
    let mut pos = json!({ "clip": ["2", 0], "prompt": prompt, "vae": ["3", 0] });
    let mut neg = json!({ "clip": ["2", 0], "prompt": "", "vae": ["3", 0] });
    for (i, img) in images.iter().take(3).enumerate() {
        let id = format!("2{i}");
        node(&id, "LoadImage", json!({ "image": img }));
        pos[format!("image{}", i + 1)] = json!([id, 0]);
        neg[format!("image{}", i + 1)] = json!([id, 0]);
    }
    node("8", "TextEncodeQwenImageEditPlus", pos);
    node("9", "TextEncodeQwenImageEditPlus", neg);
    node("14", "FluxKontextMultiReferenceLatentMethod", json!({ "conditioning": ["8", 0], "reference_latents_method": "index_timestep_zero" }));
    node("15", "FluxKontextMultiReferenceLatentMethod", json!({ "conditioning": ["9", 0], "reference_latents_method": "index_timestep_zero" }));
    node("10", "EmptySD3LatentImage", json!({ "width": width, "height": height, "batch_size": 1 }));
    node(
        "11",
        "KSampler",
        json!({ "model": ["6", 0], "seed": seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                "positive": ["14", 0], "negative": ["15", 0], "latent_image": ["10", 0], "denoise": 1.0 }),
    );
    node("12", "VAEDecode", json!({ "samples": ["11", 0], "vae": ["3", 0] }));
    node("13", "SaveImage", json!({ "images": ["12", 0], "filename_prefix": prefix }));
    serde_json::Value::Object(g)
}

/// Mémoire vidéo totale de la carte vue par ComfyUI (octets), d'après `/system_stats`.
pub fn vram_total(port: u16) -> Option<u64> {
    let v: serde_json::Value = agent().get(&format!("http://127.0.0.1:{port}/system_stats")).call().ok()?.into_json().ok()?;
    v.get("devices")?.as_array()?.iter().filter_map(|d| d.get("vram_total").and_then(|t| t.as_u64())).max()
}

/// Demande à ComfyUI de décharger ses modèles et de rendre la mémoire vidéo (avant la porte qualité).
pub fn free_models(port: u16) -> bool {
    agent()
        .post(&format!("http://127.0.0.1:{port}/free"))
        .send_json(serde_json::json!({ "unload_models": true, "free_memory": true }))
        .is_ok()
}

/// Python embarqué de ComfyUI et dossier `comfy/text_encoders/qwen25_tokenizer` (tokenizer de la porte qualité).
pub fn python_and_tokenizer(photos_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let l = layout(photos_dir)?;
    let root = engine_dir(photos_dir);
    let main = root.join(&l.main);
    let tokenizer = main.parent()?.join("comfy").join("text_encoders").join("qwen25_tokenizer");
    Some((root.join(&l.python), tokenizer))
}

/// Images produites par une exécution, d'après `/history/<id>` : chemins relatifs au dossier `output/`.
pub fn output_files(history: &serde_json::Value, prompt_id: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Some(outputs) = history.get(prompt_id).and_then(|h| h.get("outputs")).and_then(|o| o.as_object()) else {
        return out;
    };
    for node in outputs.values() {
        for img in node.get("images").and_then(|i| i.as_array()).into_iter().flatten() {
            if img.get("type").and_then(|t| t.as_str()) != Some("output") {
                continue;
            }
            let Some(name) = img.get("filename").and_then(|f| f.as_str()) else { continue };
            let sub = img.get("subfolder").and_then(|s| s.as_str()).unwrap_or("");
            let mut p = PathBuf::new();
            for seg in sub.split(['/', '\\']).chain(std::iter::once(name)) {
                if seg.is_empty() || seg == "." || seg == ".." {
                    continue;
                }
                p.push(seg);
            }
            out.push(p);
        }
    }
    out
}

fn history_error(history: &serde_json::Value, prompt_id: &str) -> Option<String> {
    let st = history.get(prompt_id)?.get("status")?;
    if st.get("status_str").and_then(|s| s.as_str()) == Some("error") {
        let msg = st
            .get("messages")
            .and_then(|m| m.as_array())
            .and_then(|m| m.iter().find_map(|e| e.get(1).and_then(|d| d.get("exception_message")).and_then(|s| s.as_str())))
            .unwrap_or("erreur ComfyUI");
        return Some(msg.to_string());
    }
    None
}

/// Envoie un graphe et attend ses images. Renvoie les fichiers produits (chemins absolus).
pub fn run_workflow(port: u16, photos_dir: &Path, graph: &serde_json::Value, progress: &dyn Fn(&'static str)) -> Result<Vec<PathBuf>, PhotosError> {
    let agent = agent();
    let body = serde_json::json!({ "prompt": graph, "client_id": "fm-immersion" });
    let resp = agent
        .post(&format!("http://127.0.0.1:{port}/prompt"))
        .send_json(body)
        .map_err(|e| match e {
            ureq::Error::Status(_, r) => PhotosError::Io(format!("graphe refusé par ComfyUI : {}", r.into_string().unwrap_or_default())),
            e => PhotosError::Network(e.to_string()),
        })?;
    let v: serde_json::Value = resp.into_json().map_err(io)?;
    let id = v.get("prompt_id").and_then(|s| s.as_str()).ok_or_else(|| PhotosError::Io("réponse de ComfyUI sans identifiant".into()))?.to_string();
    progress("queued");
    let started = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        let hist: serde_json::Value = agent.get(&format!("http://127.0.0.1:{port}/history/{id}")).call().map_err(|e| PhotosError::Network(e.to_string()))?.into_json().map_err(io)?;
        if let Some(err) = history_error(&hist, &id) {
            return Err(PhotosError::Io(format!("ComfyUI : {err}")));
        }
        let files = output_files(&hist, &id);
        if !files.is_empty() {
            return Ok(files.into_iter().map(|f| photos_dir.join("output").join(f)).collect());
        }
        if started.elapsed() > PROMPT_TIMEOUT {
            return Err(PhotosError::Io("ComfyUI n'a pas rendu d'image dans le délai".into()));
        }
    }
}

// ------------------------------------------------------------------ commandes Tauri

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProgress {
    pub step: &'static str,
    pub received: u64,
    pub total: u64,
}

use photos_remote::photos_dir;

#[tauri::command]
pub async fn photos_engine_status(app: tauri::AppHandle) -> Result<EngineStatus, PhotosError> {
    Ok(status(&photos_dir(&app)?))
}

/// Extrait l'archive téléchargée (sur clic du joueur). Émet « photos-engine » pendant l'extraction.
#[tauri::command]
pub async fn photos_engine_install(app: tauri::AppHandle) -> Result<EngineStatus, PhotosError> {
    let dir = photos_dir(&app)?;
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let m = photos_remote::manifest();
        let archive = m
            .files
            .iter()
            .find(|f| f.component == "comfyui")
            .map(|f| photos_remote::dest_path(&dir, f))
            .ok_or_else(|| PhotosError::Manifest("pas d'archive ComfyUI dans le manifeste".into()))?;
        if !archive.is_file() {
            return Err(PhotosError::Io("archive ComfyUI absente : télécharge le moteur d'abord".into()));
        }
        stop();
        extract(&archive, &dir, &m.comfyui_version, &|received, total| {
            emitter.emit("photos-engine", EngineProgress { step: "extract", received, total }).ok();
        })?;
        // L'archive (2 Go) n'a plus d'usage une fois extraite : le marqueur la remplace dans l'état.
        std::fs::remove_file(&archive).ok();
        Ok(status(&dir))
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub async fn photos_engine_start(app: tauri::AppHandle) -> Result<EngineStatus, PhotosError> {
    let dir = photos_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        start(&dir)?;
        Ok(status(&dir))
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub async fn photos_engine_stop(app: tauri::AppHandle) -> Result<EngineStatus, PhotosError> {
    stop();
    Ok(status(&photos_dir(&app)?))
}

/// Au-delà, la carte graphique est tenue pour occupée par un autre logiciel (un jeu seul reste en dessous).
const GPU_BUSY_MIB: u64 = 4096;

/// Sortie de `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits` : (Mio utilisés, Mio au
/// total) de la carte qui a le plus de mémoire ; None si illisible.
pub fn parse_gpu_memory(text: &str) -> Option<(u64, u64)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split(',').map(|v| v.trim().parse::<u64>().ok());
            Some((it.next()??, it.next()??))
        })
        .max_by_key(|&(_, total)| total)
}

#[cfg(windows)]
fn gpu_memory() -> Option<(u64, u64)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_gpu_memory(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
fn gpu_memory() -> Option<(u64, u64)> {
    None
}

/// La carte graphique est-elle déjà prise par un autre logiciel ? Demandé avant une photo faite toute seule (jamais
/// avant un clic du joueur) : la photo attend plutôt que de faire planter l'autre travail par manque de mémoire.
/// Vrai tant que FM27 est lancé : un match 3D prend toute la carte, et le moteur, s'il tourne, est arrêté et le modèle
/// d'IA de l'appli déchargé d'Ollama pour la lui rendre (les photos reprennent une fois le jeu fermé). Sinon faux
/// quand notre moteur tourne déjà (la mémoire prise est la sienne) ou quand la carte ne répond pas.
#[tauri::command]
pub async fn photos_gpu_busy(app: tauri::AppHandle) -> Result<bool, PhotosError> {
    let game = tauri::async_runtime::spawn_blocking(|| {
        let game = crate::fm_bridge::game_running(std::path::Path::new(""));
        if game {
            stop();
            crate::ai::unload_all();
        }
        game
    })
    .await
    .map_err(io)?;
    if game {
        return Ok(true);
    }
    if status(&photos_dir(&app)?).running {
        return Ok(false);
    }
    let mem = tauri::async_runtime::spawn_blocking(gpu_memory).await.map_err(io)?;
    Ok(mem.map(|(used, _)| used > GPU_BUSY_MIB).unwrap_or(false))
}

/// Image de test : le moteur est lancé si besoin, une photo est générée (avec `face`, la photo du coach en PNG,
/// si le joueur en a une), les octets PNG sont renvoyés.
#[tauri::command]
pub async fn photos_engine_test(app: tauri::AppHandle, prompt: Option<String>, face: Option<Vec<u8>>) -> Result<tauri::ipc::Response, PhotosError> {
    let dir = photos_dir(&app)?;
    let coach = face.filter(|b| !b.is_empty() && b.len() <= 4 << 20);
    let emitter = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let emit = |step: &'static str| {
            emitter.emit("photos-engine", EngineProgress { step, received: 0, total: 0 }).ok();
        };
        emit("start");
        let port = start(&dir)?;
        let models = models_from_manifest(photos_remote::manifest()).ok_or_else(|| PhotosError::Manifest("modèles absents du manifeste".into()))?;
        let input: Vec<&str> = match coach {
            Some(png) => {
                std::fs::create_dir_all(dir.join("input"))?;
                std::fs::write(dir.join("input").join("fmi-test-face.png"), png)?;
                vec!["fmi-test-face.png"]
            }
            None => vec![],
        };
        let text = prompt.unwrap_or_else(|| {
            if !input.is_empty() {
                "Press photo, telephoto lens. The man from image 1 stands on the touchline of a soccer stadium at dusk, \
                 wearing a plain dark navy tracksuit jacket with no logo, pointing to his left and shouting instructions, \
                 looking at the pitch. Blurred stands in the background, floodlights on."
                    .into()
            } else {
                "Press photo, telephoto lens. A soccer coach in a plain dark navy tracksuit jacket with no logo stands on the \
                 touchline of a stadium at dusk, pointing to his left and shouting instructions, looking at the pitch."
                    .into()
            }
        });
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(1);
        let graph = build_workflow(&models, &text, input.as_slice(), seed, 1024, 576, "fmi/test");
        emit("generate");
        let files = run_workflow(port, &dir, &graph, &|_| {})?;
        let first = files.first().ok_or_else(|| PhotosError::Io("aucune image produite".into()))?;
        let bytes = std::fs::read(first)?;
        emit("done");
        Ok::<Vec<u8>, PhotosError>(bytes)
    })
    .await
    .map_err(io)??;
    Ok(tauri::ipc::Response::new(bytes))
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memoire_de_la_carte_graphique() {
        assert_eq!(parse_gpu_memory("1523, 16303\r\n"), Some((1523, 16303)));
        assert_eq!(parse_gpu_memory("300, 4096\n9000, 16303\n"), Some((9000, 16303)));
        assert_eq!(parse_gpu_memory("NVIDIA-SMI has failed"), None);
        assert_eq!(parse_gpu_memory(""), None);
    }

    #[test]
    fn chemins_d_archive_surs() {
        assert_eq!(safe_entry_path("ComfyUI_windows_portable\\ComfyUI\\main.py").unwrap(), PathBuf::from("ComfyUI_windows_portable/ComfyUI/main.py"));
        assert_eq!(safe_entry_path("a/./b//c").unwrap(), PathBuf::from("a/b/c"));
        assert!(safe_entry_path("../x").is_none());
        assert!(safe_entry_path("a/../../x").is_none());
        assert!(safe_entry_path("/etc/passwd").is_none());
        assert!(safe_entry_path("C:\\Windows\\x").is_none());
        assert!(safe_entry_path("").is_none());
    }

    #[test]
    fn trouve_python_et_main_sous_un_dossier_racine() {
        let root = std::env::temp_dir().join(format!("fmi-engine-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let base = root.join("ComfyUI_windows_portable");
        std::fs::create_dir_all(base.join("python_embeded")).unwrap();
        std::fs::create_dir_all(base.join("ComfyUI")).unwrap();
        assert!(find_layout(&root).is_none());
        std::fs::write(base.join("python_embeded/python.exe"), b"").unwrap();
        std::fs::write(base.join("ComfyUI/main.py"), b"").unwrap();
        let (py, main) = find_layout(&root).unwrap();
        assert_eq!(py, "ComfyUI_windows_portable/python_embeded/python.exe");
        assert_eq!(main, "ComfyUI_windows_portable/ComfyUI/main.py");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn le_marqueur_ne_vaut_que_si_les_fichiers_existent() {
        let photos = std::env::temp_dir().join(format!("fmi-engine-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&photos);
        let eng = engine_dir(&photos);
        std::fs::create_dir_all(eng.join("r/python_embeded")).unwrap();
        std::fs::create_dir_all(eng.join("r/ComfyUI")).unwrap();
        let l = Layout { comfyui_version: "v0.44.0".into(), python: "r/python_embeded/python.exe".into(), main: "r/ComfyUI/main.py".into(), extracted_at: "2026-11-09T00:00:00Z".into() };
        std::fs::write(eng.join(INSTALLED_MARKER), serde_json::to_string(&l).unwrap()).unwrap();
        assert!(layout(&photos).is_none(), "fichiers absents");
        std::fs::write(eng.join("r/python_embeded/python.exe"), b"").unwrap();
        std::fs::write(eng.join("r/ComfyUI/main.py"), b"").unwrap();
        assert_eq!(layout(&photos), Some(l));
        assert!(status(&photos).installed);
        assert!(!status(&photos).running);
        std::fs::remove_dir_all(&photos).unwrap();
    }

    #[test]
    fn arguments_de_lancement_locaux_et_hors_ligne() {
        let args = launch_args("C:/x/ComfyUI/main.py", 8199, Path::new("C:/photos"));
        let s = args.join(" ");
        assert!(s.contains("--listen 127.0.0.1"));
        assert!(s.contains("--port 8199"));
        assert!(s.contains("--base-directory C:/photos"));
        for flag in ["--offline", "--disable-all-custom-nodes", "--disable-auto-launch", "--disable-assets", "--fast-disk", "--disable-pinned-memory", "--disable-metadata"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(!s.contains("0.0.0.0"));
    }

    #[test]
    fn graphe_qwen_complet() {
        let m = models_from_manifest(photos_remote::manifest()).unwrap();
        assert_eq!(m.unet, "qwen_image_edit_2511_fp8mixed.safetensors");
        assert_eq!(m.clip, "qwen_2.5_vl_7b_fp8_scaled.safetensors");
        assert_eq!(m.vae, "qwen_image_vae.safetensors");
        assert!(m.lora.contains("Lightning"));
        let g = build_workflow(&m, "test", &["face.png", "kit.png"], 42, 1024, 576, "fmi/test");
        let o = g.as_object().unwrap();
        assert_eq!(o.len(), 16);
        assert_eq!(o["11"]["inputs"]["steps"], 4);
        assert_eq!(o["11"]["inputs"]["cfg"], 1.0);
        assert_eq!(o["11"]["inputs"]["sampler_name"], "euler");
        assert_eq!(o["5"]["inputs"]["shift"], 3.1);
        assert_eq!(o["8"]["inputs"]["image1"], serde_json::json!(["20", 0]));
        assert_eq!(o["9"]["inputs"]["image2"], serde_json::json!(["21", 0]));
        assert_eq!(o["14"]["inputs"]["reference_latents_method"], "index_timestep_zero");
        assert_eq!(o["11"]["inputs"]["positive"], serde_json::json!(["14", 0]));
        assert_eq!(o["2"]["inputs"]["type"], "qwen_image");
        // Toute référence pointe vers un nœud existant.
        for (id, node) in o {
            for v in node["inputs"].as_object().unwrap().values() {
                if let Some(arr) = v.as_array() {
                    let target = arr[0].as_str().unwrap();
                    assert!(o.contains_key(target), "{id} -> {target}");
                }
            }
        }
        let sans = build_workflow(&m, "test", &[], 1, 1024, 576, "fmi/test");
        assert_eq!(sans.as_object().unwrap().len(), 14);
        assert!(sans["8"]["inputs"].get("image1").is_none());
    }

    #[test]
    fn lit_les_images_de_l_historique() {
        let h = serde_json::json!({
            "abc": { "status": { "status_str": "success" }, "outputs": { "13": { "images": [
                { "filename": "test_00001_.png", "subfolder": "fmi", "type": "output" },
                { "filename": "tmp.png", "subfolder": "", "type": "temp" }
            ] } } }
        });
        assert_eq!(output_files(&h, "abc"), vec![PathBuf::from("fmi/test_00001_.png")]);
        assert!(output_files(&h, "zzz").is_empty());
        assert!(history_error(&h, "abc").is_none());
        let e = serde_json::json!({ "abc": { "status": { "status_str": "error", "messages": [["execution_error", { "exception_message": "CUDA out of memory" }]] }, "outputs": {} } });
        assert_eq!(history_error(&e, "abc").as_deref(), Some("CUDA out of memory"));
    }

    #[test]
    fn vider_le_dossier_garde_l_archive() {
        let root = std::env::temp_dir().join(format!("fmi-engine-clear-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let target = engine_dir(&root);
        std::fs::create_dir_all(target.join("ComfyUI_windows_portable").join("ComfyUI")).unwrap();
        std::fs::write(target.join("ComfyUI_windows_portable").join("ComfyUI").join("main.py"), b"x").unwrap();
        std::fs::write(target.join(INSTALLED_MARKER), b"{}").unwrap();
        let archive = target.join("ComfyUI_windows_portable_nvidia.7z");
        std::fs::write(&archive, b"7z").unwrap();
        clear_dir_except(&target, &archive).unwrap();
        assert!(archive.is_file());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 1);
        // Archive rangée ailleurs : tout le dossier est vidé.
        std::fs::write(target.join("reste"), b"x").unwrap();
        clear_dir_except(&target, &root.join("ailleurs.7z")).unwrap();
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn date_iso() {
        let d = chrono_now();
        assert_eq!(d.len(), 20);
        assert!(d.starts_with("20") && d.ends_with('Z'));
    }

    /// Extraction réelle : `FMI_COMFY_7Z=<archive> cargo test extrait_l_archive_reelle -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn extrait_l_archive_reelle() {
        let Ok(archive) = std::env::var("FMI_COMFY_7Z") else { return };
        let photos = std::env::var("FMI_PHOTOS_DIR").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join("fmi-photos-test"));
        let t = Instant::now();
        let l = extract(Path::new(&archive), &photos, "v0.44.0", &|w, tot| {
            if w % (512 << 20) < (8 << 20) {
                eprintln!("{} / {} Mo", w >> 20, tot >> 20);
            }
        })
        .unwrap();
        eprintln!("{l:?} en {:?}", t.elapsed());
        assert!(layout(&photos).is_some());
    }
}
