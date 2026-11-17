//! Installation en un clic du pack de portraits photoréalistes dans FM27.
//!
//! Même méthode que `fm27-photoreal.ps1` (INSTALLER.bat du pack v1.0), reprise ici en Rust :
//! 1. CRC32 du bundle à installer, calculé comme Unity le vérifie (fichiers contenus, décompressés) ;
//! 2. sauvegarde du bundle et du catalogue d'origine (même dossier que les .bat :
//!    `Documents\FM27-Photoreal-Backup`, donc les deux méthodes restent compatibles) ;
//! 3. remplacement du CRC et de la taille de `portraits_assets_all.bundle` dans `catalog_info.bin`
//!    (et dans ses copies en cache de `LocalLow\...\com.unity.addressables`), sinon le jeu affiche des carrés blancs ;
//! 4. copie vérifiée du bundle (nom temporaire, puis renommage).
//!
//! Le pack peut être la v1.0 publiée ou un pack construit dans l'atelier de génération (avancement partiel) :
//! chaque bundle installé par FM Immersion est noté dans `fm-immersion-installs.json` du dossier de sauvegarde,
//! pour être reconnu ensuite (état, réinstallation, désinstallation).

use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const BUNDLE: &str = "portraits_assets_all.bundle";
const CATALOG: &str = "catalog_info.bin";
const CATALOG_HASH: &str = "catalog_info.hash";
const INSTALLS: &str = "fm-immersion-installs.json";
/// Valeurs du bundle d'origine de FM27 (version du 29/10/2026, jusqu'à la 27.0.x) dans le catalogue.
pub const ORIG_CRC: u32 = 191_505_968;
pub const ORIG_SIZE: u32 = 108_004_900;
/// Bundle d'origine de la 27.1.0 (17/11/2026) : les 14 000 portraits d'avant, identiques, et 956 nouveaux
/// (hommes, nouvelle barbe).
pub const ORIG_2710_CRC: u32 = 2_591_666_736;
pub const ORIG_2710_SIZE: u32 = 115_125_650;
/// Bundles d'origine connus, du plus ancien au plus récent.
pub const ORIGINALS: [(u32, u32); 2] = [(ORIG_CRC, ORIG_SIZE), (ORIG_2710_CRC, ORIG_2710_SIZE)];

pub fn is_original(crc: u32, size: u32) -> bool {
    ORIGINALS.contains(&(crc, size))
}

/// Taille d'un bundle d'origine connu.
pub fn is_original_size(size: u64) -> bool {
    ORIGINALS.iter().any(|&(_, s)| s as u64 == size)
}
/// Valeurs du pack v1.0 (release GitHub du 01/11/2026).
pub const V1_CRC: u32 = 1_069_530_745;
pub const V1_SIZE: u32 = 526_124_666;

#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error("dossier de FM27 introuvable (catalogue ou bundle des portraits absent)")]
    NoGame,
    #[error("FM27 est lancé : ferme le jeu, puis recommence. Rien n'a été modifié.")]
    GameRunning,
    #[error("fichier du pack introuvable : {0}")]
    NoPack(String),
    #[error("ce fichier n'est pas un bundle de portraits valide ({0}). Rien n'a été modifié.")]
    BadPack(String),
    #[error("pack en place non reconnu : le catalogue du jeu ne correspond ni à l'original, ni à la v1.0, ni à un pack installé par FM Immersion ou par l'atelier. Rien n'a été modifié.")]
    UnknownGame,
    #[error("sauvegarde introuvable ou invalide dans {0}. Rien n'a été modifié. Pour revenir aux visages d'origine : Steam > Vérifier l'intégrité des fichiers.")]
    NoBackup(String),
    #[error("ce pack a été fait pour une autre version de FM27 : il lui manque {0} portraits que le jeu attend (ils resteraient en carré blanc). Rien n'a été modifié. Prends le pack à jour dans « Visages ».")]
    Incompatible(usize),
    #[error("vérification après copie échouée : {0}")]
    Check(String),
    #[error("réseau : {0}")]
    Network(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for PackError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ------------------------------------------------------------------ CRC Unity

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}
static TABLE: [u32; 256] = crc_table();

pub fn crc_update(mut crc: u32, data: &[u8]) -> u32 {
    for &b in data {
        crc = TABLE[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc
}

fn bad(msg: &str) -> PackError {
    PackError::BadPack(msg.to_owned())
}

/// Décompression LZ4 d'un bloc (format « block », comme dans les bundles Unity).
pub fn lz4_decode(src: &[u8], dst: &mut [u8]) -> Result<(), PackError> {
    let (mut s, mut d) = (0usize, 0usize);
    let byte = |i: usize| src.get(i).copied().ok_or_else(|| bad("bloc LZ4 tronqué"));
    while s < src.len() {
        let token = byte(s)?;
        s += 1;
        let mut lit = (token >> 4) as usize;
        if lit == 15 {
            loop {
                let b = byte(s)?;
                s += 1;
                lit += b as usize;
                if b != 255 {
                    break;
                }
            }
        }
        if s + lit > src.len() || d + lit > dst.len() {
            return Err(bad("bloc LZ4 invalide"));
        }
        dst[d..d + lit].copy_from_slice(&src[s..s + lit]);
        s += lit;
        d += lit;
        if s >= src.len() {
            break;
        }
        let off = byte(s)? as usize | ((byte(s + 1)? as usize) << 8);
        s += 2;
        let mut len = (token & 15) as usize;
        if len == 15 {
            loop {
                let b = byte(s)?;
                s += 1;
                len += b as usize;
                if b != 255 {
                    break;
                }
            }
        }
        len += 4;
        if off == 0 || off > d || d + len > dst.len() {
            return Err(bad("décalage LZ4 invalide"));
        }
        for i in 0..len {
            dst[d + i] = dst[d - off + i];
        }
        d += len;
    }
    if d != dst.len() {
        return Err(bad("taille de bloc LZ4 inattendue"));
    }
    Ok(())
}

fn read_cstr<R: Read>(r: &mut R) -> Result<String, PackError> {
    let mut out = Vec::new();
    let mut b = [0u8; 1];
    loop {
        r.read_exact(&mut b)?;
        if b[0] == 0 {
            break;
        }
        out.push(b[0]);
        if out.len() > 256 {
            return Err(bad("en-tête illisible"));
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn read_be<R: Read>(r: &mut R, n: usize) -> Result<u64, PackError> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b[..n])?;
    Ok(b[..n].iter().fold(0u64, |v, &x| (v << 8) | x as u64))
}

fn be(b: &[u8], p: &mut usize, n: usize) -> Result<u64, PackError> {
    let s = b.get(*p..*p + n).ok_or_else(|| bad("table des blocs tronquée"))?;
    *p += n;
    Ok(s.iter().fold(0u64, |v, &x| (v << 8) | x as u64))
}

fn decode_into(kind: u32, src: &[u8], dst: &mut [u8]) -> Result<(), PackError> {
    match kind {
        0 if src.len() == dst.len() => {
            dst.copy_from_slice(src);
            Ok(())
        }
        2 | 3 => lz4_decode(src, dst),
        _ => Err(bad("compression non prise en charge")),
    }
}

/// CRC32 que Unity compare au catalogue : celui des fichiers contenus dans le bundle, décompressés.
pub fn unity_crc(path: &Path) -> Result<u32, PackError> {
    scan_bundle(path, |_| {})
}

/// CRC Unity et noms des portraits contenus dans le bundle (lus dans les fichiers décompressés).
pub fn bundle_portraits(path: &Path) -> Result<(u32, HashSet<String>), PackError> {
    let mut names = HashSet::new();
    // Un nom peut chevaucher deux blocs : on garde la fin du bloc précédent.
    let mut tail: Vec<u8> = Vec::new();
    let crc = scan_bundle(path, |block| {
        let mut buf = std::mem::take(&mut tail);
        buf.extend_from_slice(block);
        names.extend(portrait_names(&buf));
        tail = buf[buf.len().saturating_sub(64)..].to_vec();
    })?;
    Ok((crc, names))
}

/// Noms de portraits (« portrait_male-0-1-10-4-4 ») cités dans des octets : bundle décompressé ou catalogue.
pub fn portrait_names(bytes: &[u8]) -> HashSet<String> {
    let mut out = HashSet::new();
    for prefix in [&b"portrait_male-"[..], &b"portrait_female-"[..]] {
        let mut i = 0;
        while let Some(k) = bytes[i..].windows(prefix.len()).position(|w| w == prefix) {
            let start = i + k;
            let mut end = start + prefix.len();
            while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'-') {
                end += 1;
            }
            let name = &bytes[start..end];
            // Forme complète : cinq nombres séparés par des tirets.
            if name.ends_with(b"-") || name.iter().filter(|&&c| c == b'-').count() != 5 {
                i = start + prefix.len();
                continue;
            }
            out.insert(String::from_utf8_lossy(name).into_owned());
            i = end;
        }
    }
    out
}

fn scan_bundle(path: &Path, mut on_block: impl FnMut(&[u8])) -> Result<u32, PackError> {
    let mut f = BufReader::with_capacity(1 << 20, File::open(path)?);
    let len = f.get_ref().metadata()?.len();
    if read_cstr(&mut f)? != "UnityFS" {
        return Err(bad("ce n'est pas un bundle UnityFS"));
    }
    let version = read_be(&mut f, 4)?;
    read_cstr(&mut f)?;
    read_cstr(&mut f)?;
    read_be(&mut f, 8)?;
    let info_packed = read_be(&mut f, 4)? as usize;
    let info_size = read_be(&mut f, 4)? as usize;
    let flags = read_be(&mut f, 4)? as u32;
    if info_packed > 64 << 20 || info_size > 64 << 20 {
        return Err(bad("table des blocs trop grande"));
    }
    let align = |f: &mut BufReader<File>| -> Result<(), PackError> {
        let pos = f.stream_position()?;
        f.seek(SeekFrom::Start(pos.div_ceil(16) * 16))?;
        Ok(())
    };
    if version >= 7 {
        align(&mut f)?;
    }
    let mut after = f.stream_position()?;
    let at_end = flags & 0x80 != 0;
    if at_end {
        f.seek(SeekFrom::Start(len.checked_sub(info_packed as u64).ok_or_else(|| bad("fichier tronqué"))?))?;
    }
    let mut packed = vec![0u8; info_packed];
    f.read_exact(&mut packed)?;
    if !at_end {
        after = f.stream_position()?;
    }
    let mut info = vec![0u8; info_size];
    decode_into(flags & 0x3F, &packed, &mut info)?;
    f.seek(SeekFrom::Start(after))?;
    if flags & 0x200 != 0 {
        align(&mut f)?;
    }

    let mut p = 16;
    let blocks = be(&info, &mut p, 4)? as usize;
    let mut table = Vec::with_capacity(blocks.min(1 << 16));
    let mut total = 0u64;
    for _ in 0..blocks {
        let raw = be(&info, &mut p, 4)? as usize;
        let pack = be(&info, &mut p, 4)? as usize;
        let kind = be(&info, &mut p, 2)? as u32 & 0x3F;
        total += raw as u64;
        table.push((raw, pack, kind));
    }
    let nodes = be(&info, &mut p, 4)?;
    let mut expected = 0u64;
    for _ in 0..nodes {
        let off = be(&info, &mut p, 8)?;
        let size = be(&info, &mut p, 8)?;
        be(&info, &mut p, 4)?;
        while *info.get(p).ok_or_else(|| bad("nom de fichier tronqué"))? != 0 {
            p += 1;
        }
        p += 1;
        if off != expected {
            return Err(bad("fichiers du bundle non contigus"));
        }
        expected = off + size;
    }
    if expected != total {
        return Err(bad("fichiers et blocs du bundle incohérents"));
    }

    let mut crc = 0xFFFF_FFFFu32;
    let (mut src, mut dst) = (Vec::new(), Vec::new());
    for (raw, pack, kind) in table {
        if raw > 64 << 20 || pack > 64 << 20 {
            return Err(bad("bloc trop grand"));
        }
        src.resize(pack, 0);
        dst.resize(raw, 0);
        f.read_exact(&mut src)?;
        decode_into(kind, &src, &mut dst)?;
        crc = crc_update(crc, &dst);
        on_block(&dst);
    }
    Ok(crc ^ 0xFFFF_FFFF)
}

// ------------------------------------------------------------------ catalogue

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entry {
    pub offset: usize,
    pub crc: u32,
    pub size: u32,
}

/// Seule occurrence de `needle` (None si absente ou présente plusieurs fois).
fn find_unique(hay: &[u8], needle: &[u8]) -> Option<usize> {
    let mut it = hay.windows(needle.len()).enumerate().filter(|(_, w)| *w == needle).map(|(i, _)| i);
    let first = it.next()?;
    it.next().is_none().then_some(first)
}

/// Entrée du bundle des portraits dans le catalogue : après le nom, une empreinte de 16 octets,
/// une longueur (32) et 32 caractères hexadécimaux, deux u32, puis le CRC et la taille (u32 little endian).
pub fn read_entry(bytes: &[u8]) -> Option<Entry> {
    let mark = format!("\\{BUNDLE}");
    let i = find_unique(bytes, mark.as_bytes()).filter(|&i| i > 0)?;
    let j = i + mark.len() + 16;
    let k = j + 4 + 32 + 8;
    let u32_at = |o: usize| bytes.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if u32_at(j)? != 32 {
        return None;
    }
    Some(Entry { offset: k, crc: u32_at(k)?, size: u32_at(k + 4)? })
}

pub fn patched(bytes: &[u8], entry: Entry, crc: u32, size: u32) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out[entry.offset..entry.offset + 4].copy_from_slice(&crc.to_le_bytes());
    out[entry.offset + 4..entry.offset + 8].copy_from_slice(&size.to_le_bytes());
    out
}

// ------------------------------------------------------------------ installations connues

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub crc: u32,
    pub size: u32,
    /// Fichier d'où vient le pack (pour l'affichage).
    pub source: String,
    /// Date d'installation (ISO 8601).
    pub at: String,
    /// Version du pack (date-heure de construction), quand elle est connue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

pub fn read_installs(backup: &Path) -> Vec<Installed> {
    std::fs::read_to_string(backup.join(INSTALLS)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_installs(backup: &Path, list: &[Installed]) -> std::io::Result<()> {
    std::fs::create_dir_all(backup)?;
    let tmp = backup.join(format!("{INSTALLS}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(list).unwrap_or_default())?;
    std::fs::rename(tmp, backup.join(INSTALLS))
}

/// « 0xfb0c25a5 », « fb0c25a5 » ou un nombre décimal.
fn parse_crc(v: &serde_json::Value) -> Option<u32> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
        serde_json::Value::String(s) => {
            let s = s.trim();
            let hex = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"));
            match hex {
                Some(h) => u32::from_str_radix(h, 16).ok(),
                None => s.parse().ok(),
            }
        }
        _ => None,
    }
}

/// Manifeste d'un pack V2. Même format pour le pack de l'atelier (`v2\pack\pack.json` ou `manifest.json`)
/// et pour la release « v2-progression » publiée sur GitHub :
/// ```json
/// { "version": "2026-11-08 15:04:50", "nb_a2b": 2668, "nb_d2": 1054, "nb_v1": 10278,
///   "crc32": "0xfb0c25a5", "taille": 535426723,
///   "sha256": "<empreinte du zip>", "url": "https://github.com/amnesix-nt/FM27-Photorealistic-Faces/releases/download/v2-progression/FM27-Photoreal-Faces-v2-progression.zip" }
/// ```
/// Obligatoires : `crc32` (ou `crc`, hexadécimal « 0x… » ou décimal) et `taille` (ou `size`, octets du bundle).
/// `version` (ou `date`) sert à savoir si un pack est plus récent ; `sha256` et `url` au téléchargement.
/// Les noms courts (`a2b`, `d2`, `v1`) sont acceptés aussi.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub version: Option<String>,
    pub a2b: Option<u32>,
    pub d2: Option<u32>,
    pub v1: Option<u32>,
    pub crc: u32,
    pub size: u32,
    pub sha256: Option<String>,
    pub url: Option<String>,
}

pub fn parse_manifest(text: &str) -> Option<PackManifest> {
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let any = |keys: &[&str]| keys.iter().find_map(|k| v.get(*k)).filter(|x| !x.is_null());
    let num = |keys: &[&str]| any(keys).and_then(|x| x.as_u64()).and_then(|n| u32::try_from(n).ok());
    let text = |keys: &[&str]| any(keys).and_then(|x| x.as_str()).map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    Some(PackManifest {
        version: text(&["version", "date"]),
        a2b: num(&["nb_a2b", "a2b"]),
        d2: num(&["nb_d2", "d2"]),
        v1: num(&["nb_v1", "v1"]),
        crc: parse_crc(any(&["crc32", "crc"])?)?,
        size: num(&["taille", "size"])?,
        sha256: text(&["sha256", "sha256_zip"]).map(|s| s.to_ascii_lowercase()),
        url: text(&["url", "url_zip"]),
    })
}

impl PackManifest {
    pub fn as_installed(&self, source: &str) -> Installed {
        Installed { crc: self.crc, size: self.size, source: source.to_owned(), at: String::new(), version: self.version.clone() }
    }
}

/// Manifestes des packs de l'atelier : `v2\pack` (dernier pack) et `v2\bascule_precedent` (le précédent).
pub fn workshop_manifests(workshop: &Path) -> Vec<(PathBuf, PackManifest)> {
    let mut out = Vec::new();
    for dir in ["pack", "bascule_precedent"] {
        for name in ["manifest.json", "pack.json"] {
            let p = workshop.join("v2").join(dir).join(name);
            if let Some(m) = std::fs::read_to_string(&p).ok().and_then(|t| parse_manifest(&t)) {
                out.push((p, m));
                break;
            }
        }
    }
    out
}

/// Packs construits par l'atelier, reconnus même s'ils ont été installés sans l'app (bascule automatique V2).
pub fn workshop_packs(workshop: &Path) -> Vec<Installed> {
    workshop_manifests(workshop).iter().map(|(p, m)| m.as_installed(&p.display().to_string())).collect()
}

/// Version du pack actuellement en place, si on le connaît.
pub fn installed_version(p: &Paths, crc: u32, size: u32) -> Option<String> {
    p.all_known().into_iter().filter(|i| i.crc == crc && i.size == size).find_map(|i| i.version)
}

/// Entrée du catalogue du jeu (CRC et taille du bundle des portraits attendus par le jeu).
pub fn current_entry(p: &Paths) -> Option<Entry> {
    read_entry(&std::fs::read(&p.catalog).ok()?)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogState {
    Original,
    /// Pack v1.0 publié.
    V1,
    /// Pack installé par FM Immersion (atelier, avancement partiel…).
    Custom,
    Unknown,
}

pub fn classify(e: &Entry, installs: &[Installed]) -> CatalogState {
    if is_original(e.crc, e.size) {
        CatalogState::Original
    } else if e.crc == V1_CRC && e.size == V1_SIZE {
        CatalogState::V1
    } else if installs.iter().any(|i| i.crc == e.crc && i.size == e.size) {
        CatalogState::Custom
    } else {
        CatalogState::Unknown
    }
}

// ------------------------------------------------------------------ chemins

pub struct Paths {
    pub bundle: PathBuf,
    pub catalog: PathBuf,
    pub catalog_hash: PathBuf,
    pub cache: PathBuf,
    pub backup: PathBuf,
    /// Packs reconnus en plus de ceux de `fm-immersion-installs.json` : packs installés par l'atelier
    /// lui-même (bascule automatique de la V2, voir `workshop_packs`).
    pub known: Vec<Installed>,
}

impl Paths {
    pub fn new(game: &Path, cache: PathBuf, backup: PathBuf) -> Self {
        let addr = game.join("fm_Data").join("StreamingAssets").join("AddrData");
        Paths { bundle: addr.join(BUNDLE), catalog: addr.join(CATALOG), catalog_hash: addr.join(CATALOG_HASH), cache, backup, known: Vec::new() }
    }
    pub fn with_known(mut self, known: Vec<Installed>) -> Self {
        self.known = known;
        self
    }
    /// Tous les packs connus : installés par FM Immersion, plus ceux de l'atelier.
    fn all_known(&self) -> Vec<Installed> {
        let mut v = read_installs(&self.backup);
        v.extend(self.known.iter().cloned());
        v
    }
    fn game_ok(&self) -> bool {
        self.bundle.is_file() && self.catalog.is_file()
    }
}

/// Copies en cache du catalogue (leur nom dépend de l'installation : on les reconnaît à leur contenu).
fn cache_catalogs(dir: &Path) -> Vec<(PathBuf, Entry)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(PathBuf, Entry)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("bin")))
        .filter_map(|p| std::fs::read(&p).ok().and_then(|b| read_entry(&b)).map(|e| (p, e)))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Deux catalogues identiques à l'entrée des portraits près. Un cache Addressables qui ne l'est pas date d'une
/// autre version du jeu (mise à jour Steam) : le corriger en place mélangerait l'ancien catalogue et les nouveaux
/// bundles, il faut le retirer pour que le jeu le reconstruise depuis son catalogue.
fn same_catalog(a: &[u8], b: &[u8]) -> bool {
    match (read_entry(a), read_entry(b)) {
        (Some(ea), Some(eb)) => a.len() == b.len() && patched(a, ea, 0, 0) == patched(b, eb, 0, 0),
        _ => false,
    }
}

/// Retire une copie du catalogue dans le cache (et son `.hash`) : le jeu la reconstruit au prochain lancement.
fn drop_cached(file: &Path) -> std::io::Result<()> {
    std::fs::remove_file(file)?;
    let hash = file.with_extension("hash");
    if hash.is_file() {
        std::fs::remove_file(&hash)?;
    }
    Ok(())
}

fn sha256_file(p: &Path) -> std::io::Result<[u8; 32]> {
    let mut f = BufReader::with_capacity(1 << 20, File::open(p)?);
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().into())
}

/// Copie vers un nom temporaire, vérification, puis renommage : la destination n'est jamais à moitié écrite.
fn copy_checked(src: &Path, dst: &Path) -> Result<(), PackError> {
    let tmp = PathBuf::from(format!("{}.fm27tmp", dst.display()));
    std::fs::copy(src, &tmp)?;
    if sha256_file(src)? != sha256_file(&tmp)? {
        std::fs::remove_file(&tmp).ok();
        return Err(PackError::Check(dst.display().to_string()));
    }
    std::fs::rename(&tmp, dst)?;
    Ok(())
}

fn write_checked(bytes: &[u8], dst: &Path) -> Result<(), PackError> {
    let tmp = PathBuf::from(format!("{}.fm27tmp", dst.display()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dst)?;
    Ok(())
}

fn latest_set(backup: &Path) -> Option<PathBuf> {
    let name = std::fs::read_to_string(backup.join("latest.txt")).ok()?;
    let set = backup.join(name.trim());
    set.join(CATALOG).is_file().then_some(set)
}

/// Un bundle d'origine est sauvegardé (désinstallation possible) : celui de la 27.0, ou celui gardé avec le dernier
/// catalogue d'origine.
pub fn has_bundle_backup(p: &Paths) -> bool {
    p.backup.join(BUNDLE).is_file() || latest_set(&p.backup).is_some_and(|s| s.join(BUNDLE).is_file())
}

/// Sauvegarde des fichiers d'origine (format identique au script des .bat).
fn backup(p: &Paths, catalog: &[u8], state: CatalogState, cached: &[(PathBuf, Entry)]) -> Result<(), PackError> {
    std::fs::create_dir_all(&p.backup)?;
    let bundle_backup = p.backup.join(BUNDLE);
    let bundle_size = std::fs::metadata(&p.bundle)?.len();
    if !bundle_backup.exists() && bundle_size == ORIG_SIZE as u64 {
        copy_checked(&p.bundle, &bundle_backup)?;
    }
    // Bundle d'origine décrit par ce catalogue (27.1.0 et suivantes) : gardé avec son catalogue, pour que la
    // désinstallation remette les portraits de la bonne version.
    let own_bundle = state == CatalogState::Original
        && read_entry(catalog).is_some_and(|e| e.size as u64 == bundle_size)
        && bundle_size != ORIG_SIZE as u64;
    // Une mise à jour Steam change le catalogue : chaque catalogue d'origine a son dossier, rien n'est écrasé.
    if state == CatalogState::Original {
        let sha: String = Sha256::digest(catalog).iter().take(6).map(|b| format!("{b:02X}")).collect();
        let name = format!("catalog-{sha}");
        let set = p.backup.join(&name);
        if !set.exists() {
            let tmp = p.backup.join(format!("{name}.fm27tmp"));
            if tmp.exists() {
                std::fs::remove_dir_all(&tmp)?;
            }
            std::fs::create_dir_all(tmp.join("cache"))?;
            std::fs::copy(&p.catalog, tmp.join(CATALOG))?;
            if p.catalog_hash.is_file() {
                std::fs::copy(&p.catalog_hash, tmp.join(CATALOG_HASH))?;
            }
            for (file, e) in cached {
                if classify(e, &[]) == CatalogState::Original {
                    if let Some(n) = file.file_name() {
                        std::fs::copy(file, tmp.join("cache").join(n))?;
                    }
                    let h = file.with_extension("hash");
                    if let (true, Some(n)) = (h.is_file(), h.file_name()) {
                        std::fs::copy(&h, tmp.join("cache").join(n))?;
                    }
                }
            }
            std::fs::rename(&tmp, &set)?;
        }
        if own_bundle && std::fs::metadata(set.join(BUNDLE)).map(|m| m.len()).ok() != Some(bundle_size) {
            copy_checked(&p.bundle, &set.join(BUNDLE))?;
        }
        std::fs::write(p.backup.join("latest.txt"), &name)?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub crc: u32,
    pub size: u32,
    /// Le pack était déjà en place : rien n'a été copié.
    pub already: bool,
}

pub fn install(p: &Paths, pack: &Path, now: &str, version: Option<&str>) -> Result<InstallReport, PackError> {
    if !p.game_ok() {
        return Err(PackError::NoGame);
    }
    if !pack.is_file() {
        return Err(PackError::NoPack(pack.display().to_string()));
    }
    let (crc, pack_names) = bundle_portraits(pack)?;
    let size = u32::try_from(std::fs::metadata(pack)?.len()).map_err(|_| bad("fichier trop gros"))?;

    let catalog = std::fs::read(&p.catalog)?;
    // Le pack doit contenir chaque portrait que le catalogue du jeu décrit (la 27.1.0 en a ajouté 956).
    let missing = portrait_names(&catalog).difference(&pack_names).count();
    if missing > 0 {
        return Err(PackError::Incompatible(missing));
    }
    let entry = read_entry(&catalog).ok_or(PackError::UnknownGame)?;
    let mut installs = read_installs(&p.backup);
    let state = classify(&entry, &p.all_known());
    let game_size = std::fs::metadata(&p.bundle)?.len();
    // Après une mise à jour Steam, le catalogue revient d'origine alors que le bundle du pack est resté :
    // on peut alors réécrire le catalogue (c'est ce que faisait INSTALLER_MOD.bat).
    let steam_reset = state == CatalogState::Original && catalog_mismatch(p, game_size);
    if state == CatalogState::Unknown || (game_size != entry.size as u64 && !steam_reset) {
        return Err(PackError::UnknownGame);
    }
    let cached = cache_catalogs(&p.cache);
    let stale = cached.iter().any(|(f, _)| std::fs::read(f).map_or(true, |b| !same_catalog(&b, &catalog)));
    if entry.crc == crc && entry.size == size && !stale && cached.iter().all(|(_, e)| e.crc == crc && e.size == size) {
        return Ok(InstallReport { crc, size, already: true });
    }

    backup(p, &catalog, state, &cached)?;
    // Noté avant la copie : si elle échoue en route, le catalogue reste reconnu pour réinstaller ou désinstaller.
    if crc != V1_CRC && !installs.iter().any(|i| i.crc == crc && i.size == size) {
        let version = version.map(str::to_owned).or_else(|| installed_version(p, crc, size));
        installs.push(Installed { crc, size, source: pack.display().to_string(), at: now.to_owned(), version });
        write_installs(&p.backup, &installs)?;
    }

    let new_catalog = patched(&catalog, entry, crc, size);
    copy_checked(pack, &p.bundle)?;
    write_checked(&new_catalog, &p.catalog)?;
    for (file, e) in &cached {
        let bytes = std::fs::read(file)?;
        if !same_catalog(&bytes, &catalog) {
            drop_cached(file)?;
            continue;
        }
        std::fs::write(file, patched(&bytes, *e, crc, size))?;
        if p.catalog_hash.is_file() {
            std::fs::copy(&p.catalog_hash, file.with_extension("hash"))?;
        }
    }

    let check = read_entry(&std::fs::read(&p.catalog)?);
    if check.map(|c| (c.crc, c.size)) != Some((crc, size)) || std::fs::metadata(&p.bundle)?.len() != size as u64 {
        return Err(PackError::Check("catalogue".into()));
    }
    Ok(InstallReport { crc, size, already: false })
}

/// Remet les fichiers d'origine à partir de la sauvegarde.
pub fn uninstall(p: &Paths) -> Result<bool, PackError> {
    if !p.game_ok() {
        return Err(PackError::NoGame);
    }
    let entry = read_entry(&std::fs::read(&p.catalog)?).ok_or(PackError::UnknownGame)?;
    let state = classify(&entry, &p.all_known());
    if state == CatalogState::Unknown {
        return Err(PackError::UnknownGame);
    }
    let set = latest_set(&p.backup);
    // Bundle d'origine à remettre : celui gardé avec le dernier catalogue d'origine (27.1.0 et suivantes),
    // sinon celui de la première version (`backup\portraits_assets_all.bundle`).
    let set_entry = set.as_ref().and_then(|s| std::fs::read(s.join(CATALOG)).ok()).and_then(|b| read_entry(&b));
    let orig_size = match state {
        CatalogState::Original => entry.size,
        _ => set_entry.map_or(ORIG_SIZE, |e| e.size),
    };
    let bundle_is_mod = std::fs::metadata(&p.bundle)?.len() != orig_size as u64;
    let catalog_is_mod = state != CatalogState::Original;
    let dirty: Vec<_> = cache_catalogs(&p.cache).into_iter().filter(|(_, e)| classify(e, &[]) != CatalogState::Original).collect();
    if !bundle_is_mod && !catalog_is_mod && dirty.is_empty() {
        return Ok(false);
    }

    let no_backup = || PackError::NoBackup(p.backup.display().to_string());
    let bundle_backup = [set.as_ref().map(|s| s.join(BUNDLE)), Some(p.backup.join(BUNDLE))]
        .into_iter()
        .flatten()
        .find(|b| std::fs::metadata(b).map(|m| m.len()).ok() == Some(orig_size as u64));
    if bundle_is_mod && bundle_backup.is_none() {
        return Err(no_backup());
    }
    if catalog_is_mod {
        let ok = set_entry.is_some_and(|e| classify(&e, &[]) == CatalogState::Original);
        if !ok {
            return Err(no_backup());
        }
    }

    if let (true, Some(b)) = (bundle_is_mod, bundle_backup.as_ref()) {
        copy_checked(b, &p.bundle)?;
    }
    if let (true, Some(set)) = (catalog_is_mod, set.as_ref()) {
        copy_checked(&set.join(CATALOG), &p.catalog)?;
        if set.join(CATALOG_HASH).is_file() {
            copy_checked(&set.join(CATALOG_HASH), &p.catalog_hash)?;
        }
    }
    for (file, _) in dirty {
        let name = file.file_name().map(|n| n.to_owned());
        let hash = file.with_extension("hash");
        let saved = set.as_ref().zip(name.as_ref()).map(|(s, n)| s.join("cache").join(n));
        // La copie sauvegardée ne sert que si elle correspond au catalogue remis (sinon elle date d'une autre version).
        let restored = std::fs::read(&p.catalog).ok();
        let saved = saved.filter(|s| s.is_file() && std::fs::read(s).ok().zip(restored.as_ref()).is_some_and(|(b, c)| same_catalog(&b, c)));
        match saved {
            Some(saved) => {
                copy_checked(&saved, &file)?;
                let saved_hash = saved.with_extension("hash");
                if saved_hash.is_file() {
                    copy_checked(&saved_hash, &hash)?;
                }
            }
            None => {
                // Pas de copie d'origine : on retire l'entrée du cache, le jeu la reconstruit depuis son catalogue.
                std::fs::remove_file(&file)?;
                if hash.is_file() {
                    std::fs::remove_file(&hash)?;
                }
            }
        }
    }
    Ok(true)
}

/// Tailles des packs connus (v1.0, installés par l'appli ou par l'atelier) qui ont la taille du bundle en place.
fn packs_of_size(p: &Paths, bundle_size: u64) -> Vec<(u32, u32)> {
    let mut packs: Vec<(u32, u32)> = p.all_known().iter().map(|i| (i.crc, i.size)).collect();
    packs.push((V1_CRC, V1_SIZE));
    packs.into_iter().filter(|(_, size)| *size as u64 == bundle_size).collect()
}

/// État du catalogue du jeu (pour l'écran Visages).
/// Le bundle en place est un pack connu (v1.0 ou installé par l'appli, reconnu à sa taille) mais le catalogue
/// ne le décrit plus et décrit les portraits d'origine connus : une mise à jour Steam a remis le catalogue,
/// le jeu affiche des carrés blancs, et réinstaller le pack corrige (seule l'entrée des portraits est réécrite).
/// Vrai aussi quand le catalogue est bon mais qu'une copie du cache Addressables date d'une autre version du jeu
/// (corrigée par l'appli avant la mise à jour) : réinstaller la retire.
pub fn catalog_mismatch(p: &Paths, bundle_size: u64) -> bool {
    let Some(catalog) = std::fs::read(&p.catalog).ok() else { return false };
    let Some(entry) = read_entry(&catalog) else { return false };
    let same_size = packs_of_size(p, bundle_size);
    if same_size.is_empty() || classify(&entry, &p.all_known()) == CatalogState::Unknown {
        return false;
    }
    if !same_size.iter().any(|(crc, size)| *crc == entry.crc && *size == entry.size) {
        return true;
    }
    cache_catalogs(&p.cache)
        .iter()
        .any(|(f, e)| classify(e, &[]) != CatalogState::Original && std::fs::read(f).is_ok_and(|b| !same_catalog(&b, &catalog)))
}

/// Le catalogue décrit des portraits que l'appli ne connaît pas (nouvelle version de FM27 avec d'autres portraits
/// d'origine, ou autre mod) : installer et désinstaller sont bloqués, rien n'est écrit. `stale_pack` : un de nos
/// packs (fait pour l'ancienne version) est encore en place, à remplacer par Steam (vérifier les fichiers).
pub fn catalog_unknown(p: &Paths, bundle_size: u64) -> Option<bool> {
    let entry = std::fs::read(&p.catalog).ok().and_then(|b| read_entry(&b))?;
    (classify(&entry, &p.all_known()) == CatalogState::Unknown).then(|| !packs_of_size(p, bundle_size).is_empty())
}

pub fn catalog_state(p: &Paths) -> Option<CatalogState> {
    let entry = read_entry(&std::fs::read(&p.catalog).ok()?)?;
    Some(classify(&entry, &p.all_known()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Petit bundle UnityFS (version 8, table des blocs non compressée en tête, un bloc LZ4) pour les tests.
    pub fn fake_bundle(payload: &[u8]) -> Vec<u8> {
        // Bloc LZ4 : tout en littéraux (jeton 0xF0 + longueurs), format valide pour le décodeur.
        let mut block = Vec::new();
        let n = payload.len();
        if n >= 15 {
            block.push(0xF0);
            let mut rest = n - 15;
            while rest >= 255 {
                block.push(255);
                rest -= 255;
            }
            block.push(rest as u8);
        } else {
            block.push((n as u8) << 4);
        }
        block.extend_from_slice(payload);

        let mut info = vec![0u8; 16];
        info.extend_from_slice(&1u32.to_be_bytes());
        info.extend_from_slice(&(n as u32).to_be_bytes());
        info.extend_from_slice(&(block.len() as u32).to_be_bytes());
        info.extend_from_slice(&2u16.to_be_bytes());
        info.extend_from_slice(&1u32.to_be_bytes());
        info.extend_from_slice(&0u64.to_be_bytes());
        info.extend_from_slice(&(n as u64).to_be_bytes());
        info.extend_from_slice(&4u32.to_be_bytes());
        info.extend_from_slice(b"CAB-test\0");

        let mut out = b"UnityFS\0".to_vec();
        out.extend_from_slice(&8u32.to_be_bytes());
        out.extend_from_slice(b"5.x.x\0");
        out.extend_from_slice(b"6000.3.18f1\0");
        out.extend_from_slice(&0u64.to_be_bytes());
        out.extend_from_slice(&(info.len() as u32).to_be_bytes());
        out.extend_from_slice(&(info.len() as u32).to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        while out.len() % 16 != 0 {
            out.push(0);
        }
        out.extend_from_slice(&info);
        out.extend_from_slice(&block);
        let total = out.len() as u64;
        out[8 + 4 + 6 + 12..8 + 4 + 6 + 12 + 8].copy_from_slice(&total.to_be_bytes());
        out
    }

    fn fake_catalog(crc: u32, size: u32) -> Vec<u8> {
        let mut c = b"....catalog....AddrData\\".to_vec();
        c.extend_from_slice(BUNDLE.as_bytes());
        c.extend_from_slice(&[7u8; 16]);
        c.extend_from_slice(&32u32.to_le_bytes());
        c.extend_from_slice(&[b'a'; 32]);
        c.extend_from_slice(&[0u8; 8]);
        c.extend_from_slice(&crc.to_le_bytes());
        c.extend_from_slice(&size.to_le_bytes());
        c.extend_from_slice(b"...fin");
        c
    }

    #[test]
    fn crc_unity_du_contenu_decompresse() {
        let payload: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 251) as u8).collect();
        let dir = std::env::temp_dir().join(format!("fmi-pack-crc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("b.bundle");
        std::fs::write(&f, fake_bundle(&payload)).unwrap();
        assert_eq!(unity_crc(&f).unwrap(), crc_update(0xFFFF_FFFF, &payload) ^ 0xFFFF_FFFF);
        std::fs::write(&f, b"pas un bundle\0").unwrap();
        assert!(matches!(unity_crc(&f), Err(PackError::BadPack(_))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crc32_standard() {
        assert_eq!(crc_update(0xFFFF_FFFF, b"123456789") ^ 0xFFFF_FFFF, 0xCBF4_3926);
    }

    #[test]
    fn lz4_avec_reference_arriere() {
        // « abc » en littéraux, puis copie de 6 octets à 3 en arrière, puis « z ».
        let src = [0x32, b'a', b'b', b'c', 3, 0, 0x10, b'z'];
        let mut dst = vec![0u8; 10];
        lz4_decode(&src, &mut dst).unwrap();
        assert_eq!(&dst, b"abcabcabcz");
    }

    #[test]
    fn lit_et_corrige_l_entree_du_catalogue() {
        let c = fake_catalog(ORIG_CRC, ORIG_SIZE);
        let e = read_entry(&c).unwrap();
        assert_eq!((e.crc, e.size), (ORIG_CRC, ORIG_SIZE));
        assert_eq!(classify(&e, &[]), CatalogState::Original);
        let p = patched(&c, e, 42, 43);
        let e2 = read_entry(&p).unwrap();
        assert_eq!((e2.crc, e2.size), (42, 43));
        assert_eq!(classify(&e2, &[]), CatalogState::Unknown);
        let known = [Installed { crc: 42, size: 43, source: "x".into(), at: "t".into(), version: None }];
        assert_eq!(classify(&e2, &known), CatalogState::Custom);
        assert_eq!(p.len(), c.len());
        // Deux occurrences du nom : on ne touche à rien.
        let mut double = c.clone();
        double.extend_from_slice(&c);
        assert!(read_entry(&double).is_none());
    }

    /// Faux jeu complet : installation d'un pack, réinstallation d'un second, puis désinstallation.
    #[test]
    fn installe_puis_desinstalle() {
        let root = std::env::temp_dir().join(format!("fmi-pack-jeu-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let game = root.join("game");
        let p = Paths::new(&game, root.join("cache"), root.join("backup"));
        std::fs::create_dir_all(p.bundle.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&p.cache).unwrap();
        // Bundle « d'origine » : la taille doit valoir ORIG_SIZE pour être sauvegardée ; on la simule avec set_len.
        let orig = File::create(&p.bundle).unwrap();
        orig.set_len(ORIG_SIZE as u64).unwrap();
        drop(orig);
        let cat = fake_catalog(ORIG_CRC, ORIG_SIZE);
        std::fs::write(&p.catalog, &cat).unwrap();
        std::fs::write(&p.catalog_hash, b"hash").unwrap();
        std::fs::write(p.cache.join("abc.bin"), &cat).unwrap();
        std::fs::write(p.cache.join("abc.hash"), b"vieux").unwrap();

        let pack = root.join("pack.bundle");
        std::fs::write(&pack, fake_bundle(b"portraits photoreal partiels")).unwrap();
        let r = install(&p, &pack, "2026-11-07T20:00:00Z", None).unwrap();
        assert!(!r.already);
        assert_eq!(std::fs::read(&p.bundle).unwrap(), std::fs::read(&pack).unwrap());
        assert_eq!(catalog_state(&p), Some(CatalogState::Custom));
        let cached = read_entry(&std::fs::read(p.cache.join("abc.bin")).unwrap()).unwrap();
        assert_eq!((cached.crc, cached.size), (r.crc, r.size));
        assert!(p.backup.join(BUNDLE).is_file());
        assert!(latest_set(&p.backup).is_some());
        // Même pack : rien à faire.
        assert!(install(&p, &pack, "t", None).unwrap().already);

        // Un pack plus avancé remplace le premier, la sauvegarde d'origine reste.
        let pack2 = root.join("pack2.bundle");
        std::fs::write(&pack2, fake_bundle(b"portraits photoreal un peu plus avances")).unwrap();
        let r2 = install(&p, &pack2, "t2", Some("2026-11-08 15:04:50")).unwrap();
        assert_ne!(r2.crc, r.crc);
        assert_eq!(read_installs(&p.backup).len(), 2);
        assert_eq!(std::fs::metadata(p.backup.join(BUNDLE)).unwrap().len(), ORIG_SIZE as u64);

        // Mise à jour Steam : catalogue (et cache) remis d'origine, bundle du pack resté en place.
        std::fs::write(&p.catalog, &cat).unwrap();
        std::fs::write(p.cache.join("abc.bin"), &cat).unwrap();
        assert!(catalog_mismatch(&p, r2.size as u64));
        let r3 = install(&p, &pack2, "t3", None).unwrap();
        assert!(!r3.already);
        assert_eq!(catalog_state(&p), Some(CatalogState::Custom));
        assert!(!catalog_mismatch(&p, r2.size as u64));

        assert!(uninstall(&p).unwrap());
        assert_eq!(std::fs::metadata(&p.bundle).unwrap().len(), ORIG_SIZE as u64);
        assert_eq!(std::fs::read(&p.catalog).unwrap(), cat);
        assert_eq!(std::fs::read(p.cache.join("abc.bin")).unwrap(), cat);
        assert_eq!(std::fs::read(p.cache.join("abc.hash")).unwrap(), b"vieux");
        assert_eq!(catalog_state(&p), Some(CatalogState::Original));
        assert!(!uninstall(&p).unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reconnait_le_pack_de_la_bascule_v2() {
        let json = "{\n \"date\": \"2026-11-08 15:04:50\",\n \"a2b\": 2668,\n \"crc\": \"0xfb0c25a5\",\n \"taille\": 535426723,\n \"taille_mo\": 535.4\n}";
        let m = parse_manifest(json).unwrap();
        assert_eq!((m.crc, m.size, m.a2b), (0xfb0c_25a5, 535_426_723, Some(2668)));
        assert_eq!(m.version.as_deref(), Some("2026-11-08 15:04:50"));
        let release = r#"{"version":"2026-11-08 18:00","nb_a2b":3700,"nb_d2":1054,"nb_v1":9246,"crc32":4211877285,"taille":7,"sha256":"ABC","url":"https://x"}"#;
        let r = parse_manifest(release).unwrap();
        assert_eq!((r.crc, r.size, r.a2b, r.v1), (4_211_877_285, 7, Some(3700), Some(9246)));
        assert_eq!(r.sha256.as_deref(), Some("abc"));
        assert!(parse_manifest(r#"{"crc": "zz", "taille": 7}"#).is_none());
        assert!(parse_manifest(r#"{"crc": 1}"#).is_none());

        let root = std::env::temp_dir().join(format!("fmi-pack-bascule-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(root.join("v2/pack")).unwrap();
        std::fs::write(root.join("v2/pack/pack.json"), json).unwrap();
        let known = workshop_packs(&root);
        assert_eq!(known.len(), 1);
        let p = Paths::new(&root.join("game"), root.join("cache"), root.join("backup")).with_known(known);
        std::fs::create_dir_all(p.catalog.parent().unwrap()).unwrap();
        std::fs::write(&p.catalog, fake_catalog(0xfb0c_25a5, 535_426_723)).unwrap();
        assert_eq!(catalog_state(&p), Some(CatalogState::Custom));
        assert_eq!(installed_version(&p, 0xfb0c_25a5, 535_426_723).as_deref(), Some("2026-11-08 15:04:50"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// Mise à jour Steam : bundle du pack toujours là, catalogue remis d'origine (ou d'une nouvelle version).
    #[test]
    fn detecte_le_catalogue_remis_par_steam() {
        let root = std::env::temp_dir().join(format!("fmi-pack-steam-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let known = vec![Installed { crc: 42, size: 4300, source: "x".into(), at: "t".into(), version: None }];
        let p = Paths::new(&root.join("game"), root.join("cache"), root.join("backup")).with_known(known);
        std::fs::create_dir_all(p.catalog.parent().unwrap()).unwrap();
        // Pack de l'atelier en place, catalogue à jour : rien à signaler.
        std::fs::write(&p.catalog, fake_catalog(42, 4300)).unwrap();
        assert!(!catalog_mismatch(&p, 4300));
        // Catalogue d'origine (ou CRC d'une nouvelle version du jeu) avec le même bundle : carrés blancs.
        std::fs::write(&p.catalog, fake_catalog(ORIG_CRC, ORIG_SIZE)).unwrap();
        assert!(catalog_mismatch(&p, 4300));
        assert_eq!(catalog_unknown(&p, 4300), None);
        // Nouvelle version du jeu (portraits d'origine inconnus) : réinstaller ne marcherait pas, on le dit autrement.
        std::fs::write(&p.catalog, fake_catalog(7, 4300)).unwrap();
        assert!(!catalog_mismatch(&p, 4300));
        assert_eq!(catalog_unknown(&p, 4300), Some(true));
        assert_eq!(catalog_unknown(&p, 5000), Some(false));
        std::fs::write(&p.catalog, fake_catalog(ORIG_CRC, ORIG_SIZE)).unwrap();
        // Pack v1.0 en place, catalogue d'origine.
        assert!(catalog_mismatch(&p, V1_SIZE as u64));
        // Bundle d'origine ou d'un autre mod : pas notre affaire.
        assert!(!catalog_mismatch(&p, ORIG_SIZE as u64));
        assert!(!catalog_mismatch(&p, 999));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn lit_les_noms_de_portraits() {
        let n = portrait_names(b"..portrait_male-0-1-10-4-4\0portrait_female-2-13-25-2-1xx portrait_male-1-2- portrait_male-3\0portrait_male-0-1-10-4-4");
        let mut v: Vec<_> = n.into_iter().collect();
        v.sort();
        assert_eq!(v, ["portrait_female-2-13-25-2-1", "portrait_male-0-1-10-4-4"]);
        assert!(is_original(ORIG_2710_CRC, ORIG_2710_SIZE) && is_original(ORIG_CRC, ORIG_SIZE));
        assert!(!is_original(ORIG_CRC, ORIG_2710_SIZE));
    }

    /// 27.1.0 : nouveau bundle d'origine (avec des portraits en plus). Un pack fait pour la 27.0 est refusé ;
    /// le pack refait est installé, l'original de la 27.1.0 gardé à part, et la désinstallation le remet.
    #[test]
    fn version_2710_avec_nouveaux_portraits() {
        let root = std::env::temp_dir().join(format!("fmi-pack-2710-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let p = Paths::new(&root.join("game"), root.join("cache"), root.join("backup"));
        std::fs::create_dir_all(p.bundle.parent().unwrap()).unwrap();
        // Sauvegarde de la 27.0 déjà là (installation d'avant la mise à jour).
        std::fs::create_dir_all(&p.backup).unwrap();
        File::create(p.backup.join(BUNDLE)).unwrap().set_len(ORIG_SIZE as u64).unwrap();
        // Jeu en 27.1.0 : bundle et catalogue d'origine, qui cite deux portraits.
        File::create(&p.bundle).unwrap().set_len(ORIG_2710_SIZE as u64).unwrap();
        let mut cat = fake_catalog(ORIG_2710_CRC, ORIG_2710_SIZE);
        cat.extend_from_slice(b"portrait_male-0-1-10-4-0\0portrait_male-0-1-10-4-4\0");
        std::fs::write(&p.catalog, &cat).unwrap();
        assert_eq!(catalog_state(&p), Some(CatalogState::Original));

        let old = root.join("old.bundle");
        std::fs::write(&old, fake_bundle(b"portrait_male-0-1-10-4-0 seulement")).unwrap();
        assert!(matches!(install(&p, &old, "t", None), Err(PackError::Incompatible(1))));
        assert_eq!(std::fs::read(&p.catalog).unwrap(), cat);

        let pack = root.join("pack.bundle");
        std::fs::write(&pack, fake_bundle(b"portrait_male-0-1-10-4-0 portrait_male-0-1-10-4-4")).unwrap();
        install(&p, &pack, "t", Some("2026-11-17 16:00:00")).unwrap();
        assert_eq!(catalog_state(&p), Some(CatalogState::Custom));
        let set = latest_set(&p.backup).unwrap();
        assert_eq!(std::fs::metadata(set.join(BUNDLE)).unwrap().len(), ORIG_2710_SIZE as u64);
        assert_eq!(std::fs::metadata(p.backup.join(BUNDLE)).unwrap().len(), ORIG_SIZE as u64);

        assert!(uninstall(&p).unwrap());
        assert_eq!(std::fs::metadata(&p.bundle).unwrap().len(), ORIG_2710_SIZE as u64);
        assert_eq!(std::fs::read(&p.catalog).unwrap(), cat);
        assert!(!uninstall(&p).unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuse_un_catalogue_inconnu() {
        let root = std::env::temp_dir().join(format!("fmi-pack-inconnu-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let p = Paths::new(&root.join("game"), root.join("cache"), root.join("backup"));
        std::fs::create_dir_all(p.bundle.parent().unwrap()).unwrap();
        std::fs::write(&p.bundle, b"x").unwrap();
        std::fs::write(&p.catalog, fake_catalog(1, 1)).unwrap();
        let pack = root.join("pack.bundle");
        std::fs::write(&pack, fake_bundle(b"abc")).unwrap();
        assert!(matches!(install(&p, &pack, "t", None), Err(PackError::UnknownGame)));
        assert_eq!(read_entry(&std::fs::read(&p.catalog).unwrap()).unwrap().crc, 1);
        assert!(matches!(uninstall(&p), Err(PackError::UnknownGame)));
        std::fs::remove_dir_all(&root).ok();
    }

    /// Version finale de FM27 : nouveaux portraits d'origine (CRC inconnu) avec notre pack resté en place, ou
    /// remplacé par Steam. Rien n'est écrit, ni installation ni désinstallation (l'ancienne sauvegarde ne convient plus).
    #[test]
    fn bloque_une_nouvelle_version_des_portraits() {
        let root = std::env::temp_dir().join(format!("fmi-pack-finale-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let pack = root.join("pack.bundle");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&pack, fake_bundle(b"pack fait sur la beta")).unwrap();
        let (crc, size) = (unity_crc(&pack).unwrap(), std::fs::metadata(&pack).unwrap().len() as u32);
        let known = vec![Installed { crc, size, source: "x".into(), at: "t".into(), version: None }];
        let p = Paths::new(&root.join("game"), root.join("cache"), root.join("backup")).with_known(known);
        std::fs::create_dir_all(p.bundle.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&p.backup).unwrap();
        std::fs::copy(&pack, &p.bundle).unwrap();
        let retail = fake_catalog(0x1234_5678, 9_999);
        std::fs::write(&p.catalog, &retail).unwrap();
        assert!(!catalog_mismatch(&p, size as u64));
        assert_eq!(catalog_unknown(&p, size as u64), Some(true));
        assert!(matches!(install(&p, &pack, "t", None), Err(PackError::UnknownGame)));
        assert!(matches!(uninstall(&p), Err(PackError::UnknownGame)));
        // Steam a aussi remis le bundle : nouveaux portraits d'origine, le pack de la beta est refusé.
        std::fs::write(&p.bundle, vec![0u8; 9_999]).unwrap();
        assert_eq!(catalog_unknown(&p, 9_999), Some(false));
        assert!(matches!(install(&p, &pack, "t", None), Err(PackError::UnknownGame)));
        assert_eq!(std::fs::read(&p.catalog).unwrap(), retail);
        assert_eq!(std::fs::metadata(&p.bundle).unwrap().len(), 9_999);
        std::fs::remove_dir_all(&root).ok();
    }

    /// Mise à jour Steam avec un nouveau catalogue : la copie du cache corrigée sur l'ancien catalogue est retirée
    /// (le jeu la reconstruit), jamais corrigée en place avec l'empreinte du nouveau.
    #[test]
    fn retire_le_cache_d_une_autre_version() {
        let root = std::env::temp_dir().join(format!("fmi-pack-cache-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let p0 = Paths::new(&root.join("game"), root.join("cache"), root.join("backup"));
        std::fs::create_dir_all(p0.bundle.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&p0.cache).unwrap();
        let orig = File::create(&p0.bundle).unwrap();
        orig.set_len(ORIG_SIZE as u64).unwrap();
        drop(orig);
        let beta = fake_catalog(ORIG_CRC, ORIG_SIZE);
        std::fs::write(&p0.catalog, &beta).unwrap();
        std::fs::write(&p0.catalog_hash, b"hash-beta").unwrap();
        std::fs::write(p0.cache.join("abc.bin"), &beta).unwrap();
        std::fs::write(p0.cache.join("abc.hash"), b"hash-beta").unwrap();
        let pack = root.join("pack.bundle");
        std::fs::write(&pack, fake_bundle(b"pack")).unwrap();
        let r = install(&p0, &pack, "t", None).unwrap();
        let p = Paths::new(&root.join("game"), root.join("cache"), root.join("backup")).with_known(read_installs(&p0.backup));

        // Steam : nouveau catalogue (portraits d'origine inchangés), le cache garde l'ancien catalogue corrigé.
        let mut retail = beta.clone();
        retail.extend_from_slice(b"...nouvelles entrees de la version finale");
        std::fs::write(&p.catalog, &retail).unwrap();
        std::fs::write(&p.catalog_hash, b"hash-finale").unwrap();
        assert!(catalog_mismatch(&p, r.size as u64));
        install(&p, &pack, "t2", None).unwrap();
        assert!(!p.cache.join("abc.bin").exists());
        assert!(!p.cache.join("abc.hash").exists());
        assert_eq!(read_entry(&std::fs::read(&p.catalog).unwrap()).map(|e| (e.crc, e.size)), Some((r.crc, r.size)));
        assert!(!catalog_mismatch(&p, r.size as u64));
        // Désinstaller remet le catalogue de la version finale, pas l'ancien cache.
        assert!(uninstall(&p).unwrap());
        assert_eq!(std::fs::read(&p.catalog).unwrap(), retail);
        assert!(!p.cache.join("abc.bin").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    /// Vérification sur les vrais fichiers du jeu (hors CI) :
    /// `FMI_BUNDLE=… FMI_CATALOG_ORIG=… FMI_CATALOG_V1=… cargo test fichiers_reels -- --ignored`
    #[test]
    #[ignore]
    fn fichiers_reels() {
        let var = |k: &str| std::env::var(k).ok().map(PathBuf::from);
        if let Some(b) = var("FMI_BUNDLE") {
            assert_eq!(unity_crc(&b).unwrap(), ORIG_CRC);
        }
        if let Some(c) = var("FMI_CATALOG_ORIG") {
            let e = read_entry(&std::fs::read(c).unwrap()).unwrap();
            assert_eq!(classify(&e, &[]), CatalogState::Original);
        }
        if let Some(c) = var("FMI_CATALOG_V1") {
            let e = read_entry(&std::fs::read(c).unwrap()).unwrap();
            assert_eq!(classify(&e, &[]), CatalogState::V1);
        }
    }
}

