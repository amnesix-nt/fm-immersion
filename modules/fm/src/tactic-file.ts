import { piKeyOfGameValue } from './game-instructions';
import { MENTALITIES_FM27 } from './team-instructions-fm27';
import { gameRoleOfBits, positionOf, type TacticSlot } from './tactic-slots';

/*
 * Tactique exportée par FM27 (fichier .fmf du dossier `tactics`), une fois déchiffrée côté Rust (fm_tactics.rs) :
 * le contenu `.tac`. Disposition relevée par notre propre analyse (11 et 16/11/2026), vérifiée sur des tactiques
 * exportées du jeu puis réimportées :
 *
 * - en-tête de 16 octets (`03 01 "cat."`…), u32 longueur du nom, nom en UTF-8 ;
 * - `04 02 <mentalité 1-7> 07 02 03`, puis 12 octets de consignes d'équipe (un bit par option non standard,
 *   correspondance encore incomplète : elles ne sont pas importées) et le nom du style ;
 * - 22 blocs de poste, par paire (avec ballon puis sans ballon) pour les 11 joueurs, un octet de rang entre deux paires
 *   à partir de la 3e : `44 00 02`, u32 masque du poste (mêmes bits que le plugin), 3 octets, u32 n,
 *   n × (u64 rôle + 16 octets de consignes individuelles), u32, u64 rôle choisi (bit du rôle + bit de la mission) ;
 * - consignes individuelles d'un rôle : `02 02 02`, u64 masque (bit = valeur de l'énumération PlayerInstruction
 *   du jeu), `ff 00 00 00 00`. Seules celles choisies par le joueur y sont, pas celles que le rôle impose.
 */

export interface TacticFile {
  name: string;
  /** Mentalité (libellé de MENTALITIES_FM27), ou null si elle n'est pas lue. */
  mentality: string | null;
  /** Les onze postes et rôles, dans l'ordre du fichier (gardien d'abord). */
  slots: TacticSlot[];
  /** Consignes individuelles choisies, par poste (« Groupe:Option »). */
  pi: string[][];
}

const u32 = (b: Uint8Array, p: number) => (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)) + b[p + 3]! * 0x1000000;
const u64 = (b: Uint8Array, p: number) => BigInt(u32(b, p)) | (BigInt(u32(b, p + 4)) << 32n);

interface Block {
  pos: number;
  role: bigint;
  pi: bigint;
}

/** Bloc de poste à `p`, ou null si les octets n'en sont pas un. */
function readBlock(b: Uint8Array, p: number): { block: Block; end: number } | null {
  if (p + 14 > b.length || b[p] !== 0x44 || b[p + 1] !== 0 || b[p + 2] !== 2) return null;
  const pos = u32(b, p + 3);
  if (!pos || pos >= 1 << 22) return null;
  const n = u32(b, p + 10);
  if (n < 1 || n > 64) return null;
  let i = p + 14;
  const entries: { role: bigint; pi: bigint }[] = [];
  for (let k = 0; k < n; k++) {
    if (i + 24 > b.length) return null;
    const role = u64(b, i);
    // Consignes : 02 02 02 puis le masque sur 8 octets.
    const pi = b[i + 8] === 2 && b[i + 9] === 2 && b[i + 10] === 2 ? u64(b, i + 11) : 0n;
    entries.push({ role, pi });
    i += 24;
  }
  if (i + 12 > b.length) return null;
  const role = u64(b, i + 4);
  // Consignes du rôle choisi (son bit est dans la valeur choisie, avec celui de la mission).
  const chosen = entries.find((e) => e.role !== 0n && (role & e.role) === e.role);
  return { block: { pos, role, pi: chosen?.pi ?? 0n }, end: i + 12 };
}

function piOf(mask: bigint): string[] {
  const out: string[] = [];
  for (let v = 0; v < 64; v++) {
    if (!((mask >> BigInt(v)) & 1n)) continue;
    const k = piKeyOfGameValue(v);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Lit le contenu `.tac` d'une tactique exportée, ou null s'il n'a pas la forme attendue. */
export function parseTacticFile(bytes: Uint8Array | readonly number[]): TacticFile | null {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length < 40 || b[2] !== 0x63 || b[3] !== 0x61 || b[4] !== 0x74 || b[5] !== 0x2e) return null; // « cat. »
  const len = u32(b, 16);
  if (len > 200 || 20 + len > b.length) return null;
  const name = new TextDecoder().decode(b.subarray(20, 20 + len)).trim();
  let mentality: string | null = null;
  let p = 20 + len;
  for (let i = p + 3; i + 3 <= Math.min(b.length, p + 64); i++) {
    if (b[i] === 7 && b[i + 1] === 2 && b[i + 2] === 3 && b[i - 3] === 4 && b[i - 2] === 2) {
      const m = b[i - 1]!;
      mentality = m >= 1 && m <= 7 ? MENTALITIES_FM27[m - 1]! : null;
      p = i + 3;
      break;
    }
  }
  // Premier bloc de poste : le premier « 44 00 02 » qui se lit en entier.
  let start = -1;
  for (let i = p; i + 3 < b.length; i++) {
    if (b[i] === 0x44 && b[i + 1] === 0 && b[i + 2] === 2 && readBlock(b, i)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const blocks: Block[] = [];
  let i = start;
  while (blocks.length < 22) {
    // Un octet de rang avant chaque paire, à partir de la deuxième.
    let r = readBlock(b, i);
    if (!r && blocks.length % 2 === 0) r = readBlock(b, i + 1);
    if (!r) return null;
    blocks.push(r.block);
    i = r.end;
  }
  const slots: TacticSlot[] = [];
  const pi: string[][] = [];
  for (let k = 0; k < 11; k++) {
    const ip = blocks[2 * k]!;
    const oop = blocks[2 * k + 1]!;
    const pos = positionOf(ip.pos);
    if (!pos) return null;
    slots.push({ index: k, pos, posOOP: positionOf(oop.pos), roleIP: gameRoleOfBits(ip.role, 'ip'), roleOOP: gameRoleOfBits(oop.role, 'oop') });
    pi.push([...piOf(ip.pi), ...piOf(oop.pi)]);
  }
  return { name, mentality, slots, pi };
}
