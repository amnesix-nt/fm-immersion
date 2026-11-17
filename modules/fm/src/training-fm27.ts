import type { SessionId, TrainingWeek } from './training';

/**
 * Codes des séances dans un programme d'entraînement exporté par FM27 (fichier .fmf du dossier `schedules`),
 * relevés le 17/11/2026 sur FM27 27.1 : un export du jeu, ses modèles et des fichiers chargés en jeu.
 * - compréhension tactique 0 à 7, dans l'ordre du jeu ;
 * - préparation de match 100 à 108 (le jeu les retire d'une semaine sans match) ;
 * - développement 200 à 203 : les variantes « Attaque - … », « Théorie - … », « Technique - … », « Transition - … »
 *   n'ont pas de code dans FM27 (204 et plus s'affichent vides) : elles prennent le travail avec ballon le plus proche ;
 * - physique 300 (repos) à 304, esprit d'équipe 400, programme de proximité 401, match 500.
 */
export const FM27_SESSION_CODE: Record<SessionId, number> = {
  passingStyle: 0,
  buildUpStrategy: 1,
  chanceCreation: 2,
  inPossessionShape: 3,
  lineOfEngagement: 4,
  pressingIntensity: 5,
  pressingTrap: 6,
  outOfPossessionShape: 7,
  pressAvoidance: 100,
  ballProgression: 101,
  finalThird: 102,
  defensiveBlock: 103,
  defensivePositioning: 104,
  defensiveEngagement: 105,
  corners: 106,
  freeKicks: 107,
  setPiecesPenalties: 108,
  individualDevelopment: 200,
  attackingBalanced: 201,
  attackingPatient: 201,
  attackingDirect: 201,
  attackingWings: 201,
  theoryAttacking: 201,
  techChanceCreation: 201,
  techChanceConversion: 201,
  transitionProgress: 201,
  defendingBalanced: 202,
  defendingEngaged: 202,
  defendingDisengaged: 202,
  defendingWide: 202,
  theoryDefensive: 202,
  techGroundDefense: 202,
  techAerialDefense: 202,
  transitionRestrict: 202,
  transitionPress: 202,
  possessionBallWork: 203,
  techBallRetention: 203,
  setPiecesDelivery: 106,
  rest: 300,
  recovery: 301,
  lightConditioning: 302,
  conditioning: 303,
  heavyConditioning: 304,
  teamBonding: 400,
  communityOutreach: 401,
  travel: 300,
  match: 500,
};

export const FM27_REST = 300;

/** Les 7 jours × 3 créneaux d'un programme FM27, dans l'ordre de la semaine de l'appli (séance 1, séance 2, extra). */
export function fm27ScheduleDays(week: Pick<TrainingWeek, 'days'>): number[][] {
  const out: number[][] = [];
  for (let wd = 0; wd < 7; wd++) {
    const d = week.days.find((x) => x.weekday === wd);
    if (!d || d.kind === 'off') {
      out.push([FM27_REST, FM27_REST, FM27_REST]);
      continue;
    }
    // Jour de match : le match au milieu, comme dans les programmes du jeu ; FM27 le place lui-même d'après le calendrier.
    if (d.kind === 'match') {
      out.push([FM27_REST, FM27_SESSION_CODE.match, FM27_REST]);
      continue;
    }
    out.push(d.sessions.map((s) => (s ? FM27_SESSION_CODE[s] : FM27_REST)));
  }
  return out;
}

/** Nom du programme dans la liste du jeu : « FM Immersion - 27/09 » (lundi de la semaine). */
export function fm27ScheduleName(monday: string): string {
  return `FM Immersion - ${monday.slice(8, 10)}/${monday.slice(5, 7)}`;
}
