//! Lecture directe de la base de FM27 en mémoire, de l'extérieur du jeu et en lecture seule.
//!
//! FM Immersion ouvre le processus `fm.exe` avec les seuls droits de lecture (`PROCESS_VM_READ`) et lit la base
//! native du moteur (module `game_plugin.dll`). Il n'écrit jamais dans le jeu, n'y injecte rien et n'y lance
//! aucun code : une adresse invalide fait seulement échouer la lecture, sans effet sur la partie.
//! Rien ne se lit sans une action du joueur dans l'interface.
//!
//! Les adresses viennent de notre propre analyse hors jeu de `game_plugin.dll` (FM27 du 29/10/2026) :
//! - trois points d'entrée globaux, retrouvés à chaque lancement par des motifs d'octets cherchés dans le
//!   fichier du module sur disque (ils survivent à un patch tant que le code autour ne change pas) ;
//! - la disposition des objets (joueur, personne, contrat, équipe, club), fixée pour cette version.
//!   Chaque lecture est contrôlée (valeurs plausibles) : si la structure ne correspond plus, on s'arrête.

// Hors Windows, seule la partie testable est utilisée.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Serialize, Serializer};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ---------------------------------------------------------------------------------------------
// Erreurs

#[derive(Debug, thiserror::Error)]
pub enum MemError {
    #[cfg_attr(windows, allow(dead_code))]
    #[error("lecture directe disponible uniquement sous Windows")]
    Unsupported,
    #[error("FM27 n'est pas lancé")]
    NotRunning,
    #[error("FM27 est lancé mais sa base n'est pas encore chargée : réessaie une fois la partie ouverte")]
    ModuleMissing,
    #[error("accès au processus de FM27 refusé")]
    AccessDenied,
    #[error("version de FM27 non reconnue : {0}")]
    UnknownVersion(String),
    #[error("aucune partie chargée dans FM27")]
    NoSave,
    #[error("structure inattendue ({0}) : la lecture est arrêtée")]
    Unexpected(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for MemError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// Accès mémoire (abstrait : le processus du jeu sous Windows, une mémoire simulée dans les tests)

pub trait Mem {
    /// Copie `buf.len()` octets depuis `addr` ; `false` si la zone n'est pas lisible en entier.
    fn read(&self, addr: u64, buf: &mut [u8]) -> bool;
}

/// Adresse plausible d'un objet du jeu (espace utilisateur Windows x64).
fn valid(p: u64) -> bool {
    (0x10000..0x7FFF_FFFF_0000).contains(&p)
}

struct R<'a, M: Mem>(&'a M);

impl<M: Mem> R<'_, M> {
    fn bytes(&self, addr: u64, len: usize) -> Option<Vec<u8>> {
        if !valid(addr) {
            return None;
        }
        let mut b = vec![0u8; len];
        self.0.read(addr, &mut b).then_some(b)
    }
    fn arr<const N: usize>(&self, addr: u64) -> Option<[u8; N]> {
        if !valid(addr) {
            return None;
        }
        let mut b = [0u8; N];
        self.0.read(addr, &mut b).then_some(b)
    }
    fn u8(&self, a: u64) -> Option<u8> {
        self.arr::<1>(a).map(|b| b[0])
    }
    fn i16(&self, a: u64) -> Option<i16> {
        self.arr::<2>(a).map(i16::from_le_bytes)
    }
    fn i32(&self, a: u64) -> Option<i32> {
        self.arr::<4>(a).map(i32::from_le_bytes)
    }
    fn ptr(&self, a: u64) -> Option<u64> {
        self.arr::<8>(a).map(u64::from_le_bytes).filter(|&p| valid(p))
    }
    /// Chaîne du jeu : pointeur `p` vers `[p+0]` longueur (int32) puis les octets (UTF-8 supposé).
    fn string_at(&self, p: u64) -> Option<String> {
        let len = self.i32(p)?;
        if !(1..=512).contains(&len) {
            return None;
        }
        let b = self.bytes(p + 4, len as usize)?;
        Some(decode(&b)).filter(|s| !s.trim().is_empty())
    }
    /// Champ qui contient directement le pointeur de chaîne.
    fn string(&self, field: u64) -> Option<String> {
        self.string_at(self.ptr(field)?)
    }
    /// Champ qui pointe vers un enregistrement dont le premier mot est la chaîne (prénoms, noms).
    fn string_indirect(&self, field: u64) -> Option<String> {
        self.string(self.ptr(field)?)
    }
}

/// UTF-8 si valide, sinon Latin-1 (l'encodage des noms reste à confirmer en jeu).
fn decode(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b.iter().map(|&c| c as char).collect(),
    }
}

fn le_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn le_i16(b: &[u8], o: usize) -> i16 {
    le_u16(b, o) as i16
}
fn le_i32(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn le_u64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

// ---------------------------------------------------------------------------------------------
// Points d'entrée : motifs d'octets cherchés dans game_plugin.dll

/// RVA des trois points d'entrée (à ajouter à l'adresse de chargement du module).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Globals {
    /// Objet statique `db::DATABASE`.
    pub database: u64,
    /// Pointeur vers le gestionnaire des managers humains.
    pub humans: u64,
    /// Date courante du jeu (date de 4 octets, statique).
    pub date: u64,
}

/// Valeurs trouvées dans FM27 du 29/10/2026 (game_plugin.dll, SHA-256 bc940e47…0fe057f).
pub const KNOWN: Globals = Globals { database: 0x57036D0, humans: 0x56F3008, date: 0x56AD378 };

/// Vtable (RVA) d'un contrat d'essai (`TRIAL_CONTRACT`) pour cette version : il occupe la même place que
/// le contrat de prêt (`[ACTUAL_PERSON+0x88]+0`) mais n'en est pas un (vérifié en partie le 01/11, 1 cas).
pub const KNOWN_TRIAL_VTABLE: u64 = 0x4C8EB78;

/// FM27 mis à jour le 03/11/2026 (game_plugin.dll de 404 308 480 octets, SHA-256 252ff8fb…89e66c6a) :
/// mêmes motifs, points d'entrée décalés de 0x2000 ; vtable du contrat d'essai retrouvée par la RTTI.
pub const KNOWN_1103: Globals = Globals { database: 0x57056D0, humans: 0x56F5008, date: 0x56AF378 };
pub const KNOWN_1103_TRIAL_VTABLE: u64 = 0x4C90B78;

/// Version finale de FM27 (Steam, 10/11/2026, build 26385295 ; game_plugin.dll de 398 661 632 octets) : points
/// d'entrée décalés de 0x11B040, retrouvés par les motifs (base : `C7 44 24 5C 00 01 00 1B` au lieu de `00 00 00 1B`) ;
/// vtable de `TRIAL_CONTRACT@db` retrouvée par la RTTI. Disposition des objets à confirmer en jeu.
pub const KNOWN_1110: Globals = Globals { database: 0x5820710, humans: 0x5810048, date: 0x57CA3B8 };
pub const KNOWN_1110_TRIAL_VTABLE: u64 = 0x4D92BB8;

/// Vtable du contrat d'essai pour une version connue.
fn trial_vtable_for(globals: Globals) -> Option<u64> {
    if globals == KNOWN {
        Some(KNOWN_TRIAL_VTABLE)
    } else if globals == KNOWN_1103 {
        Some(KNOWN_1103_TRIAL_VTABLE)
    } else if globals == KNOWN_1110 {
        Some(KNOWN_1110_TRIAL_VTABLE)
    } else {
        None
    }
}

/// Points d'entrée d'une version analysée.
pub fn is_known(globals: Globals) -> bool {
    trial_vtable_for(globals).is_some()
}

struct Sig {
    pattern: &'static str,
    /// Position du déplacement 32 bits relatif à RIP dans le motif.
    disp: usize,
    /// Écart entre la cible et le point d'entrée cherché (table des personnes = DATABASE + 0x68).
    minus: u64,
}

/// L'octet après `5C 00` vaut 00 avant la version finale, 01 depuis : laissé libre.
const SIG_DATABASE: Sig = Sig { pattern: "48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? C7 44 24 5C 00 ?? 00 1B", disp: 3, minus: 0 };
const SIG_PERSONS: Sig = Sig {
    pattern: "48 8B 05 ?? ?? ?? ?? 48 8B 80 80 00 00 00 48 8B 48 08 48 3B 08 0F 85 ?? ?? ?? ??",
    disp: 3,
    minus: 0x68,
};
/// Le saut qui suit (`74 4D` avant la version finale) change d'une version à l'autre : hors du motif.
const SIG_HUMANS: Sig = Sig { pattern: "4C 8B 25 ?? ?? ?? ?? 49 8B 44 24 18 49 8B 54 24 20 48 39 C2", disp: 3, minus: 0 };
/// `lea rdx, [date courante]` dans le calcul d'âge du jeu.
const SIG_DATE: Sig = Sig { pattern: "48 8D 15 ?? ?? ?? ?? 49 0F 42 D0 0F B7 42 02", disp: 3, minus: 0 };

fn parse_pattern(p: &str) -> Vec<Option<u8>> {
    p.split_whitespace().map(|t| if t == "??" { None } else { u8::from_str_radix(t, 16).ok() }).collect()
}

fn matches_at(data: &[u8], i: usize, pat: &[Option<u8>]) -> bool {
    pat.iter().enumerate().all(|(k, b)| b.map_or(true, |b| data[i + k] == b))
}

#[derive(Debug, Clone, Copy)]
struct Section {
    va: u32,
    raw_size: u32,
    raw_ptr: u32,
}

fn sections(header: &[u8]) -> Option<Vec<Section>> {
    if header.len() < 0x40 || &header[..2] != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(header[0x3C..0x40].try_into().ok()?) as usize;
    if header.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    let count = le_u16(header, pe + 6) as usize;
    let opt = le_u16(header, pe + 20) as usize;
    let first = pe + 24 + opt;
    (0..count)
        .map(|i| {
            let s = first + i * 40;
            let b = header.get(s..s + 40)?;
            Some(Section {
                va: u32::from_le_bytes(b[12..16].try_into().ok()?),
                raw_size: u32::from_le_bytes(b[16..20].try_into().ok()?),
                raw_ptr: u32::from_le_bytes(b[20..24].try_into().ok()?),
            })
        })
        .collect()
}

/// Cherche les motifs dans le fichier du module et en déduit les RVA des points d'entrée.
/// Chaque motif doit apparaître exactement une fois, et les deux motifs de la base doivent concorder.
pub fn scan_globals<F: Read + Seek>(file: &mut F) -> Result<Globals, MemError> {
    let mut header = vec![0u8; 4096];
    file.seek(SeekFrom::Start(0))?;
    let n = file.read(&mut header)?;
    header.truncate(n);
    let secs = sections(&header).ok_or_else(|| MemError::UnknownVersion("module illisible".into()))?;

    let sigs = [&SIG_DATABASE, &SIG_PERSONS, &SIG_HUMANS, &SIG_DATE];
    let pats: Vec<Vec<Option<u8>>> = sigs.iter().map(|s| parse_pattern(s.pattern)).collect();
    let longest = pats.iter().map(Vec::len).max().unwrap_or(0);
    let mut found: Vec<Vec<u64>> = vec![Vec::new(); sigs.len()];

    const CHUNK: usize = 8 << 20;
    let mut buf = Vec::with_capacity(CHUNK + longest);
    for s in secs.iter().filter(|s| s.raw_size > 0) {
        file.seek(SeekFrom::Start(s.raw_ptr as u64))?;
        let mut remaining = s.raw_size as usize;
        // Position (dans la section) du premier octet de `buf`.
        let mut base = 0usize;
        buf.clear();
        while remaining > 0 || buf.len() >= longest {
            let want = CHUNK.min(remaining);
            let old = buf.len();
            buf.resize(old + want, 0);
            file.read_exact(&mut buf[old..])?;
            remaining -= want;
            let end = if remaining == 0 { buf.len() } else { buf.len().saturating_sub(longest - 1) };
            for i in 0..end {
                for (k, pat) in pats.iter().enumerate() {
                    if i + pat.len() <= buf.len() && pat[0] == Some(buf[i]) && matches_at(&buf, i, pat) {
                        let d = le_i32(&buf, i + sigs[k].disp) as i64;
                        let rva = s.va as i64 + (base + i) as i64 + sigs[k].disp as i64 + 4 + d;
                        found[k].push((rva as u64).wrapping_sub(sigs[k].minus));
                    }
                }
            }
            if remaining == 0 {
                break;
            }
            buf.drain(..end);
            base += end;
        }
    }

    let names = ["base", "personnes", "managers", "date"];
    let mut one = |k: usize| -> Result<u64, MemError> {
        found[k].sort_unstable();
        found[k].dedup();
        match found[k].as_slice() {
            [v] => Ok(*v),
            [] => Err(MemError::UnknownVersion(format!("motif « {} » introuvable", names[k]))),
            _ => Err(MemError::UnknownVersion(format!("motif « {} » ambigu", names[k]))),
        }
    };
    let database = one(0)?;
    if one(1)? != database {
        return Err(MemError::UnknownVersion("les motifs de la base ne concordent pas".into()));
    }
    Ok(Globals { database, humans: one(2)?, date: one(3)? })
}

// ---------------------------------------------------------------------------------------------
// Disposition des objets (FM27 du 29/10/2026)

mod off {
    /// `DATABASE` : vecteur {début, fin} de tous les `ACTUAL_PLAYER*`.
    pub const DB_PLAYERS: u64 = 0x100;
    /// Gestionnaire des managers humains : vecteur de `HUMAN_NON_PLAYER*`.
    pub const HUMANS_VEC: u64 = 0x18;
    pub const HUMAN_PERSON: u64 = 0x440;
    pub const HUMAN_ACTUAL_PERSON: u64 = 0x468;

    // ACTUAL_PLAYER
    pub const AP_VBPTR: u64 = 0x8;
    pub const AP_TEAM: u64 = 0x130;
    /// Pointeur vers le vecteur des blessures en cours (code du jeu, pas encore vu en partie).
    pub const AP_INJURIES: u64 = 0xF8;
    pub const AP_POSITIONS: u64 = 0x150;
    pub const AP_ATTR_BASE: usize = 0x150;
    pub const AP_VALUE: usize = 0x234;
    pub const AP_REP_HOME: usize = 0x25E;
    pub const AP_REP_CURRENT: usize = 0x260;
    pub const AP_REP_WORLD: usize = 0x262;
    pub const AP_CA: usize = 0x264;
    pub const AP_PA: usize = 0x266;
    pub const AP_SCALE: usize = 0x278;
    /// Taille lue d'un coup pour un joueur (couvre tous les champs ci-dessus).
    pub const AP_BLOCK: usize = 0x280;

    // PERSON / ACTUAL_PERSON
    pub const P_UID: u64 = 0xC;
    /// Drapeaux de la personne : bit `0x10` = femme (vu en jeu le 13/11/2026 sur 7 500 joueurs : 99,8 % des prénoms
    /// féminins, 0,6 % des masculins, les écarts étant des prénoms mixtes ; vaut aussi pour les joueuses libres).
    pub const P_FLAGS: u64 = 0x19;
    pub const P_FEMALE: u8 = 0x10;
    pub const A_FULL_NAME: u64 = 0x18;
    pub const A_FIRST_NAME: u64 = 0x28;
    pub const A_LAST_NAME: u64 = 0x30;
    pub const A_COMMON_NAME: u64 = 0x38;
    pub const A_BIRTH: u64 = 0x60;
    /// Nation (`NATION*`), vérifiée sur 35 joueurs le 01/11.
    pub const A_NATION: u64 = 0x40;
    pub const A_CONTRACT: u64 = 0x80;
    /// Pointeur X (nul sans prêt) ; `[X+0]` = contrat de prêt.
    pub const A_LOAN: u64 = 0x88;

    // CONTRACT
    pub const C_TEAM: u64 = 0x10;
    pub const C_WAGE: u64 = 0x20;
    pub const C_FLAGS: u64 = 0x2B;
    pub const C_END: u64 = 0x48;
    /// Drapeaux de mise en vente : bit 0 ou 3 = sur la liste des transferts (code du jeu ; 2 901 joueurs en partie le 01/11).
    pub const C_LISTING: u64 = 0x57;
    /// Contrat de prêt : équipe d'accueil `+0x10`, fin du prêt `+0x48` (sans condition).
    pub const L_TEAM: u64 = 0x10;
    pub const L_END: u64 = 0x48;

    /// `DATABASE` : table des personnes (`DATABASE_TABLE<PERSON>*`), vecteur par index à `+0x60` jusqu'à la bêta,
    /// à `+0x88` dans la version finale (vu en jeu le 10/11/2026 : `+0x60` n'y contient plus que des zéros).
    pub const DB_PERSONS: u64 = 0x68;
    pub const TABLE_BY_INDEX: u64 = 0x60;
    pub const TABLE_BY_INDEX_1110: u64 = 0x88;
    /// Fonction (poste) d'un membre du staff : octet du contrat (slot 0x50 de la vtable des contrats).
    pub const C_JOB: u64 = 0x26;

    // TEAM (ses noms sont vides en partie : on prend celui du club)
    pub const T_NATIONAL: u64 = 0x2F;
    pub const T_CONTAINER: u64 = 0x30;
    /// Compétition de l'équipe (`COMP*`, peut être nulle).
    pub const T_COMP: u64 = 0x50;

    // NATION
    pub const N_UID: u64 = 0xC;
    pub const N_NAME: u64 = 0x20;

    // COMP (division)
    pub const CO_UID: u64 = 0xC;
    pub const CO_NAME: u64 = 0x40;
    /// Réputation de la compétition (Premier League 189, LaLiga 180, 2e division slovaque 82…).
    pub const CO_REPUTATION: u64 = 0x188;

    // CLUB
    pub const CL_UID: u64 = 0xC;
    pub const CL_NAME: u64 = 0xC0;
    pub const CL_SHORT_NAME: u64 = 0xC8;
}

/// Les 47 attributs : clé FM Immersion et position après `ACTUAL_PLAYER+0x150` (table du jeu à la RVA 0x4D36B3E).
const ATTRIBUTES: [(&str, usize); 47] = [
    ("AerialReach", 27),
    ("CommandOfArea", 28),
    ("Communication", 29),
    ("Eccentricity", 46),
    ("Handling", 26),
    ("Kicking", 30),
    ("Reflexes", 36),
    ("RushingOut", 47),
    ("TendencyToPunch", 48),
    ("Throwing", 31),
    ("OneOnOnes", 34),
    ("Crossing", 15),
    ("Dribbling", 16),
    ("Finishing", 17),
    ("Heading", 18),
    ("LongShots", 19),
    ("LongThrows", 45),
    ("Marking", 20),
    ("Passing", 22),
    ("PenaltyTaking", 23),
    ("FreeKicks", 50),
    ("Tackling", 24),
    ("Technique", 38),
    ("FirstTouch", 37),
    ("Corners", 42),
    ("Aggression", 60),
    ("Anticipation", 32),
    ("Bravery", 58),
    ("Vision", 25),
    ("Decisions", 33),
    ("Determination", 66),
    ("Flair", 41),
    ("Leadership", 55),
    ("OffTheBall", 21),
    ("Positioning", 35),
    ("Teamwork", 43),
    ("WorkRate", 44),
    ("Composure", 67),
    ("Concentration", 68),
    ("Acceleration", 49),
    ("Agility", 61),
    ("Balance", 57),
    ("Pace", 53),
    ("Stamina", 52),
    ("Strength", 51),
    ("JumpingReach", 54),
    ("NaturalFitness", 65),
];

/// Les 15 postes (octets `+0x150` à `+0x15E`) en codes FM Immersion ; le libéro n'a pas d'équivalent.
const POSITIONS: [Option<&str>; 15] = [
    Some("GB"),
    None,
    Some("DG"),
    Some("DC"),
    Some("DD"),
    Some("MDF"),
    Some("MG"),
    Some("MC"),
    Some("MD"),
    Some("MOG"),
    Some("MOC"),
    Some("MOD"),
    Some("BT"),
    Some("DLG"),
    Some("DLD"),
];

// ---------------------------------------------------------------------------------------------
// Dates du jeu : 2 octets jour de l'année (bits 0-8), 2 octets année

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SiDate {
    pub day: u16,
    pub year: u16,
}

impl SiDate {
    fn from_bytes(b: [u8; 4]) -> Self {
        SiDate { day: u16::from_le_bytes([b[0], b[1]]) & 0x1FF, year: u16::from_le_bytes([b[2], b[3]]) }
    }
    /// Le jour 1 de 1900 est la date « non renseignée » du jeu.
    fn plausible(&self) -> bool {
        (1901..=2200).contains(&self.year) && (1..=366).contains(&self.day)
    }
    /// Date ISO ; le jour de l'année est compté à partir de 1 (vérifié en jeu).
    pub fn iso(&self) -> Option<String> {
        if !self.plausible() {
            return None;
        }
        let leap = |y: u16| (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let months = [31, if leap(self.year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mut d = self.day - 1;
        for (m, len) in months.iter().enumerate() {
            if d < *len {
                return Some(format!("{:04}-{:02}-{:02}", self.year, m + 1, d + 1));
            }
            d -= len;
        }
        None
    }
    /// Âge en années révolues à la date `today`.
    fn age_at(&self, today: &SiDate) -> Option<u16> {
        (self.plausible() && today.plausible() && today.year >= self.year)
            .then(|| today.year - self.year - u16::from(today.day < self.day))
    }
}

fn date_at<M: Mem>(r: &R<M>, a: u64) -> Option<SiDate> {
    r.arr::<4>(a).map(SiDate::from_bytes).filter(SiDate::plausible)
}

// ---------------------------------------------------------------------------------------------
// Lecture des joueurs

/// Un joueur de la base, au format des joueurs de l'instantané (`players`) plus quelques champs bruts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPlayer {
    pub id: i32,
    pub name: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub common_name: Option<String>,
    pub birth_date: Option<String>,
    pub age: Option<u16>,
    /// Club propriétaire (contrat principal), même pour un joueur prêté.
    pub club: Option<String>,
    pub club_short: Option<String>,
    pub club_id: Option<i32>,
    /// Club où le joueur est prêté, et fin du prêt.
    pub loan_club: Option<String>,
    pub loan_club_id: Option<i32>,
    pub loan_end: Option<String>,
    /// Nationalité (nom court du jeu, ex. « Argentine »).
    pub nation: Option<String>,
    pub nation_id: Option<i32>,
    /// Division du club propriétaire (sinon de l'équipe où il joue), et sa réputation (0-200 environ).
    pub division: Option<String>,
    pub division_id: Option<i32>,
    pub division_reputation: Option<i16>,
    /// Capacité actuelle et potentielle réelles (0-200 ; potentiel négatif = fourchette du jeu).
    pub ca: i16,
    pub pa: i16,
    pub reputation: [i16; 3],
    /// Postes à 15 ou plus sur 20 (« compétent » et au-delà), au format texte de FM Immersion.
    pub positions_text: String,
    pub position_ratings: BTreeMap<&'static str, u8>,
    pub attributes: BTreeMap<&'static str, u8>,
    /// Échelle de stockage des attributs (`100` : convertis en 1-20 comme le fait le jeu).
    pub attribute_scale: u8,
    /// Salaire du contrat principal, par semaine, dans la monnaie de base du jeu (l'affichage en € par mois
    /// vaut environ × 52/12 × le taux de change du jeu, 1,165 dans la partie d'essai).
    pub wage_weekly: Option<i32>,
    pub contract_end: Option<String>,
    /// Sur la liste des transferts (lu dans le code du jeu, à confirmer en partie).
    pub transfer_listed: bool,
    /// Blessé (lu dans le code du jeu, à confirmer en partie).
    pub injured: bool,
    /// Joueuse (drapeau du jeu) ; `None` si l'octet n'a pas pu être lu.
    pub female: Option<bool>,
    /// Valeur stockée par le jeu, monnaie de base (le jeu affiche une fourchette estimée autour de cette valeur).
    pub value_raw: Option<i32>,
}

/// Données de base d'un joueur, disponibles avant les lectures coûteuses.
pub struct Pre<'a> {
    pub ca: i16,
    pub pa: i16,
    pub position_ratings: &'a BTreeMap<&'static str, u8>,
}

struct Ctx<'a, M: Mem> {
    r: R<'a, M>,
    /// Adresse de la vtable des contrats d'essai (version connue seulement).
    trial_vtable: Option<u64>,
    today: Option<SiDate>,
    clubs: HashMap<u64, Option<ClubInfo>>,
    names: HashMap<u64, Option<Named>>,
}

/// Nation ou compétition : identifiant, nom, réputation (compétitions seulement).
#[derive(Clone)]
struct Named {
    id: i32,
    name: Option<String>,
    reputation: Option<i16>,
}

#[derive(Clone)]
struct ClubInfo {
    id: i32,
    name: Option<String>,
    short: Option<String>,
}

impl<M: Mem> Ctx<'_, M> {
    fn named(&mut self, at: u64, uid: u64, name: u64, reputation: Option<u64>) -> Option<Named> {
        if let Some(n) = self.names.get(&at) {
            return n.clone();
        }
        let info = self.r.i32(at + uid).filter(|&id| id > 0).map(|id| Named {
            id,
            name: self.r.string(at + name),
            reputation: reputation.and_then(|o| self.r.i16(at + o)),
        });
        self.names.insert(at, info.clone());
        info
    }

    fn nation(&mut self, at: u64) -> Option<Named> {
        self.named(at, off::N_UID, off::N_NAME, None)
    }

    /// Division d'une équipe (compétition `[équipe+0x50]`).
    fn division_of_team(&mut self, team: u64) -> Option<Named> {
        let comp = self.r.ptr(team + off::T_COMP)?;
        self.named(comp, off::CO_UID, off::CO_NAME, Some(off::CO_REPUTATION))
    }

    fn club(&mut self, club: u64) -> Option<ClubInfo> {
        if let Some(c) = self.clubs.get(&club) {
            return c.clone();
        }
        let info = self.r.i32(club + off::CL_UID).filter(|&id| id > 0).map(|id| ClubInfo {
            id,
            name: self.r.string(club + off::CL_NAME),
            short: self.r.string(club + off::CL_SHORT_NAME),
        });
        self.clubs.insert(club, info.clone());
        info
    }

    /// Club d'une équipe (`None` pour une sélection nationale).
    fn club_of_team(&mut self, team: u64) -> Option<ClubInfo> {
        if self.r.u8(team + off::T_NATIONAL)? != 0 {
            return None;
        }
        let club = self.r.ptr(team + off::T_CONTAINER)?;
        self.club(club)
    }

    fn player(&mut self, ap: u64) -> Option<DbPlayer> {
        self.player_if(ap, &|_| true)
    }

    /// Lit un joueur si `pre` accepte ses données de base (CA, PA, postes), avant les lectures plus coûteuses
    /// (noms, contrat, club) : une recherche dans toute la base reste ainsi rapide.
    fn player_if(&mut self, ap: u64, pre: &dyn Fn(&Pre) -> bool) -> Option<DbPlayer> {
        let b = self.r.bytes(ap, off::AP_BLOCK)?;
        // Héritage virtuel : les sous-objets PERSON et ACTUAL_PERSON se trouvent par le vbptr.
        let vb = self.r.ptr(ap + off::AP_VBPTR)?;
        let person = ap + off::AP_VBPTR + self.r.i32(vb + 4)? as i64 as u64;
        let actual = ap + off::AP_VBPTR + self.r.i32(vb + 8)? as i64 as u64;
        let id = self.r.i32(person + off::P_UID).filter(|&id| id > 0)?;
        let female = self.r.u8(person + off::P_FLAGS).map(|f| f & off::P_FEMALE != 0);

        let ca = le_i16(&b, off::AP_CA);
        let pa = le_i16(&b, off::AP_PA);
        if !(0..=200).contains(&ca) || !(-200..=200).contains(&pa) {
            return None;
        }
        let scale100 = b[off::AP_SCALE] & 0x80 != 0;
        let mut attributes = BTreeMap::new();
        for (key, pos) in ATTRIBUTES {
            let v = b[off::AP_ATTR_BASE + pos];
            let v = if scale100 { ((v as u16 + 2) / 5).clamp(1, 20) as u8 } else { v };
            attributes.insert(key, v);
        }
        if attributes.values().any(|&v| v > 20) {
            return None;
        }
        let mut position_ratings = BTreeMap::new();
        for (i, code) in POSITIONS.iter().enumerate() {
            if let Some(code) = code {
                position_ratings.insert(*code, b[off::AP_POSITIONS as usize + i]);
            }
        }
        if !pre(&Pre { ca, pa, position_ratings: &position_ratings }) {
            return None;
        }
        let mut best: Vec<_> = position_ratings.iter().filter(|(_, &v)| v >= 15).map(|(c, v)| (*c, *v)).collect();
        best.sort_by(|a, b| b.1.cmp(&a.1));
        let positions_text = best.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(", ");

        let first_name = self.r.string_indirect(actual + off::A_FIRST_NAME);
        let last_name = self.r.string_indirect(actual + off::A_LAST_NAME);
        let common_name = self.r.string_indirect(actual + off::A_COMMON_NAME);
        // Comme le jeu : nom usuel, sinon prénom + nom, sinon nom complet (vérifié sur 27 joueurs).
        let name = common_name
            .clone()
            .or_else(|| match (&first_name, &last_name) {
                (Some(f), Some(l)) => Some(format!("{f} {l}")),
                (f, l) => f.clone().or_else(|| l.clone()),
            })
            .or_else(|| self.r.string(actual + off::A_FULL_NAME))?;
        let birth = date_at(&self.r, actual + off::A_BIRTH);

        let contract = self.r.ptr(actual + off::A_CONTRACT);
        let wage_weekly = contract.and_then(|c| self.r.i32(c + off::C_WAGE)).filter(|&w| w >= 0);
        let contract_end = contract
            .filter(|&c| self.r.u8(c + off::C_FLAGS).is_some_and(|f| f & 0x08 == 0))
            .and_then(|c| date_at(&self.r, c + off::C_END))
            .and_then(|d| d.iso());

        // Club propriétaire : celui du contrat principal ; à défaut, celui où le joueur évolue (+0x130).
        let team = le_u64(&b, off::AP_TEAM as usize);
        let team = valid(team).then_some(team);
        // `[X+0]` est un contrat de prêt ou d'essai (même emplacement) : la vtable les distingue.
        let other = self.r.ptr(actual + off::A_LOAN).and_then(|x| self.r.ptr(x));
        let trial = other.filter(|&l| self.trial_vtable.is_some() && self.r.ptr(l) == self.trial_vtable);
        let loan = other.filter(|_| trial.is_none());
        // Sans contrat principal lisible : prêté ou à l'essai, le club propriétaire reste inconnu (pas le club
        // d'accueil) ; un joueur à l'essai sans contrat est libre.
        let owner_team = contract.and_then(|c| self.r.ptr(c + off::C_TEAM));
        // Division du club propriétaire ; à défaut, celle de l'équipe où il joue.
        let division = match owner_team.and_then(|t| self.division_of_team(t)) {
            Some(d) => Some(d),
            None => team.and_then(|t| self.division_of_team(t)),
        };
        let nation = self.r.ptr(actual + off::A_NATION).and_then(|n| self.nation(n));
        let club = match owner_team.and_then(|t| self.club_of_team(t)) {
            Some(c) => Some(c),
            None if other.is_none() => team.and_then(|t| self.club_of_team(t)),
            None => None,
        };
        let loan_club = loan.and_then(|l| self.r.ptr(l + off::L_TEAM)).and_then(|t| self.club_of_team(t));
        let loan_end = loan.and_then(|l| date_at(&self.r, l + off::L_END)).and_then(|d| d.iso());
        let value = le_i32(&b, off::AP_VALUE);
        let transfer_listed = contract.and_then(|c| self.r.u8(c + off::C_LISTING)).is_some_and(|f| f & 0x09 != 0);
        let injured = self
            .r
            .ptr(ap + off::AP_INJURIES)
            .and_then(|v| Some((self.r.ptr(v)?, self.r.ptr(v + 8)?)))
            .is_some_and(|(begin, end)| end > begin);

        Some(DbPlayer {
            id,
            name,
            first_name,
            last_name,
            common_name,
            birth_date: birth.and_then(|d| d.iso()),
            age: match (birth, self.today) {
                (Some(b), Some(t)) => b.age_at(&t),
                _ => None,
            },
            club_id: club.as_ref().map(|c| c.id),
            club_short: club.as_ref().and_then(|c| c.short.clone()),
            club: club.and_then(|c| c.name),
            loan_club_id: loan_club.as_ref().map(|c| c.id),
            loan_club: loan_club.and_then(|c| c.name),
            loan_end,
            nation_id: nation.as_ref().map(|n| n.id),
            nation: nation.and_then(|n| n.name),
            division_id: division.as_ref().map(|d| d.id),
            division_reputation: division.as_ref().and_then(|d| d.reputation),
            division: division.and_then(|d| d.name),
            ca,
            pa,
            reputation: [le_i16(&b, off::AP_REP_HOME), le_i16(&b, off::AP_REP_CURRENT), le_i16(&b, off::AP_REP_WORLD)],
            positions_text,
            position_ratings,
            attributes,
            attribute_scale: if scale100 { 100 } else { 20 },
            wage_weekly,
            contract_end,
            transfer_listed,
            injured,
            female,
            value_raw: (value >= 0).then_some(value),
        })
    }
}

/// Copie d'un vecteur {début, fin} de pointeurs (8 octets par élément), éléments nuls retirés.
fn pointer_vec<M: Mem>(r: &R<M>, at: u64, max: usize) -> Option<Vec<u64>> {
    let begin = r.ptr(at)?;
    let end = r.ptr(at + 8)?;
    if end < begin || (end - begin) % 8 != 0 {
        return None;
    }
    let n = ((end - begin) / 8) as usize;
    if n > max {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    const STEP: usize = 4096;
    for start in (0..n).step_by(STEP) {
        let count = STEP.min(n - start);
        let raw = r.bytes(begin + start as u64 * 8, count * 8)?;
        out.extend((0..count).map(|i| le_u64(&raw, i * 8)).filter(|&p| valid(p)));
    }
    Some(out)
}

/// Base lue en mémoire, prête à parcourir.
pub struct Database<'a, M: Mem> {
    ctx: Ctx<'a, M>,
    module_base: u64,
    globals: Globals,
    players: Vec<u64>,
}

/// Nombre maximal de joueurs accepté (une base FM complète en compte quelques centaines de milliers).
const MAX_PLAYERS: usize = 3_000_000;

impl<'a, M: Mem> Database<'a, M> {
    pub fn open(mem: &'a M, module_base: u64, globals: Globals) -> Result<Self, MemError> {
        let r = R(mem);
        let today = date_at(&r, module_base + globals.date);
        let players = pointer_vec(&r, module_base + globals.database + off::DB_PLAYERS, MAX_PLAYERS)
            .ok_or_else(|| MemError::Unexpected("liste des joueurs illisible".into()))?;
        if players.is_empty() {
            return Err(MemError::NoSave);
        }
        let trial_vtable = trial_vtable_for(globals).map(|v| module_base + v);
        Ok(Database { ctx: Ctx { r, today, trial_vtable, clubs: HashMap::new(), names: HashMap::new() }, module_base, globals, players })
    }

    pub fn count(&self) -> usize {
        self.players.len()
    }

    pub fn today(&self) -> Option<SiDate> {
        self.ctx.today
    }

    /// Contrôle sur un échantillon : au moins 90 % des joueurs doivent être lisibles et plausibles.
    pub fn check(&mut self) -> Result<(usize, usize), MemError> {
        let step = (self.players.len() / 200).max(1);
        let sample: Vec<u64> = self.players.iter().step_by(step).take(200).copied().collect();
        let ok = sample.iter().filter(|&&p| self.ctx.player(p).is_some()).count();
        if ok * 10 < sample.len() * 9 {
            return Err(MemError::Unexpected(format!("{ok} joueurs plausibles sur {} contrôlés", sample.len())));
        }
        Ok((ok, sample.len()))
    }

    /// Parcourt les joueurs et garde ceux que `keep` accepte, jusqu'à `limit`.
    pub fn players(&mut self, limit: usize, mut keep: impl FnMut(&DbPlayer) -> bool) -> Vec<DbPlayer> {
        let mut out = Vec::new();
        for i in 0..self.players.len() {
            if out.len() >= limit {
                break;
            }
            if let Some(p) = self.ctx.player(self.players[i]) {
                if keep(&p) {
                    out.push(p);
                }
            }
        }
        out
    }

    /// Recherche : joueurs acceptés par `pre` puis `keep`, triés par CA décroissant, `limit` au plus.
    pub fn search(&mut self, limit: usize, pre: &dyn Fn(&Pre) -> bool, keep: impl Fn(&DbPlayer) -> bool) -> Vec<DbPlayer> {
        let mut out: Vec<DbPlayer> = Vec::new();
        for i in 0..self.players.len() {
            if let Some(p) = self.ctx.player_if(self.players[i], pre) {
                if keep(&p) {
                    out.push(p);
                }
            }
        }
        out.sort_by(|a, b| b.ca.cmp(&a.ca).then(b.pa.cmp(&a.pa)));
        out.truncate(limit);
        out
    }

    /// Managers humains de la partie et leur club.
    pub fn humans(&mut self) -> Vec<Human> {
        let r = &self.ctx.r;
        let Some(mgr) = r.ptr(self.module_base + self.globals.humans) else { return Vec::new() };
        let list = pointer_vec(r, mgr + off::HUMANS_VEC, 64).unwrap_or_default();
        let mut out = Vec::new();
        for h in list {
            let actual = h + off::HUMAN_ACTUAL_PERSON;
            let r = &self.ctx.r;
            let id = r.i32(h + off::HUMAN_PERSON + off::P_UID);
            let name = r.string(actual + off::A_FULL_NAME).or_else(|| {
                let f = r.string_indirect(actual + off::A_FIRST_NAME);
                let l = r.string_indirect(actual + off::A_LAST_NAME);
                match (f, l) {
                    (Some(f), Some(l)) => Some(format!("{f} {l}")),
                    (f, l) => f.or(l),
                }
            });
            let team = r.ptr(actual + off::A_CONTRACT).and_then(|c| r.ptr(c + off::C_TEAM));
            let club = team.and_then(|t| self.ctx.club_of_team(t));
            out.push(Human { id, name, club: club.as_ref().and_then(|c| c.name.clone()), club_id: club.map(|c| c.id) });
        }
        out
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Human {
    pub id: Option<i32>,
    pub name: Option<String>,
    pub club: Option<String>,
    pub club_id: Option<i32>,
}

// ---------------------------------------------------------------------------------------------
// Staff (`ACTUAL_NON_PLAYER`) — analyse hors jeu de game_plugin.dll (patch du 03/11), pas encore vu en partie

/// Nom RTTI de la classe des membres du staff.
const STAFF_CLASS: &[u8] = b".?AVACTUAL_NON_PLAYER@db@@\0";
/// Sous-objets virtuels d'un membre du staff (vbptr en `+0`).
const STAFF_PERSON: i32 = 0x100;
const STAFF_ACTUAL_PERSON: i32 = 0x128;
/// Octets lus d'un coup à partir du début de l'objet (couvre toutes les notes).
const STAFF_BLOCK: usize = 0x50;
/// Adaptabilité : dans `ACTUAL_PERSON`, valeur directe 1-20.
const STAFF_ADAPTABILITY: u64 = 0x48;
/// Nombre maximal de personnes acceptées dans la table (joueurs, staff, managers…).
const MAX_PERSONS: usize = 5_000_000;

/// Notes du staff : clé FM Immersion, position dans l'objet, stockée sur 100 (convertie en 1-20 comme le jeu).
/// Retrouvées par l'accesseur des notes (RVA 0x17D40C0, table de sauts 0x4D8EB14) et le dictionnaire des codes.
const STAFF_ATTRIBUTES: [(&str, usize, bool); 21] = [
    ("Attacking", 0x32, true),
    ("Defending", 0x33, true),
    ("Fitness", 0x34, true),
    ("Goalkeeping", 0x2B, true),
    ("Possession", 0x35, true),
    ("Technical", 0x36, true),
    ("Tactical", 0x37, true),
    ("SetPieces", 0x43, true),
    ("TacticalKnowledge", 0x31, true),
    ("WorkingWithYoungsters", 0x1C, false),
    ("PeopleManagement", 0x2E, true),
    ("Determination", 0x1D, true),
    ("Authority", 0x14, false),
    ("Motivating", 0x2F, true),
    ("JudgingPlayerAbility", 0x2C, true),
    ("JudgingPlayerPotential", 0x2D, true),
    ("JudgingStaffAbility", 0x42, true),
    ("Negotiating", 0x41, true),
    ("Physiotherapy", 0x30, true),
    ("SportsScience", 0x3F, true),
    ("AnalysingData", 0x3C, true),
];

/// Conversion 1-100 → 1-20 du jeu : `(v × 0x6667 + 0xCCCE) >> 17`, bornée à 1-20.
fn staff_scale(v: u8) -> u8 {
    (((v as u32) * 0x6667 + 0xCCCE) >> 17).clamp(1, 20) as u8
}

/// Un membre du staff lu dans la base.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStaff {
    pub id: i32,
    pub name: String,
    pub birth_date: Option<String>,
    pub age: Option<u16>,
    pub club: Option<String>,
    pub club_id: Option<i32>,
    pub nation: Option<String>,
    /// Code brut de la fonction dans le contrat (`contrat+0x26`) ; correspondance avec les intitulés à confirmer.
    pub job_code: Option<u8>,
    pub wage_weekly: Option<i32>,
    pub contract_end: Option<String>,
    /// Notes 1-20 (21 notes, plus l'adaptabilité).
    pub attributes: BTreeMap<&'static str, u8>,
}

impl<M: Mem> Ctx<'_, M> {
    /// Décalage du sous-objet `PERSON` si la vtable `vt` est celle d'un membre du staff (lu par le RTTI).
    fn staff_offset(&self, module_base: u64, vt: u64) -> Option<i32> {
        let col = self.r.ptr(vt.checked_sub(8)?)?;
        if self.r.i32(col)? != 1 {
            return None;
        }
        let offset = self.r.i32(col + 4)?;
        let td = self.r.i32(col + 12)?;
        let name = self.r.bytes(module_base + td as u32 as u64 + 16, STAFF_CLASS.len())?;
        (name == STAFF_CLASS).then_some(offset)
    }

    fn staff(&mut self, base: u64) -> Option<DbStaff> {
        let vb = self.r.ptr(base)?;
        if self.r.i32(vb + 4)? != STAFF_PERSON || self.r.i32(vb + 8)? != STAFF_ACTUAL_PERSON {
            return None;
        }
        let person = base + STAFF_PERSON as u64;
        let actual = base + STAFF_ACTUAL_PERSON as u64;
        let id = self.r.i32(person + off::P_UID).filter(|&id| id > 0)?;
        let b = self.r.bytes(base, STAFF_BLOCK)?;
        let mut attributes = BTreeMap::new();
        for (key, pos, scaled) in STAFF_ATTRIBUTES {
            let v = b[pos];
            let v = if scaled { staff_scale(v) } else { v };
            if !(1..=20).contains(&v) {
                return None;
            }
            attributes.insert(key, v);
        }
        let adaptability = self.r.u8(actual + STAFF_ADAPTABILITY).filter(|v| (1..=20).contains(v));
        if let Some(a) = adaptability {
            attributes.insert("Adaptability", a);
        }

        let first = self.r.string_indirect(actual + off::A_FIRST_NAME);
        let last = self.r.string_indirect(actual + off::A_LAST_NAME);
        let name = self
            .r
            .string_indirect(actual + off::A_COMMON_NAME)
            .or_else(|| match (&first, &last) {
                (Some(f), Some(l)) => Some(format!("{f} {l}")),
                (f, l) => f.clone().or_else(|| l.clone()),
            })
            .or_else(|| self.r.string(actual + off::A_FULL_NAME))?;
        let birth = date_at(&self.r, actual + off::A_BIRTH);
        let contract = self.r.ptr(actual + off::A_CONTRACT);
        let club = contract.and_then(|c| self.r.ptr(c + off::C_TEAM)).and_then(|t| self.club_of_team(t));
        let nation = self.r.ptr(actual + off::A_NATION).and_then(|n| self.nation(n));
        Some(DbStaff {
            id,
            name,
            birth_date: birth.and_then(|d| d.iso()),
            age: match (birth, self.today) {
                (Some(b), Some(t)) => b.age_at(&t),
                _ => None,
            },
            club_id: club.as_ref().map(|c| c.id),
            club: club.and_then(|c| c.name),
            nation: nation.and_then(|n| n.name),
            job_code: contract.and_then(|c| self.r.u8(c + off::C_JOB)),
            wage_weekly: contract.and_then(|c| self.r.i32(c + off::C_WAGE)).filter(|&w| w >= 0),
            contract_end: contract.and_then(|c| date_at(&self.r, c + off::C_END)).and_then(|d| d.iso()),
            attributes,
        })
    }
}

impl<M: Mem> Database<'_, M> {
    /// Toutes les personnes de la base (`PERSON*`) : table `[DATABASE+0x68]`, vecteur par index à `+0x60`
    /// (bêta) ou `+0x88` (version finale). Le premier vecteur non vide l'emporte : les deux dispositions restent lues.
    fn persons(&self) -> Option<Vec<u64>> {
        let table = self.ctx.r.ptr(self.module_base + self.globals.database + off::DB_PERSONS)?;
        let mut found = None;
        for at in [off::TABLE_BY_INDEX, off::TABLE_BY_INDEX_1110] {
            match pointer_vec(&self.ctx.r, table + at, MAX_PERSONS) {
                Some(v) if !v.is_empty() => return Some(v),
                Some(v) => found = found.or(Some(v)),
                None => {}
            }
        }
        found
    }

    /// Membres du staff acceptés par `keep`, jusqu'à `limit` (classe reconnue par son nom RTTI, mis en cache par vtable).
    pub fn staff(&mut self, limit: usize, mut keep: impl FnMut(&DbStaff) -> bool) -> Result<Vec<DbStaff>, MemError> {
        let persons = self.persons().ok_or_else(|| MemError::Unexpected("table des personnes illisible".into()))?;
        let mut classes: HashMap<u64, Option<i32>> = HashMap::new();
        let mut out = Vec::new();
        for p in persons {
            if out.len() >= limit {
                break;
            }
            let Some(vt) = self.ctx.r.ptr(p) else { continue };
            let offset = match classes.get(&vt) {
                Some(o) => *o,
                None => {
                    let o = self.ctx.staff_offset(self.module_base, vt);
                    classes.insert(vt, o);
                    o
                }
            };
            let Some(offset) = offset.filter(|&o| o == STAFF_PERSON) else { continue };
            if let Some(s) = self.ctx.staff(p - offset as u64) {
                if keep(&s) {
                    out.push(s);
                }
            }
        }
        Ok(out)
    }
}

/// Staff du club du manager humain, et membres du staff sans club (recrutables sans indemnité).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClubStaff {
    pub game_date: Option<String>,
    pub club_id: Option<i32>,
    pub staff: Vec<DbStaff>,
    pub free_agents: Vec<DbStaff>,
}

/// Nombre maximal de membres du staff renvoyés par liste.
const MAX_STAFF: usize = 3_000;

pub fn club_staff<M: Mem>(db: &mut Database<M>, free_agents: bool) -> Result<ClubStaff, MemError> {
    let club_id = db.humans().iter().find_map(|h| h.club_id);
    let mut staff = Vec::new();
    let mut free = Vec::new();
    if club_id.is_some() || free_agents {
        for s in db.staff(usize::MAX, |s| (club_id.is_some() && s.club_id == club_id) || (free_agents && s.club_id.is_none()))? {
            if club_id.is_some() && s.club_id == club_id {
                if staff.len() < MAX_STAFF {
                    staff.push(s);
                }
            } else if free.len() < MAX_STAFF {
                free.push(s);
            }
        }
    }
    Ok(ClubStaff { game_date: db.today().and_then(|d| d.iso()), club_id, staff, free_agents: free })
}

/// Staff du club (et, sur demande, staff libre) : lecture seule, à la demande du joueur.
#[tauri::command]
pub async fn fm_memory_staff(free_agents: Option<bool>) -> Result<ClubStaff, MemError> {
    tauri::async_runtime::spawn_blocking(move || {
        with_database(|db, _| {
            db.check()?;
            club_staff(db, free_agents.unwrap_or(false))
        })
    })
    .await
    .map_err(|e| MemError::Unexpected(e.to_string()))?
}

// ---------------------------------------------------------------------------------------------
// Processus du jeu (Windows)

#[derive(Debug, Clone)]
pub struct Module {
    pub pid: u32,
    pub base: u64,
    pub size: u32,
    pub path: PathBuf,
}

#[cfg(windows)]
mod win {
    use super::{Mem, MemError, Module};
    use std::ffi::c_void;
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Process32FirstW, Process32NextW, MODULEENTRY32W,
        PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

    fn wide(s: &[u16]) -> String {
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        String::from_utf16_lossy(&s[..end])
    }

    struct Snapshot(HANDLE);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub(crate) fn game_pid() -> Option<u32> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let snap = Snapshot(snap);
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap.0, &mut e) != 0;
            while ok {
                if wide(&e.szExeFile).eq_ignore_ascii_case("fm.exe") {
                    return Some(e.th32ProcessID);
                }
                ok = Process32NextW(snap.0, &mut e) != 0;
            }
            None
        }
    }

    pub fn find_module() -> Result<Module, MemError> {
        let pid = game_pid().ok_or(MemError::NotRunning)?;
        // La liste des modules peut échouer pendant que le jeu en charge : quelques essais.
        for _ in 0..5 {
            unsafe {
                let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
                if snap == INVALID_HANDLE_VALUE {
                    if GetLastError() == ERROR_ACCESS_DENIED {
                        return Err(MemError::AccessDenied);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
                let snap = Snapshot(snap);
                let mut e: MODULEENTRY32W = std::mem::zeroed();
                e.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
                let mut ok = Module32FirstW(snap.0, &mut e) != 0;
                while ok {
                    if wide(&e.szModule).eq_ignore_ascii_case("game_plugin.dll") {
                        return Ok(Module {
                            pid,
                            base: e.modBaseAddr as u64,
                            size: e.modBaseSize,
                            path: PathBuf::from(wide(&e.szExePath)),
                        });
                    }
                    ok = Module32NextW(snap.0, &mut e) != 0;
                }
                return Err(MemError::ModuleMissing);
            }
        }
        Err(MemError::ModuleMissing)
    }

    /// Processus du jeu ouvert en lecture seule.
    pub struct Process(HANDLE);

    impl Process {
        pub fn open(pid: u32) -> Result<Self, MemError> {
            let h = unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if h.is_null() {
                return Err(MemError::AccessDenied);
            }
            Ok(Process(h))
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Mem for Process {
        fn read(&self, addr: u64, buf: &mut [u8]) -> bool {
            let mut n = 0usize;
            let ok = unsafe {
                ReadProcessMemory(self.0, addr as *const c_void, buf.as_mut_ptr() as *mut c_void, buf.len(), &mut n)
            };
            ok != 0 && n == buf.len()
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Commandes

/// Points d'entrée retrouvés pour un fichier donné (taille + date), pour ne pas relire 400 Mo à chaque fois.
static GLOBALS_CACHE: Mutex<Option<((PathBuf, u64, u128), Globals)>> = Mutex::new(None);

/// FM27 tourne-t-il ? Liste des processus en mémoire (Toolhelp32) : ni processus lancé, ni accès au jeu.
#[cfg(windows)]
pub(crate) fn game_process_running() -> bool {
    win::game_pid().is_some()
}

#[cfg(not(windows))]
pub(crate) fn game_process_running() -> bool {
    false
}

pub(crate) fn globals_for(path: &Path) -> Result<Globals, MemError> {
    let meta = std::fs::metadata(path)?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    let key = (path.to_path_buf(), meta.len(), modified);
    if let Some((k, g)) = GLOBALS_CACHE.lock().unwrap().as_ref() {
        if *k == key {
            return Ok(*g);
        }
    }
    let mut f = std::io::BufReader::new(std::fs::File::open(path)?);
    let g = scan_globals(&mut f)?;
    *GLOBALS_CACHE.lock().unwrap() = Some((key, g));
    Ok(g)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub module_path: String,
    pub module_size: u32,
    pub globals: Globals,
    /// Les points d'entrée sont ceux de la version analysée (sinon : patch du jeu, retrouvés par motifs).
    pub known_version: bool,
    pub game_date: Option<String>,
    pub game_date_raw: Option<SiDate>,
    pub player_count: usize,
    pub checked: usize,
    pub plausible: usize,
    pub humans: Vec<Human>,
    /// Joueurs du club du premier manager humain, à comparer avec leurs fiches dans le jeu.
    pub squad: Vec<DbPlayer>,
}

#[cfg(windows)]
fn with_database<T>(f: impl FnOnce(&mut Database<win::Process>, &Module) -> Result<T, MemError>) -> Result<T, MemError> {
    let module = win::find_module()?;
    let globals = globals_for(&module.path)?;
    let process = win::Process::open(module.pid)?;
    let mut db = Database::open(&process, module.base, globals)?;
    f(&mut db, &module)
}

#[cfg(not(windows))]
fn with_database<T>(_f: impl FnOnce(&mut Database<NoMem>, &Module) -> Result<T, MemError>) -> Result<T, MemError> {
    Err(MemError::Unsupported)
}

#[cfg(not(windows))]
pub struct NoMem;
#[cfg(not(windows))]
impl Mem for NoMem {
    fn read(&self, _: u64, _: &mut [u8]) -> bool {
        false
    }
}

fn probe() -> Result<Probe, MemError> {
    with_database(|db, module| {
        let (plausible, checked) = db.check()?;
        let humans = db.humans();
        let squad = match humans.iter().find_map(|h| h.club_id) {
            Some(club) => db.players(80, |p| p.club_id == Some(club) || p.loan_club_id == Some(club)),
            None => Vec::new(),
        };
        let today = db.today();
        Ok(Probe {
            module_path: module.path.display().to_string(),
            module_size: module.size,
            globals: db.globals,
            known_version: is_known(db.globals),
            game_date: today.and_then(|d| d.iso()),
            game_date_raw: today,
            player_count: db.count(),
            checked,
            plausible,
            humans,
            squad,
        })
    })
}

/// Comparaison de noms sans casse ni accents (« Kåre » trouve « kare »).
pub fn fold(s: &str) -> String {
    s.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
            'ç' | 'ć' | 'č' => 'c',
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ñ' | 'ń' | 'ň' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
            'ù' | 'ú' | 'û' | 'ü' | 'ů' => 'u',
            'ý' | 'ÿ' => 'y',
            'š' | 'ś' => 's',
            'ž' | 'ź' | 'ż' => 'z',
            'ł' => 'l',
            c => c,
        })
        .collect()
}

/// État de la lecture directe : points d'entrée, date, nombre de joueurs, managers humains et effectif.
#[tauri::command]
pub async fn fm_memory_probe() -> Result<Probe, MemError> {
    tauri::async_runtime::spawn_blocking(probe).await.map_err(|e| MemError::Unexpected(e.to_string()))?
}

/// Joueurs dont le nom contient `query` (50 au plus), pour comparer avec leurs fiches dans le jeu.
#[tauri::command]
pub async fn fm_memory_find(query: String) -> Result<Vec<DbPlayer>, MemError> {
    let q = fold(query.trim());
    if q.chars().count() < 3 {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_database(|db, _| {
            db.check()?;
            Ok(db.players(50, |p| fold(&p.name).contains(&q)))
        })
    })
    .await
    .map_err(|e| MemError::Unexpected(e.to_string()))?
}

/// Vrai si aucun filtre, ou si l'un des morceaux (séparés par des virgules) figure dans la valeur.
fn matches(query: &Option<String>, value: &Option<String>) -> bool {
    let parts: Vec<String> = query.iter().flat_map(|q| q.split(',')).map(|q| fold(q.trim())).filter(|q| !q.is_empty()).collect();
    if parts.is_empty() {
        return true;
    }
    value.as_deref().map(fold).is_some_and(|v| parts.iter().any(|q| v.contains(q.as_str())))
}

/// Adjectifs de nationalité dont le pays ne commence pas pareil (repliés, sans accents) : « anglais » → Angleterre.
const NATION_ALIASES: &[(&str, &str)] = &[
    ("anglais", "angleterre"), ("english", "england"), ("belge", "belgique"), ("russe", "russie"), ("turc", "turquie"),
    ("danois", "danemark"), ("suedois", "suede"), ("polonais", "pologne"), ("serbe", "serbie"), ("gallois", "galles"),
    ("neerlandais", "pays-bas"), ("hollandais", "pays-bas"), ("dutch", "netherlands"), ("americain", "etats-unis"),
    ("tcheque", "tchequie"), ("slovene", "slovenie"), ("bosnien", "bosnie"), ("irlandais", "irlande"), ("islandais", "islande"),
    ("finlandais", "finlande"), ("estonien", "estonie"), ("letton", "lettonie"), ("lituanien", "lituanie"), ("bulgare", "bulgarie"),
    ("albanais", "albanie"), ("maltais", "malte"), ("chypriote", "chypre"), ("georgien", "georgie"), ("armenien", "armenie"),
    ("swiss", "switzerland"), ("german", "germany"), ("french", "france"), ("spanish", "spain"), ("belarusian", "belarus"),
];

/// Nationalité : le nom du pays (« Biélorussie ») ou son adjectif (« biélorusse ») ; chaque morceau séparé par une
/// virgule est essayé. Un adjectif se reconnaît à un long début commun avec le pays (« espagnol » / « Espagne »).
fn matches_nation(query: &Option<String>, value: &Option<String>) -> bool {
    let parts: Vec<String> = query.iter().flat_map(|q| q.split(',')).map(|q| fold(q.trim())).filter(|q| !q.is_empty()).collect();
    if parts.is_empty() {
        return true;
    }
    let Some(v) = value.as_deref().map(fold) else { return false };
    let words: Vec<&str> = v.split(|c: char| !c.is_alphanumeric() && c != '-').filter(|w| !w.is_empty()).collect();
    parts.iter().any(|q| {
        if v.contains(q.as_str()) {
            return true;
        }
        let q = NATION_ALIASES.iter().find(|(a, _)| a == q).map_or(q.as_str(), |(_, b)| b);
        if v.contains(q) {
            return true;
        }
        let need = 5.max(q.chars().count().saturating_sub(3));
        words.iter().any(|w| w.chars().zip(q.chars()).take_while(|(a, b)| a == b).count() >= need)
    })
}

/// Critères de recherche dans la base (tous facultatifs).
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchFilter {
    /// Postes FM Immersion (`DC`, `MC`…) : au moins un tenu à `min_rating` ou plus (15 par défaut).
    pub positions: Vec<String>,
    pub min_rating: Option<u8>,
    pub min_age: Option<u16>,
    pub max_age: Option<u16>,
    pub min_ca: Option<i16>,
    pub max_ca: Option<i16>,
    /// Potentiel minimal (les potentiels négatifs du jeu, en fourchette, sont gardés).
    pub min_pa: Option<i16>,
    pub max_wage_weekly: Option<i32>,
    /// Club à exclure (celui du manager).
    pub exclude_club_id: Option<i32>,
    /// Exclure le club du manager humain (trouvé dans la partie).
    pub exclude_own: bool,
    /// Seulement les joueurs sans club (libres).
    pub free_only: bool,
    /// Seulement les joueurs sur la liste des transferts.
    pub transfer_listed_only: bool,
    /// Écarter les blessés.
    pub exclude_injured: bool,
    /// Nationalité ou division : morceau du nom, sans tenir compte des majuscules ni des accents.
    pub nation: Option<String>,
    pub division: Option<String>,
    /// Réputation minimale de la division (niveau du championnat).
    pub min_division_reputation: Option<i16>,
    /// Réputation actuelle maximale du joueur (celles que le jeu laisse à 0 ou moins, non lues, sont gardées) :
    /// écarte d'emblée les vedettes qu'un petit club n'attirera pas, avant que la limite de 300 ne les garde.
    pub max_reputation: Option<i16>,
    /// Seulement ces joueurs (identifiants du jeu) : relecture des joueurs suivis. Vide = tous.
    pub ids: Vec<i32>,
    /// Football féminin ou masculin (rempli d'après le club du manager) : on ne propose que des joueurs de la même
    /// catégorie. `None` : pas de tri.
    #[serde(skip)]
    pub women: Option<bool>,
    pub limit: Option<usize>,
}

impl SearchFilter {
    fn pre(&self, p: &Pre) -> bool {
        let min = self.min_rating.unwrap_or(15);
        self.min_ca.map_or(true, |m| p.ca >= m)
            && self.max_ca.map_or(true, |m| p.ca <= m)
            && self.min_pa.map_or(true, |m| p.pa < 0 || p.pa >= m)
            && (self.positions.is_empty()
                || self.positions.iter().any(|c| p.position_ratings.get(c.as_str()).is_some_and(|&v| v >= min)))
    }
    fn keep(&self, p: &DbPlayer) -> bool {
        (self.ids.is_empty() || self.ids.contains(&p.id))
            && self.women.map_or(true, |w| match p.female {
                Some(f) => f == w,
                None => is_women_player(p) == w || (w && p.club_id.is_none()),
            })
            && self.min_age.map_or(true, |m| p.age.is_some_and(|a| a >= m))
            && self.max_age.map_or(true, |m| p.age.is_some_and(|a| a <= m))
            && self.max_wage_weekly.map_or(true, |m| p.wage_weekly.map_or(true, |w| w <= m))
            && self.exclude_club_id.map_or(true, |c| p.club_id != Some(c) && p.loan_club_id != Some(c))
            && (!self.free_only || (p.club_id.is_none() && p.loan_club_id.is_none()))
            && (!self.transfer_listed_only || p.transfer_listed)
            && (!self.exclude_injured || !p.injured)
            && matches_nation(&self.nation, &p.nation)
            && matches(&self.division, &p.division)
            && self.min_division_reputation.map_or(true, |m| p.division_reputation.is_some_and(|r| r >= m))
            && self.max_reputation.map_or(true, |m| p.reputation[1] <= 0 || p.reputation[1] <= m)
    }
}

/// Mots qui désignent le football féminin dans un nom de club ou de championnat (texte replié, sans accents).
/// La base lue ne dit pas le sexe d'un joueur : on le déduit de son club et de son championnat.
const WOMEN_MARKS: &[&str] = &[
    "women", "woman", "ladies", "femin", "femmin", "femenil", "femeni", "frauen", "vrouwen", "damallsvenskan", "toppserien",
    "kvinde", "naisten", "kobiet", "zeny", "nwsl", "wsl", "liga f", "arkema", "(f)", "(w)",
];

pub fn is_women_name(name: &str) -> bool {
    let f = fold(name);
    WOMEN_MARKS.iter().any(|m| f.contains(m)) || f.ends_with(" w") || f.ends_with(" f")
}

/// Prénoms féminins courants (texte replié), pour les joueuses libres que le club ne trahit pas.
/// Prénoms mixtes (Andrea, Camille, Alexis…) volontairement absents.
const WOMEN_FIRST_NAMES: &[&str] = &[
    "abigail", "adriana", "agata", "agathe", "agnes", "agnieszka", "aida", "aina", "ainhoa", "aitana", "aiyana", "alba",
    "alejandra", "alessandra", "alessia", "alexandra", "alexia", "alice", "alicia", "alina", "alisha", "alyssa", "amalie", "amanda",
    "amandine", "amber", "amelia", "amelie", "ana", "anastasia", "andreia", "anette", "angela", "angelica", "angelina", "anja",
    "ann", "anna", "annabel", "anne", "annika", "antonia", "ariadna", "asisat", "aurelie", "ayumi", "barbara", "beatrice",
    "beatriz", "bethany", "bianca", "birgit", "brenda", "bridget", "brittany", "camila", "carla", "carlota", "carmen", "carolina",
    "caroline", "cassandra", "catalina", "catarina", "caterina", "catherine", "cecilia", "celia", "chantal", "charlotte", "chiara", "chloe",
    "christina", "christine", "cindy", "clara", "clarisse", "claudia", "clementine", "constance", "cristiana", "cristina", "dagny", "daniela",
    "danielle", "daphne", "debora", "deborah", "delphine", "denise", "diana", "dominika", "dora", "dorota", "edita", "elena",
    "eleonora", "elisa", "elisabeth", "elise", "elizabeth", "ella", "ellen", "ellie", "eloise", "elsa", "emilia", "emilie",
    "emily", "emma", "erika", "estefania", "esther", "eugenie", "eva", "evelyn", "fabienne", "fatima", "federica", "felicitas",
    "fernanda", "filippa", "francesca", "franziska", "frida", "gabriela", "gabriella", "gaelle", "georgia", "giada", "gina", "giorgia",
    "giulia", "giuliana", "grace", "greta", "gwen", "hailey", "hanna", "hannah", "harriet", "hayley", "heather", "heidi",
    "helena", "helene", "hina", "hinata", "ida", "ilaria", "ines", "ingrid", "irene", "irina", "isabel", "isabella",
    "isabelle", "itziar", "ivana", "jacqueline", "jade", "jana", "jane", "janina", "jasmine", "jenni", "jennifer", "jessica",
    "jill", "joanna", "johanna", "jordyn", "josefine", "josephine", "judit", "judith", "julia", "juliana", "julie", "justine",
    "kadidiatou", "kaja", "karin", "karina", "karolina", "kate", "katharina", "katherine", "kathrin", "katie", "katja", "katrin",
    "kayla", "kerstin", "kirsty", "klara", "kristin", "kristina", "laia", "lara", "laura", "lauren", "lea",
    "leah", "leila", "lena", "leonie", "lieke", "lina", "linda", "lindsey", "line", "lisa", "livia", "lotte",
    "louisa", "louise", "lucia", "luciana", "lucie", "lucy", "luisa", "madeleine", "magdalena", "maite", "maja",
    "malin", "manuela", "mara", "mareike", "margaux", "margot", "maria", "mariana", "marie", "marina", "marion", "marta",
    "martina", "mary", "maryse", "megan", "melanie", "melissa", "mia", "michelle", "mikaela", "milena", "millie", "miriam",
    "molly", "monica", "monika", "nadia", "nadine", "naomi", "natalia", "natasha", "nathalie", "nicole", "nina", "noemi",
    "nora", "oihane", "olga", "olivia", "paula", "paulina", "pauline", "pernille", "petra", "pia", "rachel", "rebecca",
    "rebekah", "renata", "rita", "roberta", "rosa", "rose", "ruth", "sabrina", "sakina", "samantha", "sandra", 
    "sara", "sarah", "selma", "serena", "shannon", "sharon", "silvia", "sofia", "sofie", "sonia", "sophia",
    "sophie", "stefanie", "stephanie", "susanne", "svenja", "tabea", "tanja", "tatiana", "teresa", "tessa", "tina",
    "valentina", "valeria", "vanessa", "vera", "veronica", "veronika", "victoria", "vilde", "viola", "virginia", "vivianne", "wendy",
    "ximena", "yasmin", "yui", "yuka", "yuki", "zoe",
];

/// Prénom féminin courant (premier mot du prénom, sinon du nom complet).
pub fn has_women_first_name(p: &DbPlayer) -> bool {
    let first = p.first_name.as_deref().filter(|f| !f.trim().is_empty()).unwrap_or(&p.name);
    let f = fold(first);
    f.split(|c: char| c.is_whitespace() || c == '-').next().is_some_and(|w| WOMEN_FIRST_NAMES.contains(&w))
}

/// Joueuse : drapeau du jeu ; à défaut (octet illisible), équipe ou championnat féminin (club propriétaire, club de
/// prêt ou division) et, sans club, prénom.
pub fn is_women_player(p: &DbPlayer) -> bool {
    if let Some(f) = p.female {
        return f;
    }
    [&p.club, &p.loan_club, &p.division].iter().any(|x| x.as_deref().is_some_and(is_women_name))
        || (p.club_id.is_none() && p.loan_club_id.is_none() && has_women_first_name(p))
}

/// Recherche dans toute la base (lecture seule, à la demande) : 300 joueurs au plus, meilleurs CA d'abord.
#[tauri::command]
pub async fn fm_memory_search(filter: SearchFilter) -> Result<Vec<DbPlayer>, MemError> {
    tauri::async_runtime::spawn_blocking(move || {
        with_database(|db, _| {
            db.check()?;
            let mut filter = filter;
            let own_club = db.humans().iter().find_map(|h| h.club_id);
            if filter.exclude_own && filter.exclude_club_id.is_none() {
                filter.exclude_club_id = own_club;
            }
            // Même catégorie que l'équipe du manager (relecture des suivis par identifiant : pas de tri).
            if filter.ids.is_empty() {
                if let Some(c) = own_club {
                    filter.women = db.players(1, |p| p.club_id == Some(c) && p.loan_club_id.is_none()).pop().map(|p| is_women_player(&p));
                }
            }
            let limit = filter.limit.unwrap_or(100).min(300);
            Ok(db.search(limit, &|p| filter.pre(p), |p| filter.keep(p)))
        })
    })
    .await
    .map_err(|e| MemError::Unexpected(e.to_string()))?
}

/// CA et PA réels d'un joueur de l'effectif (0-200 ; PA négatif = fourchette du jeu).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ability {
    pub id: i32,
    pub ca: i16,
    pub pa: i16,
    /// Réputation actuelle, salaire par semaine et valeur (monnaie de base) : repères de ce que le club peut
    /// attirer et payer, comparés à ceux des recrues trouvées dans la base.
    pub reputation: i16,
    pub wage_weekly: Option<i32>,
    pub value_raw: Option<i32>,
    pub division_reputation: Option<i16>,
}

/// CA/PA de l'effectif du manager humain, à la date de la partie en cours.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadAbilities {
    pub game_date: Option<String>,
    pub players: Vec<Ability>,
}

/// Joueurs du club (y compris prêtés ailleurs) réduits à leur CA/PA.
pub fn squad_abilities<M: Mem>(db: &mut Database<M>) -> SquadAbilities {
    let players = match db.humans().iter().find_map(|h| h.club_id) {
        Some(club) => db
            .players(120, |p| p.club_id == Some(club) || p.loan_club_id == Some(club))
            .into_iter()
            .map(|p| Ability {
                id: p.id,
                ca: p.ca,
                pa: p.pa,
                reputation: p.reputation[1],
                wage_weekly: p.wage_weekly,
                value_raw: p.value_raw,
                division_reputation: p.division_reputation,
            })
            .collect(),
        None => Vec::new(),
    };
    SquadAbilities { game_date: db.today().and_then(|d| d.iso()), players }
}

/// CA/PA réels de l'effectif (lecture seule, de l'extérieur du jeu), pour suivre la progression sur une échelle
/// fixe : les étoiles du jeu sont relatives à l'effectif. Lancé seulement si le joueur l'a activé.
#[tauri::command]
pub async fn fm_memory_abilities() -> Result<SquadAbilities, MemError> {
    tauri::async_runtime::spawn_blocking(|| {
        with_database(|db, _| {
            db.check()?;
            Ok(squad_abilities(db))
        })
    })
    .await
    .map_err(|e| MemError::Unexpected(e.to_string()))?
}

/// Joueurs d'une division, pour situer le niveau de l'équipe dans son championnat (ou celui d'au-dessus).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivisionPlayers {
    /// Club du manager humain, et sa division (celle de ses joueurs sous contrat).
    pub own_club_id: Option<i32>,
    pub own_division: Option<String>,
    pub own_division_id: Option<i32>,
    /// Joueurs sous contrat avec un club des divisions retenues (prêtés ailleurs exclus).
    pub players: Vec<DbPlayer>,
}

/// Nombre maximal de joueurs renvoyés (une division compte rarement plus de 30 clubs de 40 joueurs).
const MAX_DIVISION_PLAYERS: usize = 4_000;

/// Joueurs de la division du club humain (`division` vide) ou des divisions dont le nom contient `division`.
pub fn division_players<M: Mem>(db: &mut Database<M>, division: Option<&str>) -> DivisionPlayers {
    let own_club_id = db.humans().iter().find_map(|h| h.club_id);
    let own = own_club_id.and_then(|c| db.players(1, |p| p.club_id == Some(c) && p.loan_club_id.is_none() && p.division_id.is_some()).pop());
    let own_division_id = own.as_ref().and_then(|p| p.division_id);
    let own_division = own.and_then(|p| p.division);
    let query = division.map(str::trim).filter(|q| !q.is_empty()).map(String::from);
    let players = match (&query, own_division_id) {
        (Some(_), _) => db.players(MAX_DIVISION_PLAYERS, |p| p.club_id.is_some() && p.loan_club_id.is_none() && p.division.is_some() && matches(&query, &p.division)),
        (None, Some(d)) => db.players(MAX_DIVISION_PLAYERS, |p| p.club_id.is_some() && p.loan_club_id.is_none() && p.division_id == Some(d)),
        (None, None) => Vec::new(),
    };
    DivisionPlayers { own_club_id, own_division, own_division_id, players }
}

/// Joueurs d'une division (lecture seule, à la demande) : la nôtre si `division` est vide, sinon celles dont le
/// nom contient ce texte (sans casse ni accents).
#[tauri::command]
pub async fn fm_memory_division(division: Option<String>) -> Result<DivisionPlayers, MemError> {
    tauri::async_runtime::spawn_blocking(move || {
        with_database(|db, _| {
            db.check()?;
            Ok(division_players(db, division.as_deref()))
        })
    })
    .await
    .map_err(|e| MemError::Unexpected(e.to_string()))?
}

// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Mémoire simulée : des zones posées à des adresses précises.
    #[derive(Default)]
    struct Fake(Vec<(u64, Vec<u8>)>);

    impl Fake {
        fn put(&mut self, addr: u64, bytes: Vec<u8>) {
            self.0.push((addr, bytes));
        }
        fn put_u64(&mut self, addr: u64, v: u64) {
            self.put(addr, v.to_le_bytes().to_vec());
        }
        fn put_i32(&mut self, addr: u64, v: i32) {
            self.put(addr, v.to_le_bytes().to_vec());
        }
        fn put_str(&mut self, addr: u64, s: &str) {
            let mut b = (s.len() as i32).to_le_bytes().to_vec();
            b.extend_from_slice(s.as_bytes());
            b.push(0);
            self.put(addr, b);
        }
    }

    impl Mem for Fake {
        fn read(&self, addr: u64, buf: &mut [u8]) -> bool {
            // Zones les plus récentes en premier, octet par octet.
            for (i, slot) in buf.iter_mut().enumerate() {
                let a = addr + i as u64;
                match self.0.iter().rev().find(|(s, b)| a >= *s && a < s + b.len() as u64) {
                    Some((s, b)) => *slot = b[(a - s) as usize],
                    None => return false,
                }
            }
            true
        }
    }

    const BASE: u64 = 0x7FF0_0000_0000;

    fn date(day: u16, year: u16) -> Vec<u8> {
        let mut b = day.to_le_bytes().to_vec();
        b.extend_from_slice(&year.to_le_bytes());
        b
    }

    /// Un joueur `ACTUAL_PLAYER` complet, comme le jeu le range, plus sa base et la date.
    fn world() -> Fake {
        let mut m = Fake::default();
        let ap = 0x2000_0000u64;
        let vb = 0x2100_0000u64;
        let contract = 0x2200_0000u64;
        let team = 0x2300_0000u64;
        let club = 0x2400_0000u64;
        let list = 0x2600_0000u64;

        // Date du jeu : 1er novembre 2026 (jour 305, compté depuis 1).
        m.put(BASE + KNOWN.date, date(305 | 0x2000, 2026));
        // Liste des joueurs : un pointeur nul (trou) et notre joueur.
        m.put_u64(BASE + KNOWN.database + off::DB_PLAYERS, list);
        m.put_u64(BASE + KNOWN.database + off::DB_PLAYERS + 8, list + 16);
        m.put_u64(list, 0);
        m.put_u64(list + 8, ap);

        let mut b = vec![0u8; off::AP_BLOCK];
        b[0x130..0x138].copy_from_slice(&team.to_le_bytes());
        for (i, (_, pos)) in ATTRIBUTES.iter().enumerate() {
            b[0x150 + pos] = (i % 20 + 1) as u8;
        }
        b[0x150 + 3] = 20; // DC
        b[0x150 + 7] = 15; // MC
        b[0x150 + 5] = 8; // MDF
        b[0x264..0x266].copy_from_slice(&142i16.to_le_bytes());
        b[0x266..0x268].copy_from_slice(&(-8i16).to_le_bytes());
        b[0x234..0x238].copy_from_slice(&1_250_000i32.to_le_bytes());
        m.put(ap, b);
        m.put_u64(ap + 8, vb);
        m.put_i32(vb + 4, 0x288 - 8);
        m.put_i32(vb + 8, 0x2B0 - 8);
        let person = ap + 0x288;
        let actual = ap + 0x2B0;
        m.put_i32(person + 0xC, 2_000_533);
        m.put(person + 0x19, vec![0x02]);
        m.put_u64(actual + 0x18, 0);
        m.put_u64(actual + 0x28, 0x2700_0000);
        m.put_u64(0x2700_0000, 0x2700_0100);
        m.put_str(0x2700_0100, "Pontus");
        m.put_u64(actual + 0x30, 0x2700_0200);
        m.put_u64(0x2700_0200, 0x2700_0300);
        m.put_str(0x2700_0300, "Edh");
        m.put_u64(actual + 0x38, 0);
        m.put(actual + 0x60, date(151, 2000)); // 30 mai 2000 (année bissextile)
        m.put_u64(actual + 0x80, contract);
        m.put(contract, vec![0u8; 0x60]);
        m.put_u64(contract + 0x10, team);
        m.put_u64(actual + 0x88, 0);
        m.put_i32(contract + 0x20, 4_500);
        m.put(contract + 0x48, date(365, 2027));
        m.put(team, vec![0u8; 0x40]);
        m.put_u64(team + 0x30, club);
        m.put_i32(club + 0xC, 7_001);
        m.put_u64(club + 0xC0, 0x2700_0500);
        m.put_str(0x2700_0500, "Vänersborgs IF");
        m.put_u64(club + 0xC8, 0x2700_0600);
        m.put_str(0x2700_0600, "Vänersborg");
        // Nation et division.
        let (nation, comp) = (0x2500_0000u64, 0x2500_1000u64);
        m.put_u64(actual + 0x40, nation);
        m.put_i32(nation + 0xC, 796);
        m.put_u64(nation + 0x20, 0x2700_0700);
        m.put_str(0x2700_0700, "Suède");
        m.put_u64(team + 0x50, comp);
        m.put_i32(comp + 0xC, 1_301);
        m.put_u64(comp + 0x40, 0x2700_0800);
        m.put_str(0x2700_0800, "Ettan Södra");
        m.put(comp + 0x188, 74i16.to_le_bytes().to_vec());
        m
    }

    #[test]
    fn lit_un_joueur_complet() {
        let m = world();
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        assert_eq!(db.count(), 1);
        assert_eq!(db.today().unwrap().iso().as_deref(), Some("2026-11-01"));
        let p = db.players(10, |_| true).pop().unwrap();
        assert_eq!(p.id, 2_000_533);
        assert_eq!(p.name, "Pontus Edh");
        assert_eq!(p.birth_date.as_deref(), Some("2000-05-30"));
        assert_eq!(p.age, Some(26));
        assert_eq!((p.ca, p.pa), (142, -8));
        assert_eq!(p.club.as_deref(), Some("Vänersborgs IF"));
        assert_eq!(p.club_short.as_deref(), Some("Vänersborg"));
        assert_eq!(p.club_id, Some(7_001));
        assert_eq!(p.wage_weekly, Some(4_500));
        assert_eq!((p.loan_club.as_deref(), p.loan_end.as_deref()), (None, None));
        assert_eq!(p.contract_end.as_deref(), Some("2027-12-31"));
        assert_eq!(p.positions_text, "DC, MC");
        assert_eq!(p.attributes.len(), 47);
        assert_eq!(p.attributes["AerialReach"], 1);
        assert_eq!(p.attributes["NaturalFitness"], 47 % 20);
        assert_eq!(p.value_raw, Some(1_250_000));
        assert!(!p.transfer_listed && !p.injured);
        assert_eq!(db.check().unwrap(), (1, 1));
    }

    #[test]
    fn recherche_par_criteres() {
        let m = world();
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        let run = |db: &mut Database<Fake>, f: SearchFilter| db.search(10, &|p| f.pre(p), |p| f.keep(p)).len();
        assert_eq!(run(&mut db, SearchFilter::default()), 1);
        let f = SearchFilter { positions: vec!["DC".into()], max_age: Some(26), min_ca: Some(140), ..Default::default() };
        assert_eq!(run(&mut db, f), 1);
        // MDF à 8 seulement, sous le seuil de 15.
        assert_eq!(run(&mut db, SearchFilter { positions: vec!["MDF".into()], ..Default::default() }), 0);
        assert_eq!(run(&mut db, SearchFilter { max_age: Some(25), ..Default::default() }), 0);
        assert_eq!(run(&mut db, SearchFilter { min_age: Some(40), ..Default::default() }), 0);
        assert_eq!(run(&mut db, SearchFilter { min_age: Some(18), ..Default::default() }), 1);
        assert_eq!(run(&mut db, SearchFilter { exclude_club_id: Some(7_001), ..Default::default() }), 0);
        assert_eq!(run(&mut db, SearchFilter { max_wage_weekly: Some(4_000), ..Default::default() }), 0);
        // Réputation non lue (0) : le joueur reste, le plafond ne joue que sur une réputation connue.
        assert_eq!(run(&mut db, SearchFilter { max_reputation: Some(1), ..Default::default() }), 1);
        assert_eq!(run(&mut db, SearchFilter { free_only: true, ..Default::default() }), 0);
        assert_eq!(run(&mut db, SearchFilter { transfer_listed_only: true, ..Default::default() }), 0);
        let f = |n: &str, d: &str, r| SearchFilter {
            nation: Some(n.into()),
            division: Some(d.into()),
            min_division_reputation: r,
            ..Default::default()
        };
        assert_eq!(run(&mut db, f("suede", "södra", Some(70))), 1);
        assert_eq!(run(&mut db, f("Argentine, Suède", "", None)), 1);
        assert_eq!(run(&mut db, f("France", "", None)), 0);
        // Adjectif de nationalité plutôt que le pays.
        assert_eq!(run(&mut db, f("suédois", "", None)), 1);
        assert!(matches_nation(&Some("biélorusse".into()), &Some("Biélorussie".into())));
        assert!(matches_nation(&Some("espagnol".into()), &Some("Espagne".into())));
        assert!(matches_nation(&Some("slovaque".into()), &Some("Slovaquie".into())));
        assert!(matches_nation(&Some("anglais".into()), &Some("Angleterre".into())));
        assert!(!matches_nation(&Some("slovaque".into()), &Some("Slovénie".into())));
        assert!(!matches_nation(&Some("autrichien".into()), &Some("Australie".into())));
        assert_eq!(run(&mut db, f("", "Allsvenskan", None)), 0);
        assert_eq!(run(&mut db, f("", "", Some(100))), 0);
        // Potentiel négatif (fourchette du jeu) : gardé.
        assert_eq!(run(&mut db, SearchFilter { min_pa: Some(170), ..Default::default() }), 1);
        // Joueur de club féminin : écarté pour une équipe masculine, seul gardé pour une équipe féminine.
        assert_eq!(run(&mut db, SearchFilter { women: Some(false), ..Default::default() }), 1);
        assert_eq!(run(&mut db, SearchFilter { women: Some(true), ..Default::default() }), 0);
        assert!(is_women_name("Arsenal Women") && is_women_name("Olympique Lyonnais Féminin") && is_women_name("Liga F") && is_women_name("Frauen-Bundesliga"));
        let mut w = db.players(1, |_| true).pop().unwrap();
        // Drapeau du jeu lu (octet à 0 dans le monde d'essai) : il décide seul.
        assert_eq!(w.female, Some(false));
        w.first_name = Some("Nicole".into());
        assert!(!is_women_player(&w));
        w.female = Some(true);
        assert!(is_women_player(&w));
        let keep = |f: &SearchFilter, p: &DbPlayer| f.keep(p);
        assert!(keep(&SearchFilter { women: Some(true), ..Default::default() }, &w));
        assert!(!keep(&SearchFilter { women: Some(false), ..Default::default() }, &w));
        // Drapeau illisible : repli sur le club, le championnat et le prénom.
        w.female = None;
        (w.club, w.club_id, w.division, w.first_name) = (None, None, None, Some("Oihane".into()));
        assert!(is_women_player(&w));
        w.first_name = Some("Andrea".into());
        assert!(!is_women_player(&w));
        w.club_id = Some(7_001);
        w.first_name = Some("Nicole".into());
        assert!(!is_women_player(&w), "le prénom ne compte que sans club");
        assert!(is_women_name("Lyon (F)") && !is_women_name("Toulouse FC") && !is_women_name("Malženice") && !is_women_name("Fenerbahçe"));
        // Relecture des joueurs suivis, par identifiant.
        let id = db.search(1, &|_| true, |_| true)[0].id;
        assert_eq!(run(&mut db, SearchFilter { ids: vec![id], ..Default::default() }), 1);
        assert_eq!(run(&mut db, SearchFilter { ids: vec![id + 1], ..Default::default() }), 0);
    }

    #[test]
    fn joueurs_d_une_division() {
        let m = world();
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        // Recherche par nom de division (sans accents) ; sans manager humain, pas de division « à nous ».
        let d = division_players(&mut db, Some("sodra"));
        assert_eq!(d.players.len(), 1);
        assert_eq!(d.own_club_id, None);
        assert!(division_players(&mut db, Some("Allsvenskan")).players.is_empty());
        assert!(division_players(&mut db, None).players.is_empty());
    }

    #[test]
    fn lit_le_staff_du_club() {
        let mut m = world();
        let (table, list) = (0x3000_0000u64, 0x3000_1000u64);
        let (staff, vb, vt, col) = (0x3100_0000u64, 0x3100_1000u64, 0x3100_2000u64, 0x3100_3000u64);
        let (contract, td) = (0x3100_4000u64, 0x0010_0000u32);
        let player_person = 0x2000_0000u64 + 0x288;
        let (pvt, pcol, ptd) = (0x3200_0000u64, 0x3200_1000u64, 0x0010_1000u32);

        // Table des personnes : le joueur de `world()` (classe différente), un trou et le membre du staff.
        m.put_u64(BASE + KNOWN.database + off::DB_PERSONS, table);
        m.put_u64(table + off::TABLE_BY_INDEX, list);
        m.put_u64(table + off::TABLE_BY_INDEX + 8, list + 24);
        m.put_u64(list, player_person);
        m.put_u64(list + 8, 0);
        m.put_u64(list + 16, staff + 0x100);
        m.put_u64(player_person, pvt);
        m.put_u64(pvt - 8, pcol);
        m.put(pcol, [1i32, 0x288, 0, ptd as i32].iter().flat_map(|v| v.to_le_bytes()).collect());
        m.put(BASE + ptd as u64 + 16, b".?AVACTUAL_PLAYER@db@@\0".to_vec());

        // RTTI : vtable du sous-objet PERSON → COL (signature 1, décalage 0x100) → nom de classe.
        m.put_u64(vt - 8, col);
        m.put(col, [1i32, 0x100, 0, td as i32].iter().flat_map(|v| v.to_le_bytes()).collect());
        m.put(BASE + td as u64 + 16, STAFF_CLASS.to_vec());

        let mut b = vec![0u8; 0x200];
        for (_, pos, scaled) in STAFF_ATTRIBUTES {
            b[pos] = if scaled { 50 } else { 12 };
        }
        b[0x32] = 100; // Attaque 20
        b[0x2B] = 1; // Gardiens 1
        m.put(staff, b);
        m.put_u64(staff, vb);
        m.put_i32(vb + 4, 0x100);
        m.put_i32(vb + 8, 0x128);
        m.put_u64(staff + 0x100, vt);
        m.put_i32(staff + 0x100 + 0xC, 9_000_001);
        let actual = staff + 0x128;
        m.put_u64(actual + 0x18, 0);
        m.put_u64(actual + 0x28, 0x3300_0000);
        m.put_u64(0x3300_0000, 0x3300_0100);
        m.put_str(0x3300_0100, "Ján");
        m.put_u64(actual + 0x30, 0x3300_0200);
        m.put_u64(0x3300_0200, 0x3300_0300);
        m.put_str(0x3300_0300, "Novák");
        m.put_u64(actual + 0x38, 0);
        m.put(actual + 0x48, vec![14]);
        m.put(actual + 0x60, date(1, 1980));
        m.put_u64(actual + 0x80, contract);
        m.put(contract, vec![0u8; 0x60]);
        m.put_u64(contract + 0x10, 0x2300_0000); // même équipe que le joueur de `world()`
        m.put(contract + 0x26, vec![2]);
        m.put_i32(contract + 0x20, 900);

        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        let all = db.staff(10, |_| true).unwrap();
        assert_eq!(all.len(), 1);
        let s = &all[0];
        assert_eq!((s.id, s.name.as_str()), (9_000_001, "Ján Novák"));
        assert_eq!((s.club_id, s.club.as_deref()), (Some(7_001), Some("Vänersborgs IF")));
        assert_eq!((s.job_code, s.wage_weekly, s.age), (Some(2), Some(900), Some(46)));
        assert_eq!(s.attributes.len(), 22);
        assert_eq!((s.attributes["Attacking"], s.attributes["Goalkeeping"], s.attributes["Tactical"]), (20, 1, 10));
        assert_eq!((s.attributes["Authority"], s.attributes["WorkingWithYoungsters"], s.attributes["Adaptability"]), (12, 12, 14));
        // Sans manager humain : rien à lister pour « notre » club ; le staff libre est demandé à part.
        let c = club_staff(&mut db, true).unwrap();
        assert!(c.staff.is_empty() && c.free_agents.is_empty());
    }

    #[test]
    fn table_des_personnes_de_la_version_finale() {
        // Version finale : `+0x60` ne contient que des zéros, le vecteur par index est à `+0x88`.
        let mut m = world();
        let (table, list) = (0x3000_0000u64, 0x3000_1000u64);
        m.put_u64(BASE + KNOWN.database + off::DB_PERSONS, table);
        m.put(table, vec![0u8; 0x100]);
        m.put_u64(table + off::TABLE_BY_INDEX_1110, list);
        m.put_u64(table + off::TABLE_BY_INDEX_1110 + 8, list + 16);
        m.put_u64(list, 0x2000_0288);
        m.put_u64(list + 8, 0x2100_0100);
        let db = Database::open(&m, BASE, KNOWN).unwrap();
        assert_eq!(db.persons(), Some(vec![0x2000_0288, 0x2100_0100]));
    }

    #[test]
    fn echelle_des_notes_du_staff() {
        assert_eq!([staff_scale(0), staff_scale(5), staff_scale(50), staff_scale(98), staff_scale(100)], [1, 1, 10, 20, 20]);
        assert_eq!(staff_scale(73), 15);
    }

    #[test]
    fn joueur_prete() {
        let mut m = world();
        let ap = 0x2000_0000u64;
        let actual = ap + 0x2B0;
        let (x, loan, team2, club2) = (0x2800_0000u64, 0x2800_1000u64, 0x2800_2000u64, 0x2800_3000u64);
        // Il joue ailleurs (+0x130), mais son contrat principal reste au club propriétaire.
        m.put_u64(ap + 0x130, team2);
        m.put_u64(actual + 0x88, x);
        m.put_u64(x, loan);
        m.put(loan, vec![0u8; 0x60]);
        m.put_u64(loan + 0x10, team2);
        m.put(loan + 0x48, date(151, 2027));
        m.put(team2, vec![0u8; 0x40]);
        m.put_u64(team2 + 0x30, club2);
        m.put_i32(club2 + 0xC, 9_002);
        m.put_u64(club2 + 0xC0, 0x2800_4000);
        m.put_str(0x2800_4000, "MFK Košice");
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        let p = db.players(1, |_| true).pop().unwrap();
        assert_eq!(p.club.as_deref(), Some("Vänersborgs IF"));
        assert_eq!(p.loan_club.as_deref(), Some("MFK Košice"));
        assert_eq!(p.loan_club_id, Some(9_002));
        assert_eq!(p.loan_end.as_deref(), Some("2027-05-31"));
        // Sans contrat principal lisible, le propriétaire n'est pas le club d'accueil.
        m.put_u64(actual + 0x80, 0);
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        let p = db.players(1, |_| true).pop().unwrap();
        assert_eq!((p.club.as_deref(), p.loan_club.as_deref()), (None, Some("MFK Košice")));
        // Contrat d'essai au même emplacement : ni prêt ni club propriétaire (joueur libre à l'essai).
        m.put_u64(loan, BASE + KNOWN_TRIAL_VTABLE);
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        let p = db.players(1, |_| true).pop().unwrap();
        assert_eq!((p.club.as_deref(), p.loan_club.as_deref(), p.loan_end.as_deref()), (None, None, None));
        // X non nul mais `[X+0]` nul : pas de prêt, le club est celui où il joue.
        m.put_u64(x, 0);
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        let p = db.players(1, |_| true).pop().unwrap();
        assert_eq!((p.club.as_deref(), p.loan_club.as_deref()), (Some("MFK Košice"), None));
    }

    #[test]
    fn convertit_les_attributs_sur_100() {
        let mut m = world();
        let ap = 0x2000_0000u64;
        m.put(ap + 0x278, vec![0x80]);
        m.put(ap + 0x150 + 27, vec![73]); // AerialReach 73/100 → 15
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        let p = db.players(1, |_| true).pop().unwrap();
        assert_eq!(p.attribute_scale, 100);
        assert_eq!(p.attributes["AerialReach"], 15);
    }

    #[test]
    fn rejette_une_structure_incoherente() {
        let mut m = world();
        m.put(0x2000_0000 + 0x264, 999i16.to_le_bytes().to_vec());
        let mut db = Database::open(&m, BASE, KNOWN).unwrap();
        assert!(db.players(1, |_| true).is_empty());
        assert!(matches!(db.check(), Err(MemError::Unexpected(_))));
    }

    #[test]
    fn sans_partie_chargee() {
        let mut m = world();
        let list = 0x2600_0000u64;
        m.put_u64(BASE + KNOWN.database + off::DB_PLAYERS + 8, list);
        assert!(matches!(Database::open(&m, BASE, KNOWN), Err(MemError::NoSave)));
    }

    #[test]
    fn dates_du_jeu() {
        assert_eq!(SiDate { day: 1, year: 2026 }.iso().as_deref(), Some("2026-01-01"));
        assert_eq!(SiDate { day: 60, year: 2028 }.iso().as_deref(), Some("2028-02-29"));
        assert_eq!(SiDate { day: 329, year: 2026 }.iso().as_deref(), Some("2026-11-25"));
        assert_eq!(SiDate { day: 366, year: 2027 }.iso(), None);
        // Date « non renseignée » du jeu.
        assert_eq!(SiDate { day: 1, year: 1900 }.iso(), None);
        // Bits hauts du premier mot ignorés (valeur lue en jeu : 9033 → jour 329).
        assert_eq!(SiDate::from_bytes([0x49, 0x23, 0xEA, 0x07]), SiDate { day: 329, year: 2026 });
        let birth = SiDate { day: 151, year: 2000 };
        assert_eq!(birth.age_at(&SiDate { day: 150, year: 2026 }), Some(25));
        assert_eq!(birth.age_at(&SiDate { day: 151, year: 2026 }), Some(26));
    }

    #[test]
    fn noms_sans_accents() {
        assert_eq!(fold("Kåre Ødegård"), "kare odegard");
    }

    /// Petit PE : une section dont le contenu porte les quatre motifs.
    fn fake_pe(code: &[u8], va: u32) -> Vec<u8> {
        let mut f = vec![0u8; 0x400];
        f[0..2].copy_from_slice(b"MZ");
        f[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        f[0x80..0x84].copy_from_slice(b"PE\0\0");
        f[0x86..0x88].copy_from_slice(&1u16.to_le_bytes());
        f[0x94..0x96].copy_from_slice(&0xF0u16.to_le_bytes());
        let s = 0x80 + 24 + 0xF0;
        f[s..s + 5].copy_from_slice(b".code");
        f[s + 12..s + 16].copy_from_slice(&va.to_le_bytes());
        f[s + 16..s + 20].copy_from_slice(&(code.len() as u32).to_le_bytes());
        f[s + 20..s + 24].copy_from_slice(&0x400u32.to_le_bytes());
        f.extend_from_slice(code);
        f
    }

    fn emit(code: &mut Vec<u8>, va: u32, sig: &Sig, target: u64) {
        let at = code.len();
        let pat = parse_pattern(sig.pattern);
        code.extend(pat.iter().map(|b| b.unwrap_or(0x90)));
        let disp = target as i64 - (va as i64 + at as i64 + sig.disp as i64 + 4);
        code[at + sig.disp..at + sig.disp + 4].copy_from_slice(&(disp as i32).to_le_bytes());
    }

    #[test]
    fn retrouve_les_points_d_entree_par_motifs() {
        let va = 0x1000;
        let mut code = vec![0xCC; 3_000];
        emit(&mut code, va, &SIG_DATABASE, KNOWN.database);
        code.extend(vec![0xCC; 5_000]);
        emit(&mut code, va, &SIG_PERSONS, KNOWN.database + 0x68);
        emit(&mut code, va, &SIG_HUMANS, KNOWN.humans);
        code.extend(vec![0xCC; 100]);
        emit(&mut code, va, &SIG_DATE, KNOWN.date);
        code.extend(vec![0xCC; 64]);
        let g = scan_globals(&mut Cursor::new(fake_pe(&code, va))).unwrap();
        assert_eq!(g, KNOWN);
    }

    #[test]
    fn motif_absent_ou_double() {
        let va = 0x1000;
        let mut code = vec![0xCC; 64];
        emit(&mut code, va, &SIG_DATABASE, KNOWN.database);
        emit(&mut code, va, &SIG_PERSONS, KNOWN.database + 0x68);
        emit(&mut code, va, &SIG_HUMANS, KNOWN.humans);
        assert!(matches!(scan_globals(&mut Cursor::new(fake_pe(&code, va))), Err(MemError::UnknownVersion(_))));
        emit(&mut code, va, &SIG_DATE, KNOWN.date);
        emit(&mut code, va, &SIG_DATE, KNOWN.date + 8);
        assert!(matches!(scan_globals(&mut Cursor::new(fake_pe(&code, va))), Err(MemError::UnknownVersion(_))));
    }
}

/// Vérification sur le vrai module du jeu (hors CI) : `FMI_MODULE=…\\game_plugin.dll cargo test module_reel -- --ignored --nocapture`
#[cfg(test)]
mod module_reel {
    #[test]
    #[ignore]
    fn points_d_entree() {
        let p = std::path::PathBuf::from(std::env::var("FMI_MODULE").unwrap());
        let g = super::globals_for(&p);
        println!("points d'entrée : {:?}, version connue : {:?}", g, g.as_ref().ok().map(|g| super::is_known(*g)));
    }
}
