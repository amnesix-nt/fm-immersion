import type { FmPlayer } from './player';
import type { PosCode } from './positions';
import { balancePenalty, oopFit, readiness, readinessParts, slotContexts, slotFit, type FormationPlan, type Phase, type Slot, type TacticEngine } from './tactic';

/*
 * L'avis de l'adjoint sur un onze (celui du jeu, celui calculé, ou celui d'une tactique construite) :
 * ce qu'un calcul poste par poste ne dit pas. Quatre lectures, chacune avec ses chiffres :
 * - un rôle qui irait nettement mieux au joueur, au même poste, sans déséquilibrer l'équipe ;
 * - un remplaçant nettement meilleur que le titulaire choisi dans le jeu (forme du jour comprise) ;
 * - un joueur mieux noté laissé sur le banc par le calcul à cause de sa forme (rythme, fatigue, moral) ;
 * - un poste sans doublure : qui glisse, qui entre, ou qui monter de la réserve.
 * Purement consultatif : le joueur décide et règle lui-même FM27.
 */

/** Onze lu dans le jeu, calculé par FM Immersion, ou tactique construite par le joueur. */
export type PlanSource = 'game' | 'suggested' | 'built';

/**
 * Gain minimal (note sur 20) pour conseiller un autre rôle : 0,6 = 0,3 étoile. En dessous, l'écart est dans la
 * précision des étoiles du jeu, et changer un rôle remet à zéro la familiarité du joueur avec lui.
 */
export const ROLE_GAIN = 0.6;
/** Gain minimal (adéquation + forme du jour, sur 20) pour conseiller de changer de titulaire : une demi-étoile. */
export const STARTER_GAIN = 1;
/** Familiarité minimale (sur 20) pour dépanner à un poste qui n'est pas le sien. */
export const MAKESHIFT_FAMILIARITY = 10;

export interface RoleAdvice {
  slot: number;
  player: FmPlayer;
  phase: Phase;
  /** Rôle actuel et rôle conseillé (codes du repère), avec leurs notes sur 20. */
  from: string;
  to: string;
  fromFit: number;
  toFit: number;
}

export interface StarterAdvice {
  slot: number;
  starter: FmPlayer;
  better: FmPlayer;
  /** Adéquation aux rôles du créneau, sur 20 (sans la forme du jour). */
  starterFit: number;
  betterFit: number;
  /** Écart adéquation + forme du jour. */
  gain: number;
}

export type RestedReason = 'sharpness' | 'condition' | 'morale' | 'risk';

export interface RestedAdvice {
  slot: number;
  starter: FmPlayer;
  /** Joueur mieux noté dans ces rôles, laissé sur le banc par le calcul. */
  better: FmPlayer;
  starterFit: number;
  betterFit: number;
  reason: RestedReason;
  /** Rythme ou condition en %, sinon null (moral : voir `better.morale`). */
  value: number | null;
}

export interface CoverAdvice {
  slot: number;
  pos: PosCode;
  starter: FmPlayer | null;
  /** Titulaire d'un autre poste qui peut glisser ici, et celui qui entre à sa place. */
  shift: { player: FmPlayer; from: PosCode; replacement: FmPlayer } | null;
  /** Joueur de la réserve ou des jeunes qui tient le poste. */
  reserve: FmPlayer | null;
  /** Remplaçant de l'équipe première qui peut dépanner (familiarité partielle). */
  makeshift: { player: FmPlayer; familiarity: number } | null;
}

export interface LineupAdvice {
  roles: RoleAdvice[];
  starters: StarterAdvice[];
  rested: RestedAdvice[];
  cover: CoverAdvice[];
}

const MAX_ROLES = 4;
const MAX_STARTERS = 3;
const MAX_RESTED = 3;

const posFor = (sl: Slot, ph: Phase): PosCode => (ph === 'oop' ? (sl.posOOP ?? sl.pos) : sl.pos);

/**
 * Rôles à revoir : pour chaque titulaire, le rôle de la même phase et du même poste où il est nettement mieux noté.
 * Un rôle qui creuse un déséquilibre (largeur, création, couverture, présence dans la surface) n'est pas proposé :
 * on passe au suivant. Les changements retenus sont évalués ensemble, du plus gros gain au plus petit.
 */
export function betterRoles(engine: TacticEngine, plan: FormationPlan): RoleAdvice[] {
  const work = plan.slots.map((s) => ({ ...s }));
  const ctxs = slotContexts(work.map((s) => ({ pos: s.pos, x: s.x })));
  const cands: (RoleAdvice & { gain: number })[] = [];
  work.forEach((sl, i) => {
    const p = sl.player;
    if (!p) return;
    for (const ph of ['ip', 'oop'] as const) {
      const pos = posFor(sl, ph);
      const fitAt = (code: string) => (ph === 'oop' ? oopFit(engine, p, code, sl.pos, sl.posOOP) : engine.roleFit(p, code, ph, pos));
      const cur = fitAt(sl[ph]);
      if (cur == null) continue;
      // Poste sans ballon différent : le créneau n'est plus « excentré » au sens du poste avec ballon.
      const ctx = pos === sl.pos ? ctxs[i] : { wide: false, cbs: ctxs[i]!.cbs };
      for (const r of engine.ref.roles) {
        if (r.code === sl[ph] || !engine.availableAt(r, pos, ph, ctx)) continue;
        const f = fitAt(r.code);
        if (f != null && f - cur >= ROLE_GAIN) cands.push({ slot: i, player: p, phase: ph, from: sl[ph], to: r.code, fromFit: cur, toFit: f, gain: f - cur });
      }
    }
  });
  cands.sort((a, b) => b.gain - a.gain);
  const out: RoleAdvice[] = [];
  const done = new Set<string>();
  let pen = balancePenalty(engine.roleChecks(work));
  for (const c of cands) {
    const key = `${c.slot}|${c.phase}`;
    if (done.has(key)) continue;
    const sl = work[c.slot]!;
    const old = sl[c.phase];
    sl[c.phase] = c.to;
    const next = balancePenalty(engine.roleChecks(work));
    if (next > pen + 1e-9) {
      sl[c.phase] = old;
      continue;
    }
    pen = next;
    done.add(key);
    const { gain: _gain, ...row } = c;
    out.push(row);
    if (out.length >= MAX_ROLES) break;
  }
  return out;
}

/** Titulaires à revoir (onze du jeu) : un remplaçant disponible nettement meilleur dans les rôles du créneau, forme comprise. */
export function betterStarters(engine: TacticEngine, plan: FormationPlan, players: FmPlayer[]): StarterAdvice[] {
  const xi = new Set(plan.slots.flatMap((s) => (s.player ? [s.player.id] : [])));
  const bench = players.filter((p) => !xi.has(p.id));
  const cands: StarterAdvice[] = [];
  plan.slots.forEach((sl, i) => {
    const s = sl.player;
    if (!s) return;
    const sFit = slotFit(engine, s, sl);
    if (sFit == null) return;
    for (const b of bench) {
      if (!engine.canPlay(b, sl.pos)) continue;
      const bFit = slotFit(engine, b, sl);
      if (bFit == null) continue;
      const gain = bFit + readiness(b) - (sFit + readiness(s));
      if (gain >= STARTER_GAIN) cands.push({ slot: i, starter: s, better: b, starterFit: sFit, betterFit: bFit, gain });
    }
  });
  cands.sort((a, b) => b.gain - a.gain);
  const usedSlot = new Set<number>();
  const usedPlayer = new Set<string>();
  return cands.filter((c) => !usedSlot.has(c.slot) && !usedPlayer.has(c.better.id) && !!usedSlot.add(c.slot) && !!usedPlayer.add(c.better.id)).slice(0, MAX_STARTERS);
}

/**
 * Joueurs écartés par le calcul pour leur forme du jour : mieux notés que le titulaire dans les rôles du créneau
 * (au moins ROLE_GAIN), mais pénalisés par le manque de rythme, la fatigue ou le moral. À relancer par du temps de jeu.
 */
export function restedPlayers(engine: TacticEngine, plan: FormationPlan, players: FmPlayer[]): RestedAdvice[] {
  const xi = new Set(plan.slots.flatMap((s) => (s.player ? [s.player.id] : [])));
  const bench = players.filter((p) => !xi.has(p.id));
  const cands: (RestedAdvice & { gap: number })[] = [];
  plan.slots.forEach((sl, i) => {
    const s = sl.player;
    if (!s) return;
    const sFit = slotFit(engine, s, sl);
    if (sFit == null) return;
    for (const b of bench) {
      if (!engine.canPlay(b, sl.pos)) continue;
      const bFit = slotFit(engine, b, sl);
      if (bFit == null || bFit - sFit < ROLE_GAIN || readiness(b) >= readiness(s)) continue;
      const r = readinessParts(b);
      const worst = ([['sharpness', r.sharpness], ['condition', r.condition], ['morale', r.morale], ['risk', r.risk]] as [RestedReason, number][]).sort((x, y) => x[1] - y[1])[0]!;
      if (worst[1] >= 0) continue;
      const value = worst[0] === 'sharpness' ? (b.sharpness ?? null) : worst[0] === 'condition' ? (b.condition ?? null) : null;
      cands.push({ slot: i, starter: s, better: b, starterFit: sFit, betterFit: bFit, reason: worst[0], value, gap: bFit - sFit });
    }
  });
  cands.sort((a, b) => b.gap - a.gap);
  const usedSlot = new Set<number>();
  const usedPlayer = new Set<string>();
  return cands
    .filter((c) => !usedSlot.has(c.slot) && !usedPlayer.has(c.better.id) && !!usedSlot.add(c.slot) && !!usedPlayer.add(c.better.id))
    .slice(0, MAX_RESTED)
    .map(({ gap: _gap, ...row }) => row);
}

/**
 * Postes sans doublure dans l'équipe première (aucune, ou seulement un joueur de la réserve) : comme le ferait un
 * staff, on cherche d'abord un titulaire qui peut glisser à ce poste et dont le propre poste a une doublure,
 * puis la réserve, puis un remplaçant qui connaît un peu le poste.
 */
export function coverGaps(engine: TacticEngine, plan: FormationPlan, players: FmPlayer[]): CoverAdvice[] {
  const xi = new Set(plan.slots.flatMap((s) => (s.player ? [s.player.id] : [])));
  const bench = players.filter((p) => !xi.has(p.id));
  const out: CoverAdvice[] = [];
  plan.slots.forEach((sl, i) => {
    const first = plan.subs[i]?.[0] ?? null;
    if (first && !first.team) return;
    let shift: CoverAdvice['shift'] = null;
    let best = -Infinity;
    if (sl.pos !== 'GB')
      plan.slots.forEach((other, j) => {
        const q = other.player;
        const repl = plan.subs[j]?.[0];
        if (j === i || !q || other.pos === 'GB' || !repl || repl.team || !engine.canPlay(q, sl.pos)) return;
        const f = slotFit(engine, q, sl) ?? 0;
        if (f > best) [best, shift] = [f, { player: q, from: other.pos, replacement: repl }];
      });
    const makeshift =
      bench
        .filter((p) => !engine.canPlay(p, sl.pos) && (p.familiarity?.[sl.pos] ?? 0) >= MAKESHIFT_FAMILIARITY)
        .map((p) => ({ player: p, familiarity: p.familiarity![sl.pos]!, f: slotFit(engine, p, sl) ?? 0 }))
        .sort((a, b) => b.f - a.f)
        .map(({ player, familiarity }) => ({ player, familiarity }))[0] ?? null;
    out.push({ slot: i, pos: sl.pos, starter: sl.player, shift, reserve: first, makeshift });
  });
  return out;
}

/** Tout l'avis sur un onze. `players` : équipe première disponible. */
export function lineupAdvice(engine: TacticEngine, plan: FormationPlan, players: FmPlayer[], source: PlanSource): LineupAdvice {
  return {
    // Un onze calculé a déjà les rôles du style les mieux notés : on ne le contredit pas.
    roles: source === 'suggested' ? [] : betterRoles(engine, plan),
    starters: source === 'game' ? betterStarters(engine, plan, players) : [],
    rested: source === 'game' ? [] : restedPlayers(engine, plan, players),
    cover: coverGaps(engine, plan, players),
  };
}
