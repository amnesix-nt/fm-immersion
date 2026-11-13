import type { FmPlayer } from './player';
import type { PosCode } from './positions';
import { keyAttrs } from './project';
import { ROLE_RATINGS_FM27 } from './role-ratings-fm27';
import { attrOf, avg, slotFit, type FormationPlan, type Phase, type TacticEngine } from './tactic';

/*
 * Écart entre la tactique et l'effectif, poste par poste : pour chaque créneau du onze (celui du jeu d'abord), ce que
 * les deux rôles demandent (leurs attributs clés, ceux du radar de FM27), ce que le titulaire et sa doublure donnent,
 * et les attributs clés qui manquent. Purement consultatif : rien n'est changé dans le jeu.
 *
 * Deux repères, calculés sur le onze lui-même pour rester justes à tous les niveaux (2e division slovaque ou Ligue des
 * champions) :
 * - la note du créneau est comparée à la médiane des notes du onze : un point de moins (une demi-étoile) = poste fragile ;
 * - un attribut clé manque quand il est au moins un point sous le niveau moyen des titulaires de champ.
 */

/** Note sous la médiane du onze à partir de laquelle un poste est fragile (sur 20 : une demi-étoile). */
export const GAP_WEAK = 1;
/** Doublure trop juste : une étoile sous le titulaire (sur 20). */
export const GAP_THIN = 2;
/** Avance d'une doublure sur le titulaire pour la signaler (sur 20 : un quart d'étoile, sous l'arrondi du jeu en dessous). */
export const SUB_AHEAD = 0.5;
/** Attributs manquants montrés par poste. */
const MAX_MISSING = 3;

export type GapVerdict = 'hole' | 'weak' | 'thin' | 'ok';

export interface GapAttr {
  /** Clé du jeu (« Pace »). */
  key: string;
  value: number;
  /** Niveau attendu : moyenne des attributs des titulaires de champ. */
  bar: number;
}

export interface SlotGap {
  slot: number;
  pos: PosCode;
  ip: string;
  oop: string;
  starter: FmPlayer | null;
  starterFit: number | null;
  /** Première doublure du poste (équipe première, sinon réserve). */
  sub: FmPlayer | null;
  subFit: number | null;
  /** Doublure mieux notée que le titulaire dans ces rôles (d'au moins SUB_AHEAD) : à essayer, forme du jour à part. */
  subAhead: boolean;
  /** Écart du titulaire avec la médiane du onze (positif = en dessous). */
  gap: number | null;
  /** Attributs clés des deux rôles sous le niveau du onze, du plus gros manque au plus petit. */
  missing: GapAttr[];
  verdict: GapVerdict;
}

export interface TacticGap {
  slots: SlotGap[];
  /** Médiane des notes du onze, sur 20. */
  median: number | null;
  /** Niveau moyen des attributs des titulaires de champ. */
  level: number | null;
  count: Record<GapVerdict, number>;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Attributs clés d'un rôle : ceux du jeu (radar) pour un rôle FM27, sinon les plus lourds du repère. */
export function roleKeys(engine: TacticEngine, code: string, phase: Phase): string[] {
  const r = engine.roles.get(code);
  const game = phase === 'oop' ? r?.game?.oop : r?.game?.ip;
  const k = game ? ROLE_RATINGS_FM27[game]?.k : undefined;
  return k?.length ? k : keyAttrs(engine, code, phase, 6);
}

/** Niveau d'un joueur : moyenne de ses attributs utiles (sans ceux de gardien pour un joueur de champ, voir player.ts). */
const meanAttr = (p: FmPlayer) => p.level ?? avg(Object.values(p.attributes));

export function tacticGap(engine: TacticEngine, plan: FormationPlan): TacticGap {
  const fits = plan.slots.map((sl) => (sl.player ? slotFit(engine, sl.player, sl) : null));
  const med = median(fits.filter((f): f is number => f != null));
  const field = plan.slots.filter((sl) => sl.player && sl.pos !== 'GB').map((sl) => meanAttr(sl.player!));
  const level = avg(field);
  const count: Record<GapVerdict, number> = { hole: 0, weak: 0, thin: 0, ok: 0 };

  const slots = plan.slots.map((sl, i): SlotGap => {
    const starter = sl.player;
    const starterFit = fits[i] ?? null;
    const sub = plan.subs[i]?.[0] ?? null;
    const subFit = sub ? slotFit(engine, sub, sl) : null;
    const subAhead = subFit != null && starterFit != null && subFit - starterFit >= SUB_AHEAD;
    const gap = starterFit != null && med != null ? med - starterFit : null;
    // Un gardien se juge à ses propres attributs : le niveau du champ ne lui va pas.
    const bar = sl.pos === 'GB' ? (starter ? meanAttr(starter) : null) : level;
    const keys = [...new Set([...roleKeys(engine, sl.ip, 'ip'), ...roleKeys(engine, sl.oop, 'oop')])];
    const missing: GapAttr[] =
      starter && bar != null
        ? keys
            .flatMap((key) => {
              const value = attrOf(starter, key);
              return value != null && value <= bar - 1 ? [{ key, value, bar }] : [];
            })
            .sort((a, b) => a.value - b.value || a.key.localeCompare(b.key))
            .slice(0, MAX_MISSING)
        : [];
    const verdict: GapVerdict = !starter
      ? 'hole'
      : gap != null && gap >= GAP_WEAK
        ? 'weak'
        : !sub || subFit == null || (starterFit != null && starterFit - subFit >= GAP_THIN)
          ? 'thin'
          : 'ok';
    count[verdict]++;
    return { slot: i, pos: sl.pos, ip: sl.ip, oop: sl.oop, starter, starterFit, sub, subFit, subAhead, gap, missing, verdict };
  });
  return { slots, median: med, level, count };
}
