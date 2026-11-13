import { z } from 'zod';
import { moraleLevel } from './club';
import type { FmPlayer } from './player';
import type { PosCode } from './positions';
import { gameRoleRating, roleThreshold } from './role-ratings-fm27';
import { roleKey } from './game-stars';

/*
 * Tactique : rôles avec et sans ballon, schémas, onze conseillé et équilibre de l'équipe.
 * Les repères de rôles (poids des attributs) et les styles de jeu sont fournis à l'exécution
 * (`TacticReference`) : ils ne sont pas embarqués dans le dépôt.
 */

export const roleRefSchema = z
  .object({
    code: z.string(),
    fr: z.string(),
    en: z.string().optional(),
    phase: z.enum(['ip', 'oop', 'both']),
    positions: z.array(z.string()),
    /** Postes sans ballon quand ils diffèrent des postes avec ballon (rôle « both »). */
    positionsOOP: z.array(z.string()).nullish(),
    /** Codes d'énumération du jeu (InPossessionRole, OutOfPossessionRole). */
    game: z.object({ ip: z.string().optional(), oop: z.string().optional() }).nullish(),
    /**
     * Condition du jeu sur le créneau : « wide » = créneau axial excentré (deux milieux défensifs,
     * centraux gauche/droit…), « wide3 » = idem dans une défense à trois centraux ou plus.
     */
    cond: z.enum(['wide', 'wide3']).nullish(),
    /** Mission avec ballon, fixée par le rôle dans FM27 : Défense, Soutien ou Attaque. */
    duty: z.enum(['d', 's', 'a']).nullish(),
    group: z.string(),
    weights: z.record(z.number()),
    weightsOOP: z.record(z.number()).nullish(),
  })
  .passthrough();

export const styleRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    nameEn: z.string().optional(),
    summary: z.string().optional(),
    inPossession: z.array(z.string()).default([]),
    outOfPossession: z.array(z.string()).default([]),
    weights: z.record(z.number()),
    mentality: z.string().optional(),
    signatureRoles: z.object({ ip: z.array(z.string()), oop: z.array(z.string()) }),
  })
  .passthrough();

export const tacticReferenceSchema = z.object({ roles: z.array(roleRefSchema), styles: z.array(styleRefSchema) }).passthrough();

export type RoleRef = z.infer<typeof roleRefSchema>;
export type StyleRef = z.infer<typeof styleRefSchema>;
export type TacticReference = z.infer<typeof tacticReferenceSchema>;
export type Phase = 'ip' | 'oop';

/** Contexte d'un créneau du schéma, pour les rôles que le jeu réserve aux créneaux excentrés. */
export interface SlotCtx {
  /** Créneau axial décalé à gauche ou à droite (le jeu ajoute un bit de côté au poste central). */
  wide: boolean;
  /** Nombre de défenseurs centraux du schéma. */
  cbs: number;
}

const CENTRAL: ReadonlySet<PosCode> = new Set<PosCode>(['DC', 'MDF', 'MC', 'MOC', 'BT']);

/** Contexte de chaque créneau d'après sa position sur le terrain (x en %, 50 = axe). */
export function slotContexts(slots: { pos: PosCode; x: number }[]): SlotCtx[] {
  const cbs = slots.filter((s) => s.pos === 'DC').length;
  return slots.map((s) => ({ wide: CENTRAL.has(s.pos) && Math.abs(s.x - 50) >= 8, cbs }));
}

/** Coordonnées des postes en % du terrain (x de gauche à droite, y du but adverse vers le sien). */
export const FORMATIONS: Record<string, [PosCode, number, number][]> = {
  '4-3-3': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MDF', 50, 57], ['MC', 30, 44], ['MC', 70, 44], ['MOG', 15, 22], ['BT', 50, 12], ['MOD', 85, 22]],
  '4-2-3-1': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MDF', 35, 57], ['MDF', 65, 57], ['MOG', 15, 34], ['MOC', 50, 34], ['MOD', 85, 34], ['BT', 50, 12]],
  '4-4-2': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MG', 15, 48], ['MC', 38, 50], ['MC', 62, 50], ['MD', 85, 48], ['BT', 38, 16], ['BT', 62, 16]],
  '4-1-4-1': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MDF', 50, 60], ['MG', 15, 42], ['MC', 36, 44], ['MC', 64, 44], ['MD', 85, 42], ['BT', 50, 12]],
  '4-4-1-1': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MG', 15, 50], ['MC', 38, 52], ['MC', 62, 52], ['MD', 85, 50], ['MOC', 50, 30], ['BT', 50, 12]],
  '4-3-1-2': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MDF', 50, 60], ['MC', 28, 48], ['MC', 72, 48], ['MOC', 50, 32], ['BT', 36, 13], ['BT', 64, 13]],
  '3-5-2': [['GB', 50, 92], ['DC', 25, 76], ['DC', 50, 78], ['DC', 75, 76], ['DLG', 10, 52], ['MDF', 50, 60], ['MC', 32, 44], ['MC', 68, 44], ['DLD', 90, 52], ['BT', 38, 15], ['BT', 62, 15]],
  '3-4-3': [['GB', 50, 92], ['DC', 25, 76], ['DC', 50, 78], ['DC', 75, 76], ['DLG', 12, 50], ['MC', 38, 54], ['MC', 62, 54], ['DLD', 88, 50], ['MOG', 18, 22], ['BT', 50, 12], ['MOD', 82, 22]],
  '5-3-2': [['GB', 50, 92], ['DLG', 10, 66], ['DC', 30, 77], ['DC', 50, 79], ['DC', 70, 77], ['DLD', 90, 66], ['MC', 28, 48], ['MDF', 50, 56], ['MC', 72, 48], ['BT', 38, 15], ['BT', 62, 15]],
  '5-4-1': [['GB', 50, 92], ['DLG', 10, 66], ['DC', 30, 77], ['DC', 50, 79], ['DC', 70, 77], ['DLD', 90, 66], ['MG', 15, 45], ['MC', 38, 50], ['MC', 62, 50], ['MD', 85, 45], ['BT', 50, 14]],
  '5-2-3': [['GB', 50, 92], ['DLG', 10, 66], ['DC', 30, 77], ['DC', 50, 79], ['DC', 70, 77], ['DLD', 90, 66], ['MC', 35, 50], ['MC', 65, 50], ['MOG', 18, 24], ['BT', 50, 13], ['MOD', 82, 24]],
  // Schémas réels des entraîneurs d'aujourd'hui (relevés dans le mod « AI Manager Mode », 07/11/2026) : deux
  // centraux et des latéraux hauts (Arteta, Slot, Emery…), 3-2-4-1 de Gasperini et Alonso, 3-4-3 décalé de
  // De Zerbi, et les schémas sans avant-centre (Fàbregas). Le jeu ne les nomme pas ainsi : les clés sont les lignes.
  '2-3-2-3': [['GB', 50, 92], ['DC', 36, 76], ['DC', 64, 76], ['DLG', 10, 52], ['MDF', 50, 58], ['DLD', 90, 52], ['MC', 32, 42], ['MC', 68, 42], ['MOG', 15, 22], ['BT', 50, 12], ['MOD', 85, 22]],
  '2-4-3-1': [['GB', 50, 92], ['DC', 36, 76], ['DC', 64, 76], ['DLG', 10, 54], ['MDF', 36, 58], ['MDF', 64, 58], ['DLD', 90, 54], ['MOG', 15, 32], ['MOC', 50, 32], ['MOD', 85, 32], ['BT', 50, 12]],
  '2-3-4-1': [['GB', 50, 92], ['DC', 36, 76], ['DC', 64, 76], ['DLG', 10, 52], ['MDF', 50, 58], ['DLD', 90, 52], ['MOG', 15, 30], ['MOC', 36, 32], ['MOC', 64, 32], ['MOD', 85, 30], ['BT', 50, 12]],
  '2-4-2-2': [['GB', 50, 92], ['DC', 36, 76], ['DC', 64, 76], ['DLG', 10, 50], ['MC', 36, 48], ['MC', 64, 48], ['DLD', 90, 50], ['MOG', 15, 26], ['MOD', 85, 26], ['BT', 38, 13], ['BT', 62, 13]],
  '3-2-4-1': [['GB', 50, 92], ['DC', 25, 76], ['DC', 50, 78], ['DC', 75, 76], ['MDF', 36, 58], ['MDF', 64, 58], ['MG', 12, 44], ['MD', 88, 44], ['MOC', 36, 30], ['MOC', 64, 30], ['BT', 50, 12]],
  '3-3-1-3': [['GB', 50, 92], ['DC', 25, 76], ['DC', 50, 78], ['DC', 75, 76], ['DLG', 10, 52], ['MDF', 50, 58], ['DLD', 90, 52], ['MC', 50, 42], ['MOG', 18, 22], ['BT', 50, 12], ['MOD', 82, 22]],
  '3-4-3-0': [['GB', 50, 92], ['DC', 25, 76], ['DC', 50, 78], ['DC', 75, 76], ['DLG', 10, 50], ['DLD', 90, 50], ['MC', 36, 46], ['MC', 64, 46], ['MOG', 18, 22], ['MOC', 50, 26], ['MOD', 82, 22]],
  '5-2-3-0': [['GB', 50, 92], ['DG', 12, 70], ['DC', 30, 77], ['DC', 50, 79], ['DC', 70, 77], ['DD', 88, 70], ['MDF', 36, 56], ['MDF', 64, 56], ['MOG', 18, 22], ['MOC', 50, 26], ['MOD', 82, 22]],
  '4-1-2-3-0': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MDF', 50, 58], ['MC', 32, 44], ['MC', 68, 44], ['MOG', 18, 22], ['MOC', 50, 26], ['MOD', 82, 22]],
  '4-2-1-3-0': [['GB', 50, 92], ['DG', 15, 72], ['DC', 38, 76], ['DC', 62, 76], ['DD', 85, 72], ['MDF', 36, 58], ['MDF', 64, 58], ['MC', 50, 44], ['MOG', 18, 22], ['MOC', 50, 26], ['MOD', 82, 22]],
};

/** Clés de schéma, la plus longue d'abord : « 3-4-3-0 … » ne doit pas être pris pour un 3-4-3. */
export const formationKeys = (): string[] => Object.keys(FORMATIONS).sort((a, b) => b.length - a.length);

/** Schéma connu dont les onze postes sont exactement ceux donnés (onze du jeu, formation adverse), sinon null. */
export function formationOfPositions(positions: (PosCode | null | undefined)[]): string | null {
  if (positions.length !== 11 || positions.some((p) => !p)) return null;
  const key = [...(positions as PosCode[])].sort().join(',');
  return formationKeys().find((k) => FORMATIONS[k]!.map(([p]) => p).sort().join(',') === key) ?? null;
}

/** Schémas naturels de chaque style (avec ballon, du plus naturel au plus alternatif). */
export const STYLE_FORMS: Record<string, string[]> = {
  possession: ['4-3-3', '2-3-2-3', '4-2-3-1', '2-4-3-1', '4-1-4-1', '3-2-4-1'],
  tikitaka: ['4-3-3', '2-3-2-3', '4-1-4-1', '3-4-3', '4-1-2-3-0', '3-4-3-0'],
  'tikitaka-v': ['4-3-1-2', '4-2-3-1', '2-3-4-1'],
  gegenpress: ['4-2-3-1', '2-4-3-1', '4-3-3', '2-3-2-3', '4-4-2', '4-2-1-3-0'],
  wings: ['4-4-2', '2-4-2-2', '4-2-3-1', '3-4-3', '3-3-1-3', '5-2-3'],
  longball: ['4-4-2', '4-4-1-1', '3-5-2'],
  'counter-fluid': ['4-2-3-1', '2-4-3-1', '4-3-3', '4-4-2', '5-2-3-0'],
  'counter-direct': ['4-4-2', '4-4-1-1', '3-5-2'],
  catenaccio: ['5-3-2', '3-5-2'],
  'ultra-def': ['5-4-1', '5-3-2', '4-1-4-1'],
};

const ROLE_POS: Record<string, PosCode> = { GK: 'GB', DC: 'DC', DL: 'DG', DR: 'DD', WBL: 'DLG', WBR: 'DLD', DM: 'MDF', MC: 'MC', ML: 'MG', MR: 'MD', AML: 'MOG', AMR: 'MOD', AMC: 'MOC', ST: 'BT' };
const DEFAULT_ROLE: Record<PosCode, string> = { GB: 'GK', DC: 'CB', DG: 'FB', DD: 'FB', DLG: 'WB', DLD: 'WB', MDF: 'DM', MC: 'CM', MG: 'W', MD: 'W', MOG: 'W', MOD: 'W', MOC: 'AM', BT: 'CF' };

/** Attributs de base de chaque famille de poste, du plus au moins important. */
const POS_BASE: Record<string, string[]> = {
  GK: ['Reflexes', 'OneOnOnes', 'Agility', 'Handling', 'AerialReach', 'CommandOfArea', 'Positioning', 'Anticipation', 'Concentration', 'Communication', 'Kicking', 'Decisions', 'Composure'],
  CB: ['Marking', 'Tackling', 'Heading', 'Positioning', 'Strength', 'JumpingReach', 'Pace', 'Anticipation', 'Composure', 'Decisions'],
  FB: ['Tackling', 'Marking', 'Crossing', 'Stamina', 'Pace', 'Positioning', 'Acceleration', 'WorkRate', 'Teamwork', 'Decisions'],
  WB: ['Crossing', 'Stamina', 'Pace', 'Acceleration', 'WorkRate', 'Dribbling', 'Tackling', 'Teamwork', 'Passing', 'Decisions'],
  DM: ['Tackling', 'Positioning', 'Anticipation', 'Passing', 'Teamwork', 'Concentration', 'Decisions', 'Composure', 'Stamina', 'WorkRate'],
  CM: ['Passing', 'Decisions', 'Vision', 'FirstTouch', 'Teamwork', 'Stamina', 'WorkRate', 'Technique', 'Composure', 'Anticipation'],
  WM: ['Crossing', 'Passing', 'Stamina', 'WorkRate', 'Pace', 'Dribbling', 'Technique', 'Teamwork', 'Acceleration', 'Decisions'],
  W: ['Dribbling', 'Crossing', 'Pace', 'Acceleration', 'Technique', 'Agility', 'Flair', 'FirstTouch', 'Passing', 'Movement'],
  AM: ['Passing', 'Vision', 'Technique', 'FirstTouch', 'Decisions', 'Flair', 'Movement', 'Composure', 'Dribbling', 'LongShots'],
  ST: ['Finishing', 'Movement', 'Composure', 'FirstTouch', 'Anticipation', 'Acceleration', 'Pace', 'Technique', 'Heading', 'Strength'],
};
const POS_BASE_OF: Record<PosCode, string> = { GB: 'GK', DC: 'CB', DD: 'FB', DG: 'FB', DLD: 'WB', DLG: 'WB', MDF: 'DM', MC: 'CM', MD: 'WM', MG: 'WM', MOD: 'W', MOG: 'W', MOC: 'AM', BT: 'ST' };
// Attributs qui pèsent le plus dans le moteur de FM27 (tests d'Harvestgreen, FM-Arena, 10/11/2026, voir engine-value.ts) :
// vitesse, accélération et endurance loin devant, puis l'anticipation. Les prises de décision n'y changent presque rien.
// Ne sert qu'aux rôles sans note du jeu.
const ENGINE_KEYS = ['Acceleration', 'Pace', 'Stamina', 'Anticipation'];
const FIT_W = { keys: 0.7, base: 0.2, engine: 0.1 };
export const INVERTED = new Set(['IFB', 'IWB', 'IF', 'IW', 'IOW']);

/** Signaux agrégés de l'effectif, comparés aux exigences des styles. */
const SIGNALS: Record<string, string[]> = {
  technical: ['Passing', 'FirstTouch', 'Technique', 'Composure'],
  creators: ['Vision', 'Passing', 'Flair', 'Decisions'],
  physical: ['Stamina', 'Strength', 'NaturalFitness', 'WorkRate'],
  pace: ['Pace', 'Acceleration'],
  press: ['WorkRate', 'Stamina', 'Aggression', 'Teamwork', 'Anticipation'],
  aerial: ['Heading', 'JumpingReach', 'Strength'],
  wide: ['Crossing', 'Dribbling', 'Acceleration', 'Stamina'],
  finishing: ['Finishing', 'Composure', 'Movement'],
  defense: ['Marking', 'Tackling', 'Positioning', 'Concentration'],
};

export const avg = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
/** Clé d'attribut des repères (« offTheBall », « firstTouch ») vers celle du jeu (« Movement », « FirstTouch »). */
export const attrKey = (k: string) => (k === 'offTheBall' ? 'Movement' : k.charAt(0).toUpperCase() + k.slice(1));
export const attrOf = (p: FmPlayer, k: string): number | null => p.attributes[k] ?? null;

export const sideOf = (pos: PosCode): 'L' | 'R' | null => (/^(DG|DLG|MG|MOG)$/.test(pos) ? 'L' : /^(DD|DLD|MD|MOD)$/.test(pos) ? 'R' : null);

export function footInfo(p: FmPlayer) {
  const f = (p.foot ?? '').toLowerCase();
  if (/deux|ambi|both|either/.test(f)) return { strong: 'B' as const, only: false };
  const strong = /gauch|left/.test(f) ? ('L' as const) : /droit|right/.test(f) ? ('R' as const) : null;
  return { strong, only: /uniquement|only/.test(f) };
}

/** Pénalité de pied : un rôle rentrant veut le pied opposé au côté, les autres le pied du côté. */
function footAdj(p: FmPlayer, code: string, pos: PosCode) {
  const side = sideOf(pos);
  if (!side) return 0;
  const fi = footInfo(p);
  if (!fi.strong || fi.strong === 'B') return 0;
  const want = INVERTED.has(code) ? (side === 'L' ? 'R' : 'L') : side;
  return fi.strong === want ? 0 : fi.only ? -1 : -0.5;
}

function wmean(p: FmPlayer, w: Record<string, number>) {
  let s = 0;
  let t = 0;
  for (const [k, wt] of Object.entries(w)) {
    const a = attrOf(p, attrKey(k));
    if (a != null) {
      s += a * wt;
      t += wt;
    }
  }
  return t ? s / t : null;
}

/**
 * Rôles exigeants de FM27 (Attaquant désaxé, Rôle libre, Faux neuf…) : le jeu divise la valeur par 2 quand
 * la capacité actuelle du joueur est sous le seuil du rôle. Avec la capacité (`ca`, lue en mémoire si le joueur
 * l'a activé), on applique la règle ; sans elle, on retient un quart de moins, pour ne choisir ces rôles que s'ils
 * dépassent nettement les autres.
 */
function thresholdFactor(p: FmPlayer, gameCode: string): number {
  const t = roleThreshold(gameCode);
  if (t == null) return 1;
  const ca = p.ca;
  return ca == null ? 0.75 : ca < t ? 0.5 : 1;
}

/**
 * Forme du jour, sur l'échelle des notes (/20) : fatigue (condition sous 95 %), rythme de match
 * (sous 90 %), moral et place de leader pèsent sur le choix du titulaire, sans changer
 * l'adéquation au rôle affichée.
 */
/** Points retirés (sur 20) par point de rythme de match sous 90 %. */
export const SHARPNESS_WEIGHT = 0.025;

export function readiness(p: FmPlayer): number {
  const r = readinessParts(p);
  return r.condition + r.sharpness + r.morale + r.leader;
}

/** Détail de la forme du jour, pour dire pourquoi un joueur est écarté (fatigue, manque de rythme, moral). */
export function readinessParts(p: FmPlayer): { condition: number; sharpness: number; morale: number; leader: number } {
  const condition = p.condition != null && p.condition < 95 ? -(95 - p.condition) * 0.1 : 0;
  // Le rythme se regagne en jouant : il départage deux joueurs proches, il ne doit pas écarter un joueur nettement
  // meilleur (à 0,05 par point, un joueur à 55 % perdait 1,75 point, soit presque une étoile, et ne rejouait jamais).
  const sharpness = p.sharpness != null && p.sharpness < 90 ? -(90 - p.sharpness) * SHARPNESS_WEIGHT : 0;
  const m = moraleLevel(p.morale);
  const morale = m == null ? 0 : ([-1.2, -0.7, -0.3, 0, 0.2, 0.4] as const)[m]!;
  // Faire jouer les leaders du vestiaire soutient le moral du groupe.
  const leader = /leader|meneur|chef/i.test(p.hierarchy ?? '') ? 0.2 : /influen/i.test(p.hierarchy ?? '') ? 0.1 : 0;
  return { condition, sharpness, morale, leader };
}

export class TacticEngine {
  readonly roles: Map<string, RoleRef>;

  constructor(readonly ref: TacticReference) {
    this.roles = new Map(ref.roles.map((r) => [r.code, r]));
  }

  /** Notes calculées sur les seuls attributs, sans valeurs lues ni étoiles du jeu (voir `absolute`). */
  private raw = false;

  /**
   * Même moteur, notes sur une échelle fixe : moyenne pondérée des attributs du rôle, sur 20, comparable d'un club à
   * l'autre. Les étoiles du jeu sont rapportées à l'effectif ; pour juger une recrue d'un autre club, il faut l'absolu.
   */
  absolute(): TacticEngine {
    const e = new TacticEngine(this.ref);
    e.raw = true;
    return e;
  }

  /** Postes où le jeu propose le rôle ; sans phase, tous ses postes. */
  rolePositions(r: RoleRef, phase?: Phase): PosCode[] {
    const raw = phase === 'oop' && r.positionsOOP ? r.positionsOOP : phase === undefined && r.positionsOOP ? [...new Set([...r.positions, ...r.positionsOOP])] : r.positions;
    return raw.map((x) => ROLE_POS[x]).filter((x): x is PosCode => !!x);
  }

  /**
   * Le jeu propose-t-il ce rôle à ce poste dans cette phase ? Sans contexte de créneau, les rôles
   * réservés aux créneaux excentrés sont admis (on ne sait pas où joue le joueur).
   */
  availableAt(r: RoleRef, pos: PosCode, phase: Phase, ctx?: SlotCtx): boolean {
    if (!(r.phase === phase || r.phase === 'both') || !this.rolePositions(r, phase).includes(pos)) return false;
    if (!ctx || !r.cond) return true;
    return ctx.wide && (r.cond === 'wide' || ctx.cbs >= 3);
  }

  /**
   * Adéquation d'un joueur à un rôle, sur 20. Pour les rôles de FM27, c'est la note du jeu
   * (role-ratings-fm27.ts). Sinon (repères locaux) : 70 % attributs-clés du rôle, 20 % base du poste,
   * 10 % « moteur de match » (vitesse, accélération, anticipation, décisions), puis correction du pied.
   */
  roleFit(p: FmPlayer, code: string, phase: Phase, pos?: PosCode): number | null {
    const r = this.roles.get(code);
    if (!r) return null;
    if (this.raw) {
      // Échelle des attributs, corrigée pour les joueurs du club par l'avis du staff (voir withStaffOpinion).
      const c = this.computedFit(p, code, phase, pos);
      return c == null || !p.staffAdj ? c : Math.max(1, Math.min(20, c + p.staffAdj));
    }
    // Valeur lue dans le jeu pour ce joueur, ce poste et cette phase : elle prime sur tout calcul.
    const read = this.readFit(p, r, phase, pos);
    if (read != null) return read;
    // Sans lecture, la note calculée est ramenée à l'échelle des étoiles du jeu (voir calibrate).
    if (!this.cal) return this.computedFit(p, code, phase, pos);
    const thr = this.thresholdCode(r, phase);
    const c = this.computedFit(p, code, phase, pos, !!thr);
    if (c == null) return c;
    // Rôle à seuil : perte mesurée sur les valeurs lues de ce rôle, sinon 5 points (4 à 7 constatés).
    return thr ? Math.max(1, this.scaled(p, c, pos) - (this.thrLoss.get(thr) ?? 5)) : this.scaled(p, c, pos);
  }

  /** Code du jeu du rôle s'il est à seuil (note divisée par 2 sous une capacité minimale) et la capacité inconnue. */
  private thresholdCode(r: RoleRef, phase: Phase): string | null {
    const g = phase === 'oop' ? r.game?.oop : r.game?.ip;
    return g && roleThreshold(g) != null ? g : null;
  }

  /** Valeur lue dans le jeu (sur 20, 10 = 0 étoile, 20 = 5 étoiles), ou null. */
  readFit(p: FmPlayer, r: RoleRef, phase: Phase, pos?: PosCode): number | null {
    if (!pos) return null;
    const table = p.gameStars?.[pos]?.[phase];
    if (!table) return null;
    const v = table[roleKey(r.fr)];
    return v == null ? null : Math.max(1, Math.min(20, v));
  }

  /**
   * Échelle commune : `a × note calculée + b` ≈ valeur lue dans le jeu. Les deux ne sont pas sur la même
   * échelle (moyenne d'attributs d'un côté, étoiles rapportées à la capacité actuelle de l'autre) ; sans
   * cette correction, un joueur lu dans le jeu écraserait les autres.
   * - Pente et décalage ajustés par moindres carrés, à part pour les gardiens (attributs propres) et pour les
   *   joueurs de champ (au moins 6 valeurs et une pente positive, sinon simple décalage moyen).
   * - Décalage propre à chaque joueur dès qu'il a 2 valeurs lues : le jeu rapporte ses étoiles à la capacité
   *   actuelle du joueur, que les attributs seuls ne donnent pas. Ses rôles et postes non lus en profitent.
   */
  calibrate(list: FmPlayer[]): this {
    this.cal = null;
    this.calBy = new Map();
    this.thrLoss = new Map();
    this.calOut = null;
    this.calGk = null;
    const pairs: { id: string; gk: boolean; c: number; v: number }[] = [];
    const thrPairs: { id: string; gk: boolean; c: number; v: number; thr: string }[] = [];
    for (const p of list)
      for (const [pos, byPh] of Object.entries(p.gameStars ?? {}))
        for (const ph of ['ip', 'oop'] as const)
          for (const r of this.roles.values()) {
            if (!byPh?.[ph] || !(r.phase === ph || r.phase === 'both')) continue;
            const v = this.readFit(p, r, ph, pos as PosCode);
            if (v == null) continue;
            const thr = this.thresholdCode(r, ph);
            const c = this.computedFit(p, r.code, ph, pos as PosCode, !!thr);
            if (c == null) continue;
            // Les rôles à seuil sont mesurés à part (perte propre), pour ne pas fausser l'échelle.
            if (thr) thrPairs.push({ id: p.id, gk: pos === 'GB', c, v, thr });
            else pairs.push({ id: p.id, gk: pos === 'GB', c, v });
          }
    // Joueurs sans valeur lue : leur meilleure valeur suit leurs étoiles générales (à ±1 sur 440 valeurs).
    const anchored = list.filter((p) => p.stars?.current != null && Object.keys(p.attributes).length);
    if (!pairs.length && !anchored.length) return this;
    const fit = (xs: { c: number; v: number }[]) => {
      const n = xs.length;
      const mx = xs.reduce((a, x) => a + x.c, 0) / n;
      const my = xs.reduce((a, x) => a + x.v, 0) / n;
      let sxy = 0;
      let sxx = 0;
      for (const x of xs) {
        sxy += (x.c - mx) * (x.v - my);
        sxx += (x.c - mx) ** 2;
      }
      const a = n >= 6 && sxx > 1e-6 ? sxy / sxx : 0;
      return a > 0.2 ? { a, b: my - a * mx, n } : { a: 1, b: my - mx, n };
    };
    this.cal = pairs.length ? fit(pairs) : { a: 1, b: 0, n: 0 };
    const out = pairs.filter((x) => !x.gk);
    const gk = pairs.filter((x) => x.gk);
    if (out.length) this.calOut = fit(out);
    if (gk.length) this.calGk = fit(gk);
    const byPlayer = new Map<string, { c: number; v: number; gk: boolean }[]>();
    for (const x of pairs) byPlayer.set(`${x.id}|${x.gk ? 'g' : 'o'}`, [...(byPlayer.get(`${x.id}|${x.gk ? 'g' : 'o'}`) ?? []), x]);
    for (const [k, xs] of byPlayer) {
      if (xs.length < 2) continue;
      const a = (xs[0]!.gk ? this.calGk : this.calOut)?.a ?? this.cal.a;
      this.calBy.set(k, xs.reduce((s, x) => s + (x.v - a * x.c), 0) / xs.length);
    }
    // Ancrage sur les étoiles générales : valeur du meilleur rôle ≈ 10 + 2 × étoiles (échelle du jeu, 10 = 0 étoile).
    // Les étoiles sont relatives à l'effectif : l'échelle calibrée sert à comparer des joueurs à une même date (onze,
    // tactique, recrue face à l'effectif), jamais à suivre une progression dans le temps (voir `level`, tiré des attributs).
    for (const p of anchored) {
      const gk = p.positions.includes('GB');
      const k = `${p.id}|${gk ? 'g' : 'o'}`;
      if (this.calBy.has(k)) continue;
      const best = this.bestComputed(p);
      if (best == null) continue;
      const a = (gk ? this.calGk : this.calOut)?.a ?? this.cal.a;
      this.calBy.set(k, 10 + 2 * p.stars!.current! - a * best);
    }
    // Sans aucune valeur lue, les joueurs sans étoiles prennent le décalage moyen des joueurs ancrés.
    if (!pairs.length && this.calBy.size) this.cal = { a: 1, b: [...this.calBy.values()].reduce((x, y) => x + y, 0) / this.calBy.size, n: 0 };
    const loss = new Map<string, number[]>();
    for (const x of thrPairs) {
      const pl = list.find((p) => p.id === x.id)!;
      loss.set(x.thr, [...(loss.get(x.thr) ?? []), this.scaled(pl, x.c, x.gk ? 'GB' : undefined) - x.v]);
    }
    for (const [k, xs] of loss) this.thrLoss.set(k, Math.max(0, xs.reduce((a, b) => a + b, 0) / xs.length));
    return this;
  }

  /** Meilleure note calculée du joueur (postes naturels, rôles sans seuil). */
  private bestComputed(p: FmPlayer): number | null {
    let best: number | null = null;
    for (const pos of p.positions)
      for (const r of this.roles.values())
        for (const ph of ['ip', 'oop'] as const) {
          if (!this.availableAt(r, pos, ph) || this.thresholdCode(r, ph)) continue;
          const c = this.computedFit(p, r.code, ph, pos, true);
          if (c != null && (best == null || c > best)) best = c;
        }
    return best;
  }

  /** Note calculée ramenée à l'échelle du jeu pour ce joueur et ce poste (voir calibrate). */
  private scaled(p: FmPlayer, c: number, pos?: PosCode): number {
    if (!this.cal) return c;
    const gk = pos === 'GB';
    const g = (gk ? this.calGk : this.calOut) ?? this.cal;
    const b = this.calBy.get(`${p.id}|${gk ? 'g' : 'o'}`) ?? g.b;
    return Math.max(1, Math.min(20, g.a * c + b));
  }

  /** Correction d'échelle en cours (null : aucune valeur lue dans le jeu). */
  cal: { a: number; b: number; n: number } | null = null;
  private calOut: { a: number; b: number; n: number } | null = null;
  private calGk: { a: number; b: number; n: number } | null = null;
  private calBy = new Map<string, number>();
  private thrLoss = new Map<string, number>();

  /**
   * Le joueur peut-il tenir ce poste ? Poste naturel, poste où le jeu le juge au moins accompli
   * (familiarité 15 et plus), ou poste pour lequel le jeu a donné ses étoiles. Hors poste naturel, la note
   * tient déjà compte de la familiarité (formule du jeu ou étoiles lues).
   */
  canPlay(p: FmPlayer, pos: PosCode): boolean {
    if (p.positions.includes(pos)) return true;
    if ((p.familiarity?.[pos] ?? 0) >= 15) return true;
    const t = p.gameStars?.[pos];
    return !!t && Object.values(t).some((x) => x && Object.keys(x).length > 0);
  }

  /** Note calculée (formule du jeu ou repères maison), sans les valeurs lues. */
  computedFit(p: FmPlayer, code: string, phase: Phase, pos?: PosCode, noThreshold = false): number | null {
    const r = this.roles.get(code);
    if (!r) return null;
    // Rôle connu du jeu : note de FM27 (attributs clés, secondaires, à éviter, familiarité), puis pied.
    const gameCode = phase === 'oop' ? r.game?.oop : r.game?.ip;
    const game = gameCode ? gameRoleRating(p, gameCode, pos) : null;
    if (game != null) return Math.max(1, Math.min(20, game * (noThreshold ? 1 : thresholdFactor(p, gameCode!)) + (pos ? footAdj(p, code, pos) : 0)));
    const keys = wmean(p, phase === 'oop' && r.weightsOOP ? r.weightsOOP : r.weights);
    if (keys == null) return null;
    const p0 = pos ?? this.rolePositions(r, phase)[0];
    const bk = (p0 && POS_BASE[POS_BASE_OF[p0]]) || [];
    const third = Math.ceil(bk.length / 3);
    const base = avgWeighted(bk.map((k, i) => [attrOf(p, k), i < third ? 10 : i < 2 * third ? 6 : 3]));
    const eng = r.group === 'GK' ? null : avg(ENGINE_KEYS.map((k) => attrOf(p, k)));
    let s = FIT_W.keys * keys;
    let t = FIT_W.keys;
    if (base != null) {
      s += FIT_W.base * base;
      t += FIT_W.base;
    }
    if (eng != null) {
      s += FIT_W.engine * eng;
      t += FIT_W.engine;
    }
    const foot = pos ? footAdj(p, code, pos) : 0;
    return Math.max(1, Math.min(20, s / t + foot));
  }

  /** Meilleur rôle d'une phase pour le joueur à un poste donné (naturel ou non). */
  bestAtPos(p: FmPlayer, pos: PosCode, phase: Phase, ctx?: SlotCtx): { role: RoleRef; fit: number } | null {
    let best: { role: RoleRef; fit: number } | null = null;
    for (const role of this.ref.roles) {
      if (!this.availableAt(role, pos, phase, ctx)) continue;
      const fit = this.roleFit(p, role.code, phase, pos);
      if (fit != null && (!best || fit > best.fit)) best = { role, fit };
    }
    return best;
  }

  /** Meilleur rôle avec ballon du joueur sur l'un de ses postes naturels. */
  bestRole(p: FmPlayer): { role: RoleRef; pos: PosCode; fit: number } | null {
    let best: { role: RoleRef; pos: PosCode; fit: number } | null = null;
    for (const role of this.ref.roles) {
      if (role.phase === 'oop') continue;
      for (const pos of this.rolePositions(role, 'ip')) {
        if (!p.positions.includes(pos)) continue;
        const fit = this.roleFit(p, role.code, 'ip', pos);
        if (fit != null && (!best || fit > best.fit)) best = { role, pos, fit };
      }
    }
    return best;
  }

  squadSignals(list: FmPlayer[]): Record<string, number | null> {
    const pool = list
      .filter((p) => !p.positions.includes('GB'))
      .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
      .slice(0, 16);
    return Object.fromEntries(Object.entries(SIGNALS).map(([sig, keys]) => [sig, avg(pool.map((p) => avg(keys.map((k) => attrOf(p, k)))))]));
  }

  /** Styles classés par adéquation à l'effectif (sur 20). */
  rankStyles(list: FmPlayer[]): { style: StyleRef; fit: number | null }[] {
    const sig = this.squadSignals(list);
    return this.ref.styles
      .map((style) => {
        let s = 0;
        let t = 0;
        for (const [k, w] of Object.entries(style.weights)) {
          const v = sig[k];
          if (w > 0 && v != null) {
            s += v * w;
            t += w;
          }
        }
        return { style, fit: t ? s / t : null };
      })
      .sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));
  }

  /**
   * Onze et rôles d'un schéma pour un style, choisis pour la meilleure note d'équipe :
   * 1. chaque joueur est jugé à chaque créneau de son poste naturel, avec le rôle du style qui lui va le mieux
   *    et sa forme du jour (fatigue, rythme, moral) ;
   * 2. l'attribution joueurs ↔ créneaux est optimale pour l'ensemble du onze (méthode hongroise), et non
   *    plus poste par poste : un joueur bon à deux postes va là où l'équipe y gagne le plus ;
   * 3. les rôles sont ensuite ajustés tant que la note d'équipe monte. Un rôle hors du style n'est pris que
   *    s'il corrige un déséquilibre (couverture, largeur, création, présence dans la surface).
   * `reserve` : réserve et jeunes du club, appelés seulement pour un créneau que l'équipe première ne peut pas
   * tenir (ou pour une doublure quand elle n'en a aucune) ; un onze ne laisse jamais un poste vide tant que
   * quelqu'un au club peut y jouer.
   */
  formationPlan(form: string, style: StyleRef, list: FmPlayer[], reserve: FmPlayer[] = []): FormationPlan {
    const used: Record<Phase, Record<string, number>> = { ip: {}, oop: {} };
    // Rôles du style proposés à ce créneau ; un créneau excentré prend d'abord les rôles qui lui sont réservés.
    const pickRole = (pos: PosCode, ph: Phase, ctx: SlotCtx) => {
      const opts = style.signatureRoles[ph].filter((c) => {
        const r = this.roles.get(c);
        return r && this.availableAt(r, pos, ph, ctx);
      });
      if (ctx.wide) opts.sort((a, b) => Number(!!this.roles.get(b)?.cond) - Number(!!this.roles.get(a)?.cond));
      if (!opts.length) return DEFAULT_ROLE[pos];
      const key = `${pos}${ctx.wide ? '+' : ''}`;
      used[ph][key] = (used[ph][key] ?? -1) + 1;
      return opts[used[ph][key] % opts.length] ?? DEFAULT_ROLE[pos];
    };
    const base = FORMATIONS[form] ?? FORMATIONS['4-3-3']!;
    const ctxs = slotContexts(base.map(([pos, x]) => ({ pos, x })));
    const slots: Slot[] = base.map(([pos, x, y], i) => ({ pos, x, y, ip: pickRole(pos, 'ip', ctxs[i]!), oop: pickRole(pos, 'oop', ctxs[i]!), player: null, fit: null }));
    const PH: Phase[] = ['ip', 'oop'];

    const memo = new Map<string, number>();
    const fitOf = (p: FmPlayer, code: string, ph: Phase, pos: PosCode) => {
      const k = `${p.id}|${code}|${ph}|${pos}`;
      let v = memo.get(k);
      if (v === undefined) memo.set(k, (v = this.roleFit(p, code, ph, pos) ?? 0));
      return v;
    };
    const ready = new Map(list.map((p) => [p.id, readiness(p)]));
    // Rôles du style (et rôle par défaut du poste) que le jeu propose à chaque créneau, puis tous les rôles proposés.
    const avail = slots.map((sl, i) => {
      const of = (ph: Phase, codes: string[]) => [...new Set(codes)].filter((c) => {
        const r = this.roles.get(c);
        return r && this.availableAt(r, sl.pos, ph, ctxs[i]);
      });
      const inStyle = { ip: of('ip', [...style.signatureRoles.ip, DEFAULT_ROLE[sl.pos]]), oop: of('oop', [...style.signatureRoles.oop, DEFAULT_ROLE[sl.pos]]) };
      const all = { ip: of('ip', this.ref.roles.map((r) => r.code)), oop: of('oop', this.ref.roles.map((r) => r.code)) };
      return { inStyle, all };
    });
    // Meilleur rôle du style pour ce joueur à ce créneau (on garde le rôle prévu sauf gain net).
    const styleRole = (p: FmPlayer, i: number, ph: Phase): [string, number] => {
      const sl = slots[i]!;
      let code = sl[ph];
      let f = fitOf(p, code, ph, sl.pos);
      for (const c of avail[i]!.inStyle[ph]) {
        const g = fitOf(p, c, ph, sl.pos);
        if (g > f + 0.3) [code, f] = [c, g];
      }
      return [code, f];
    };

    // 1-2. Attribution optimale : somme maximale de (adéquation au rôle + forme du jour) sur le onze.
    const pool = list.filter((p) => slots.some((sl) => this.canPlay(p, sl.pos)));
    const value = slots.map((sl, i) => pool.map((p) => (this.canPlay(p, sl.pos) ? (styleRole(p, i, 'ip')[1] + styleRole(p, i, 'oop')[1]) / 2 + ready.get(p.id)! : null)));
    const assign = assignMax(value);
    const taken = new Set<string>();
    slots.forEach((sl, i) => {
      const p = assign[i]! >= 0 ? pool[assign[i]!]! : null;
      if (!p) return;
      const [ip, a] = styleRole(p, i, 'ip');
      const [oop, b] = styleRole(p, i, 'oop');
      Object.assign(sl, { player: p, ip, oop, fit: (a + b) / 2 });
      taken.add(p.id);
    });

    // 2b. Créneau vide : le meilleur de la réserve ou des jeunes qui peut y jouer (chacun au plus une fois).
    const readyOf = (p: FmPlayer) => ready.get(p.id) ?? (ready.set(p.id, readiness(p)), ready.get(p.id)!);
    const spare = reserve.filter((p) => !taken.has(p.id) && !list.some((q) => q.id === p.id));
    slots.forEach((sl, i) => {
      if (sl.player) return;
      const best = spare
        .filter((p) => !taken.has(p.id) && this.canPlay(p, sl.pos))
        .map((p) => ({ p, f: (styleRole(p, i, 'ip')[1] + styleRole(p, i, 'oop')[1]) / 2 + readyOf(p) }))
        .sort((a, b) => b.f - a.f)[0];
      if (!best) return;
      const [ip, a] = styleRole(best.p, i, 'ip');
      const [oop, b] = styleRole(best.p, i, 'oop');
      Object.assign(sl, { player: best.p, ip, oop, fit: (a + b) / 2 });
      taken.add(best.p.id);
    });

    // 3. Rôles : on garde chaque changement qui fait monter la note d'équipe.
    const meanFit = () => slots.reduce((a, s) => a + (s.fit ?? 0), 0) / slots.length;
    const rolePen = () => balancePenalty(this.roleChecks(slots));
    let pen = rolePen();
    let team = meanFit() - pen;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      slots.forEach((sl, i) => {
        const p = sl.player;
        if (!p) return;
        for (const ph of PH)
          for (const c of avail[i]!.all[ph]) {
            if (c === sl[ph]) continue;
            const [old, oldFit] = [sl[ph], sl.fit];
            sl[ph] = c;
            sl.fit = (fitOf(p, sl.ip, 'ip', sl.pos) + fitOf(p, sl.oop, 'oop', sl.pos)) / 2;
            const pn = rolePen();
            const t = meanFit() - pn;
            if (t > team + 0.01 && (avail[i]!.inStyle[ph].includes(c) || pn < pen - 1e-9)) {
              [team, pen, moved] = [t, pn, true];
            } else {
              sl[ph] = old;
              sl.fit = oldFit;
            }
          }
      });
      if (!moved) break;
    }

    // Remplaçants : chaque joueur hors du onze au plus une fois en premier choix.
    const bench = list.filter((p) => !taken.has(p.id));
    const cands = slots.map((sl) =>
      bench
        .filter((p) => this.canPlay(p, sl.pos))
        .map((p) => ({ p, f: (fitOf(p, sl.ip, 'ip', sl.pos) + fitOf(p, sl.oop, 'oop', sl.pos)) / 2 + ready.get(p.id)! }))
        .sort((a, b) => b.f - a.f),
    );
    const subs: FmPlayer[][] = slots.map(() => []);
    const usedSub = new Set<string>();
    slots
      .map((_, i) => i)
      .sort((a, b) => (cands[b]![0]?.f ?? 0) - (cands[a]![0]?.f ?? 0))
      .forEach((i) => {
        const c = cands[i]!.find((x) => !usedSub.has(x.p.id));
        if (c) {
          subs[i]!.push(c.p);
          usedSub.add(c.p.id);
        }
      });
    slots.forEach((_, i) => {
      const c = cands[i]!.find((x) => !subs[i]!.includes(x.p));
      if (c) subs[i]!.push(c.p);
    });
    // Sans doublure dans l'équipe première : la meilleure de la réserve ou des jeunes.
    slots.forEach((sl, i) => {
      if (subs[i]!.length) return;
      const c = spare
        .filter((p) => !taken.has(p.id) && this.canPlay(p, sl.pos))
        .map((p) => ({ p, f: (fitOf(p, sl.ip, 'ip', sl.pos) + fitOf(p, sl.oop, 'oop', sl.pos)) / 2 + readyOf(p) }))
        .sort((a, b) => b.f - a.f)[0];
      if (c) subs[i]!.push(c.p);
    });

    const fit = meanFit();
    const form1 = slots.filter((s) => s.player).reduce((a, s) => a + ready.get(s.player!.id)!, 0) / slots.length;
    const penalty = pen + balancePenalty(this.playerChecks(slots, style));
    return { form, slots, subs, score: fit + form1 - penalty, fit, penalty, holes: slots.filter((s) => !s.player).length };
  }

  /** Équilibre du onze : largeur, création, couverture, présence offensive, vitesse, pressing, jeu aérien, fraîcheur. */
  balance(plan: FormationPlan, style: StyleRef): BalanceCheck[] {
    return [...this.roleChecks(plan.slots), ...this.playerChecks(plan.slots, style)];
  }

  /** Équilibre qui dépend des rôles : largeur, création, couverture, présence dans la surface. */
  roleChecks(slots: Slot[]): BalanceCheck[] {
    // Seuls les créneaux occupés comptent : un poste vide ne couvre ni ne crée rien.
    const xi = slots.filter((x) => x.player);
    const box = xi.filter((x) => BOX.has(x.ip));
    const finisher = box
      .filter((x) => x.player)
      .map((x) => ({ p: x.player!, v: avg(['Finishing', 'Composure', 'Movement'].map((k) => attrOf(x.player!, k))) ?? 0 }))
      .sort((a, b) => b.v - a.v)[0];
    const nCreate = xi.filter((x) => CREATE.has(x.ip)).length;
    const nHold = xi.filter((x) => HOLD.has(x.ip) || ['SCRDM', 'SCRCM', 'DROPDM'].includes(x.oop)).length;
    const wide = (side: 'L' | 'R') => xi.some((sl) => sideOf(sl.pos) === side && WIDE.has(sl.ip));
    const wideL = wide('L');
    const wideR = wide('R');
    return [
      { id: 'width', status: wideL && wideR ? 'good' : wideL || wideR ? 'warn' : 'bad', params: { side: !wideL && !wideR ? 'both' : !wideL ? 'L' : !wideR ? 'R' : null } },
      { id: 'creation', status: nCreate > 4 ? 'warn' : nCreate >= 2 ? 'good' : nCreate === 1 ? 'warn' : 'bad', params: { count: nCreate } },
      { id: 'cover', status: nHold >= 1 ? 'good' : 'bad', params: { count: nHold } },
      { id: 'box', status: box.length >= 2 ? 'good' : box.length === 1 ? 'warn' : 'bad', params: { count: box.length, finisher: finisher?.p.name ?? null, value: r1(finisher?.v ?? null) } },
    ];
  }

  /** Équilibre qui dépend des joueurs : vitesse de la défense, pressing, jeu aérien, fraîcheur. */
  playerChecks(xi: Slot[], style: StyleRef): BalanceCheck[] {
    const P = xi.filter((x): x is Slot & { player: FmPlayer } => !!x.player);
    const lvl = avg(P.map((x) => x.player.level)) ?? 10;
    const grp = (sls: Slot[], keys: string[]) => avg(sls.filter((x) => x.player).map((x) => avg(keys.map((k) => attrOf(x.player!, k)))));
    const rel = (v: number | null, ok = 0.5, warn = -1): Status => (v == null ? 'warn' : v >= lvl + ok ? 'good' : v >= lvl + warn ? 'warn' : 'bad');
    const back = xi.filter((x) => /^(DC|DD|DG|DLD|DLG)$/.test(x.pos));
    const dcs = xi.filter((x) => x.pos === 'DC');
    const outf = xi.filter((x) => x.pos !== 'GB');
    const highLine = style.outOfPossession.some((t) => /plus haute|higher/i.test(t));
    const highPress = style.outOfPossession.some((t) => /pressing haut|beaucoup plus souvent|high press|much more often/i.test(t));
    const vPace = grp(back, ['Pace', 'Acceleration']);
    const vPress = grp(outf, ['WorkRate', 'Stamina', 'Teamwork']);
    const vAir = grp(dcs, ['Heading', 'JumpingReach', 'Strength']);
    const lowCond = P.filter((x) => x.player.condition != null && x.player.condition < 90).map((x) => x.player.name);
    return [
      { id: 'pace', status: rel(vPace, highLine ? 1 : 0, highLine ? -0.5 : -1.5), params: { value: r1(vPace), highLine } },
      { id: 'press', status: rel(vPress, highPress ? 1 : 0, highPress ? -0.5 : -1.5), params: { value: r1(vPress), highPress } },
      { id: 'aerial', status: rel(vAir, 0, -1.5), params: { value: r1(vAir) } },
      { id: 'fitness', status: lowCond.length ? (lowCond.length >= 3 ? 'bad' : 'warn') : 'good', params: { names: lowCond } },
    ];
  }
}

const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * Coût d'un point faible dans la note d'équipe (sur 20) : [à surveiller, problème]. Repère : 0,4 vaut
 * 4,4 points d'adéquation perdus par un seul joueur (la note est une moyenne sur onze). Une équipe sans
 * couverture devant la défense accepte donc qu'un milieu prenne un rôle un peu moins adapté pour la donner,
 * mais pas qu'il joue à contre-emploi. La forme du jour est déjà comptée joueur par joueur, d'où 0 pour la fraîcheur.
 */
const PENALTY: Record<BalanceCheck['id'], [number, number]> = {
  width: [0.1, 0.3],
  creation: [0.05, 0.2],
  cover: [0.15, 0.4],
  box: [0.1, 0.3],
  pace: [0.05, 0.2],
  press: [0.05, 0.2],
  aerial: [0.05, 0.2],
  fitness: [0, 0],
};

/** Baisse de la note d'équipe due aux déséquilibres. */
export function balancePenalty(checks: BalanceCheck[]): number {
  return checks.reduce((a, c) => a + (c.status === 'bad' ? PENALTY[c.id][1] : c.status === 'warn' ? PENALTY[c.id][0] : 0), 0);
}

/**
 * Attribution de somme maximale (méthode hongroise) : `value[i][j]` est la valeur du joueur j au créneau i,
 * null s'il ne peut pas y jouer. Renvoie, pour chaque créneau, l'index du joueur, ou -1 (créneau vide).
 * Un créneau n'est laissé vide que si aucun joueur restant ne peut l'occuper.
 */
export function assignMax(value: (number | null)[][]): number[] {
  const n = value.length;
  const m0 = n ? value[0]!.length : 0;
  const m = m0 + n; // un créneau vide par créneau
  const HOLE = 1e5;
  const NO = 1e7;
  const cost = (i: number, j: number) => (j >= m0 ? HOLE : value[i]![j] == null ? NO : -value[i]![j]!);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const usedCol = new Array<boolean>(m + 1).fill(false);
    do {
      usedCol[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++)
        if (!usedCol[j]) {
          const cur = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      for (let j = 0; j <= m; j++)
        if (usedCol[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else minv[j]! -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const res = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m0; j++) if (p[j] && value[p[j]! - 1]![j - 1] != null) res[p[j]! - 1] = j - 1;
  return res;
}
const avgWeighted = (xs: [number | null, number][]) => {
  let s = 0;
  let t = 0;
  for (const [v, w] of xs)
    if (v != null) {
      s += v * w;
      t += w;
    }
  return t ? s / t : null;
};

const WIDE = new Set(['FB', 'WB', 'AWB', 'PMWB', 'WM', 'W', 'WF', 'WP', 'OCB']);
const CREATE = new Set(['DLP', 'B2BPM', 'MFPM', 'AP', 'WP', 'PMWB', 'F9', 'FREE', 'BPCB']);
const HOLD = new Set(['DM', 'HB', 'DLP']);
const BOX = new Set(['CF', 'POA', 'TF', 'CHF', 'DLF', 'IF', 'WF', 'SS', 'BBM']);

export interface Slot {
  pos: PosCode;
  /** Poste sans ballon quand il diffère (FM27 place chaque joueur deux fois : un MO (D) peut défendre en M (D)). */
  posOOP?: PosCode;
  x: number;
  y: number;
  /** Rôle avec ballon (code du repère). */
  ip: string;
  /** Rôle sans ballon. */
  oop: string;
  player: FmPlayer | null;
  /** Adéquation moyenne avec et sans ballon, sur 20. */
  fit: number | null;
  /** Lu dans le jeu (onze du jeu) : rôle personnalisé et consignes individuelles réelles. */
  game?: { custom: boolean; instructions: { ip: string[]; oop: string[] } };
}

/**
 * Note d'un joueur dans le rôle sans ballon d'un créneau. Quand la tactique le déplace sans ballon (un MO (C) qui
 * défend en pointe, un MD (C) qui monte en M (C)), il reste le joueur de son poste avec ballon : c'est la tactique qui
 * le place là, pas un changement de poste. On ne lui retire donc pas plus de familiarité qu'à son poste avec ballon
 * (sinon un meneur à l'aise en MO (C) tombait à 2,5 sur 20 parce qu'il n'est pas avant-centre).
 */
export function oopFit(engine: TacticEngine, p: FmPlayer, code: string, pos: PosCode, posOOP?: PosCode | null): number | null {
  const at = engine.roleFit(p, code, 'oop', posOOP ?? pos);
  if (!posOOP || posOOP === pos) return at;
  const home = engine.roleFit(p, code, 'oop', pos);
  return at == null ? home : home == null ? at : Math.max(at, home);
}

/** Adéquation moyenne d'un joueur aux deux rôles d'un créneau (le rôle sans ballon jugé à son poste sans ballon), sur 20. */
export function slotFit(engine: TacticEngine, p: FmPlayer, sl: Pick<Slot, 'pos' | 'posOOP' | 'ip' | 'oop'>): number | null {
  const a = engine.roleFit(p, sl.ip, 'ip', sl.pos);
  const b = oopFit(engine, p, sl.oop, sl.pos, sl.posOOP);
  return a != null && b != null ? (a + b) / 2 : (a ?? b);
}

export interface FormationPlan {
  form: string;
  slots: Slot[];
  /** Remplaçants par poste, du meilleur au suivant. */
  subs: FmPlayer[][];
  /** Note d'équipe sur 20 : adéquation moyenne + forme du jour moyenne − déséquilibres. Sert à choisir schéma et style. */
  score: number;
  /** Adéquation moyenne des joueurs à leurs rôles (créneau vide = 0). */
  fit: number;
  /** Baisse due aux déséquilibres (voir balancePenalty). */
  penalty: number;
  holes: number;
}

export type Status = 'good' | 'warn' | 'bad';
export interface BalanceCheck {
  id: 'width' | 'creation' | 'cover' | 'box' | 'pace' | 'press' | 'aerial' | 'fitness';
  status: Status;
  params: Record<string, unknown>;
}

/* ---------- Formes avec et sans ballon ---------- */

/** Déplacement de chaque rôle selon la phase : [vers l'axe (0-1), vers l'extérieur (%), vertical (+ recule, - monte)]. */
const ROLE_MOVE: Record<Phase, Record<string, [number, number, number]>> = {
  ip: {
    IFB: [0.55, 0, -12], FB: [0, 0, -14], CF: [0, 0, -2], IWB: [0.45, 0, -28], WB: [0, 0, -22], AWB: [0, 0, -34], PMWB: [0.25, 0, -22], HB: [0, 0, 12], ADCB: [0, 0, -14],
    B2BPM: [0, 0, -10], BBM: [0, 0, -14], CHM: [0, 12, -12], WCM: [0, 14, 0], OCB: [0, 6, -16], WCB: [0, 4, -8], NNGK: [0, 0, 0], W: [0, 4, -8], IF: [0.35, 0, -8], IW: [0.25, 0, -2],
    WF: [0, 0, -10], WP: [0.3, 0, 0], AP: [0, 0, -4], SS: [0, 0, -10], DLF: [0, 0, 10], F9: [0, 0, 12], CHF: [0, 12, 0], TF: [0, 0, -3], POA: [0, 0, -3], BPGK: [0, 0, -4],
  },
  oop: {
    TW: [0, 0, 18], TWM: [0, 0, 6], WOM: [0, 0, -4], WOW: [0, 0, -4], IOW: [0.15, 0, -4], TAM: [0, 0, 12], COAM: [0, 0, -6], SOAM: [0, 18, -4], TCF: [0, 0, 10], COCF: [0, 0, -4], SOCF: [0, 14, -4],
    DROPDM: [0, 0, 14], WCDM: [0, 20, 0], WCCM: [0, 20, 0], SCRDM: [0, 0, 5], SCRCM: [0, 0, 5], PRSDM: [0, 0, -4], PRSCM: [0, 0, -4], PFB: [0, 0, -3], PWB: [0, 0, -3], HFB: [0, 0, 4], HWB: [0, 0, 6],
    STCB: [0, 0, -5], CCB: [0, 0, 4], SWCB: [0, 0, -5], CWCB: [0, 0, 4], SK: [0, 0, -6], LHK: [0, 0, 2],
  },
};

/** Décalage de tout le bloc : il monte avec le ballon, et se place selon la ligne d'engagement sans ballon. */
export type Block = 'high' | 'mid' | 'low';
const blockShift = (ph: Phase, block: Block) => (ph === 'ip' ? -6 : block === 'low' ? 8 : block === 'mid' ? 3 : -3);

/** Hauteur de chaque poste sur le terrain (en %), pour replacer un joueur à son poste sans ballon. */
const POS_Y: Record<PosCode, number> = { GB: 92, DG: 72, DC: 76, DD: 72, DLG: 60, DLD: 60, MDF: 57, MG: 48, MC: 47, MD: 48, MOG: 28, MOC: 32, MOD: 28, BT: 14 };
const POS_SIDE_X = (pos: PosCode): number | null => (/G$/.test(pos) && pos !== 'GB' ? 15 : /D$/.test(pos) && pos !== 'MDF' ? 85 : null);

/**
 * Point de départ d'un créneau dans une phase : sa place dans le schéma, ou, sans ballon, celle de son poste
 * sans ballon quand le jeu en donne un autre (un MO (D) qui défend en M (D) redescend sur la ligne du milieu).
 */
export function slotBase(sl: Pick<Slot, 'pos' | 'posOOP' | 'x' | 'y'>, ph: Phase): [number, number] {
  if (ph !== 'oop' || !sl.posOOP || sl.posOOP === sl.pos) return [sl.x, sl.y];
  const side = POS_SIDE_X(sl.posOOP);
  // Même couloir : on garde l'écart du schéma ; changement de couloir ou retour dans l'axe : place du nouveau poste.
  const x = side != null ? (POS_SIDE_X(sl.pos) === side ? sl.x : side) : POS_SIDE_X(sl.pos) != null ? (sl.x < 50 ? 38 : 62) : sl.x;
  return [x, POS_Y[sl.posOOP]];
}

/** Poste d'un créneau dans une phase : le poste sans ballon du jeu quand il diffère. */
export const slotPos = (sl: Pick<Slot, 'pos' | 'posOOP'>, ph: Phase): PosCode => (ph === 'oop' ? (sl.posOOP ?? sl.pos) : sl.pos);

export function phaseXY(sl: Slot, ph: Phase, block: Block = 'mid'): [number, number] {
  const [bx, by] = slotBase(sl, ph);
  const mv = ROLE_MOVE[ph][ph === 'ip' ? sl.ip : sl.oop] ?? [0, 0, 0];
  const sh = sl.pos === 'GB' ? 0 : blockShift(ph, block) * (by > 60 ? 0.8 : 1);
  const x = bx + (50 - bx) * mv[0] + Math.sign(bx - 50) * mv[1];
  const y = by + mv[2] + sh;
  return [Math.max(6, Math.min(94, x)), Math.max(6, Math.min(94, y))];
}

/** Poste occupé d'après une position sur le terrain. */
export function zonePos(x: number, y: number): PosCode {
  const side = x < 27 ? 'G' : x > 73 ? 'D' : 'C';
  if (y >= 68) return side === 'C' ? 'DC' : (`D${side}` as PosCode);
  if (y >= 55) return side === 'C' ? 'MDF' : (`DL${side}` as PosCode);
  if (y >= 36) return side === 'C' ? 'MC' : (`M${side}` as PosCode);
  if (y >= 18) return `MO${side}` as PosCode;
  return 'BT';
}

/** Poste occupé selon le rôle seul, sans le décalage du bloc. */
export function rolePos(sl: Slot, ph: Phase): PosCode {
  if (sl.pos === 'GB') return 'GB';
  const [bx, by] = slotBase(sl, ph);
  const mv = ROLE_MOVE[ph][ph === 'ip' ? sl.ip : sl.oop] ?? [0, 0, 0];
  return zonePos(bx + (50 - bx) * mv[0] + Math.sign(bx - 50) * mv[1], by + mv[2]);
}

/** Forme en lignes (« 4-1-4-1 ») à partir des positions des joueurs de champ. */
export function shapeOf(pts: [number, number][]): string {
  if (!pts.length) return '';
  const ys = pts.map((p) => p[1]).sort((a, b) => b - a);
  const lines: number[][] = [];
  let cur: number[] = [];
  for (const y of ys) {
    if (cur.length && cur[cur.length - 1]! - y > 8) {
      lines.push(cur);
      cur = [];
    }
    cur.push(y);
  }
  lines.push(cur);
  return lines.map((l) => l.length).join('-');
}

/** Écarte les cartes qui se chevauchent (affichage seulement). */
export function spreadXY(pts: [number, number][], w = 19, hh = 11): [number, number][] {
  const P = pts.map((p) => [...p] as [number, number]);
  for (let it = 0; it < 30; it++) {
    let moved = false;
    for (let i = 0; i < P.length; i++)
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i]!;
        const b = P[j]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        if (Math.abs(dx) < w && Math.abs(dy) < hh) {
          moved = true;
          const ox = w - Math.abs(dx);
          const oy = hh - Math.abs(dy);
          if (ox < oy) {
            const s = ((dx >= 0 ? 1 : -1) * ox) / 2;
            a[0] -= s;
            b[0] += s;
          } else {
            const s = ((dy >= 0 ? 1 : -1) * oy) / 2;
            a[1] -= s;
            b[1] += s;
          }
        }
      }
    P.forEach((p) => {
      p[0] = Math.max(9, Math.min(91, p[0]));
      p[1] = Math.max(6, Math.min(94, p[1]));
    });
    if (!moved) break;
  }
  return P;
}

/** Ligne d'engagement déduite des consignes sans ballon du style. */
export function styleBlock(style: StyleRef): Block {
  const op = style.outOfPossession.join(' | ');
  return /pressing haut|high press/i.test(op) ? 'high' : /bloc bas|low block/i.test(op) ? 'low' : 'mid';
}

/** Schéma de la tactique du jeu (« 4-2-3-1 DM Wide » → « 4-2-3-1 ») s'il est connu. */
export function knownFormation(name: string | null | undefined): string | null {
  if (!name) return null;
  return formationKeys().find((k) => name.startsWith(k)) ?? null;
}

/** Schéma de la tactique active lue par le plugin. « formation » peut n'être que la formation la plus
 *  utilisée de la saison (formationSource = MostUsedFormation) : on préfère alors le nom de la tactique,
 *  s'il désigne un schéma connu. */
export function gameFormationOf(tactic: { name?: string | null; formation?: string | null; formationSource?: unknown } | null | undefined): string | null {
  if (!tactic) return null;
  if (knownFormation(tactic.name)) return tactic.name!;
  if (tactic.formationSource === 'MostUsedFormation') return null;
  return tactic.formation ?? null;
}
