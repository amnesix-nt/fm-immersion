import { lineOf, parsePositions, POS_LABEL, type Line, type PosCode } from './positions';
import type { FmPlayerRaw } from './snapshot';

/** Nombre à partir d'une valeur du jeu : 12, « 85 % », « 1,2 M€ », « 450 K € ». */
export function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/\s/g, '').replace(',', '.').match(/(-?\d+(?:\.\d+)?)([KkMm](?![a-z]))?/);
  if (!m) return null;
  let n = parseFloat(m[1]!);
  if (/m/i.test(m[2] ?? '')) n *= 1e6;
  else if (/k/i.test(m[2] ?? '')) n *= 1e3;
  return n;
}

/** Attribut exact, ou milieu de la fourchette quand le recrutement ne l'a pas encore affiné. */
function attrValue(a: number | { min?: unknown; max?: unknown }): number | null {
  if (typeof a === 'number') return a;
  const lo = toNumber(a.min);
  const hi = toNumber(a.max);
  if (lo == null && hi == null) return null;
  return ((lo ?? hi)! + (hi ?? lo)!) / 2;
}

const GK_ONLY = new Set(['AerialReach', 'CommandOfArea', 'Communication', 'Eccentricity', 'Handling', 'Kicking', 'OneOnOnes', 'Reflexes', 'RushingOut', 'TendencyToPunch', 'Throwing']);
const GK_SKIP = new Set(['Corners', 'Crossing', 'Dribbling', 'Finishing', 'Heading', 'LongShots', 'LongThrows', 'Marking', 'Tackling', 'Technique']);

export interface FmPlayer {
  id: string;
  name: string;
  age: number | null;
  positions: PosCode[];
  positionsLabel: string;
  line: Line | null;
  /** Moyenne des attributs utiles au poste (gardien ou joueur de champ), sur 20. */
  level: number | null;
  condition: number | null;
  sharpness: number | null;
  contractEnd: string | null;
  wage: number | null;
  value: number | null;
  squadStatus: string | null;
  apps: number | null;
  goals: number | null;
  avgRating: number | null;
  injury: string | null;
  injuryDays: number | null;
  /**
   * Jours avant le prochain match (date du jeu de l'instantané), posé par `forNextMatch` : un blessé rétabli d'ici là
   * compte pour le match.
   */
  matchInDays?: number | null;
  /**
   * Suspension en cours lue par chemins.json (`custom.joueurs[].suspensions`, `custom.equipe.suspensionsEnCours`) :
   * texte du jeu (« Championnat national, 1 match, 3 cartons jaunes ») ou « Suspendu » si le détail manque.
   */
  suspension: string | null;
  /** Moral tel qu'écrit par le jeu (« Très bon »…), s'il est connu. */
  morale: string | null;
  personality: string | null;
  /** Place dans la hiérarchie du vestiaire (« Leader de l'équipe », « Joueur influent »…), plugin 0.3.1. */
  hierarchy: string | null;
  /** Équipe du club quand ce n'est pas l'équipe première (réserve, U19…). */
  team: string | null;
  /** Pied fort tel qu'écrit par le jeu (« Gauche », « Droit uniquement », « Les deux »…). */
  foot: string | null;
  /** Étoiles de niveau et de potentiel vues par le staff (plugin 0.3.1), sur 5. */
  stars: { current: number | null; potential: number | null; /** Niveau actuel sans arrondi à la demi-étoile (le jeu compte en quarts). */ fine?: number | null } | null;
  /**
   * Correction des notes de rôle par l'avis du staff (points sur 20, voir `withStaffOpinion`) ; absente pour un joueur
   * d'un autre club, noté sur ses seuls attributs.
   */
  staffAdj?: number;
  /**
   * Risque de blessure global donné par le jeu (`tracking.injuryRisk`) : 100 = normal, 180 = accru, 300 = élevé,
   * au-delà très élevé. Il monte avec la fatigue et le manque de rythme. null si le plugin ne le donne pas.
   */
  injuryRisk?: number | null;
  /** Valeurs sur 20 des rôles lues dans le jeu, par poste et phase (libellé FR normalisé → valeur). */
  gameStars: Partial<Record<PosCode, { ip?: Record<string, number>; oop?: Record<string, number> }>> | null;
  /** Familiarité au poste lue dans le jeu (1-20), si le plugin la donne (`positionRatings`). */
  familiarity: Partial<Record<PosCode, number>> | null;
  /** Attributs connus (milieu de fourchette si le recrutement ne les a pas affinés), sans le préfixe « Attribute ». */
  attributes: Record<string, number>;
  /**
   * CA et PA réels (0-200) lus dans la mémoire du jeu, si le joueur l'a activé. Échelle fixe : à préférer aux
   * étoiles (relatives à l'effectif) pour la progression et le potentiel. PA négatif = fourchette du jeu (inconnu).
   */
  ca: number | null;
  pa: number | null;
}

export function normalizePlayer(p: FmPlayerRaw): FmPlayer {
  const familiarity = familiarityOf(p.positionRatings);
  // Poste principal en tête : celui que le jeu donne comme meilleur, puis la familiarité lue, puis l'ordre du terrain.
  // (Le texte du jeu « D/AL/M/MO (G) » suit l'ordre du terrain, pas la préférence : son premier poste n'est pas le meilleur.)
  const best = typeof p.bestPosition === 'string' ? parsePositions(p.bestPosition) : [];
  const positions = parsePositions(p.positionsText ?? p.positions)
    .map((c, i) => ({ c, i, k: best.includes(c) ? 1 : 0, f: familiarity?.[c] ?? 0 }))
    .sort((a, b) => b.k - a.k || b.f - a.f || a.i - b.i)
    .map((x) => x.c);
  const isGK = positions[0] === 'GB';
  const skip = isGK ? GK_SKIP : GK_ONLY;
  const attributes: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.attributes ?? {})) {
    const n = attrValue(v);
    if (n != null) attributes[k.replace(/^Attribute/, '')] = n;
  }
  const values = Object.entries(attributes)
    .filter(([k]) => !skip.has(k))
    .map(([, v]) => v);
  const level = p.level ?? (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);
  const injury = typeof p.injury === 'string' ? p.injury : (p.injury?.description ?? null);
  const injuryDays = p.injuryReturnDays ?? (typeof p.injury === 'object' ? p.injury?.returnDays : null) ?? null;
  const condition = toNumber(p.condition);
  return {
    id: String(p.id),
    // Le jeu entoure parfois les noms de balises de mise en forme.
    name: p.name.replace(/<[^>]*>/g, '').trim(),
    age: p.age ?? null,
    positions,
    positionsLabel: positions.map((c) => POS_LABEL[c]).join(', '),
    line: positions[0] ? lineOf(positions[0]) : null,
    level,
    condition: condition != null && condition >= 0 ? condition : null,
    sharpness: toNumber(p.sharpness),
    contractEnd: p.contractEnd ?? null,
    wage: toNumber(p.wage ?? p.wageText),
    value: toNumber(p.value ?? p.valueText),
    squadStatus: p.squadStatus ?? null,
    apps: p.apps ?? null,
    goals: p.goals ?? null,
    avgRating: p.avgRating ?? null,
    injury: injury || null,
    injuryDays,
    suspension: typeof p.suspension === 'string' && p.suspension ? p.suspension : null,
    foot: p.foot ?? null,
    morale: p.morale ?? null,
    personality: typeof p.personality === 'string' ? p.personality : null,
    hierarchy: typeof p.hierarchy === 'string' ? p.hierarchy : null,
    team: typeof p.team === 'string' ? p.team : null,
    stars: p.stars && typeof p.stars === 'object' ? (p.stars as FmPlayer['stars']) : null,
    attributes,
    familiarity,
    injuryRisk: injuryRiskOf(p),
    gameStars: p.gameStars && typeof p.gameStars === 'object' ? (p.gameStars as FmPlayer['gameStars']) : null,
    ca: typeof p.ca === 'number' && p.ca > 0 ? p.ca : null,
    pa: typeof p.pa === 'number' && p.pa > 0 ? p.pa : null,
  };
}

/** Joint aux joueurs bruts le CA/PA lu dans la mémoire du jeu (`snap.abilities`), s'il y en a. */
export function withAbilities<S extends { players: { id: string | number }[]; abilities?: Record<string, { ca: number; pa: number }> | null }>(snap: S): S {
  const ab = snap.abilities;
  if (!ab || !Object.keys(ab).length) return snap;
  return { ...snap, players: snap.players.map((p) => (ab[String(p.id)] ? { ...p, ...ab[String(p.id)] } : p)) };
}

/** Risque de blessure du jeu : valeurs sous 100 ou absentes = inconnu. */
function injuryRiskOf(p: unknown): number | null {
  const t = (p as { tracking?: { injuryRisk?: unknown } }).tracking;
  const n = toNumber(t?.injuryRisk as never);
  return n != null && n >= 100 ? n : null;
}

function familiarityOf(raw: unknown): Partial<Record<PosCode, number>> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Partial<Record<PosCode, number>> = {};
  for (const [label, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = toNumber(v);
    if (n == null) continue;
    for (const c of parsePositions(label)) out[c] = Math.max(out[c] ?? 0, n);
  }
  return Object.keys(out).length ? out : null;
}

/** Blessé aujourd'hui mais rétabli le jour du prochain match (durée de la blessure ≤ jours avant le match). */
export function backForMatch(p: Pick<FmPlayer, 'injury' | 'injuryDays' | 'matchInDays'>): boolean {
  return !!p.injury && p.injuryDays != null && p.matchInDays != null && p.injuryDays <= p.matchInDays;
}

/** Joueur indisponible pour le prochain match : suspendu, ou blessé encore absent le jour du match. */
export function unavailable(p: FmPlayer): boolean {
  return (!!p.injury && !backForMatch(p)) || !!p.suspension;
}

/** Pose sur chaque joueur le nombre de jours avant le prochain match (null : pas de match connu). */
export function forNextMatch(players: FmPlayer[], days: number | null): FmPlayer[] {
  return players.map((p) => ({ ...p, matchInDays: days }));
}

/** Part de l'écart d'étoiles reportée sur les notes de rôle (1 = tout l'écart : une étoile = 2 points sur 20). */
export const STAFF_WEIGHT = 0.75;
/** Correction maximale, en points sur 20. */
export const STAFF_MAX = 2.5;

/**
 * L'avis du staff dans les notes de l'effectif. Les notes de rôle viennent des attributs clés du rôle ; le jeu, lui,
 * rapporte aussi ses étoiles de rôle au niveau général du joueur (capacité actuelle). Sans cela, un défenseur à
 * 3,5 étoiles aux bons attributs clés passait devant des titulaires à 4 et 4,5 étoiles. Chaque joueur du club reçoit
 * donc une correction selon ses étoiles de niveau actuel, comparées à la moyenne de l'équipe première : au-dessus,
 * ses notes montent ; en dessous, elles baissent. L'échelle reste celle des attributs (correction moyenne nulle), et
 * les joueurs des autres clubs, sans étoiles de ton staff, restent notés sur leurs seuls attributs.
 */
export function withStaffOpinion(players: FmPlayer[]): FmPlayer[] {
  const of = (p: FmPlayer) => p.stars?.fine ?? p.stars?.current ?? null;
  const ref = players.filter((p) => !p.team).map(of).filter((v): v is number => v != null);
  // Trop peu d'avis pour une moyenne fiable : on ne corrige rien.
  if (ref.length < 8) return players;
  const mean = ref.reduce((a, b) => a + b, 0) / ref.length;
  return players.map((p) => {
    const v = of(p);
    if (v == null) return p;
    const adj = Math.max(-STAFF_MAX, Math.min(STAFF_MAX, STAFF_WEIGHT * 2 * (v - mean)));
    return { ...p, staffAdj: Math.round(adj * 100) / 100 };
  });
}
