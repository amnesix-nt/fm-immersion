//! Programme d'entraînement d'équipe pour FM27 : l'appli écrit la semaine conseillée dans un fichier
//! `.fmf` du dossier `schedules` du jeu (à côté de `games`), que le joueur charge lui-même dans l'écran
//! Entraînement de FM27 (bouton de chargement d'un programme). Rien n'est écrit dans la partie.
//!
//! Format relevé le 17/11/2026 sur un programme exporté par FM27 27.1 (même conteneur que les tactiques) :
//! - en-tête `02 01 afe.` + segments (u32 16, u32 16, clé, IV, AES-128-CTR d'une trame zstd), puis le
//!   répertoire `02 01 fmf.` (trame zstd) : `image.img`, `<nom>.tsc` et `_data/details.aom` ;
//! - `.tsc` : `03 01 cst. 03 00 05`, u32 1, puis 7 jours × (drapeau premier jour, 04, 3 séances u16),
//!   00, description, 8 octets nuls ;
//! - `details.aom` : `SCHEDULE_TYPE_HANDLER`, nom, description, auteur, fin reprise de l'export du jeu.
//! Codes des séances : voir `modules/fm/src/training-fm27.ts`.

use serde::{Serialize, Serializer};
use std::path::{Path, PathBuf};

/// Séance « Repos » : créneau vide.
pub const REST: u16 = 300;
/// Fin de `details.aom` d'un programme exporté par le jeu (reprise telle quelle).
const AOM_TRAILER: [u8; 22] = [
    0x02, 0x00, 0x01, 0x00, 0x02, 0x19, 0x0c, 0xa8, 0x04, 0x01, 0x00, 0x10, 0x01, 0x0b, 0xea, 0xb0, 0x4d, 0x1d, 0xc9,
    0x02, 0x30, 0x10,
];
/// Horodatage écrit par le jeu pour chaque fichier du répertoire.
const STAMP: [u8; 8] = [0x00, 0x09, 0x6e, 0x88, 0xf1, 0xff, 0xff, 0xff];

#[derive(Debug, thiserror::Error)]
pub enum ScheduleError {
    #[error("dossier invalide")]
    InvalidFolder,
    #[error("programme invalide : {0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for ScheduleError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Codes de séance connus du jeu (tactique, préparation de match, développement, physique, extra, match).
fn known_code(c: u16) -> bool {
    matches!(c, 0..=7 | 100..=108 | 200..=203 | 300..=304 | 400..=401 | 500)
}

fn lp(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u32).to_le_bytes());
    out.extend_from_slice(b);
}

/// Contenu du fichier `.tsc` : 7 jours de 3 séances.
pub fn tsc(days: &[[u16; 3]; 7], desc: &str) -> Vec<u8> {
    let mut out = b"\x03\x01cst.\x03\x00\x05".to_vec();
    out.extend_from_slice(&1u32.to_le_bytes());
    for (i, d) in days.iter().enumerate() {
        out.push(u8::from(i == 0));
        out.push(4);
        for s in d {
            out.extend_from_slice(&s.to_le_bytes());
        }
    }
    out.push(0);
    lp(&mut out, desc.as_bytes());
    out.extend_from_slice(&[0; 8]);
    out
}

/// Contenu de `details.aom` : nom, description et auteur du programme.
pub fn aom(name: &str, desc: &str, author: &str) -> Vec<u8> {
    let mut out = b"\x03\x01moa.\x04\x00".to_vec();
    lp(&mut out, b"SCHEDULE_TYPE_HANDLER");
    lp(&mut out, name.as_bytes());
    lp(&mut out, desc.as_bytes());
    out.extend_from_slice(&[0; 6]);
    out.extend_from_slice(&[0xff; 16]);
    lp(&mut out, author.as_bytes());
    out.extend_from_slice(&AOM_TRAILER);
    out
}

/// Trame zstd sans compression (un bloc brut) avec somme de contrôle, comme celles du jeu.
pub fn zstd_raw(data: &[u8]) -> Vec<u8> {
    assert!(data.len() < 4096);
    let mut out = vec![0x28, 0xb5, 0x2f, 0xfd];
    out.push(0x04); // descripteur : somme de contrôle, pas de taille du contenu
    out.push(0x10); // fenêtre de 4 Kio
    let header = 1u32 | ((data.len() as u32) << 3); // dernier bloc, type brut
    out.extend_from_slice(&header.to_le_bytes()[..3]);
    out.extend_from_slice(data);
    let sum = xxhash_rust::xxh64::xxh64(data, 0) as u32;
    out.extend_from_slice(&sum.to_le_bytes());
    out
}

/// AES-128-CTR (compteur 128 bits gros-boutiste) : chiffre et déchiffre.
pub fn ctr(key: &[u8; 16], iv: &[u8; 16], data: &mut [u8]) {
    use aes::cipher::{KeyIvInit, StreamCipher};
    let mut c = ctr::Ctr128BE::<aes::Aes128>::new(key.into(), iv.into());
    c.apply_keystream(data);
}

fn segment(data: &[u8], seed: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let h = Sha256::new().chain_update(seed).chain_update(data).finalize();
    let key: [u8; 16] = h[..16].try_into().unwrap();
    let iv: [u8; 16] = h[16..].try_into().unwrap();
    let mut z = zstd_raw(data);
    ctr(&key, &iv, &mut z);
    let mut out = Vec::with_capacity(40 + z.len());
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&key);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&z);
    out
}

fn entry(out: &mut Vec<u8>, name: &[u8], ext: &[u8], off: usize, cs: usize, us: usize) {
    lp(out, name);
    lp(out, ext);
    for v in [off, cs, us] {
        out.extend_from_slice(&(v as u64).to_le_bytes());
    }
    out.extend_from_slice(&STAMP);
    out.extend_from_slice(&STAMP);
}

/// Fichier `.fmf` complet. `seed` rend les clés différentes d'un fichier à l'autre (aucun secret ici).
pub fn fmf(name: &str, tsc_b: &[u8], aom_b: &[u8], seed: &[u8]) -> Vec<u8> {
    let img = [1u8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let (sa, si, st) = (segment(aom_b, seed), segment(&img, seed), segment(tsc_b, seed));
    let n = name.as_bytes();
    let mut d = Vec::new();
    lp(&mut d, n);
    d.extend_from_slice(&2u32.to_le_bytes());
    entry(&mut d, b"image", b".img", sa.len(), si.len(), img.len());
    entry(&mut d, n, b".tsc", sa.len() + si.len(), st.len(), tsc_b.len());
    d.extend_from_slice(&1u32.to_le_bytes());
    lp(&mut d, b"_data");
    d.extend_from_slice(&1u32.to_le_bytes());
    entry(&mut d, b"details", b".aom", 0, sa.len(), aom_b.len());
    d.extend_from_slice(&0u32.to_le_bytes());
    let body_len = sa.len() + si.len() + st.len();
    let mut out = b"\x02\x01afe.\x08\x00\x00".to_vec();
    out.extend_from_slice(&((17 + body_len) as u64).to_le_bytes());
    out.extend_from_slice(&17u64.to_le_bytes());
    out.push(3);
    out.extend_from_slice(&sa);
    out.extend_from_slice(&si);
    out.extend_from_slice(&st);
    out.extend_from_slice(b"\x02\x01fmf.\x08\x00\x00");
    out.extend_from_slice(&zstd_raw(&d));
    out
}

/// Dossier `schedules` du jeu, à côté du dossier `archivix` du plugin.
pub fn schedules_dir(plugin_folder: &Path) -> Option<PathBuf> {
    if !plugin_folder.is_absolute() {
        return None;
    }
    Some(plugin_folder.parent()?.join("schedules"))
}

/// Nom de programme sûr pour un nom de fichier Windows (le jeu affiche ce nom dans sa liste).
fn clean_name(name: &str) -> Result<String, ScheduleError> {
    let n: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let n = n.trim().trim_end_matches('.').to_string();
    if n.is_empty() || n.chars().count() > 60 {
        return Err(ScheduleError::Invalid("nom"));
    }
    Ok(n)
}

/// Écrit le programme et renvoie le chemin du fichier.
pub fn write_schedule(plugin_folder: &Path, name: &str, desc: &str, days: &[Vec<u16>]) -> Result<PathBuf, ScheduleError> {
    let dir = schedules_dir(plugin_folder).ok_or(ScheduleError::InvalidFolder)?;
    if !dir.parent().is_some_and(|p| p.is_dir()) {
        return Err(ScheduleError::InvalidFolder);
    }
    let name = clean_name(name)?;
    if desc.len() > 400 {
        return Err(ScheduleError::Invalid("description"));
    }
    if days.len() != 7 {
        return Err(ScheduleError::Invalid("7 jours attendus"));
    }
    let mut week = [[REST; 3]; 7];
    for (i, d) in days.iter().enumerate() {
        if d.len() != 3 || !d.iter().all(|c| known_code(*c)) {
            return Err(ScheduleError::Invalid("séance inconnue"));
        }
        week[i] = [d[0], d[1], d[2]];
    }
    std::fs::create_dir_all(&dir)?;
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_le_bytes().to_vec())
        .unwrap_or_default();
    let bytes = fmf(&name, &tsc(&week, desc), &aom(&name, desc, "FM Immersion"), &seed);
    let path = dir.join(format!("{name}.fmf"));
    let tmp = dir.join(format!("{name}.fmf.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Écrit la semaine conseillée dans `schedules` ; le joueur la charge dans FM27.
#[tauri::command]
pub fn fm_write_schedule(folder: String, name: String, description: String, days: Vec<Vec<u16>>) -> Result<String, ScheduleError> {
    write_schedule(Path::new(&folder), &name, &description, &days).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    // Fichiers déchiffrés du programme « fmimmertest » exporté par FM27 27.1 (17/11/2026).
    const GAME_TSC: &str = "03016373742e0300050100000001042c012c012c0100042f01c9002c010004ca002e012c010004c80006002c0100042c012c012c010004070006002c01000405002c012c01001b0000004465736372697074696f6e2064752070726f6772616d6d652e2e2e0000000000000000";
    const GAME_AOM: &str = "03016d6f612e0400150000005343484544554c455f545950455f48414e444c45520b000000666d696d6d65727465737400000000000000000000ffffffffffffffffffffffffffffffff07000000416d6e657369780200010002190ca804010010010beab04d1dc9023010";

    #[test]
    fn tsc_and_aom_match_game_export() {
        let days = [[300, 300, 300], [303, 201, 300], [202, 302, 300], [200, 6, 300], [300, 300, 300], [7, 6, 300], [5, 300, 300]];
        assert_eq!(tsc(&days, "Description du programme..."), hex(GAME_TSC));
        assert_eq!(aom("fmimmertest", "", "Amnesix"), hex(GAME_AOM));
    }

    #[test]
    fn segments_decrypt_to_raw_zstd() {
        let data = b"bonjour".to_vec();
        let seg = segment(&data, b"x");
        assert_eq!(&seg[..8], &[16, 0, 0, 0, 16, 0, 0, 0]);
        let key: [u8; 16] = seg[8..24].try_into().unwrap();
        let iv: [u8; 16] = seg[24..40].try_into().unwrap();
        let mut z = seg[40..].to_vec();
        ctr(&key, &iv, &mut z);
        assert_eq!(&z[..4], &[0x28, 0xb5, 0x2f, 0xfd]);
        assert_eq!(&z[9..9 + data.len()], &data[..]);
    }

    #[test]
    fn aes_ctr_known_vector() {
        // NIST SP 800-38A F.5.1, premier bloc.
        let key: [u8; 16] = hex("2b7e151628aed2a6abf7158809cf4f3c").try_into().unwrap();
        let iv: [u8; 16] = hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff").try_into().unwrap();
        let mut b = hex("6bc1bee22e409f96e93d7e117393172a");
        ctr(&key, &iv, &mut b);
        assert_eq!(b, hex("874d6191b620e3261bef6864990db6ce"));
    }

    #[test]
    fn rejects_bad_input() {
        let dir = std::env::temp_dir().join("fmi-sched-test").join("archivix");
        std::fs::create_dir_all(&dir).unwrap();
        let ok = vec![vec![300, 300, 300]; 7];
        assert!(write_schedule(&dir, "  ", "", &ok).is_err());
        assert!(write_schedule(&dir, "x", "", &ok[..6]).is_err());
        let mut bad = ok.clone();
        bad[2][1] = 999;
        assert!(write_schedule(&dir, "x", "", &bad).is_err());
        let p = write_schedule(&dir, "FM Immersion : semaine/test", "", &ok).unwrap();
        assert!(p.ends_with("schedules/FM Immersion  semainetest.fmf") || p.to_string_lossy().contains("semainetest"));
        assert!(write_schedule(Path::new("relatif"), "x", "", &ok).is_err());
    }
}
