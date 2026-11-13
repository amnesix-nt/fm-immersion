import { CONDITION_HORIZON_DAYS, TIRED_CONDITION } from './briefing';
import { unavailable, type FmPlayer } from './player';
import { CHAIN_STARTS, strainOf, type PlayerLoad, type Strain } from './rotation';
import { RISK_HIGH, RISK_RAISED, type FormationPlan, type TacticEngine } from './tactic';

/**
 * Écart d'adéquation (sur 20) qu'on accepte pour reposer un titulaire : plus large pour un joueur fatigué (sous 85 %,
 * il joue nettement moins bien) ou au risque de blessure élevé que pour une simple rotation. Hors coupe et calendrier
 * chargé, un joueur qui enchaîne ou au risque accru ne sort que si sa doublure le vaut presque (`important`).
 * Au-delà, il joue quand même.
 */
export const REST_MAX_DROP = { tired: 5, rotation: 3, important: 1.5 } as const;
/** Un remplaçant n'est « frais » que s'il est au-dessus de 85 % et nettement plus en forme que le titulaire. */
export const FRESHER_BY = 5;

export interface MatchdayChange {
  slot: number;
  out: FmPlayer;
  /** Remplaçant retenu ; null si personne ne peut tenir le poste (le titulaire absent laisse un trou). */
  in: FmPlayer | null;
  /**
   * Absent (blessé, suspendu), fatigué (sous 85 %), à faire tourner (coupe, calendrier chargé : sous 92 %),
   * risque de blessure affiché par le jeu, ou matchs enchaînés.
   */
  reason: 'unavailable' | 'tired' | 'rotation' | 'risk' | 'chained';
}

/** Un titulaire à surveiller physiquement avant le match, qu'il soit remplacé ou non. */
export interface PhysicalWatch {
  slot: number;
  player: FmPlayer;
  strain: Strain;
  load: PlayerLoad | null;
  /** Meilleure doublure en bon état au poste ; null s'il n'y en a pas. */
  sub: FmPlayer | null;
  /** Note du titulaire et de la doublure dans les rôles du poste (sur 20). */
  fit: number;
  subFit: number | null;
  /** Points perdus (sur 20) en alignant la doublure ; null sans doublure. */
  drop: number | null;
  /** La doublure prend sa place dans le onze du match. */
  swapped: boolean;
}

/**
 * Onze du prochain match : le onze de base (celui du jeu ou le calculé) corrigé pour ce match-là.
 * Les absents sont remplacés ; les titulaires fatigués (85 %, ou 92 % quand il faut faire tourner), au risque de
 * blessure élevé ou qui enchaînent les matchs laissent leur place au meilleur joueur en bon état du poste, si l'écart
 * d'adéquation reste raisonnable. Un joueur frais mais à court de rythme reste dans le onze (il a besoin de jouer) :
 * il est seulement signalé dans `watch`, pour être sorti en cours de match.
 */
export function matchdayPlan(
  engine: TacticEngine,
  plan: FormationPlan,
  players: FmPlayer[],
  opts: { rotate: boolean; inDays?: number | null; load?: Map<string, PlayerLoad> },
): { plan: FormationPlan; changes: MatchdayChange[]; watch: PhysicalWatch[] } {
  // Match lointain (trêve) : la condition d'aujourd'hui sera remontée, seuls les absents et les risques élevés comptent.
  const far = opts.inDays != null && opts.inDays > CONDITION_HORIZON_DAYS;
  const load = opts.load ?? new Map<string, PlayerLoad>();
  const fresh = (c: FmPlayer, out: FmPlayer) =>
    !unavailable(c) && (c.condition ?? 100) >= TIRED_CONDITION && (c.condition ?? 100) >= (out.condition ?? 100) + FRESHER_BY && (c.injuryRisk ?? 0) < RISK_HIGH;
  /** En bon état pour relayer un joueur à risque ou qui enchaîne : ni entamé, ni à risque, ni lui-même en série. */
  const sound = (c: FmPlayer) => !unavailable(c) && (c.condition ?? 100) >= TIRED_CONDITION && (c.injuryRisk ?? 0) < RISK_RAISED && (load.get(c.id)?.starts ?? 0) < CHAIN_STARTS;
  const slots = plan.slots.map((s) => ({ ...s }));
  const xi = new Set(slots.flatMap((s) => (s.player ? [s.player.id] : [])));
  const fitAt = (p: FmPlayer, i: number) => {
    const s = slots[i]!;
    return ((engine.roleFit(p, s.ip, 'ip', s.pos) ?? 0) + (engine.roleFit(p, s.oop, 'oop', s.pos) ?? 0)) / 2;
  };
  const changes: MatchdayChange[] = [];
  const watch: PhysicalWatch[] = [];
  // Les absents d'abord (le poste doit être tenu), puis les joueurs à ménager, puis les plus fatigués.
  const order = slots
    .map((s, i) => ({ i, p: s.player }))
    .filter((x): x is { i: number; p: FmPlayer } => !!x.p)
    .map((x) => ({ ...x, gone: unavailable(x.p), strain: unavailable(x.p) ? null : strainOf(x.p, load.get(x.p.id), far) }))
    .filter((x) => x.gone || x.strain)
    .sort((a, b) => Number(b.gone) - Number(a.gone) || Number(b.strain?.level === 'rest') - Number(a.strain?.level === 'rest') || (a.p.condition ?? 100) - (b.p.condition ?? 100));
  for (const { i, p, gone, strain } of order) {
    const pos = slots[i]!.pos;
    const cands = players.filter((c) => !xi.has(c.id) && !unavailable(c) && engine.canPlay(c, pos)).map((c) => ({ c, f: fitAt(c, i) }));
    if (gone) {
      // Un absent ne joue pas : le meilleur disponible, même entamé.
      const pick = cands.sort((a, b) => b.f - a.f)[0];
      xi.delete(p.id);
      if (pick) xi.add(pick.c.id);
      slots[i]!.player = pick?.c ?? null;
      slots[i]!.fit = pick ? pick.f : null;
      changes.push({ slot: i, out: p, in: pick?.c ?? null, reason: 'unavailable' });
      continue;
    }
    const s = strain!;
    const byCondition = s.reason === 'tired' || s.reason === 'worn';
    const best = cands.filter((x) => (byCondition ? fresh(x.c, p) : sound(x.c))).sort((a, b) => b.f - a.f)[0];
    const drop = best ? fitAt(p, i) - best.f : null;
    // Entamé (sous 92 %) : seulement quand le match se prête à la rotation. À court de rythme : il doit jouer.
    const maxDrop =
      s.cause === 'rhythm' || (s.reason === 'worn' && !opts.rotate) ? null : s.level === 'rest' ? REST_MAX_DROP.tired : opts.rotate ? REST_MAX_DROP.rotation : REST_MAX_DROP.important;
    const swapped = !!best && maxDrop != null && drop! <= maxDrop;
    if (s.reason !== 'worn' || opts.rotate) watch.push({ slot: i, player: p, strain: s, load: load.get(p.id) ?? null, sub: best?.c ?? null, fit: fitAt(p, i), subFit: best?.f ?? null, drop, swapped });
    if (!swapped) continue;
    xi.delete(p.id);
    xi.add(best!.c.id);
    slots[i]!.player = best!.c;
    slots[i]!.fit = best!.f;
    changes.push({ slot: i, out: p, in: best!.c, reason: s.reason === 'tired' ? 'tired' : s.reason === 'worn' ? 'rotation' : s.reason === 'chained' ? 'chained' : 'risk' });
  }
  watch.sort((a, b) => a.slot - b.slot);
  if (!changes.length) return { plan, changes, watch };
  // Doublures : les titulaires reposés en premier (ils peuvent entrer), puis les anciennes doublures encore libres.
  const subs = slots.map((_, i) => {
    const rested = changes.filter((c) => c.slot === i && c.reason !== 'unavailable').map((c) => c.out);
    return [...rested, ...(plan.subs[i] ?? []).filter((p) => !xi.has(p.id) && !rested.includes(p))];
  });
  return { plan: { ...plan, slots, subs }, changes, watch };
}
