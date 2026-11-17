import type { FmPlayer } from './player';
import type { PosCode } from './positions';

/*
 * « Indice moteur » : ce que les attributs d'un joueur pèsent vraiment dans le moteur de match de FM27.
 *
 * Source : tests d'Harvestgreen sur FM27, mis en tableau par squirrel_plays et résumés par ZaZ sur FM-Arena
 * (« Player Attributes », https://fm-arena.com/threads/player-attributes.59/, 10/11/2026). Méthode : tous les
 * joueurs de champ d'une équipe passent de 12 partout à une autre valeur dans un seul attribut, et l'on mesure le
 * taux de victoire. Trois paliers testés (1, 6, 12, 18), interpolés en ligne droite entre eux.
 *
 * Limites, à dire au joueur : un seul jeu de tests et une seule tactique ; d'autres testeurs trouvent les passes
 * plus utiles, ou l'endurance encore plus lourde avec un pressing intense. Une tendance, pas une vérité. Les
 * gardiens ne sont pas couverts (réflexes et agilité y font l'essentiel). Les attributs cachés testés (pression,
 * régularité, grands matchs) ne sont pas lus : ils comptent pour 0, comme un 12.
 *
 * Poids du poste : les tests d'Harvestgreen ne distinguent pas les postes. Les mesures de Purity (mêmes tests, mais
 * l'attribut ne change que pour les joueurs d'un poste) donnent, pour les attributs qui comptent, un coefficient par
 * poste (attaquant, milieu offensif ou ailier, latéral ou piston, défenseur central, milieu défensif). On en tire un
 * multiplicateur par attribut et par poste (voir `positionWeights`) : la courbe reste celle d'Harvestgreen, seule sa
 * hauteur change selon le poste.
 *
 * Deuxième source, FM27 Match Lab (caiograco289/Fm-Match-Lab, MIT, étude 13b du 14/11/2026,
 * https://github.com/caiograco289/Fm-Match-Lab/blob/main/docs/studies/13b-value-by-position-random.md) : le moteur du
 * jeu rejoué hors du jeu sur 50 000 matchs, chaque attribut de chaque titulaire changé de ±5 au hasard à chaque match,
 * puis une régression par poste. On en reprend la différence de buts par saison pour +1 point chez un seul joueur du
 * poste (`LAB_GD`), qui compte aussi la finition et la puissance (elles marquent des buts sans créer d'occasions), et
 * les points par saison pour le gardien (`LAB_GK`). Limites : une équipe synthétique, une tactique (Gegenpress),
 * pente moyenne entre 9 et 20 (en dessous, vitesse et accélération coûtent plus).
 *
 * Les gardiens n'ont que cette source : agilité et réflexes y arrêtent des buts sans changer les occasions subies.
 * Les attributs cachés (seule la pression y compte) ne sont pas lus par le plugin : ils ne sont pas pris en compte.
 *
 * Ce n'est pas la note du jeu : les étoiles et la note au poste restent celles de FM27 (role-ratings-fm27.ts).
 */

/** Gain de taux de victoire (en points de %) de 1 à 6, de 6 à 12 et de 12 à 18, par attribut. */
export const ENGINE_GAINS: Record<string, readonly [number, number, number]> = {
  Pace: [13.2, 26.8, 19.4],
  Acceleration: [12.6, 21.4, 14.1],
  Stamina: [11.8, 17.6, 14.0],
  JumpingReach: [5.8, 12.2, 15.4],
  Anticipation: [11.0, 8.8, 4.8],
  Strength: [10.0, 8.8, 4.6],
  Concentration: [7.8, 5.6, 4.4],
  Dribbling: [3.0, 3.8, 3.6],
  NaturalFitness: [8.6, 4.0, 2.8],
  Determination: [6.0, 0.0, 2.8],
  Positioning: [-3.0, -0.4, 2.6],
  Finishing: [3.0, 4.8, 2.2],
  Flair: [-1.0, 1.6, 1.8],
  Bravery: [0.0, 2.4, 1.4],
  Aggression: [1.2, -1.4, 1.2],
  Decisions: [-0.8, 2.4, 1.0],
  Crossing: [0.6, 4.0, 0.6],
  Agility: [5.2, 3.2, 0.2],
  WorkRate: [15.8, 6.2, 0.0],
  Balance: [6.0, 8.2, 0.0],
  LongShots: [5.2, 4.6, 0.0],
  Heading: [5.2, 1.6, 0.0],
  Passing: [-1.0, -1.0, -0.8],
  Composure: [3.0, 2.0, -2.0],
  Marking: [3.6, 0.6, -2.2],
  FirstTouch: [0.8, -1.6, -3.6],
  Tackling: [2.6, -1.6, -5.0],
  Vision: [0.0, 8.2, -5.2],
  Technique: [-0.8, 1.2, -5.4],
  Movement: [-4.0, 2.4, -6.0],
};

/** Familles de poste mesurées par Purity ; `team` = pas de mesure propre (milieux centraux et excentrés). */
export type EngineGroup = 'ST' | 'AM' | 'WB' | 'CB' | 'DM' | 'team' | 'GK';
export const ENGINE_GROUPS = ['ST', 'AM', 'WB', 'CB', 'DM'] as const;

export const ENGINE_GROUP_OF: Record<PosCode, EngineGroup | null> = {
  GB: null, DD: 'WB', DG: 'WB', DLD: 'WB', DLG: 'WB', DC: 'CB', MDF: 'DM',
  MC: 'team', MD: 'team', MG: 'team', MOD: 'AM', MOG: 'AM', MOC: 'AM', BT: 'ST',
};

/**
 * Coefficients de Purity (gain de taux de victoire par point d'attribut) pour toute l'équipe puis par poste, dans
 * l'ordre ST, AM, WB, CB, DM ; `true` = écart significatif dans son test. Seuls les attributs que Purity juge
 * déterminants sont repris : pour les autres, les écarts entre postes sont du bruit.
 */
const PURITY: Record<string, { team: number; by: readonly (readonly [number, boolean])[] }> = {
  Acceleration: { team: 0.34, by: [[0.7, true], [0.3, true], [0.33, true], [0.34, true], [0.23, true]] },
  Pace: { team: 0.34, by: [[0.9, true], [0.39, true], [0.4, true], [0.23, true], [0.11, false]] },
  JumpingReach: { team: 0.22, by: [[0.73, true], [0.05, false], [0.1, true], [0.35, true], [0.09, false]] },
  Stamina: { team: 0.19, by: [[0.34, true], [0.2, true], [0.28, true], [0.14, true], [0.09, false]] },
  Anticipation: { team: 0.15, by: [[0.37, true], [0.15, true], [0.15, true], [0.14, true], [0.02, false]] },
  Strength: { team: 0.14, by: [[0.21, false], [0.26, true], [0.15, true], [0.07, false], [0.08, false]] },
  Finishing: { team: 0.07, by: [[0.27, true], [0.14, true], [0.06, false], [0, false], [0.04, false]] },
};
const WEIGHT_MIN = 0.25;
const WEIGHT_MAX = 2;

/**
 * Multiplicateur de chaque attribut déterminant pour une famille de poste. Rapport « coefficient du poste /
 * coefficient de l'équipe », rapproché à mi-chemin de 1 quand l'écart n'est pas significatif, puis ramené à une
 * moyenne de 1 sur ces attributs (le poste change ce qui compte, pas l'échelle de l'indice), borné entre 0,25 et 2.
 */
function groupWeights(group: EngineGroup): Record<string, number> {
  const keys = Object.keys(PURITY);
  if (group === 'team' || group === 'GK') return Object.fromEntries(keys.map((k) => [k, 1]));
  const i = ENGINE_GROUPS.indexOf(group);
  const raw = keys.map((k) => {
    const { team, by } = PURITY[k]!;
    const [coef, sig] = by[i]!;
    const r = coef / team;
    return sig ? r : 1 + (r - 1) / 2;
  });
  const mean = raw.reduce((s, r) => s + r, 0) / raw.length;
  return Object.fromEntries(keys.map((k, j) => [k, Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, raw[j]! / mean))]));
}
const WEIGHTS = Object.fromEntries([...ENGINE_GROUPS, 'team', 'GK'].map((g) => [g, groupWeights(g as EngineGroup)])) as Record<EngineGroup, Record<string, number>>;

/** Familles de poste d'un joueur, sans doublon (les gardiens n'en ont pas). */
export function engineGroups(positions: readonly PosCode[]): EngineGroup[] {
  return [...new Set(positions.map((p) => ENGINE_GROUP_OF[p]).filter((g): g is EngineGroup => g != null))];
}

/** Multiplicateur par attribut pour ces postes : moyenne des familles s'il en joue plusieurs ; 1 hors attributs déterminants. */
export function positionWeights(positions: readonly PosCode[]): Record<string, number> {
  const groups = engineGroups(positions);
  if (!groups.length) return WEIGHTS.team;
  return Object.fromEntries(Object.keys(PURITY).map((k) => [k, groups.reduce((s, g) => s + WEIGHTS[g][k]!, 0) / groups.length]));
}

/**
 * Match Lab, étude 13b (Gegenpress) : différence de buts par saison pour +1 point chez un joueur du poste, dans l'ordre
 * ST, AM, DM, FB (latéral ou piston), CB. Les autres attributs y sont à moins de ±0,04 point par saison partout.
 */
const LAB_GD: Record<string, readonly [number, number, number, number, number]> = {
  Acceleration: [0.49, 0.24, 0.27, 0.29, 0.41],
  Pace: [0.45, 0.27, 0.26, 0.36, 0.31],
  JumpingReach: [0.34, 0.21, 0.09, 0.11, 0.44],
  Stamina: [0.15, 0.16, 0.2, 0.25, 0.2],
  Balance: [0.21, 0.0, 0.06, 0.09, 0.24],
  Strength: [0.16, 0.14, 0.15, 0.09, 0.17],
  Finishing: [0.21, 0.06, 0.04, 0.0, 0.04],
  Anticipation: [0.13, 0.11, 0.1, 0.14, 0.15],
  Concentration: [0.08, 0.06, 0.08, 0.19, 0.12],
};
const LAB_COL: Record<Exclude<EngineGroup, 'GK'>, number | null> = { ST: 0, AM: 1, DM: 2, WB: 3, CB: 4, team: null };

/** Match Lab, étude 13b : points par saison pour +1 point du gardien (les effets nets, t ≥ 2,5). */
export const LAB_GK: Record<string, number> = { Agility: 0.58, Reflexes: 0.5, AerialReach: 0.16, Acceleration: 0.16, Determination: 0.12 };

/**
 * Passage des points par saison (Match Lab) aux points de taux de victoire de l'indice : la vitesse de 12 à 18 pour
 * dix joueurs de champ vaut 19,4 points de % chez Harvestgreen et 0,16 × 10 × 6 ≈ 9,6 points par saison chez
 * Match Lab, soit environ 2 points de % par point de saison.
 */
const LAB_TO_INDEX = 2;

/** Écart de note méta au-delà duquel les deux sources ne disent pas la même chose. */
export const ENGINE_AGREE_GAP = 1.5;

/** Coefficient Match Lab d'un attribut pour ces familles de poste (moyenne ; équipe = moyenne des cinq postes). */
function labCoef(attr: string, groups: readonly EngineGroup[]): number {
  const row = LAB_GD[attr]!;
  const cols = groups.length ? groups.map((g) => (g === 'GK' ? null : LAB_COL[g])) : [null];
  const one = (c: number | null) => (c == null ? row.reduce((s, x) => s + x, 0) / row.length : row[c]!);
  return cols.reduce<number>((s, c) => s + one(c), 0) / cols.length;
}

/**
 * Note méta selon Match Lab : la moyenne des attributs lus, pondérée par ce que chacun rapporte au poste (le modèle
 * est linéaire, donc un joueur à X partout vaut X). Null si moins de 7 des 9 attributs sont lus.
 */
export function labMeta(attributes: Record<string, number>, groups: readonly EngineGroup[]): number | null {
  let num = 0;
  let den = 0;
  let read = 0;
  for (const attr of Object.keys(LAB_GD)) {
    const v = attributes[attr];
    if (v == null || !Number.isFinite(v)) continue;
    const c = labCoef(attr, groups);
    num += c * Math.max(1, Math.min(20, v));
    den += c;
    read++;
  }
  return read >= 7 && den > 0 ? Math.round((num / den) * 10) / 10 : null;
}

/** Attributs à ne pas laisser sous 6 : ils coûtent cher en dessous et rapportent peu au-dessus de 12. */
export const ENGINE_MINIMUMS = ['WorkRate', 'Anticipation', 'Strength', 'Balance', 'Concentration', 'NaturalFitness'] as const;
export const ENGINE_MIN_VALUE = 6;

/**
 * Effet d'un attribut à cette valeur, comparé à 12 (en points de taux de victoire, pour un onze entier à cette
 * valeur). Au-delà de 18, la pente du dernier palier continue.
 */
export function attributeEffect(attr: string, value: number): number | null {
  const g = ENGINE_GAINS[attr];
  if (!g || !Number.isFinite(value)) return null;
  const [a, b, c] = g;
  const v = Math.max(1, Math.min(20, value));
  if (v >= 12) return (c * (v - 12)) / 6;
  if (v >= 6) return (-b * (12 - v)) / 6;
  return -b - (a * (6 - v)) / 5;
}

export interface EngineFactor {
  attr: string;
  value: number;
  /** Effet comparé à 12, en points de taux de victoire. */
  effect: number;
}

export interface EngineValue {
  /** Familles de poste prises en compte pour les poids (vide ou `team` seul : poids de toute l'équipe). */
  groups: EngineGroup[];
  /**
   * Note méta sur 20 : la valeur X telle qu'un joueur à X partout, au même poste, pèse autant dans le moteur
   * (12 partout = 12). Lisible comme une note du jeu, mais sur ce que le moteur récompense.
   */
  meta: number;
  /** Somme des effets : un onze entier de ce profil gagnerait environ autant de points de % qu'un onze à 12 partout. */
  index: number;
  /** Atouts les plus nets (effet ≥ 4), du plus fort au moins fort. */
  strengths: EngineFactor[];
  /** Points faibles les plus coûteux (effet ≤ −4), du plus coûteux au moins coûteux. */
  weaknesses: EngineFactor[];
  /** Attributs minimums sous 6. */
  belowMin: EngineFactor[];
  /** Nombre d'attributs testés lus pour ce joueur. */
  read: number;
  /** Gardien : note et indice tirés de Match Lab seul (agilité, réflexes, jeu aérien, accélération, détermination). */
  keeper: boolean;
  /** Note méta selon la deuxième source (Match Lab) ; pour un gardien, la même que `meta`. Null si non lue. */
  lab: number | null;
  /** Joueur de champ : les deux sources donnent-elles la même note (moins de ENGINE_AGREE_GAP d'écart) ? */
  agree: boolean | null;
}

/** Attributs testés en dessous desquels l'indice ne veut rien dire (attributs non lus). */
const MIN_READ = 20;
const NOTABLE = 4;

/** Indice moteur d'un gardien, d'après Match Lab : linéaire, donc la note méta est la moyenne pondérée des attributs. */
function keeperValue(attributes: Record<string, number>): EngineValue | null {
  const factors: EngineFactor[] = [];
  let num = 0;
  let den = 0;
  for (const [attr, c] of Object.entries(LAB_GK)) {
    const value = attributes[attr];
    if (value == null || !Number.isFinite(value)) continue;
    const v = Math.max(1, Math.min(20, value));
    factors.push({ attr, value, effect: c * LAB_TO_INDEX * (v - 12) });
    num += c * v;
    den += c;
  }
  // Agilité et réflexes font l'essentiel : sans eux, pas de note.
  if (attributes.Agility == null || attributes.Reflexes == null || factors.length < 4) return null;
  const meta = Math.round((num / den) * 10) / 10;
  const round = (f: EngineFactor) => ({ ...f, effect: Math.round(f.effect * 10) / 10 });
  return {
    groups: ['GK'],
    meta,
    index: Math.round(factors.reduce((s, f) => s + f.effect, 0)),
    strengths: factors.filter((f) => f.effect >= NOTABLE).sort((a, b) => b.effect - a.effect).slice(0, 3).map(round),
    weaknesses: factors.filter((f) => f.effect <= -NOTABLE).sort((a, b) => a.effect - b.effect).slice(0, 3).map(round),
    belowMin: [],
    read: factors.length,
    keeper: true,
    lab: meta,
    agree: null,
  };
}

/**
 * Indice moteur d'un joueur, pondéré selon ses postes (ou `at`, le poste visé, par exemple pour une recrue). Un
 * gardien (tous ses postes, ou `at`, en GB) est noté par Match Lab seul. Null si ses attributs ne sont pas lus.
 */
export function engineValue(p: Pick<FmPlayer, 'attributes' | 'positions'>, at?: PosCode): EngineValue | null {
  if (at === 'GB' || (!at && p.positions.length > 0 && p.positions.every((pos) => pos === 'GB'))) return keeperValue(p.attributes);
  const positions = at ? [at] : p.positions;
  const weights = positionWeights(positions);
  const factors: EngineFactor[] = [];
  for (const attr of Object.keys(ENGINE_GAINS)) {
    const value = p.attributes[attr];
    if (value == null) continue;
    const effect = attributeEffect(attr, value);
    if (effect != null) factors.push({ attr, value, effect: effect * (weights[attr] ?? 1) });
  }
  if (factors.length < MIN_READ) return null;
  const index = factors.reduce((s, f) => s + f.effect, 0);
  // Joueur « à X partout » sur les mêmes attributs lus et au même poste : X croît avec l'indice, on le cherche par dichotomie.
  const uniform = (x: number) => factors.reduce((s, f) => s + (attributeEffect(f.attr, x) ?? 0) * (weights[f.attr] ?? 1), 0);
  let lo = 1;
  let hi = 20;
  if (index <= uniform(lo)) hi = lo;
  else if (index >= uniform(hi)) lo = hi;
  else
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (uniform(mid) < index) lo = mid;
      else hi = mid;
    }
  const meta = Math.round(((lo + hi) / 2) * 10) / 10;
  const round = (f: EngineFactor) => ({ ...f, effect: Math.round(f.effect * 10) / 10 });
  const lab = labMeta(p.attributes, engineGroups(positions));
  return {
    keeper: false,
    lab,
    agree: lab == null ? null : Math.abs(lab - meta) < ENGINE_AGREE_GAP,
    groups: engineGroups(positions),
    meta,
    index: Math.round(index),
    strengths: factors.filter((f) => f.effect >= NOTABLE).sort((a, b) => b.effect - a.effect).slice(0, 3).map(round),
    weaknesses: factors.filter((f) => f.effect <= -NOTABLE).sort((a, b) => a.effect - b.effect).slice(0, 3).map(round),
    belowMin: factors.filter((f) => (ENGINE_MINIMUMS as readonly string[]).includes(f.attr) && f.value < ENGINE_MIN_VALUE).map(round),
    read: factors.length,
  };
}

/** Attributs cachés lus dans la mémoire du jeu, dans l'ordre d'affichage. */
export const HIDDEN_ATTRS = ['Consistency', 'ImportantMatches', 'InjuryProneness', 'Versatility', 'Dirtiness'] as const;

export type HiddenNote = 'cards' | 'fragile' | 'bigGames';

/**
 * Ce que les attributs cachés changent vraiment, d'après Match Lab (étude 11, 12 800 matchs) : aucun ne change les
 * résultats d'un match de façon mesurable (régularité, grands matchs, fragilité et polyvalence comptent pour 0 dans
 * l'indice). La saleté donne des cartons (20 : un carton de plus par match). Signalés : saleté 15 ou plus, fragilité
 * 15 ou plus (blessures sur une saison, hors du match), grands matchs 15 ou plus (léger mieux, non établi).
 */
export function hiddenNotes(hidden: Record<string, number> | null | undefined): HiddenNote[] {
  if (!hidden) return [];
  const out: HiddenNote[] = [];
  if ((hidden.Dirtiness ?? 0) >= 15) out.push('cards');
  if ((hidden.InjuryProneness ?? 0) >= 15) out.push('fragile');
  if ((hidden.ImportantMatches ?? 0) >= 15) out.push('bigGames');
  return out;
}

export type EngineTier = 'top' | 'good' | 'average' | 'poor';

/** Repères pour la pastille : un joueur à 12 partout vaut 0. */
export function engineTier(index: number): EngineTier {
  return index >= 25 ? 'top' : index >= 8 ? 'good' : index > -10 ? 'average' : 'poor';
}

/**
 * Classement « poste et méta » : moyenne de l'adaptation à la tactique (note dans les rôles du créneau, sur 20) et de
 * la note méta au poste (ce que ses attributs valent dans le moteur, sur 20). Une seule des deux connue : elle seule.
 */
export function fitMetaScore(fit: number | null | undefined, meta: number | null | undefined): number | null {
  if (fit != null && meta != null) return (fit + meta) / 2;
  return fit ?? meta ?? null;
}
