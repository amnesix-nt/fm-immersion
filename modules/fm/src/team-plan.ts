import type { Project, ProjectSlot } from './project';
import { oopFit, type TacticEngine } from './tactic';
import type { FmPlayer } from './player';
import type { Target } from './targets';

/**
 * Plan pour atteindre un niveau d'équipe visé (formule reprise de l'ancienne appli « FM Notebook » du coach).
 *
 * Moyenne du onze = moyenne des notes des titulaires dans leur rôle (sur 20). Toutes les cibles suivies qui font
 * mieux qu'un titulaire sont classées du plus gros gain au plus petit ; on les retient dans cet ordre (un poste et
 * une cible une seule fois) tant que l'argent et la marge salariale restants le permettent : chaque recrue retenue
 * en consomme une part. Chacune ajoute gain / 11 à la moyenne ; le plan s'arrête dès que la barre est passée.
 * Une cible sans prix connu n'est jamais comptée comme abordable : elle est listée à part, à faire chiffrer.
 */
export interface TeamUpgrade {
  slot: ProjectSlot;
  starter: FmPlayer | null;
  starterFit: number;
  player: Target;
  fit: number;
  delta: number;
  /** Prix retenu (valeur du joueur) et s'il est estimé (fourchette des recruteurs) plutôt que connu. */
  price: number | null;
  priceIsEst: boolean;
  /** Salaire (même unité que la masse salariale du club), null s'il est inconnu. */
  wage: number | null;
  /** Connaissance du joueur par tes recruteurs, en % (null si le jeu ne la donne pas). */
  knowledge: number | null;
  /** Moyenne du onze après cette recrue (en cumulant les précédentes du plan). */
  after: number;
}

export interface TeamPlanLimits {
  /** Argent disponible pour toutes les recrues du plan (null = sans limite). */
  budget: number | null;
  /** Marge salariale disponible pour toutes les recrues du plan (null = sans limite). */
  wageRoom: number | null;
}

export interface TeamPlan {
  xiAvg: number;
  /** Maillon faible : la note du poste le plus faible du onze. */
  floor: number;
  target: number;
  reachable: number;
  reached: boolean;
  /** Recrues retenues, du plus gros gain au plus petit, dans les limites d'argent et de salaire (cumulées). */
  upgrades: TeamUpgrade[];
  /** Les recrues qui suffisent à passer la barre (vide si hors de portée). */
  toTarget: TeamUpgrade[];
  /** Cibles qui feraient mieux qu'un titulaire mais dont le prix est inconnu : à faire chiffrer par tes recruteurs. */
  unpriced: Omit<TeamUpgrade, 'after'>[];
  /** Cibles écartées faute d'argent ou de marge salariale (la meilleure par poste). */
  tooDear: Omit<TeamUpgrade, 'after'>[];
  spent: number;
  wages: number;
}

/** Prix d'une cible : valeur connue, sinon milieu de la fourchette des recruteurs (estimé). */
export function targetPrice(t: Target): { price: number | null; isEst: boolean } {
  if (t.value != null && t.value > 0) return { price: t.value, isEst: false };
  const r = t.scout?.value;
  const v = r?.mid ?? r?.min ?? r?.max ?? null;
  return { price: v != null && v > 0 ? v : null, isEst: v != null };
}

const targetWage = (t: Target) => (t.wage != null && t.wage > 0 ? t.wage : (t.scout?.wage?.mid ?? t.scout?.wage?.max ?? null));

export function teamPlan(engine: TacticEngine, project: Project, pool: Target[], target: number, limits: TeamPlanLimits = { budget: null, wageRoom: null }): TeamPlan {
  const slots = project.slots;
  const n = slots.length || 11;
  const fitOf = (p: FmPlayer, sl: ProjectSlot) => {
    const a = engine.roleFit(p, sl.ip, 'ip', sl.pos);
    const b = oopFit(engine, p, sl.oop, sl.pos, sl.posOOP);
    return a == null || b == null ? null : (a + b) / 2;
  };
  const xiAvg = slots.reduce((s, sl) => s + (sl.fit ?? 0), 0) / n;
  const floor = slots.length ? Math.min(...slots.map((sl) => sl.fit ?? 0)) : 0;
  // Toutes les paires poste × cible qui font mieux que le titulaire, du plus gros gain au plus petit.
  const pairs: Omit<TeamUpgrade, 'after'>[] = [];
  for (const sl of slots) {
    const starterFit = sl.fit ?? 0;
    for (const p of pool) {
      if (!p.positions.includes(sl.pos) || !Object.keys(p.attributes).length) continue;
      const fit = fitOf(p, sl);
      if (fit == null || fit <= starterFit) continue;
      const { price, isEst } = targetPrice(p);
      pairs.push({ slot: sl, starter: sl.player, starterFit, player: p, fit, delta: fit - starterFit, price, priceIsEst: isEst, wage: targetWage(p), knowledge: p.scout?.knowledge ?? null });
    }
  }
  pairs.sort((a, b) => b.delta - a.delta);
  // Glouton : chaque poste et chaque cible une seule fois ; l'argent et la marge salariale baissent à chaque recrue.
  let money = limits.budget;
  let room = limits.wageRoom;
  const filled = new Set<ProjectSlot>();
  const used = new Set<string>();
  const upgrades: TeamUpgrade[] = [];
  const unpriced = new Map<ProjectSlot, Omit<TeamUpgrade, 'after'>>();
  const tooDear = new Map<ProjectSlot, Omit<TeamUpgrade, 'after'>>();
  let run = xiAvg;
  let spent = 0;
  let wages = 0;
  for (const u of pairs) {
    if (filled.has(u.slot) || used.has(u.player.id)) continue;
    if (u.price == null) {
      if (!unpriced.has(u.slot)) unpriced.set(u.slot, u);
      continue;
    }
    if ((money != null && u.price > money) || (room != null && u.wage != null && u.wage > room)) {
      if (!tooDear.has(u.slot)) tooDear.set(u.slot, u);
      continue;
    }
    filled.add(u.slot);
    used.add(u.player.id);
    if (money != null) money -= u.price;
    if (room != null && u.wage != null) room -= u.wage;
    spent += u.price;
    wages += u.wage ?? 0;
    run += u.delta / n;
    upgrades.push({ ...u, after: run });
  }
  const reachable = run;
  const reached = reachable >= target - 1e-6;
  const toTarget: TeamUpgrade[] = [];
  if (xiAvg < target && reached) for (const u of upgrades) { toTarget.push(u); if (u.after >= target - 1e-6) break; }
  const open = (m: Map<ProjectSlot, Omit<TeamUpgrade, 'after'>>) => {
    // Un joueur n'apparaît qu'une fois, à son poste le plus utile.
    const seen = new Set<string>();
    return [...m.values()]
      .filter((u) => !filled.has(u.slot) && !used.has(u.player.id))
      .sort((a, b) => b.delta - a.delta)
      .filter((u) => !seen.has(u.player.id) && seen.add(u.player.id));
  };
  return { xiAvg, floor, target, reachable, reached, upgrades, toTarget, unpriced: open(unpriced), tooDear: open(tooDear), spent, wages };
}

/**
 * « Moneyball » : juste prix calibré sur ton marché (tes cibles chiffrées), pas sur une grille fixe.
 * On ajuste log(prix) = a + b × note sur les cibles dont le prix est connu ; une cible qui coûte nettement moins
 * que le prix attendu pour sa note est une bonne affaire (souvent un joueur au profil bien réparti que le marché
 * sous-cote), nettement plus est chère. Seuils repris de FM Notebook : ≤ 0,6 × et ≥ 1,6 ×.
 */
export type PriceVerdict = 'bargain' | 'fair' | 'pricey';
export interface MarketModel {
  fair: (fit: number) => number;
  verdict: (fit: number, price: number | null) => { verdict: PriceVerdict; ratio: number } | null;
  /** Nombre de cibles chiffrées ayant servi au calcul. */
  n: number;
}
export const BARGAIN_RATIO = 0.6;
export const PRICEY_RATIO = 1.6;
const MIN_MARKET = 6;

export function marketModel(points: { fit: number; price: number | null }[]): MarketModel | null {
  const pts = points.filter((p): p is { fit: number; price: number } => p.price != null && p.price > 0);
  if (pts.length < MIN_MARKET) return null;
  const xs = pts.map((p) => p.fit);
  const ys = pts.map((p) => Math.log(p.price));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  // Pente au moins nulle : un meilleur joueur ne doit pas valoir moins (petit échantillon bruité).
  const b = sxx > 0 ? Math.max(0, xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / sxx) : 0;
  const a = my - b * mx;
  const fair = (fit: number) => Math.exp(a + b * fit);
  return {
    n: pts.length,
    fair,
    verdict: (fit, price) => {
      if (price == null || price <= 0) return null;
      const ratio = price / fair(fit);
      return { ratio, verdict: ratio <= BARGAIN_RATIO ? 'bargain' : ratio >= PRICEY_RATIO ? 'pricey' : 'fair' };
    },
  };
}

/** Meilleure note d'une cible sur les postes du onze du projet (null si aucun poste ne lui va). */
export function bestSlotFit(engine: TacticEngine, project: Project, p: FmPlayer): { slot: ProjectSlot; fit: number } | null {
  let best: { slot: ProjectSlot; fit: number } | null = null;
  for (const sl of project.slots) {
    if (!p.positions.includes(sl.pos)) continue;
    const a = engine.roleFit(p, sl.ip, 'ip', sl.pos);
    const b = oopFit(engine, p, sl.oop, sl.pos, sl.posOOP);
    if (a == null || b == null) continue;
    const fit = (a + b) / 2;
    if (!best || fit > best.fit) best = { slot: sl, fit };
  }
  return best;
}

/* ---------- Note actuelle et potentiel atteignable (sur 20) ---------- */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Potentiel atteignable dans le rôle, sur 20 (formule de FM Notebook) : le plafond est tiré du PA quand il est lu en
 * mémoire (note × PA / CA), sinon des étoiles de potentiel du staff ou des recruteurs (8 + 2 × étoiles, 5 étoiles = 18).
 * Plus le joueur est jeune, plus il a de chances d'y arriver : poids (25 − âge) / 11, plafonné à 0,88 ; à 25 ans et
 * plus, le potentiel est la note actuelle. Jamais sous la note actuelle.
 */
export function roleCeiling(fit: number | null, p: Pick<FmPlayer, 'age' | 'ca' | 'pa' | 'stars'> & { scout?: { stars: { potential: number | null } | null } | null }): number | null {
  if (fit == null) return null;
  const w = clamp((25 - (p.age ?? 25)) / 11, 0, 0.88);
  if (!w) return fit;
  const potStars = p.scout?.stars?.potential ?? p.stars?.potential ?? null;
  const cap = p.ca != null && p.pa != null && p.ca > 0 ? Math.min(20, (fit * Math.max(p.pa, p.ca)) / p.ca) : potStars != null ? 8 + 2 * potStars : null;
  if (cap == null) return fit;
  return fit * (1 - w) + Math.max(fit, cap) * w;
}

/** Score « moneyball » de FM Notebook : note + 0,4 × gain − 1,5 × log10(prix en M€ + 1). */
export const valueScore = (fit: number, delta: number, price: number | null) => fit + 0.4 * Math.max(0, delta) - 1.5 * Math.log10((price ?? 0) / 1e6 + 1);
