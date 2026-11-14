import type { FmPlayer } from './player';
import type { WorkPlan } from './project';
import { roleCeiling } from './team-plan';
import type { YouthStatus, YouthTeam } from './youth';

/**
 * Académie : la réserve et les équipes de jeunes du club, vues d'un coup d'œil (bilan par équipe, alertes, meilleurs
 * espoirs). S'appuie sur `youthTeams` (statut et rôle de chaque joueur) ; ajoute ce qui demande une décision du joueur :
 * contrats qui finissent, joueurs trop âgés pour leur catégorie, espoirs prêts pour l'équipe première.
 */

/** Contrat « bientôt fini » : 6 mois ou moins. */
export const ACADEMY_CONTRACT_DAYS = 183;

export type AcademyAlertKind = 'promote' | 'contract' | 'ageOut' | 'release';

export interface AcademyAlert {
  kind: AcademyAlertKind;
  player: FmPlayer;
  team: string;
  /** Contrat : jours restants. Âge : limite de la catégorie. */
  days?: number;
  limit?: number;
}

export interface AcademySummary {
  team: string;
  size: number;
  avgAge: number | null;
  counts: Record<YouthStatus, number>;
  /** Limite d'âge de la catégorie (19 pour « U19 »), null pour la réserve. */
  ageLimit: number | null;
}

export interface AcademyProspect {
  player: FmPlayer;
  team: string;
  fit: number | null;
  /** Niveau atteignable dans le rôle, sur 20 (`roleCeiling`). */
  ceiling: number | null;
  role: WorkPlan['role'];
}

export interface Academy {
  teams: AcademySummary[];
  alerts: AcademyAlert[];
  prospects: AcademyProspect[];
}

/** Limite d'âge écrite dans le nom ou le type de l'équipe (« Slutsk U19 », « Équipe U-21 ») ; null pour la réserve. */
export function ageLimitOf(team: string): number | null {
  const m = /\bU\s?-?(\d{2})\b/i.exec(team);
  return m ? Number(m[1]) : null;
}

const days = (from: string, to: string) => Math.round((new Date(to.slice(0, 10)).getTime() - new Date(from.slice(0, 10)).getTime()) / 86_400_000);

const ALERT_ORDER: Record<AcademyAlertKind, number> = { promote: 0, contract: 1, ageOut: 2, release: 3 };

export function academy(teams: YouthTeam[], gameDate: string): Academy {
  const summaries: AcademySummary[] = [];
  const alerts: AcademyAlert[] = [];
  const prospects: AcademyProspect[] = [];
  for (const t of teams) {
    const ages = t.rows.map((r) => r.plan.player.age).filter((a): a is number => a != null);
    const limit = ageLimitOf(t.team);
    summaries.push({ team: t.team, size: t.rows.length, avgAge: ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : null, counts: t.counts, ageLimit: limit });
    for (const { plan, status } of t.rows) {
      const p = plan.player;
      const pot = p.stars?.potential ?? null;
      if (status === 'promote') alerts.push({ kind: 'promote', player: p, team: t.team });
      const left = p.contractEnd ? days(gameDate, p.contractEnd) : null;
      // Contrat qui finit : à prolonger s'il a du potentiel (ou s'il n'est pas connu) ; sinon le laisser partir est un choix.
      if (left != null && left >= 0 && left <= ACADEMY_CONTRACT_DAYS) {
        if (pot == null || pot >= 3 || status === 'promote') alerts.push({ kind: 'contract', player: p, team: t.team, days: left });
        else alerts.push({ kind: 'release', player: p, team: t.team, days: left });
      } else if (status === 'low') alerts.push({ kind: 'release', player: p, team: t.team });
      // Trop âgé pour sa catégorie : il ne pourra plus y jouer, il faut le monter, le prêter ou le libérer.
      if (limit != null && p.age != null && p.age >= limit) alerts.push({ kind: 'ageOut', player: p, team: t.team, limit });
      prospects.push({ player: p, team: t.team, fit: plan.fit, ceiling: roleCeiling(plan.fit, p), role: plan.role });
    }
  }
  alerts.sort((a, b) => ALERT_ORDER[a.kind] - ALERT_ORDER[b.kind] || (a.days ?? 999) - (b.days ?? 999) || a.player.name.localeCompare(b.player.name));
  prospects.sort((a, b) => (b.ceiling ?? -1) - (a.ceiling ?? -1) || (b.player.stars?.potential ?? 0) - (a.player.stars?.potential ?? 0) || (a.player.age ?? 99) - (b.player.age ?? 99));
  return { teams: summaries, alerts, prospects: prospects.slice(0, 5) };
}
