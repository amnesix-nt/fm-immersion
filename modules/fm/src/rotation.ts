import { ROTATION_CONDITION, TIRED_CONDITION } from './briefing';
import type { FmPlayer } from './player';
import type { MatchResult } from './results';
import { RISK_HIGH, RISK_RAISED, RUSTY_SHARPNESS } from './tactic';

/*
 * Physique et rotation : ce qui, au-delà de la note dans le rôle, dit qu'un titulaire ne devrait pas enchaîner.
 * Trois signaux, tous lus dans le jeu : le risque de blessure qu'il affiche (il monte avec la fatigue et le manque
 * de rythme), la condition du jour, et les matchs enchaînés (titularisations des derniers jours, d'après les
 * instantanés). Enchaîner les matchs, c'est le premier facteur de blessure : on le signale avant que la condition
 * ne le montre. Purement consultatif.
 */

/** Fenêtre des matchs enchaînés, en jours de jeu. */
export const LOAD_WINDOW_DAYS = 10;
/** Titularisations dans la fenêtre à partir desquelles un joueur enchaîne (un match tous les trois jours). */
export const CHAIN_STARTS = 3;

export interface PlayerLoad {
  /** Titularisations dans la fenêtre. */
  starts: number;
  /** Minutes jouées dans la fenêtre. */
  minutes: number;
}

const DAY_MS = 86_400_000;

/**
 * Charge récente de chaque joueur : titularisations et minutes des `LOAD_WINDOW_DAYS` derniers jours, amicaux
 * compris (ils fatiguent autant). Une période de plusieurs matchs entre deux instantanés compte pour ses minutes,
 * et pour une titularisation par tranche de 60 minutes (le détail match par match n'est pas connu).
 */
export function recentLoad(results: MatchResult[], gameDate: string): Map<string, PlayerLoad> {
  const out = new Map<string, PlayerLoad>();
  const now = Date.parse(gameDate);
  if (Number.isNaN(now)) return out;
  for (const r of results) {
    const at = Date.parse(r.played ?? r.date);
    if (Number.isNaN(at) || at > now || now - at > LOAD_WINDOW_DAYS * DAY_MS) continue;
    for (const p of r.players) {
      if (!(p.minutes > 0)) continue;
      const cur = out.get(p.id) ?? { starts: 0, minutes: 0 };
      cur.minutes += p.minutes;
      cur.starts += r.matches === 1 ? Number(p.started) : p.started ? Math.min(r.matches, Math.max(1, Math.round(p.minutes / 60))) : 0;
      out.set(p.id, cur);
    }
  }
  return out;
}

/** risk : risque de blessure élevé · tired : condition basse · chained : matchs enchaînés · riskRaised : risque accru · worn : entamé. */
export type StrainReason = 'risk' | 'tired' | 'chained' | 'riskRaised' | 'worn';

export interface Strain {
  /** rest : à ménager dès ce match · rotate : à faire tourner si la doublure suit. */
  level: 'rest' | 'rotate';
  reason: StrainReason;
  /** D'où vient le risque : fatigue (repos), ou manque de rythme (du temps de jeu par petites doses). */
  cause: 'fatigue' | 'rhythm';
}

/**
 * Signal physique d'un joueur avant le prochain match, du plus sérieux au plus léger ; null si tout va bien.
 * `far` : match lointain, la condition et la fatigue des matchs enchaînés seront remontées, seul un risque élevé reste.
 */
export function strainOf(p: FmPlayer, load: PlayerLoad | undefined, far = false): Strain | null {
  const risk = p.injuryRisk ?? 0;
  const cond = p.condition ?? 100;
  const cause: Strain['cause'] = p.sharpness != null && p.sharpness < RUSTY_SHARPNESS && cond >= ROTATION_CONDITION && (load?.starts ?? 0) < CHAIN_STARTS ? 'rhythm' : 'fatigue';
  if (risk >= RISK_HIGH) return { level: 'rest', reason: 'risk', cause };
  if (far) return null;
  if (cond < TIRED_CONDITION) return { level: 'rest', reason: 'tired', cause: 'fatigue' };
  if ((load?.starts ?? 0) >= CHAIN_STARTS) return { level: 'rotate', reason: 'chained', cause: 'fatigue' };
  if (risk >= RISK_RAISED) return { level: 'rotate', reason: 'riskRaised', cause };
  if (cond < ROTATION_CONDITION) return { level: 'rotate', reason: 'worn', cause: 'fatigue' };
  return null;
}
