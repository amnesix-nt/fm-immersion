//! Tactiques FM27 exportées par le joueur (`.fmf` du dossier `tactics`, à côté de `games`), lues hors jeu
//! pour les importer dans l'éditeur de FM Immersion. Lecture seule : rien n'est écrit dans ce dossier.
//!
//! Conteneur relevé par notre propre analyse du code du jeu (11/11/2026) :
//! - en-tête de 26 octets : u8 2, u8, magie (« afe. » ou « fmf. »), u16 8, u8, u64 position du répertoire
//!   (comptée depuis l'octet 9), u64 17, u8 compression ;
//! - répertoire à 9 + position : `02 01 "fmf." 08 00 00` puis une trame zstd : arborescence (nom, fichiers, sous-dossiers),
//!   chaque fichier = nom, extension, u64 position (depuis l'octet 26), u64 taille stockée, u64 taille réelle, 16 octets ;
//! - chaque fichier stocké : u32 16, u32 16, clé AES-128 (16), IV (16), puis le contenu chiffré en AES-CTR
//!   (compteur 128 bits gros-boutiste), qui est une trame zstd. C'est la forme des exports du jeu (magie « afe. ») ;
//!   un fichier écrit par le sérialiseur du jeu hors de l'écran d'export (magie « fmf. », ex. FM Tactics Lab) range
//!   directement la trame zstd, sans chiffrement.
//!
//! On renvoie le fichier `.tac` déchiffré ; son contenu (postes, rôles, mentalité) est lu côté TypeScript
//! (`modules/fm/src/tactic-file.ts`).

use std::io::Read;
use std::path::{Path, PathBuf};

use aes::cipher::{KeyIvInit, StreamCipher};
use serde::Serialize;

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;

/// Taille maximale d'un fichier de tactique lu (les vrais font 1 à 10 Ko).
const MAX_FILE: u64 = 4 * 1024 * 1024;
/// Taille maximale d'un fichier décompressé.
const MAX_UNPACKED: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FmTacticFile {
    /// Nom du fichier, extension comprise.
    pub name: String,
    pub modified_ms: Option<u64>,
    pub bytes: u64,
}

/// Dossier des tactiques exportées : `tactics`, à côté du dossier `archivix` du plugin
/// (ex. D:\Sports Interactive\Football Manager 27\tactics).
pub fn tactics_dir(plugin_folder: &Path) -> Option<PathBuf> {
    if !plugin_folder.is_absolute() {
        return None;
    }
    Some(plugin_folder.parent()?.join("tactics"))
}

/// Liste les `.fmf` du dossier, la plus récente d'abord.
pub fn list_tactic_files(dir: &Path) -> Vec<FmTacticFile> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<FmTacticFile> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            let is_fmf = Path::new(&name).extension().is_some_and(|x| x.eq_ignore_ascii_case("fmf"));
            if !meta.is_file() || !is_fmf || meta.len() > MAX_FILE {
                return None;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            Some(FmTacticFile { name, modified_ms, bytes: meta.len() })
        })
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.name.cmp(&b.name)));
    out
}

struct Cursor<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or("répertoire tronqué")?;
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn str(&mut self) -> Result<String, String> {
        let n = self.u32()? as usize;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
}

struct Entry {
    name: String,
    offset: u64,
    stored: u64,
    size: u64,
}

fn read_dir_tree(c: &mut Cursor, out: &mut Vec<Entry>, depth: u32) -> Result<(), String> {
    if depth > 8 {
        return Err("répertoire trop profond".into());
    }
    let _folder = c.str()?;
    let files = c.u32()?;
    if files > 1000 {
        return Err("répertoire invalide".into());
    }
    for _ in 0..files {
        let name = c.str()?;
        let ext = c.str()?;
        let (offset, stored, size) = (c.u64()?, c.u64()?, c.u64()?);
        c.take(16)?;
        out.push(Entry { name: name + &ext, offset, stored, size });
    }
    let subs = c.u32()?;
    if subs > 100 {
        return Err("répertoire invalide".into());
    }
    for _ in 0..subs {
        read_dir_tree(c, out, depth + 1)?;
    }
    Ok(())
}

fn unzstd(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut dec = ruzstd::decoding::StreamingDecoder::new(data).map_err(|e| format!("zstd : {e}"))?;
    let mut out = Vec::new();
    (&mut dec).take(MAX_UNPACKED as u64 + 1).read_to_end(&mut out).map_err(|e| format!("zstd : {e}"))?;
    if out.len() > MAX_UNPACKED {
        return Err("fichier trop gros".into());
    }
    Ok(out)
}

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// Déchiffre un fichier stocké (clé et IV en tête), puis le décompresse s'il est en zstd.
/// Un fichier non chiffré (trame zstd directe) est seulement décompressé.
fn unpack(seg: &[u8]) -> Result<Vec<u8>, String> {
    if seg.starts_with(&ZSTD_MAGIC) {
        return unzstd(seg);
    }
    if seg.len() < 40 || seg[..8] != [16, 0, 0, 0, 16, 0, 0, 0] {
        return Err("fichier stocké illisible".into());
    }
    let mut data = seg[40..].to_vec();
    let mut cipher = Aes128Ctr::new(seg[8..24].into(), seg[24..40].into());
    cipher.apply_keystream(&mut data);
    if data.starts_with(&ZSTD_MAGIC) {
        unzstd(&data)
    } else {
        Ok(data)
    }
}

/// Contenu `.tac` d'une tactique exportée.
pub fn tac_of_fmf(d: &[u8]) -> Result<Vec<u8>, String> {
    if d.len() < 26 || d[0] != 2 {
        return Err("ce n'est pas un fichier FM27".into());
    }
    let dir_off = u64::from_le_bytes(d[9..17].try_into().unwrap());
    let dir = usize::try_from(dir_off).ok().and_then(|o| o.checked_add(9)).filter(|&o| o + 9 <= d.len()).ok_or("répertoire introuvable")?;
    if &d[dir..dir + 6] != b"\x02\x01fmf." {
        return Err("répertoire introuvable".into());
    }
    let tree = unzstd(&d[dir + 9..])?;
    let mut entries = Vec::new();
    read_dir_tree(&mut Cursor { b: &tree, p: 0 }, &mut entries, 0)?;
    let e = entries.iter().find(|e| e.name.to_ascii_lowercase().ends_with(".tac")).ok_or("pas de tactique dans ce fichier (coups de pied arrêtés seuls ?)")?;
    let start = usize::try_from(e.offset).ok().and_then(|o| o.checked_add(26)).ok_or("fichier invalide")?;
    let end = usize::try_from(e.stored).ok().and_then(|s| start.checked_add(s)).filter(|&x| x <= d.len()).ok_or("fichier tronqué")?;
    let tac = unpack(&d[start..end])?;
    if tac.len() as u64 != e.size {
        return Err("taille inattendue".into());
    }
    Ok(tac)
}

/// Tactiques exportées dans le dossier `tactics` du joueur.
#[tauri::command]
pub fn fm_list_tactic_files(folder: String) -> Vec<FmTacticFile> {
    tactics_dir(Path::new(&folder)).map(|d| list_tactic_files(&d)).unwrap_or_default()
}

/// Contenu `.tac` d'une tactique du dossier, par nom de fichier (sans chemin).
#[tauri::command]
pub fn fm_read_tactic_file(folder: String, name: String) -> Result<Vec<u8>, String> {
    let ok_name = !name.is_empty() && !name.contains(['/', '\\', ':']) && name != "." && name != "..";
    if !ok_name || !Path::new(&name).extension().is_some_and(|x| x.eq_ignore_ascii_case("fmf")) {
        return Err("nom de fichier invalide".into());
    }
    let dir = tactics_dir(Path::new(&folder)).ok_or("dossier du plugin inconnu")?;
    let path = dir.join(&name);
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE {
        return Err("fichier trop gros".into());
    }
    tac_of_fmf(&std::fs::read(&path).map_err(|e| e.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIVOT_GANG: &[u8] = include_bytes!("testdata/pivot-gang.fmf");
    /// Même disposition qu'un fichier écrit par le sérialiseur du jeu (« fmf. », zstd sans chiffrement), construit
    /// à partir du `.tac` de Pivot Gang renommé.
    const ELITE_ZSTD: &[u8] = include_bytes!("testdata/pivot-gang-elite-zstd.fmf");

    #[test]
    fn lit_le_tac_d_une_tactique_exportee() {
        let tac = tac_of_fmf(PIVOT_GANG).unwrap();
        assert_eq!(tac.len(), 1431);
        assert_eq!(&tac[2..6], b"cat.");
        let n = u32::from_le_bytes(tac[16..20].try_into().unwrap()) as usize;
        assert_eq!(&tac[20..20 + n], b"PSG adapte Slutsk - FM Immersion");
    }

    #[test]
    fn lit_un_fichier_non_chiffre() {
        let tac = tac_of_fmf(ELITE_ZSTD).unwrap();
        assert_eq!(&tac[2..6], b"cat.");
        let n = u32::from_le_bytes(tac[16..20].try_into().unwrap()) as usize;
        assert_eq!(&tac[20..20 + n], b"Pivot Gang Elite");
    }

    #[test]
    fn refuse_un_fichier_abime() {
        assert!(tac_of_fmf(b"pas une tactique").is_err());
        let mut bad = PIVOT_GANG.to_vec();
        bad.truncate(200);
        assert!(tac_of_fmf(&bad).is_err());
    }

    #[test]
    fn liste_les_tactiques_du_dossier() {
        let root = std::env::temp_dir().join(format!("fmi-tactics-{}", std::process::id()));
        let plugin = root.join("archivix");
        let dir = root.join("tactics");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Pivot Gang.fmf"), PIVOT_GANG).unwrap();
        std::fs::write(dir.join("config.xml"), b"<x/>").unwrap();
        let list = fm_list_tactic_files(plugin.to_string_lossy().into_owned());
        assert_eq!(list.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["Pivot Gang.fmf"]);
        let tac = fm_read_tactic_file(plugin.to_string_lossy().into_owned(), "Pivot Gang.fmf".into()).unwrap();
        assert_eq!(tac.len(), 1431);
        assert!(fm_read_tactic_file(plugin.to_string_lossy().into_owned(), "..\\games\\x.fmf".into()).is_err());
        assert!(fm_read_tactic_file(plugin.to_string_lossy().into_owned(), "config.xml".into()).is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
