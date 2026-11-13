import { z } from 'zod';
import type { FmPlayer } from './player';
import { lineOf, POS_ORDER, type PosCode } from './positions';
import { assignMax, FORMATIONS, formationOfPositions, oopFit, phaseXY, readiness, shapeOf, sideOf, slotContexts, type BalanceCheck, type FormationPlan, type Phase, type RoleRef, type Slot, type StyleRef, type TacticEngine } from './tactic';
import { checkTeamInstructions, MENTALITIES_FM27, TEAM_INSTRUCTIONS_FM27, teamInstructionOf, type TeamInstructionDef } from './team-instructions-fm27';
import type { TacticSlot } from './tactic-slots';
import type { GameInstructions } from './game-instructions';
import { phaseLocks, roleLocks, type InstructionGroup } from './instructions';
import { LEGACY_PI, lockLabel, piKey, piKeyGroup, piKeyOption, PLAYER_INSTRUCTIONS_FM27, type PiGroupDef } from './player-instructions-fm27';

/*
 * Tactique construite par le joueur (« from scratch ») : il place ses onze postes et rôles avec et sans ballon,
 * choisit la mentalité et les consignes d'équipe, et FM Immersion en dit les forces et les faiblesses.
 * Purement consultatif : rien n'est écrit dans le jeu, le joueur reporte lui-même sa tactique dans FM27.
 *
 * Comportement de chaque rôle (largeur, montée, pressing, relais en contre) : résumé d'après la fiche des rôles
 * de Guide to Football (https://fm.guidetofootball.com/fm26/roles/, consultée le 08/11/2026, rôles FM26 repris
 * dans FM27 avec et sans ballon), reformulé ici en quelques traits, et d'après les déplacements de ROLE_MOVE.
 */

/* ---------- Traits des rôles ---------- */

/** Couloir occupé avec ballon : sur la ligne de touche, dans le demi-espace, ou dans l'axe. */
export type Lane = 'wide' | 'half' | 'centre';
/** Mouvement vertical avec ballon : reste, décroche (recule), monte d'un cran, monte franchement, joue haut. */
export type Move = 'stay' | 'drop' | 'step' | 'push' | 'high';
/** Comportement sans ballon. */
export type Guard = 'base' | 'press' | 'cover' | 'screen' | 'track' | 'outlet' | 'wideCover';

interface IpTrait {
  lane: Lane;
  move: Move;
  /** Rôle de création (passes vers l'avant, demande le ballon). */
  create?: boolean;
  /** Présence dans la surface adverse. */
  box?: boolean;
  /** Point d'appui aérien (centres, relances longues). */
  target?: boolean;
}

/** Traits des rôles avec ballon (codes du repère, voir tactic-defaults.ts). */
export const IP_TRAITS: Record<string, IpTrait> = {
  GK: { lane: 'centre', move: 'stay' }, BPGK: { lane: 'centre', move: 'step' }, NNGK: { lane: 'centre', move: 'stay' },
  CB: { lane: 'centre', move: 'stay' }, NNCB: { lane: 'centre', move: 'stay' }, BPCB: { lane: 'centre', move: 'stay', create: true },
  ADCB: { lane: 'centre', move: 'step' }, WCB: { lane: 'wide', move: 'stay' }, OCB: { lane: 'wide', move: 'push' },
  FB: { lane: 'wide', move: 'push' }, IFB: { lane: 'centre', move: 'stay' }, IWB: { lane: 'half', move: 'stay' },
  PMWB: { lane: 'half', move: 'step', create: true }, WB: { lane: 'wide', move: 'push' }, AWB: { lane: 'wide', move: 'high' },
  DM: { lane: 'centre', move: 'stay' }, HB: { lane: 'centre', move: 'drop' }, DLP: { lane: 'centre', move: 'stay', create: true },
  BBM: { lane: 'centre', move: 'push', box: true }, B2BPM: { lane: 'centre', move: 'push', create: true },
  CM: { lane: 'centre', move: 'step' }, MFPM: { lane: 'centre', move: 'step', create: true }, WCM: { lane: 'half', move: 'step' },
  CHM: { lane: 'half', move: 'push' },
  AM: { lane: 'centre', move: 'high' }, AP: { lane: 'centre', move: 'high', create: true }, FREE: { lane: 'centre', move: 'high', create: true },
  SS: { lane: 'centre', move: 'high', box: true },
  WM: { lane: 'wide', move: 'stay' }, W: { lane: 'wide', move: 'push' }, WP: { lane: 'half', move: 'push', create: true },
  IW: { lane: 'half', move: 'push' }, IF: { lane: 'half', move: 'high', box: true }, WF: { lane: 'wide', move: 'high', box: true },
  CF: { lane: 'centre', move: 'high', box: true }, POA: { lane: 'centre', move: 'high', box: true }, TF: { lane: 'centre', move: 'high', box: true, target: true },
  DLF: { lane: 'centre', move: 'drop', box: true }, F9: { lane: 'centre', move: 'drop', create: true }, CHF: { lane: 'half', move: 'high', box: true },
};

/** Traits des rôles sans ballon. */
export const OOP_TRAITS: Record<string, Guard> = {
  GK: 'base', SK: 'press', LHK: 'cover',
  CB: 'base', WCB: 'base', STCB: 'press', CCB: 'cover', SWCB: 'press', CWCB: 'cover',
  FB: 'base', PFB: 'press', HFB: 'cover', WB: 'base', PWB: 'press', HWB: 'cover',
  DM: 'screen', PRSDM: 'press', SCRDM: 'screen', DROPDM: 'cover', WCDM: 'wideCover',
  CM: 'base', PRSCM: 'press', SCRCM: 'screen', WCCM: 'wideCover',
  AM: 'base', TAM: 'track', COAM: 'outlet', SOAM: 'outlet',
  WM: 'base', W: 'base', TWM: 'track', WOM: 'outlet', TW: 'track', WOW: 'outlet', IOW: 'outlet',
  CF: 'press', TCF: 'track', COCF: 'outlet', SOCF: 'outlet',
};

/* ---------- Tactique construite ---------- */

const posEnum = z.enum(POS_ORDER);

export const builtSlotSchema = z.object({
  /** Poste avec ballon. */
  pos: posEnum,
  /** Poste sans ballon (FM27 place chaque joueur deux fois). */
  posOOP: posEnum,
  /** Rôle avec ballon (code du repère). */
  ip: z.string(),
  /** Rôle sans ballon. */
  oop: z.string(),
  /** Consignes individuelles choisies (« Groupe:Option » du jeu), avec et sans ballon ; les anciens identifiants sont convertis. */
  pi: z.array(z.string()).default([]).transform((l) => normalizePi(l)),
});

export const builtTacticSchema = z.object({
  id: z.string(),
  name: z.string(),
  slots: z.array(builtSlotSchema).length(11),
  mentality: z.string(),
  /** Consignes d'équipe : identifiant de la consigne du jeu → index de l'option (absente = valeur par défaut). */
  ti: z.record(z.number()).default({}),
  updatedAt: z.string().optional(),
});

export type BuiltSlot = z.infer<typeof builtSlotSchema>;
export type BuiltTactic = z.infer<typeof builtTacticSchema>;

/** Liste retenue sur le PC, en ignorant ce qui ne se relit pas (ancienne version, fichier abîmé). */
export function parseBuiltTactics(raw: unknown): BuiltTactic[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const r = builtTacticSchema.safeParse(x);
    return r.success ? [r.data] : [];
  });
}

/** Poste sans ballon par défaut : les ailiers hauts se replacent en milieux latéraux, comme dans le jeu. */
export const defaultOOPPos = (pos: PosCode): PosCode => (pos === 'MOG' ? 'MG' : pos === 'MOD' ? 'MD' : pos);

/** Coordonnées d'affichage de chaque poste (x de gauche à droite, y du but adverse vers le sien), en %. */
const POS_XY: Record<PosCode, [number, number]> = {
  GB: [50, 92], DG: [15, 72], DC: [50, 77], DD: [85, 72], DLG: [10, 56], MDF: [50, 59], DLD: [90, 56],
  MG: [13, 44], MC: [50, 46], MD: [87, 44], MOG: [15, 24], MOC: [50, 29], MOD: [85, 24], BT: [50, 12],
};

/** Positions sur le terrain des onze postes : les postes doublés (deux centraux, deux attaquants) s'écartent. */
export function layoutPositions(positions: PosCode[]): [number, number][] {
  const count = new Map<PosCode, number>();
  for (const p of positions) count.set(p, (count.get(p) ?? 0) + 1);
  const seen = new Map<PosCode, number>();
  return positions.map((p) => {
    const [x, y] = POS_XY[p];
    const n = count.get(p)!;
    const i = seen.get(p) ?? 0;
    seen.set(p, i + 1);
    if (n === 1) return [x, y];
    // Axe : réparti autour du centre ; couloir : rapproché de l'axe.
    const span = sideOf(p) ? 10 : n >= 3 ? 25 : 13;
    const dx = n === 1 ? 0 : -span + (2 * span * i) / (n - 1);
    return [Math.max(6, Math.min(94, x + (sideOf(p) === 'L' ? Math.abs(dx) : sideOf(p) === 'R' ? -Math.abs(dx) : dx))), y + (sideOf(p) ? i * 6 : 0)];
  });
}

/** Rôles que le jeu propose à ce créneau dans cette phase. */
export function rolesAt(engine: TacticEngine, slots: { pos: PosCode }[], i: number, phase: Phase): RoleRef[] {
  const xy = layoutPositions(slots.map((s) => s.pos));
  const ctx = slotContexts(slots.map((s, k) => ({ pos: s.pos, x: xy[k]![0] })))[i];
  const pos = slots[i]!.pos;
  return engine.ref.roles.filter((r) => engine.availableAt(r, pos, phase, ctx));
}

/** Rôle par défaut d'un poste dans une phase : le rôle « de base » (avec et sans ballon) s'il existe, sinon le premier. */
export function defaultRole(engine: TacticEngine, pos: PosCode, phase: Phase): string {
  const all = engine.ref.roles.filter((r) => engine.availableAt(r, pos, phase));
  return (all.find((r) => r.phase === 'both') ?? all[0])?.code ?? '';
}

/** Nouvelle tactique à partir d'un schéma connu, rôles de base partout. */
export function newBuiltTactic(engine: TacticEngine, form: string, id: string, name = form): BuiltTactic {
  const base = FORMATIONS[form] ?? FORMATIONS['4-3-3']!;
  const slots = base.map(([pos]) => {
    const posOOP = defaultOOPPos(pos);
    return { pos, posOOP, ip: defaultRole(engine, pos, 'ip'), oop: defaultRole(engine, posOOP, 'oop'), pi: [] };
  });
  return { id, name, slots, mentality: 'Équilibrée', ti: {} };
}

/** Tactique jouée dans FM27 (lue par le plugin) recopiée dans l'éditeur, pour la retoucher. */
export function builtFromGame(
  engine: TacticEngine,
  game: TacticSlot[],
  id: string,
  name: string,
  instructions?: GameInstructions | null,
  mentality?: string | null,
): BuiltTactic | null {
  if (game.length !== 11) return null;
  const byGame = (code: string | null, phase: Phase) =>
    code ? engine.ref.roles.find((r) => (phase === 'ip' ? r.game?.ip === code && r.phase !== 'oop' : r.game?.oop === code && r.phase !== 'ip'))?.code : undefined;
  const slots = game.map((s, i) => {
    const posOOP = s.posOOP ?? defaultOOPPos(s.pos);
    return { pos: s.pos, posOOP, ip: byGame(s.roleIP, 'ip') ?? defaultRole(engine, s.pos, 'ip'), oop: byGame(s.roleOOP, 'oop') ?? defaultRole(engine, posOOP, 'oop'), pi: normalizePi(instructions?.pi[i] ?? []) };
  });
  // Consignes et mentalité lues dans le jeu quand le plugin les donne (chemins.json, 09/11/2026), sinon les valeurs par défaut.
  const ment = mentality && (MENTALITIES_FM27 as readonly string[]).includes(mentality) ? mentality : 'Équilibrée';
  return { id, name, slots, mentality: ment, ti: { ...(instructions?.ti ?? {}) } };
}

/** Consignes et mentalité d'un style de l'appli, à appliquer à la tactique construite. */
export function styleInstructions(style: StyleRef): { ti: Record<string, number>; mentality: string | null } {
  const ti: Record<string, number> = {};
  for (const l of [...style.inPossession, ...style.outOfPossession]) {
    const m = teamInstructionOf(l);
    if (m && ti[m.def.id] == null) ti[m.def.id] = m.option;
  }
  const mentality = style.mentality && (MENTALITIES_FM27 as readonly string[]).includes(style.mentality) ? style.mentality : null;
  return { ti, mentality };
}

/** Libellés des consignes choisies (options qui s'écartent de la valeur par défaut). */
export function builtInstructionLabels(t: BuiltTactic): { ip: string[]; oop: string[] } {
  const ip: string[] = [];
  const oop: string[] = [];
  for (const def of TEAM_INSTRUCTIONS_FM27) {
    const o = t.ti[def.id];
    if (o == null || o === defaultOption(def)) continue;
    const label = def.options[o];
    if (!label) continue;
    (def.phase === 'oop' || def.code === 'DefensiveTransition' ? oop : ip).push(label);
  }
  return { ip, oop };
}

/* ---------- Consignes individuelles ---------- */

/** Ramène une liste de consignes aux clés du jeu (anciens identifiants convertis), une seule par groupe (la dernière). */
export function normalizePi(list: readonly string[]): string[] {
  const byGroup = new Map<string, string>();
  for (const raw of list) {
    const key = LEGACY_PI[raw] ?? raw;
    if (!key.includes(':')) continue;
    byGroup.delete(piKeyGroup(key));
    byGroup.set(piKeyGroup(key), key);
  }
  return [...byGroup.values()];
}

/** Choisit une option d'un groupe (null : valeur neutre du jeu, donc aucune consigne). Le jeu n'en garde qu'une par groupe. */
export function setPi(list: readonly string[], group: InstructionGroup, option: string | null): string[] {
  const rest = list.filter((k) => piKeyGroup(k) !== group);
  return option ? [...rest, piKey(group, option)] : rest;
}

/** Option choisie dans un groupe, ou null. */
export const piChoice = (list: readonly string[], group: InstructionGroup): string | null => {
  const k = list.find((x) => piKeyGroup(x) === group);
  return k ? piKeyOption(k) : null;
};

export interface PiGroupState {
  def: PiGroupDef;
  /** free : au choix ; locked : verrouillé par le rôle ou le poste ; imposed : le rôle fixe déjà une option. */
  state: 'free' | 'locked' | 'imposed';
  /** Option imposée (libellé FR de l'écran). */
  imposed?: string;
  /** Options que le rôle et le poste laissent choisir (libellés FR de l'écran). */
  options: string[];
}

/** Les 17 consignes individuelles du jeu à un créneau, par phase, avec les verrous du rôle et du poste de cette phase. */
export function piOptions(engine: TacticEngine, t: BuiltTactic, i: number): Record<Phase, PiGroupState[]> {
  const s = t.slots[i]!;
  const xIp = layoutPositions(t.slots.map((x) => x.pos))[i]![0];
  const xOop = layoutPositions(t.slots.map((x) => x.posOOP))[i]![0];
  const of = (ph: Phase, pos: PosCode, x: number): PiGroupState[] => {
    const r = engine.roles.get(ph === 'ip' ? s.ip : s.oop);
    const lk = phaseLocks(r, ph, pos, x);
    // Rôle absent de la table du jeu : seul le pressing déduit de son nom est fixé.
    const press = !lk && ph === 'oop' ? roleLocks(r, pos, x, 'oop').press : null;
    return PLAYER_INSTRUCTIONS_FM27.filter((d) => d.phase === ph).map<PiGroupState>((def) => {
      const g = def.group;
      if (lk?.locked.includes(g)) return { def, state: 'locked', options: [] };
      const imp = lk?.imposed[g] ?? (g === 'TriggerPress' && press ? (press === 'more' ? 'Plus souvent' : 'Moins souvent') : undefined);
      if (imp) return { def, state: 'imposed', imposed: lockLabel(imp), options: [] };
      const refused = new Set((lk?.refused[g] ?? []).map(lockLabel));
      const options = def.options.map((o) => o.fr).filter((o) => !refused.has(o));
      return options.length ? { def, state: 'free', options } : { def, state: 'locked', options: [] };
    });
  };
  return { ip: of('ip', s.pos, xIp), oop: of('oop', s.posOOP, xOop) };
}

/** Consignes choisies que les rôles ou postes actuels n'autorisent plus (rôle changé depuis). */
export function piStale(engine: TacticEngine, t: BuiltTactic, i: number): string[] {
  const o = piOptions(engine, t, i);
  const free = new Set([...o.ip, ...o.oop].flatMap((g) => g.options.map((x) => piKey(g.def.group, x))));
  return normalizePi(t.slots[i]!.pi ?? []).filter((k) => !free.has(k));
}

/* ---------- Analyse ---------- */

const PI_HOLD = 'ForwardRuns:Effectuez moins de courses';
const PI_RUN_BEHIND = 'AttackBoxDepth:Attaquer la ligne défensive';
const PI_PRESS_MORE = 'TriggerPress:Plus souvent';
const PI_PRESS_LESS = 'TriggerPress:Moins souvent';

export type Area = 'roles' | 'lanes' | 'centre' | 'rest' | 'attack' | 'transition' | 'press' | 'coherence' | 'squad';
export type Tone = 'good' | 'warn' | 'bad';

/** Constat : une force (good) ou une faiblesse (warn, bad), avec ses valeurs pour la phrase (fm.builder.f.<id>). */
export interface Finding {
  id: string;
  area: Area;
  tone: Tone;
  params: Record<string, unknown>;
  /** Créneaux concernés (index dans la tactique), pour les mettre en évidence. */
  slots?: number[];
}

export interface SquadFit {
  /** Joueur conseillé à chaque créneau (null : personne ne peut y jouer). */
  xi: { player: FmPlayer | null; fit: number | null; second: FmPlayer | null }[];
  /** Adéquation moyenne du onze conseillé, sur 20 (créneau vide = 0). */
  fit: number;
}

export interface BuiltAnalysis {
  findings: Finding[];
  /** État de chaque domaine : le plus mauvais de ses constats (good s'il n'en a aucun de négatif). */
  areas: Record<Area, Tone>;
  /** Formes en lignes avec et sans ballon (« 2-3-5 », « 4-4-2 »). */
  shape: Record<Phase, string>;
  /** Positions affichées avec et sans ballon, rôles appliqués. */
  xy: Record<Phase, [number, number][]>;
  /** Nombre de consignes d'équipe qui s'écartent de la valeur par défaut. */
  instructions: number;
  /** Nombre de consignes individuelles choisies, tous postes confondus. */
  playerInstructions: number;
  /**
   * Trois jauges sur 100 (estimations à partir des rôles, pas une mesure du jeu) : pénétration (joueurs qui attaquent
   * l'espace et la surface), soutien (création et relais derrière l'attaque), solidité (ce qui reste et protège).
   */
  scores: { penetration: number; support: number; solidity: number };
  /** Risque pris sur 100 : mentalité, défense restante, ligne haute, contre-pressing, relais laissés devant. */
  risk: number;
  /** Duos qui partagent une zone (latéral et ailier d'un flanc, paires de l'axe). */
  partnerships: Partnership[];
  squad: SquadFit | null;
}

/** Duo de joueurs qui partagent une zone : équilibré, déséquilibré (personne ne couvre) ou en surnombre (ils se gênent). */
export interface Partnership {
  zone: 'flankL' | 'flankR' | 'cb' | 'mid' | 'front';
  slots: [number, number];
  status: 'balanced' | 'imbalanced' | 'overloading';
  /** Raison, pour la phrase (fm.builder.pair.<reason>). */
  reason: string;
}

/** Option par défaut d'une consigne : celle du jeu, et le bloc médian pour la hauteur du pressing (sans défaut dans le jeu). */
export const defaultOption = (d: TeamInstructionDef): number => d.def ?? (d.code === 'LineOfEngagement' ? 1 : 0);

const ti = (t: BuiltTactic, code: string): number | null => {
  const def = TEAM_INSTRUCTIONS_FM27.find((d) => d.code === code);
  if (!def) return null;
  return t.ti[def.id] ?? defaultOption(def);
};
const defOf = (code: string): TeamInstructionDef => TEAM_INSTRUCTIONS_FM27.find((d) => d.code === code)!;

const MENTAL_RANK = (m: string) => Math.max(0, (MENTALITIES_FM27 as readonly string[]).indexOf(m));

/** Créneaux de la tactique sous la forme du moteur (sans joueur), pour les déplacements des rôles. */
function engineSlots(t: BuiltTactic): { ip: Slot[]; oop: Slot[] } {
  const xyIp = layoutPositions(t.slots.map((s) => s.pos));
  const xyOop = layoutPositions(t.slots.map((s) => s.posOOP));
  const mk = (s: BuiltSlot, pos: PosCode, [x, y]: [number, number]): Slot => ({ pos, x, y, ip: s.ip, oop: s.oop, player: null, fit: null });
  return { ip: t.slots.map((s, i) => mk(s, s.pos, xyIp[i]!)), oop: t.slots.map((s, i) => mk(s, s.posOOP, xyOop[i]!)) };
}

/** Bloc sans ballon d'après la consigne « Hauteur du pressing ». */
const blockOf = (t: BuiltTactic) => (['low', 'mid', 'high'] as const)[ti(t, 'LineOfEngagement') ?? 1] ?? 'mid';

/**
 * Forces et faiblesses d'une tactique construite, domaine par domaine :
 * rôles possibles au poste, couloirs (largeur avec ballon, flancs protégés sans ballon), axe, défense restante
 * quand on attaque, présence dans la surface et création, transitions (relais de contre, contre-pressing),
 * pressing, cohérence des consignes avec les rôles, et, si l'effectif est connu, le onze qui la jouerait.
 */
export function analyseBuiltTactic(engine: TacticEngine, t: BuiltTactic, players: FmPlayer[] = []): BuiltAnalysis {
  const F: Finding[] = [];
  const add = (id: string, area: Area, tone: Tone, params: Record<string, unknown> = {}, slots?: number[]) => F.push({ id, area, tone, params, ...(slots ? { slots } : {}) });
  const S = t.slots;
  const idx = S.map((_, i) => i);
  // Les consignes individuelles corrigent le comportement du rôle : « moins de courses » garde le joueur en place,
  // « plus de courses » le fait monter, « presser plus / moins » change son comportement sans ballon.
  const pis = (i: number) => normalizePi(S[i]!.pi ?? []);
  const ipT = (i: number): IpTrait | undefined => {
    const tr = IP_TRAITS[S[i]!.ip];
    if (!tr) return tr;
    if (pis(i).includes(PI_HOLD) && tr.move !== 'drop') return { ...tr, move: 'stay' };
    if (pis(i).includes(PI_RUN_BEHIND) && lineOf(S[i]!.pos) === 'ATT') return { ...tr, box: true };
    return tr;
  };
  const oopG = (i: number): Guard | undefined => {
    const g = OOP_TRAITS[S[i]!.oop];
    if (pis(i).includes(PI_PRESS_MORE) && g !== 'outlet') return 'press';
    if (pis(i).includes(PI_PRESS_LESS) && g === 'press') return 'base';
    return g;
  };
  const outfield = idx.filter((i) => S[i]!.pos !== 'GB');

  // 1. Rôles : chaque rôle doit exister à son poste, dans sa phase ; un seul gardien.
  const gks = idx.filter((i) => S[i]!.pos === 'GB');
  if (gks.length !== 1) add('keeper', 'roles', 'bad', { count: gks.length });
  const ipSlots = S.map((s) => ({ pos: s.pos }));
  const oopSlots = S.map((s) => ({ pos: s.posOOP }));
  const badIp = idx.filter((i) => !rolesAt(engine, ipSlots, i, 'ip').some((r) => r.code === S[i]!.ip));
  const badOop = idx.filter((i) => !rolesAt(engine, oopSlots, i, 'oop').some((r) => r.code === S[i]!.oop));
  if (badIp.length) add('roleInvalid', 'roles', 'bad', { phase: 'ip', count: badIp.length }, badIp);
  if (badOop.length) add('roleInvalid', 'roles', 'bad', { phase: 'oop', count: badOop.length }, badOop);
  const moved = outfield.filter((i) => S[i]!.pos !== S[i]!.posOOP && sideOf(S[i]!.pos) && sideOf(S[i]!.posOOP) && sideOf(S[i]!.pos) !== sideOf(S[i]!.posOOP));
  if (moved.length) add('sideSwap', 'roles', 'warn', { count: moved.length }, moved);
  // Missions avec ballon fixées par les rôles de FM27.
  const duty = (d: 'd' | 's' | 'a') => outfield.filter((i) => engine.roles.get(S[i]!.ip)?.duty === d);
  const att = duty('a');
  // Sans mission connue pour les rôles (repère incomplet), pas de constat plutôt qu'un faux « 0 en Attaque ».
  const dutyKnown = outfield.some((i) => engine.roles.get(S[i]!.ip)?.duty);
  if (dutyKnown && att.length >= 6) add('tooManyAttack', 'roles', 'warn', { count: att.length }, att);
  else if (dutyKnown && att.length <= 1) add('fewAttack', 'roles', 'warn', { count: att.length }, att);

  // 2. Couloirs.
  const width = ti(t, 'TeamWidth') ?? 2;
  const narrowAsked = width <= 1;
  for (const side of ['L', 'R'] as const) {
    const onSide = outfield.filter((i) => sideOf(S[i]!.pos) === side);
    const wideIp = onSide.filter((i) => ipT(i)?.lane === 'wide');
    const inside = onSide.filter((i) => ipT(i)?.lane !== 'wide');
    if (!wideIp.length && !narrowAsked) add('noWidth', 'lanes', onSide.length ? 'warn' : 'bad', { side }, onSide);
    else if (wideIp.length >= 2 && (ti(t, 'SupportingRunsSecondary') ?? 0) > 0) add('overlapPair', 'lanes', 'good', { side }, wideIp);
    // Ailier intérieur avec un latéral qui reste sur la ligne : le duo classique (chacun laisse de la place à l'autre).
    const iw = inside.filter((i) => ['IW', 'IF', 'WP'].includes(S[i]!.ip));
    const hug = wideIp.filter((i) => ['FB', 'WB', 'AWB', 'OCB'].includes(S[i]!.ip));
    if (iw.length && hug.length) add('insidePair', 'lanes', 'good', { side }, [...iw, ...hug]);
    // Sans ballon : qui défend ce flanc ? Latéral monté + ailier qui reste haut = couloir ouvert en transition.
    const back = idx.filter((i) => sideOf(S[i]!.posOOP) === side && lineOf(S[i]!.posOOP) === 'DEF' && S[i]!.posOOP !== 'DLG' && S[i]!.posOOP !== 'DLD');
    const wb = idx.filter((i) => sideOf(S[i]!.posOOP) === side && (S[i]!.posOOP === 'DLG' || S[i]!.posOOP === 'DLD'));
    const flankDef = [...back, ...wb];
    const highFull = onSide.filter((i) => lineOf(S[i]!.pos) !== 'ATT' && (ipT(i)?.move === 'push' || ipT(i)?.move === 'high') && ipT(i)?.lane === 'wide');
    const outletWing = idx.filter((i) => sideOf(S[i]!.posOOP) === side && oopG(i) === 'outlet');
    const wideCover = idx.some((i) => oopG(i) === 'wideCover') || S.filter((s) => s.pos === 'DC').length >= 3;
    if (!flankDef.length) add('flankOpen', 'lanes', 'bad', { side }, onSide);
    else if (highFull.length && outletWing.length && !wideCover) add('flankExposed', 'lanes', 'bad', { side }, [...highFull, ...outletWing]);
    // Aide du côté : un ailier qui se replie, ou qui redescend au niveau du milieu sans ballon (MO → M) sans rester devant.
    const helps = idx.filter((i) => sideOf(S[i]!.posOOP) === side && lineOf(S[i]!.posOOP) !== 'DEF' && (oopG(i) === 'track' || ((S[i]!.posOOP === 'MG' || S[i]!.posOOP === 'MD') && oopG(i) !== 'outlet')));
    if (!flankDef.length || (highFull.length && outletWing.length && !wideCover)) {
      /* déjà signalé */
    } else if (highFull.length && !wideCover && !helps.length) add('flankThin', 'lanes', 'warn', { side }, highFull);
    else if (helps.length) add('flankDoubled', 'lanes', 'good', { side, drop: helps.some((i) => S[i]!.pos !== S[i]!.posOOP) }, [...flankDef, ...helps]);
  }

  // 3. Défense restante : joueurs de champ qui restent derrière quand l'équipe attaque (rest defence).
  const rest = outfield.filter((i) => {
    const tr = ipT(i);
    if (!tr) return false;
    const ln = lineOf(S[i]!.pos);
    if (ln === 'DEF') return tr.move === 'stay' || tr.move === 'drop' || (tr.move === 'step' && tr.lane === 'centre');
    return S[i]!.pos === 'MDF' || S[i]!.pos === 'MC' || S[i]!.pos === 'MG' || S[i]!.pos === 'MD' ? tr.move === 'stay' || tr.move === 'drop' : false;
  });
  const screen = outfield.filter((i) => ['MDF', 'MC'].includes(S[i]!.pos) && (ipT(i)?.move === 'stay' || ipT(i)?.move === 'drop'));
  const restTone: Tone = rest.length >= 4 && screen.length ? 'good' : rest.length >= 3 ? 'warn' : 'bad';
  add(restTone === 'good' ? 'restSolid' : restTone === 'warn' ? 'restThin' : 'restWeak', 'rest', restTone, { count: rest.length, screen: screen.length }, rest);
  if (!screen.length && rest.length >= 3) add('noPivot', 'rest', 'warn', {});

  // 4. Attaque : présence dans la surface et création.
  const box = outfield.filter((i) => ipT(i)?.box);
  const create = outfield.filter((i) => ipT(i)?.create);
  add(box.length >= 3 ? 'boxStrong' : box.length === 2 ? 'boxOk' : box.length === 1 ? 'boxThin' : 'boxEmpty', 'attack', box.length >= 2 ? 'good' : box.length === 1 ? 'warn' : 'bad', { count: box.length }, box);
  if (!create.length) add('noCreator', 'attack', 'bad', {});
  else if (create.length === 1) add('oneCreator', 'attack', 'warn', {}, create);
  else if (create.length > 4) add('tooManyCreators', 'attack', 'warn', { count: create.length }, create);
  else add('creators', 'attack', 'good', { count: create.length }, create);
  const pushers = outfield.filter((i) => ipT(i)?.move === 'push' || ipT(i)?.move === 'high');
  if (pushers.length >= 8) add('allForward', 'attack', 'warn', { count: pushers.length }, pushers);

  // 5. Transitions : relais pour contrer, joueurs qui défendent, contre-pressing.
  const outlets = idx.filter((i) => oopG(i) === 'outlet');
  const counter = ti(t, 'AttackingTransition') === 2;
  const gegen = ti(t, 'DefensiveTransition') === 2;
  const regroup = ti(t, 'DefensiveTransition') === 0;
  if (outlets.length >= 3) add('fewDefenders', 'transition', 'bad', { count: 10 - outlets.length }, outlets);
  if (outlets.length && counter) add('counterReady', 'transition', 'good', { count: outlets.length }, outlets);
  else if (counter && !outlets.length && box.length < 2) add('counterNoOutlet', 'transition', 'warn', {});
  if (gegen && rest.length <= 2) add('gegenRisk', 'transition', 'bad', { count: rest.length });
  else if (gegen) add('gegenOk', 'transition', 'good', {});
  if (regroup && rest.length >= 4) add('regroupSafe', 'transition', 'good', {});

  // 6. Pressing : hauteur du bloc et rôles sans ballon.
  const block = blockOf(t);
  const press = outfield.filter((i) => oopG(i) === 'press');
  const hold = outfield.filter((i) => ['cover', 'screen'].includes(oopG(i) ?? ''));
  const trigger = ti(t, 'PressingTrigger') ?? 2;
  if (block === 'high') {
    if (press.length >= 3) add('pressBacked', 'press', 'good', { count: press.length }, press);
    else add('pressAlone', 'press', 'warn', { count: press.length }, press);
    if (hold.length >= 4) add('pressHolders', 'press', 'warn', { count: hold.length }, hold);
  } else if (block === 'low') {
    if (press.length >= 4 || trigger >= 3) add('lowBlockPressers', 'press', 'warn', { count: press.length }, press);
    else add('lowBlockCompact', 'press', 'good', {});
  }
  // Ligne haute : il faut quelqu'un pour couvrir l'espace dans le dos.
  const highLine = (ti(t, 'DefensiveLine') ?? 2) >= 3 || ti(t, 'DefensiveLineBehaviour') === 0;
  const sweeper = idx.some((i) => S[i]!.oop === 'SK') || idx.some((i) => ['CCB', 'CWCB'].includes(S[i]!.oop));
  if (highLine && !sweeper) add('highLineNoCover', 'press', 'warn', {});
  // Bloc étiré : l'avant presse haut pendant que la défense recule (ligne plus basse ou « Rester plus bas ») : un grand
  // espace s'ouvre entre les lignes (cas réel du 09/11/2026 : pressing haut, intensité plus élevée, ligne plus basse, reculer).
  const deepLine = (ti(t, 'DefensiveLine') ?? 2) <= 1 || ti(t, 'DefensiveLineBehaviour') === 2;
  if (block === 'high' && deepLine) add('stretchedBlock', 'press', 'bad', {});
  // Entre les lignes : milieux qui sortent presser sans personne pour filtrer devant la défense.
  const midPress = idx.filter((i) => ['MDF', 'MC'].includes(S[i]!.posOOP) && oopG(i) === 'press');
  const midScreen = idx.filter((i) => ['MDF', 'MC'].includes(S[i]!.posOOP) && ['screen', 'cover', 'wideCover'].includes(oopG(i) ?? ''));
  if (midPress.length >= 2 && !midScreen.length) add('gapBetweenLines', 'centre', 'bad', {}, midPress);
  else if (midScreen.length) add('screened', 'centre', 'good', { count: midScreen.length }, midScreen);
  const centralIp = outfield.filter((i) => ipT(i)?.lane === 'centre' && lineOf(S[i]!.pos) !== 'DEF').length + outfield.filter((i) => ipT(i)?.lane === 'half').length;
  if (centralIp >= 5) add('centreOverload', 'centre', 'good', { count: centralIp });
  else if (centralIp <= 2) add('centreThin', 'centre', 'warn', { count: centralIp });

  // 7. Cohérence des consignes avec les rôles.
  const has = (codes: string[]) => S.some((s) => codes.includes(s.ip));
  const gkTarget = ti(t, 'GoalkeeperDistributionTarget') ?? 0;
  const gkOpt = defOf('GoalkeeperDistributionTarget').options[gkTarget];
  if (gkTarget === 5 && !has(['TF'])) add('gkToTarget', 'coherence', 'bad', { option: gkOpt });
  if (gkTarget === 4 && !create.length) add('gkToPlaymaker', 'coherence', 'warn', { option: gkOpt });
  if ((gkTarget === 2 || gkTarget === 3) && !outfield.some((i) => ipT(i)?.lane === 'wide')) add('gkToWide', 'coherence', 'warn', { option: gkOpt });
  const crossing = ti(t, 'CrossingStyle') ?? 0;
  const early = ti(t, 'Patience') === 0;
  if ((crossing === 1 || early) && !has(['TF', 'CF']) && box.length < 2) add('crossNoTarget', 'coherence', 'warn', {});
  const touchline = outfield.filter((i) => ipT(i)?.lane === 'wide' && (ipT(i)?.move === 'push' || ipT(i)?.move === 'high'));
  if (narrowAsked && touchline.length >= 3) add('narrowVsWide', 'coherence', 'warn', { count: touchline.length }, touchline);
  if (width >= 3 && !touchline.length) add('wideNoWidth', 'coherence', 'warn', {});
  const progress = ti(t, 'ProgressThrough') ?? 0;
  for (const [opt, side] of [[2, 'L'], [3, 'R']] as const)
    if (progress === opt && !outfield.some((i) => sideOf(S[i]!.pos) === side && ipT(i)?.lane === 'wide')) add('flankFocusEmpty', 'coherence', 'warn', { side });
  const overlap = ti(t, 'SupportingRunsSecondary') ?? 0;
  if (overlap > 0 && !outfield.some((i) => lineOf(S[i]!.pos) === 'DEF' && (ipT(i)?.move === 'push' || ipT(i)?.move === 'high'))) add('overlapNoRunner', 'coherence', 'warn', {});
  const mentality = MENTAL_RANK(t.mentality);
  if (mentality >= 5 && rest.length <= 3) add('mentalityRisk', 'coherence', 'warn', { mentality: t.mentality });
  if (mentality <= 1 && pushers.length >= 6) add('mentalityTimid', 'coherence', 'warn', { mentality: t.mentality });
  for (const issue of checkTeamInstructions(builtLabelsAll(t))) if (issue.kind === 'condition') add('instructionCondition', 'coherence', 'warn', { label: issue.label, other: issue.other });
  const nTi = TEAM_INSTRUCTIONS_FM27.filter((d) => t.ti[d.id] != null && t.ti[d.id] !== defaultOption(d)).length;
  // Une tactique chargée de consignes met jusqu'à une vingtaine de matchs à être assimilée ; épurée, elle est prête tout de suite.
  // Les consignes individuelles comptent aussi (le jeu les additionne dans la complexité).
  const nPi = idx.reduce((a, i) => a + pis(i).length, 0);
  if (nTi >= 10 || nTi + nPi / 2 >= 14) add('complex', 'coherence', 'warn', { count: nTi, pi: nPi });
  else if (nTi <= 5 && nPi <= 6) add('simple', 'coherence', 'good', { count: nTi, pi: nPi });
  const tooMany = idx.filter((i) => pis(i).length > 3);
  if (tooMany.length) add('piHeavy', 'coherence', 'warn', { count: tooMany.length }, tooMany);
  const stale = idx.filter((i) => piStale(engine, t, i).length > 0);
  if (stale.length) add('piStale', 'coherence', 'warn', { count: stale.length }, stale);

  // 8. Effectif : le onze qui jouerait cette tactique, et ses limites physiques.
  const squad = players.length ? squadFit(engine, t, players) : null;
  if (squad) {
    const holes = squad.xi.map((x, i) => (x.player ? -1 : i)).filter((i) => i >= 0);
    if (holes.length) add('squadHoles', 'squad', 'bad', { count: holes.length }, holes);
    const weak = squad.xi.map((x, i) => ({ i, f: x.fit })).filter((x) => x.f != null && x.f < squad.fit - 1.5).map((x) => x.i);
    if (weak.length) add('squadWeak', 'squad', 'warn', { count: weak.length, names: weak.map((i) => squad.xi[i]!.player!.name) }, weak);
    const noDepth = squad.xi.map((x, i) => (x.player && !x.second ? i : -1)).filter((i) => i >= 0);
    if (noDepth.length) add('squadDepth', 'squad', 'warn', { count: noDepth.length }, noDepth);
    const withPlayers: Slot[] = engineSlots(t).ip.map((sl, i) => ({ ...sl, player: squad.xi[i]!.player, fit: squad.xi[i]!.fit }));
    const pseudo: StyleRef = { id: 'built', name: t.name, inPossession: builtInstructionLabels(t).ip, outOfPossession: builtInstructionLabels(t).oop, weights: {}, signatureRoles: { ip: [], oop: [] } };
    for (const c of engine.playerChecks(withPlayers, pseudo)) if (c.id !== 'fitness') pushCheck(add, c);
  }

  const partnerships = pairsOf(t, (ti(t, 'SupportingRunsSecondary') ?? 0) > 0);
  for (const p of partnerships) if (p.status !== 'balanced') add(`pair_${p.reason}`, p.zone.startsWith('flank') ? 'lanes' : 'centre', 'warn', { zone: p.zone }, p.slots);

  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
  const scores = {
    penetration: clamp(box.length * 18 + outfield.filter((i) => ipT(i)?.move === 'high').length * 7 + (ti(t, 'PassReception') === 2 ? 8 : 0) + (counter ? 6 : 0)),
    support: clamp(create.length * 15 + outfield.filter((i) => ipT(i)?.move === 'step' || (ipT(i)?.move === 'push' && lineOf(S[i]!.pos) !== 'ATT')).length * 9 + outfield.filter((i) => ipT(i)?.lane === 'half').length * 5),
    solidity: clamp(rest.length * 14 + screen.length * 10 + midScreen.length * 6 + (sweeper ? 6 : 0) - outlets.length * 10 + (10 - outlets.length >= 8 ? 10 : 0)),
  };
  const risk = clamp(MENTAL_RANK(t.mentality) * 8 + (4 - Math.min(4, rest.length)) * 12 + (highLine ? 12 : 0) + (gegen ? 8 : 0) + outlets.length * 6 + (block === 'high' ? 6 : 0));

  const areas = Object.fromEntries((['roles', 'lanes', 'centre', 'rest', 'attack', 'transition', 'press', 'coherence', 'squad'] as Area[]).map((a) => {
    const f = F.filter((x) => x.area === a);
    return [a, f.some((x) => x.tone === 'bad') ? 'bad' : f.some((x) => x.tone === 'warn') ? 'warn' : 'good'];
  })) as Record<Area, Tone>;
  const es = engineSlots(t);
  const block2 = blockOf(t);
  const xy = { ip: es.ip.map((s) => phaseXY(s, 'ip', block2)), oop: es.oop.map((s) => phaseXY(s, 'oop', block2)) };
  const field = (ph: Phase) => xy[ph].filter((_, i) => S[i]!.pos !== 'GB');
  return { findings: F, areas, shape: { ip: shapeOf(field('ip')), oop: shapeOf(field('oop')) }, xy, instructions: nTi, playerInstructions: nPi, scores, risk, partnerships, squad };
}

/**
 * Duos de la tactique, à la façon des « partenariats » des anciens outils d'analyse : sur chaque flanc le joueur de
 * la ligne arrière et celui de devant ; dans l'axe les paires de centraux, de milieux et d'attaquants.
 */
export function pairsOf(t: BuiltTactic, overlap = false): Partnership[] {
  const S = t.slots;
  const tr = (i: number) => IP_TRAITS[S[i]!.ip];
  const fwd = (i: number) => tr(i)?.move === 'push' || tr(i)?.move === 'high';
  const out: Partnership[] = [];
  const idx = S.map((_, i) => i);
  for (const side of ['L', 'R'] as const) {
    const back = idx.filter((i) => sideOf(S[i]!.pos) === side && lineOf(S[i]!.pos) === 'DEF');
    const front = idx.filter((i) => sideOf(S[i]!.pos) === side && lineOf(S[i]!.pos) !== 'DEF');
    if (back.length !== 1 || front.length !== 1) continue;
    const [a, b] = [back[0]!, front[0]!];
    const zone = side === 'L' ? 'flankL' : 'flankR';
    // Deux joueurs qui montent dans le même couloir se gênent, sauf si les dédoublements sont demandés.
    if (tr(a)?.lane === 'wide' && tr(b)?.lane === 'wide' && fwd(a) && fwd(b) && !overlap) out.push({ zone, slots: [a, b], status: 'overloading', reason: 'sameLane' });
    else if (!fwd(a) && !fwd(b) && tr(b)?.lane !== 'wide' && tr(a)?.lane !== 'wide') out.push({ zone, slots: [a, b], status: 'imbalanced', reason: 'noWidth' });
    else out.push({ zone, slots: [a, b], status: 'balanced', reason: 'ok' });
  }
  const pair = (zone: Partnership['zone'], ps: PosCode[], judge: (a: number, b: number) => [Partnership['status'], string]) => {
    const xs = idx.filter((i) => ps.includes(S[i]!.pos));
    if (xs.length !== 2) return;
    const [st, reason] = judge(xs[0]!, xs[1]!);
    out.push({ zone, slots: [xs[0]!, xs[1]!], status: st, reason });
  };
  pair('cb', ['DC'], (a, b) => (tr(a)?.move === 'step' && tr(b)?.move === 'step' ? ['imbalanced', 'bothStep'] : ['balanced', 'ok']));
  pair('mid', ['MDF', 'MC'], (a, b) => {
    if (fwd(a) && fwd(b)) return ['imbalanced', 'bothForward'];
    if (tr(a)?.create && tr(b)?.create) return ['overloading', 'twoPlaymakers'];
    return ['balanced', 'ok'];
  });
  pair('front', ['BT'], (a, b) => {
    if (tr(a)?.move === 'drop' && tr(b)?.move === 'drop') return ['imbalanced', 'bothDrop'];
    if (S[a]!.ip === S[b]!.ip && tr(a)?.box) return ['overloading', 'sameRole'];
    return ['balanced', 'ok'];
  });
  return out;
}

/** Vérifications physiques du moteur (vitesse de la défense, volume de course, jeu aérien) en constats. */
function pushCheck(add: (id: string, area: Area, tone: Tone, params?: Record<string, unknown>) => void, c: BalanceCheck) {
  const id = `squad_${c.id}_${c.status}`;
  add(id, 'squad', c.status, c.params);
}

/** Tous les libellés des consignes choisies. */
function builtLabelsAll(t: BuiltTactic): string[] {
  const l = builtInstructionLabels(t);
  return [...l.ip, ...l.oop];
}

/**
 * Meilleur onze de l'effectif pour cette tactique : chaque joueur jugé au créneau (rôle avec ballon à son poste
 * avec ballon, rôle sans ballon à son poste sans ballon) et à sa forme du jour, attribution optimale sur le onze.
 */
export function squadFit(engine: TacticEngine, t: BuiltTactic, players: FmPlayer[]): SquadFit {
  const S = t.slots;
  const fitOf = (p: FmPlayer, i: number) => {
    const s = S[i]!;
    const a = engine.roleFit(p, s.ip, 'ip', s.pos) ?? 0;
    const b = oopFit(engine, p, s.oop, s.pos, s.posOOP) ?? 0;
    return (a + b) / 2;
  };
  const ok = (p: FmPlayer, i: number) => engine.canPlay(p, S[i]!.pos);
  const value = S.map((_, i) => players.map((p) => (ok(p, i) ? fitOf(p, i) + readiness(p) : null)));
  const assign = assignMax(value);
  const taken = new Set(assign.filter((j) => j >= 0));
  const xi = S.map((_, i) => {
    const j = assign[i]!;
    const player = j >= 0 ? players[j]! : null;
    const second =
      players
        .map((p, k) => ({ p, k }))
        .filter(({ p, k }) => !taken.has(k) && ok(p, i))
        .sort((a, b) => fitOf(b.p, i) - fitOf(a.p, i))[0]?.p ?? null;
    return { player, fit: player ? fitOf(player, i) : null, second };
  });
  return { xi, fit: xi.reduce((a, x) => a + (x.fit ?? 0), 0) / xi.length };
}

/* ---------- Tactique construite choisie dans « Le onze » ---------- */

/** Style équivalent à une tactique construite : sa mentalité, ses consignes d'équipe et ses rôles. */
export function builtStyle(t: BuiltTactic): StyleRef {
  const l = builtInstructionLabels(t);
  return {
    id: `built:${t.id}`,
    name: t.name,
    inPossession: l.ip,
    outOfPossession: l.oop,
    weights: {},
    mentality: t.mentality,
    signatureRoles: { ip: [...new Set(t.slots.map((s) => s.ip))], oop: [...new Set(t.slots.map((s) => s.oop))] },
  };
}

/**
 * Onze d'une tactique construite : postes et rôles fixés par le joueur, meilleure attribution des joueurs
 * (adéquation avec et sans ballon + forme du jour). Un poste que l'équipe première ne peut pas tenir est
 * confié à la réserve. Remplaçants : les deux meilleurs restants à chaque poste.
 */
export function builtPlan(engine: TacticEngine, t: BuiltTactic, players: FmPlayer[], reserve: FmPlayer[] = []): FormationPlan {
  const S = t.slots;
  const fitOf = (p: FmPlayer, i: number) => ((engine.roleFit(p, S[i]!.ip, 'ip', S[i]!.pos) ?? 0) + (oopFit(engine, p, S[i]!.oop, S[i]!.pos, S[i]!.posOOP) ?? 0)) / 2;
  const ok = (p: FmPlayer, i: number) => engine.canPlay(p, S[i]!.pos);
  const pick = (list: FmPlayer[], open: number[]) => {
    const value = open.map((i) => list.map((p) => (ok(p, i) ? fitOf(p, i) + readiness(p) : null)));
    return assignMax(value).map((j) => (j >= 0 ? list[j]! : null));
  };
  const xi: (FmPlayer | null)[] = pick(players, S.map((_, i) => i));
  const holes = S.map((_, i) => i).filter((i) => !xi[i]);
  if (holes.length && reserve.length) pick(reserve, holes).forEach((p, k) => (xi[holes[k]!] = p));
  const used = new Set(xi.flatMap((p) => (p ? [p.id] : [])));
  const xy = layoutPositions(S.map((s) => s.pos));
  const slots: Slot[] = S.map((s, i) => {
    const player = xi[i] ?? null;
    return { pos: s.pos, ...(s.posOOP !== s.pos ? { posOOP: s.posOOP } : {}), x: xy[i]![0], y: xy[i]![1], ip: s.ip, oop: s.oop, player, fit: player ? fitOf(player, i) : null };
  });
  const benchFor = (list: FmPlayer[], i: number) =>
    list
      .filter((p) => !used.has(p.id) && ok(p, i))
      .sort((a, b) => fitOf(b, i) - fitOf(a, i))
      .slice(0, 2);
  // Doublures : l'équipe première d'abord ; sans personne, le meilleur de la réserve ou des jeunes.
  const subs = S.map((_, i) => {
    const first = benchFor(players, i);
    return first.length ? first : benchFor(reserve, i).slice(0, 1);
  });
  const fit = slots.reduce((a, s) => a + (s.fit ?? 0), 0) / slots.length;
  const form = formationOfPositions(S.map((s) => s.pos)) ?? shapeOf(slots.filter((s) => s.pos !== 'GB').map((s) => [s.x, s.y] as [number, number]));
  return { form, slots, subs, score: fit, fit, penalty: 0, holes: slots.filter((s) => !s.player).length };
}
