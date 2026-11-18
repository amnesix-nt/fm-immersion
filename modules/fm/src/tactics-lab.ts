/*
 * Labo de tactiques : préparation des matchs pour FM Tactics Lab (moteur de match de FM27, voir
 * `src-tauri/src/tactics_lab.rs`) et lecture des résultats.
 *
 * Protocole repris des tests faits pour le joueur les 17 et 18/11/2026 : les deux équipes ont le même effectif
 * neutre (tous les attributs à 15, familiarité 20 au poste), seules les tactiques diffèrent ; chaque rencontre se
 * joue aller et retour avec les mêmes seeds. Ce qui sort compare donc les tactiques entre elles, pas un effectif.
 */

/** Équipe telle que l'outil la décrit (`scenario.teams[i]`) : on ne touche qu'aux clés nommées ici. */
export type LabTeam = Record<string, unknown> & {
  players: { attributes: number[]; native_profile?: Record<string, unknown> }[];
  lineup: number[];
  phases: { position: string }[][];
  opposition?: { players: unknown[]; positions: Record<string, unknown> };
};
export type LabScenario = Record<string, unknown> & { teams: LabTeam[] };

/** Clés d'équipe qui portent la tactique (le reste, effectif compris, vient du scénario de base). */
export const TACTIC_KEYS = ['tactic_name', 'mentality', 'instructions', 'native_extra_team_bits', 'phases', 'native_source_plan'] as const;
export type LabTactic = Partial<Record<(typeof TACTIC_KEYS)[number], unknown>>;

/** Valeur des attributs de l'effectif neutre (75 en interne = 15 à l'écran) et familiarité au poste. */
export const NEUTRAL_ATTR = 75;
export const FAMILIAR = 20;
/** Place de la familiarité de chaque poste dans `attributes` (0-14). */
export const POS_IDX: Record<string, number> = {
  GK: 0, SW: 1, DL: 2, DC: 3, DCR: 3, DCL: 3, DR: 4, DM: 5, DMC: 5, DMR: 5, DML: 5, ML: 6, MC: 7, MCL: 7, MCR: 7, MR: 8,
  AML: 9, AMC: 10, AMCL: 10, AMCR: 10, AMR: 11, ST: 12, STR: 12, STL: 12, WBL: 13, WBR: 14,
};
const PROFILE = {
  height_cm: 182, weight_kg: 77, age: 26, professionalism: 15, loyalty: 15, sportsmanship: 15, temperament: 15, pressure: 15,
  ambition: 15, adaptability: 15, traits_low: 0, traits_high: 0,
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Tactique d'une équipe importée (`/api/import-fmf`), sans son effectif. */
export function tacticOf(team: Record<string, unknown>): LabTactic {
  const out: LabTactic = {};
  for (const k of TACTIC_KEYS) if (k in team) out[k] = clone(team[k]);
  return out;
}

/** Effectif neutre : mêmes joueurs moyens des deux côtés, familiers de leur poste dans les deux phases. */
export function neutralize(team: LabTeam): void {
  const neutral = { press: 0, mark: 0, tackle: 0, foot: 0, personal: true };
  if (team.opposition) {
    team.opposition = {
      players: team.opposition.players.map(() => ({ ...neutral })),
      positions: Object.fromEntries(Object.keys(team.opposition.positions).map((p) => [p, { ...neutral }])),
    };
  }
  for (const p of team.players) {
    for (let i = 0; i < 15; i++) p.attributes[i] = 1;
    for (let i = 15; i < 69; i++) p.attributes[i] = NEUTRAL_ATTR;
    p.native_profile = { ...(p.native_profile ?? {}), ...PROFILE };
  }
  for (const phase of team.phases) {
    phase.forEach((cell, slot) => {
      const player = team.players[team.lineup[slot]!];
      const idx = POS_IDX[cell.position];
      if (player && idx != null) player.attributes[idx] = FAMILIAR;
    });
  }
}

/** Scénario d'une rencontre : `home` reçoit `away`, effectifs neutres. */
export function matchScenario(base: LabScenario, home: Record<string, LabTactic>, away: Record<string, LabTactic>): LabScenario {
  const sc = clone(base);
  // Mêmes coups de pied arrêtés des deux côtés (ceux du scénario de base).
  if (sc.teams[0] && sc.teams[1]) sc.teams[1].setpieces = clone(sc.teams[0].setpieces);
  ([home['0'], away['1']] as (LabTactic | undefined)[]).forEach((tactic, side) => {
    const team = sc.teams[side]!;
    delete team.native_source_plan;
    Object.assign(team, clone(tactic ?? {}));
    team.name = side === 0 ? 'Home' : 'Away';
    neutralize(team);
  });
  return sc;
}

/** Un match joué par l'outil (`job.runs[]`), réduit. */
export interface LabRun {
  result?: { score?: [number, number] };
  statistics?: { teams?: { xg?: number; shots?: number; possession?: number }[] };
}

/** Bilan d'une rencontre (une tactique à domicile contre une autre), cumulé sur tous ses matchs. */
export interface PairTotals {
  home: string;
  away: string;
  n: number;
  /** Points de l'équipe à domicile, et leur carré (pour l'intervalle). */
  pts: number;
  pts2: number;
  awayPts: number;
  awayPts2: number;
  goalsHome: number;
  goalsAway: number;
  xgHome: number;
  xgAway: number;
}

const points = (a: number, b: number) => (a > b ? 3 : a === b ? 1 : 0);

export function pairTotals(home: string, away: string, runs: LabRun[]): PairTotals {
  const t: PairTotals = { home, away, n: 0, pts: 0, pts2: 0, awayPts: 0, awayPts2: 0, goalsHome: 0, goalsAway: 0, xgHome: 0, xgAway: 0 };
  for (const r of runs) {
    const s = r.result?.score;
    if (!s) continue;
    const [h, a] = s;
    const ph = points(h, a);
    const pa = points(a, h);
    t.n++;
    t.pts += ph;
    t.pts2 += ph * ph;
    t.awayPts += pa;
    t.awayPts2 += pa * pa;
    t.goalsHome += h;
    t.goalsAway += a;
    t.xgHome += r.statistics?.teams?.[0]?.xg ?? 0;
    t.xgAway += r.statistics?.teams?.[1]?.xg ?? 0;
  }
  return t;
}

/** Note sur 20 : 10 = 1,35 point par match (moyenne d'un plateau de tactiques correctes), +1 par 0,05. */
export const ratingOf = (ppm: number) => Math.max(0, Math.min(20, 10 + (ppm - 1.35) / 0.05));

export interface LabRow {
  name: string;
  n: number;
  /** Points par match, et demi-largeur de l'intervalle à 95 %. */
  ppm: number;
  ci: number;
  rating: number;
  homePpm: number | null;
  awayPpm: number | null;
  goalsFor: number;
  goalsAgainst: number;
  xgFor: number;
  xgAgainst: number;
  /** Points par match contre chaque adversaire (domicile et extérieur confondus). */
  vs: Record<string, number>;
}

/** Classement à partir des rencontres jouées (chaque tactique compte ses matchs à domicile et à l'extérieur). */
export function ranking(pairs: PairTotals[]): LabRow[] {
  type Acc = { n: number; p: number; p2: number; hn: number; hp: number; an: number; ap: number; gf: number; ga: number; xf: number; xa: number; vs: Record<string, { n: number; p: number }> };
  const acc = new Map<string, Acc>();
  const get = (k: string) => {
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { n: 0, p: 0, p2: 0, hn: 0, hp: 0, an: 0, ap: 0, gf: 0, ga: 0, xf: 0, xa: 0, vs: {} }));
    return a;
  };
  const vs = (a: Acc, opp: string, n: number, p: number) => {
    const v = (a.vs[opp] ??= { n: 0, p: 0 });
    v.n += n;
    v.p += p;
  };
  for (const t of pairs) {
    if (!t.n) continue;
    const h = get(t.home);
    h.n += t.n; h.p += t.pts; h.p2 += t.pts2; h.hn += t.n; h.hp += t.pts;
    h.gf += t.goalsHome; h.ga += t.goalsAway; h.xf += t.xgHome; h.xa += t.xgAway;
    vs(h, t.away, t.n, t.pts);
    const a = get(t.away);
    a.n += t.n; a.p += t.awayPts; a.p2 += t.awayPts2; a.an += t.n; a.ap += t.awayPts;
    a.gf += t.goalsAway; a.ga += t.goalsHome; a.xf += t.xgAway; a.xa += t.xgHome;
    vs(a, t.home, t.n, t.awayPts);
  }
  const rows: LabRow[] = [...acc].map(([name, a]) => {
    const ppm = a.p / a.n;
    const sd = Math.sqrt(Math.max(0, a.p2 / a.n - ppm * ppm));
    return {
      name,
      n: a.n,
      ppm,
      ci: (1.96 * sd) / Math.sqrt(a.n),
      rating: ratingOf(ppm),
      homePpm: a.hn ? a.hp / a.hn : null,
      awayPpm: a.an ? a.ap / a.an : null,
      goalsFor: a.gf / a.n,
      goalsAgainst: a.ga / a.n,
      xgFor: a.xf / a.n,
      xgAgainst: a.xa / a.n,
      vs: Object.fromEntries(Object.entries(a.vs).map(([k, v]) => [k, v.p / v.n])),
    };
  });
  return rows.sort((x, y) => y.ppm - x.ppm || x.name.localeCompare(y.name));
}

/** Rencontres d'un tournoi : chaque tactique reçoit chacune des autres (aller et retour). */
export function fixtures(names: string[]): [string, string][] {
  return names.flatMap((h) => names.filter((a) => a !== h).map((a) => [h, a] as [string, string]));
}
