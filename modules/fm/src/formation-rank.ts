import type { FmPlayer } from './player';
import { lineOf, type PosCode } from './positions';
import type { rankTactics } from './project';
import type { FormationPlan, StyleRef } from './tactic';

/*
 * Classement des schémas selon l'effectif : pour chacun des schémas connus de l'appli (FORMATIONS), le meilleur onze
 * que l'effectif peut aligner, tous styles confondus, avec la note de chaque ligne et le poste le plus faible.
 *
 * Rien de nouveau dans le calcul : on relit le classement commun de l'appli (`rankTactics`), qui a déjà construit le
 * onze de chaque schéma pour chaque style (adéquation aux rôles, forme du jour, déséquilibres, coût du style pour cet
 * effectif). Ici on garde, par schéma, la meilleure de ces lignes, puis on les range du meilleur au moins bon.
 */

export type FormationLine = 'def' | 'mid' | 'att';

export interface FormationWeak {
  /** Index du créneau dans le onze du schéma. */
  slot: number;
  pos: PosCode;
  player: FmPlayer | null;
  /** Adéquation du joueur au créneau, sur 20 (null : personne pour ce poste). */
  fit: number | null;
}

export interface FormationRow {
  form: string;
  /** Style dont le onze est le meilleur dans ce schéma. */
  style: StyleRef;
  plan: FormationPlan;
  /** Note d'équipe sur 20, coût du style compris : la même que celle du classement des tactiques. */
  score: number;
  /** Adéquation moyenne de chaque ligne (gardien compté en défense), sur 20 ; null si la ligne est vide. */
  lines: Record<FormationLine, number | null>;
  /** Poste le plus faible du onze (créneau vide d'abord). */
  weakest: FormationWeak | null;
  /** Postes sans joueur. */
  holes: number;
}

const LINE_OF = (pos: PosCode): FormationLine => {
  const l = lineOf(pos);
  return l === 'GB' || l === 'DEF' ? 'def' : l === 'MIL' ? 'mid' : 'att';
};

/** Adéquation moyenne de chaque ligne du onze. Un créneau vide compte 0, comme dans la note d'équipe. */
export function lineFits(plan: FormationPlan): Record<FormationLine, number | null> {
  const acc: Record<FormationLine, number[]> = { def: [], mid: [], att: [] };
  for (const s of plan.slots) acc[LINE_OF(s.pos)].push(s.player ? (s.fit ?? 0) : 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { def: mean(acc.def), mid: mean(acc.mid), att: mean(acc.att) };
}

/** Poste le plus faible du onze : un créneau vide d'abord, sinon l'adéquation la plus basse. */
export function weakestOfPlan(plan: FormationPlan): FormationWeak | null {
  let best: FormationWeak | null = null;
  plan.slots.forEach((s, slot) => {
    const fit = s.player ? (s.fit ?? null) : null;
    const key = (w: FormationWeak) => (w.player ? (w.fit ?? 0) : -1);
    const cur: FormationWeak = { slot, pos: s.pos, player: s.player, fit };
    if (!best || key(cur) < key(best)) best = cur;
  });
  return best;
}

/**
 * Tous les schémas, du meilleur au moins bon pour l'effectif. Pour chaque schéma, le style qui en tire le meilleur onze
 * (note d'équipe moins le coût du style, comme `rankTactics`).
 */
export function rankFormations(ranked: ReturnType<typeof rankTactics>): FormationRow[] {
  const best = new Map<string, { style: StyleRef; plan: FormationPlan; score: number }>();
  for (const r of ranked)
    for (const plan of r.plans) {
      const score = plan.score - r.complexity;
      const cur = best.get(plan.form);
      if (!cur || score > cur.score) best.set(plan.form, { style: r.style, plan, score });
    }
  return [...best.entries()]
    .map(([form, { style, plan, score }]) => ({ form, style, plan, score, lines: lineFits(plan), weakest: weakestOfPlan(plan), holes: plan.holes }))
    .sort((a, b) => b.score - a.score);
}
