//! Labo de tactiques : FM Tactics Lab (https://github.com/lqf0624/fm-tactics-lab, code MIT) fait jouer des matchs
//! par le moteur de match de FM27 installé chez le joueur, sans ouvrir le jeu.
//!
//! L'outil n'est pas embarqué : son EXE contient des adaptateurs natifs et des données de comparaison exclues de la
//! licence MIT. L'appli télécharge l'EXE officiel sur clic du joueur (adresse GitHub Releases épinglée, taille et
//! SHA-256 vérifiés), le range dans `%LOCALAPPDATA%\app.fmimmersion.desktop\tactics-lab`, lui fait extraire son moteur
//! et vérifier la version du jeu (`--self-test`), puis lance son serveur local (`desktop_server.py`, Python embarqué
//! par l'outil) sur `127.0.0.1` et un port libre. Rien n'est écrit dans le jeu ni dans les sauvegardes ; le serveur
//! est arrêté à la fermeture de l'appli.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Version épinglée de l'outil : elle doit correspondre à la version du jeu (27.1.0+2505117 pour v1118).
pub const LAB_VERSION: &str = "v1118";
const LAB_FILE: &str = "FM27-Tactics-Lab-v1118.exe";
const LAB_URL: &str = "https://github.com/lqf0624/fm-tactics-lab/releases/download/v1118/FM27-Tactics-Lab-v1118.exe";
const LAB_SIZE: u64 = 22_984_192;
const LAB_SHA256: &str = "56c06bc7e9f03c4fd68e68fd5de56c7bf39c0dd944625679f54d3f7ec54f2757";
/// Version du jeu prise en charge par la version épinglée (affichée au joueur).
pub const LAB_GAME_BUILD: &str = "27.1.0+2505117";

const SELF_TEST_TIMEOUT: Duration = Duration::from_secs(300);
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const LOG_FILE: &str = "server.log";

static SERVER: Mutex<Option<Running>> = Mutex::new(None);

struct Running {
    child: Child,
    port: u16,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum LabError {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Net(String),
    #[error("{0}")]
    Corrupt(String),
    #[error("{0}")]
    Api(String),
}

impl From<std::io::Error> for LabError {
    fn from(e: std::io::Error) -> Self {
        LabError::Io(e.to_string())
    }
}

fn io(e: impl std::fmt::Display) -> LabError {
    LabError::Io(e.to_string())
}

/// Résultat du `--self-test` de l'outil (`<data>\self-test.json`), réduit à ce que l'appli montre.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelfTest {
    pub compatible: bool,
    pub can_simulate: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabStatus {
    pub version: &'static str,
    pub game_build: &'static str,
    pub size: u64,
    /// EXE téléchargé et vérifié.
    pub downloaded: bool,
    /// Moteur extrait par l'outil (dossier `releases\tauri-…` prêt).
    pub extracted: bool,
    pub self_test: Option<SelfTest>,
    pub running: bool,
    pub port: Option<u16>,
    pub log: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    step: &'static str,
    received: u64,
    total: u64,
}

// ------------------------------------------------------------------ emplacements

pub fn lab_dir(app: &tauri::AppHandle) -> Result<PathBuf, LabError> {
    Ok(app.path().app_local_data_dir().map_err(io)?.join("tactics-lab"))
}

fn exe_path(dir: &Path) -> PathBuf {
    dir.join(LAB_FILE)
}

fn data_dir(dir: &Path) -> PathBuf {
    dir.join("data")
}

/// Marqueur écrit après vérification de l'EXE (évite de recalculer le SHA-256 à chaque affichage).
fn verified_marker(dir: &Path) -> PathBuf {
    dir.join(format!("{LAB_FILE}.verified"))
}

fn downloaded(dir: &Path) -> bool {
    let size_ok = std::fs::metadata(exe_path(dir)).map(|m| m.len() == LAB_SIZE).unwrap_or(false);
    size_ok && std::fs::read_to_string(verified_marker(dir)).map(|s| s.trim() == LAB_SHA256).unwrap_or(false)
}

/// Dossier du moteur extrait par l'outil : `<data>\releases\tauri-<hash>\` avec `.ready`, le plus récent.
pub fn release_dir(data: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(data.join("releases")).ok()?;
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("tauri-"))
                && p.join(".ready").is_file()
                && p.join("python").join("python.exe").is_file()
                && p.join("source").join("desktop_server.py").is_file()
        })
        .max_by_key(|p| std::fs::metadata(p.join(".ready")).and_then(|m| m.modified()).ok())
}

/// Lit `self-test.json` (forme relevée sur v1118 : `engine.compatible`, `can_simulate`, `reason`).
pub fn parse_self_test(text: &str) -> Option<SelfTest> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let pick = |k: &str| v.get(k).or_else(|| v.get("engine").and_then(|e| e.get(k)));
    let reason = pick("reason").and_then(|r| r.as_str()).map(str::to_string).filter(|r| !r.is_empty());
    Some(SelfTest {
        compatible: pick("compatible").and_then(|b| b.as_bool()).unwrap_or(false),
        can_simulate: pick("can_simulate").and_then(|b| b.as_bool()).unwrap_or(false),
        reason,
    })
}

fn read_self_test(dir: &Path) -> Option<SelfTest> {
    parse_self_test(&std::fs::read_to_string(data_dir(dir).join("self-test.json")).ok()?)
}

fn log_tail(dir: &Path) -> String {
    let text = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(30)..].join("\n")
}

fn running_port() -> Option<u16> {
    SERVER.lock().ok().and_then(|g| g.as_ref().map(|r| r.port))
}

pub fn status(dir: &Path) -> LabStatus {
    let port = running_port();
    LabStatus {
        version: LAB_VERSION,
        game_build: LAB_GAME_BUILD,
        size: LAB_SIZE,
        downloaded: downloaded(dir),
        extracted: release_dir(&data_dir(dir)).is_some(),
        self_test: read_self_test(dir),
        running: port.is_some(),
        port,
        log: log_tail(dir),
    }
}

// ------------------------------------------------------------------ téléchargement

fn agent(read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(read)
        .timeout_write(Duration::from_secs(60))
        .user_agent("FM Immersion")
        .build()
}

/// Télécharge l'EXE épinglé, vérifie taille et SHA-256, puis le range. `progress(reçu, total)`.
fn download(dir: &Path, url: &str, progress: &dyn Fn(u64, u64)) -> Result<(), LabError> {
    std::fs::create_dir_all(dir)?;
    let part = dir.join(format!("{LAB_FILE}.part"));
    let resp = agent(Duration::from_secs(60)).get(url).call().map_err(|e| LabError::Net(format!("téléchargement impossible : {e}")))?;
    let mut reader = resp.into_reader().take(LAB_SIZE + 1);
    let mut out = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut received = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| LabError::Net(format!("téléchargement interrompu : {e}")))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        received += n as u64;
        progress(received, LAB_SIZE);
    }
    drop(out);
    let sha: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if received != LAB_SIZE || sha != LAB_SHA256 {
        std::fs::remove_file(&part).ok();
        return Err(LabError::Corrupt(format!("fichier reçu différent de la version {LAB_VERSION} attendue ({received} octets)")));
    }
    std::fs::remove_file(exe_path(dir)).ok();
    std::fs::rename(&part, exe_path(dir))?;
    std::fs::write(verified_marker(dir), LAB_SHA256)?;
    Ok(())
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

/// Fait extraire le moteur par l'outil et vérifier la version du jeu (`--self-test`, quitte seul).
fn self_test(dir: &Path, game_dir: &Path) -> Result<Option<SelfTest>, LabError> {
    let data = data_dir(dir);
    std::fs::create_dir_all(&data)?;
    std::fs::remove_file(data.join("self-test.json")).ok();
    let mut cmd = Command::new(exe_path(dir));
    cmd.arg("--self-test").arg("--data-dir").arg(&data);
    if game_dir.join("fm_Data").is_dir() {
        cmd.arg("--game-root").arg(game_dir);
    }
    cmd.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| LabError::Io(format!("lancement de FM Tactics Lab impossible : {e}")))?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > SELF_TEST_TIMEOUT {
            child.kill().ok();
            return Err(LabError::Io("FM Tactics Lab ne termine pas sa vérification".into()));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(read_self_test(dir))
}

// ------------------------------------------------------------------ serveur

fn free_port() -> Result<u16, LabError> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

fn alive(port: u16) -> bool {
    agent(Duration::from_secs(5)).get(&format!("http://127.0.0.1:{port}/api/status")).call().is_ok()
}

/// Dossiers des matchs et des imports gardés par l'outil (~256 Ko par match) : vidés quand le serveur ne tourne pas.
fn purge(data: &Path) {
    for sub in ["runs", "imports"] {
        std::fs::remove_dir_all(data.join(sub)).ok();
    }
}

/// Lance le serveur de l'outil s'il ne tourne pas déjà, attend qu'il réponde, renvoie son port.
pub fn start(dir: &Path, game_dir: &Path) -> Result<u16, LabError> {
    let mut guard = SERVER.lock().map_err(|_| io("verrou du labo"))?;
    if let Some(r) = guard.as_mut() {
        match r.child.try_wait() {
            Ok(None) if alive(r.port) => return Ok(r.port),
            _ => {
                r.child.kill().ok();
                *guard = None;
            }
        }
    }
    let data = data_dir(dir);
    let release = release_dir(&data).ok_or_else(|| LabError::Io("moteur du labo absent : installe-le d'abord".into()))?;
    purge(&data);
    let engine = release.join("engine");
    let port = free_port()?;
    let log = std::fs::File::create(dir.join(LOG_FILE))?;
    let mut cmd = Command::new(release.join("python").join("python.exe"));
    cmd.args(["-E", "-s", "-B", "-u", "-X", "utf8"])
        .arg(release.join("source").join("desktop_server.py"))
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&engine)
        .env("FM27_ENGINE_ROOT", &engine)
        .env("FM27_DESKTOP_DATA", &data)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    if game_dir.join("fm_Data").is_dir() {
        cmd.env("FM27_GAME_ROOT", game_dir);
    }
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| LabError::Io(format!("lancement du labo impossible : {e}")))?;
    crate::photos_engine::tie_to_app(&child);
    let started = Instant::now();
    loop {
        if alive(port) {
            break;
        }
        if let Ok(Some(st)) = child.try_wait() {
            return Err(LabError::Io(format!("le labo s'est arrêté au démarrage ({st}).\n{}", log_tail(dir))));
        }
        if started.elapsed() > READY_TIMEOUT {
            child.kill().ok();
            return Err(LabError::Io(format!("le labo ne répond pas.\n{}", log_tail(dir))));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    *guard = Some(Running { child, port });
    Ok(port)
}

/// Arrête le serveur s'il tourne (appelé aussi à la fermeture de l'appli).
pub fn stop() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut r) = guard.take() {
            r.child.kill().ok();
            r.child.wait().ok();
        }
    }
}

/// Seules ces routes de l'outil sont appelables depuis l'interface.
pub fn route_allowed(method: &str, path: &str) -> bool {
    let p = path.split('?').next().unwrap_or("");
    let ok_id = |id: &str| !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_alphanumeric());
    match method {
        "GET" => {
            matches!(p, "/api/status" | "/api/defaults" | "/api/catalog" | "/api/jobs")
                || p.strip_prefix("/api/jobs/").is_some_and(ok_id)
        }
        "POST" => matches!(p, "/api/import-fmf" | "/api/validate" | "/api/run" | "/api/cancel"),
        _ => false,
    }
}

fn call(method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, LabError> {
    if !route_allowed(method, path) {
        return Err(LabError::Api("route refusée".into()));
    }
    let port = running_port().ok_or_else(|| LabError::Api("le labo n'est pas lancé".into()))?;
    let url = format!("http://127.0.0.1:{port}{path}");
    let a = agent(Duration::from_secs(120));
    let res = match body {
        Some(b) => a.post(&url).send_json(b),
        None => a.get(&url).call(),
    };
    match res {
        Ok(r) => r.into_json().map_err(|e| LabError::Api(format!("réponse illisible : {e}"))),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or(text);
            Err(LabError::Api(format!("{code} {msg}")))
        }
        Err(e) => Err(LabError::Api(e.to_string())),
    }
}

// ------------------------------------------------------------------ commandes

#[tauri::command]
pub async fn lab_status(app: tauri::AppHandle) -> Result<LabStatus, LabError> {
    Ok(status(&lab_dir(&app)?))
}

/// Télécharge l'outil (sur clic du joueur) puis lui fait extraire son moteur et vérifier la version du jeu.
/// Émet « tactics-lab » pendant le téléchargement et la vérification.
#[tauri::command]
pub async fn lab_install(app: tauri::AppHandle, game_dir: String) -> Result<LabStatus, LabError> {
    let dir = lab_dir(&app)?;
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !downloaded(&dir) {
            download(&dir, LAB_URL, &|received, total| {
                emitter.emit("tactics-lab", Progress { step: "download", received, total }).ok();
            })?;
        }
        stop();
        emitter.emit("tactics-lab", Progress { step: "check", received: 0, total: 0 }).ok();
        self_test(&dir, Path::new(&game_dir))?;
        Ok(status(&dir))
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub async fn lab_start(app: tauri::AppHandle, game_dir: String) -> Result<LabStatus, LabError> {
    let dir = lab_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        start(&dir, Path::new(&game_dir))?;
        Ok(status(&dir))
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub async fn lab_stop(app: tauri::AppHandle) -> Result<LabStatus, LabError> {
    let dir = lab_dir(&app)?;
    stop();
    purge(&data_dir(&dir));
    Ok(status(&dir))
}

/// Supprime l'outil et son moteur (sur clic du joueur).
#[tauri::command]
pub async fn lab_remove(app: tauri::AppHandle) -> Result<LabStatus, LabError> {
    let dir = lab_dir(&app)?;
    stop();
    std::fs::remove_dir_all(&dir).ok();
    Ok(status(&dir))
}

/// Appel d'une route de l'outil (liste fermée, voir `route_allowed`).
#[tauri::command]
pub async fn lab_call(method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, LabError> {
    tauri::async_runtime::spawn_blocking(move || call(&method, &path, body)).await.map_err(io)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_permises() {
        assert!(route_allowed("GET", "/api/status"));
        assert!(route_allowed("GET", "/api/jobs?brief=1"));
        assert!(route_allowed("GET", "/api/jobs/0a1b2c3d4e5f"));
        assert!(route_allowed("POST", "/api/run"));
        assert!(!route_allowed("GET", "/api/jobs/../x"));
        assert!(!route_allowed("POST", "/api/engine/select"));
        assert!(!route_allowed("POST", "/api/jobs/delete"));
        assert!(!route_allowed("DELETE", "/api/run"));
    }

    #[test]
    fn lit_le_self_test() {
        let t = parse_self_test(r#"{"engine":{"compatible":true,"reason":""},"can_simulate":true,"adapter_version":"x"}"#).unwrap();
        assert_eq!(t, SelfTest { compatible: true, can_simulate: true, reason: None });
        let t = parse_self_test(r#"{"engine":{"compatible":false,"can_simulate":false,"reason":"PE_layout"}}"#).unwrap();
        assert!(!t.compatible && !t.can_simulate);
        assert_eq!(t.reason.as_deref(), Some("PE_layout"));
        assert!(parse_self_test("pas du json").is_none());
    }

    #[test]
    fn trouve_le_moteur_extrait() {
        let root = std::env::temp_dir().join(format!("fmi-lab-{}", std::process::id()));
        let rel = root.join("releases").join("tauri-8db4f3498a7fa98e67a2");
        assert!(release_dir(&root).is_none());
        std::fs::create_dir_all(rel.join("python")).unwrap();
        std::fs::create_dir_all(rel.join("source")).unwrap();
        std::fs::write(rel.join("python").join("python.exe"), b"").unwrap();
        std::fs::write(rel.join("source").join("desktop_server.py"), b"").unwrap();
        assert!(release_dir(&root).is_none(), "sans .ready, extraction inachevée");
        std::fs::write(rel.join(".ready"), b"x").unwrap();
        assert_eq!(release_dir(&root), Some(rel));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn telechargement_verifie() {
        // Serveur local qui sert des octets faux : le fichier doit être refusé et ne rien laisser.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body = b"pas le bon fichier";
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(body);
            }
        });
        let dir = std::env::temp_dir().join(format!("fmi-lab-dl-{}", std::process::id()));
        let r = download(&dir, &format!("http://127.0.0.1:{port}/x.exe"), &|_, _| {});
        assert!(matches!(r, Err(LabError::Corrupt(_))));
        assert!(!exe_path(&dir).exists() && !downloaded(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }
}
