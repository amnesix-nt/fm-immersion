import { monthsBetween } from './alerts';
import { projectCompat, type ProjectCompat } from './compat';
import { isUnwanted } from './club';
import type { FmPlayer } from './player';
import { POS_ORDER, type PosCode } from './positions';
import { projectLevel, type SquadAt } from './progress';
import { bestTactic, buildProject, type CoachPrefs } from './project';
import type { Slot, TacticEngine } from './tactic';

/**
 * Mercato de l'effectif actuel : qui faire partir (vente, prêt, fin de contrat) et quels jeunes valent le coup.
 *
 * Chaque joueur est situé dans deux onze : celui à jouer aujourd'hui (meilleure tactique applicable) et celui
 * du projet du coach (style visé, possession par défaut). À chaque poste, on garde les titulaires et une doublure
 * par créneau (deux au but) ; au-delà, le joueur est en trop. Le verdict croise cette place avec l'âge, le contrat,
 * les étoiles de potentiel vues par le staff (relatives au club) et la progression projetée.
 * Rien n'est lu en plus dans le jeu : tout vient de l'instantané déjà importé.
 */

export type MercatoVerdict = 'sell' | 'release' | 'loan' | 'extend' | 'develop' | 'replace' | 'backup' | 'core';
/** Ordre d'affichage : d'abord ce qui demande une action au mercato. */
export const MERCATO_ORDER: MercatoVerdict[] = ['sell', 'release', 'loan', 'extend', 'develop', 'replace', 'backup', 'core'];

/** Place d'un joueur dans un onze : 0 = titulaire, 1 = doublure, 2 = en trop. */
export type Tier = 0 | 1 | 2;
export interface Place {
  tier: Tier;
  pos: PosCode | null;
  /** Rang au poste (1 = meilleur), titulaires compris. */
  rank: number | null;
  /** Titulaires à ce poste dans le schéma. */
  need: number;
  fit: number | null;
}

export type MercatoReason =
  | { id: 'starterNow' | 'starterProject' | 'backupAt'; pos: PosCode }
  | { id: 'surplus'; pos: PosCode; rank: number; need: number }
  | { id: 'noPosition' }
  | { id: 'misfit'; pos: PosCode }
  | { id: 'contract'; months: number }
  | { id: 'unwanted'; status: string }
  | { id: 'potential'; stars: number }
  | { id: 'potentialPa'; pa: number; ca: number }
  | { id: 'lowPotential' }
  | { id: 'overtakes'; years: number; starter: string }
  | { id: 'decline'; age: number }
  | { id: 'youthTeam' }
  /** Profil qui ne colle pas au projet de jeu : ne pas y investir de temps. */
  | { id: 'offProject' }
  /** Prêté chez nous : il compte cette saison, mais ni vente, ni prolongation, ni prêt ailleurs. */
  | { id: 'loanIn' }
  /** Ne performe pas : note moyenne de la saison nettement sous celle des joueurs qui jouent. */
  | { id: 'underperforms'; rating: number; team: number; apps: number };

export interface MercatoAdvice {
  player: FmPlayer;
  verdict: MercatoVerdict;
  reasons: MercatoReason[];
  now: Place;
  project: Place;
  months: number | null;
  /** Niveau projeté dans 1, 2 et 3 saisons. */
  proj: [number | null, number | null, number | null];
  young: boolean;
  /** Jeune qui vaut le coup : potentiel du staff ou projection au niveau d'un titulaire. */
  prospect: boolean;
  /** Saisons avant d'atteindre le niveau du titulaire le plus faible à son poste (0 = déjà), null = pas en vue. */
  overtakes: number | null;
  /** Compatibilité de son profil avec le projet de jeu (null sans projet). */
  compat: ProjectCompat | null;
}

/**
 * Joueur signalé partant par le coach (il refuse de prolonger, on le laisse libre, il est vendu, il veut partir).
 * Gardé dans la partie (saves.extra) ; le mercato le retire de l'effectif à planifier et cherche son remplaçant.
 */
/** `loanIn` : prêté chez nous, il rentre dans son club à la fin du prêt (signalé à la main ou lu par le plugin). */
export type LeavingReason = 'refused' | 'released' | 'sold' | 'wantsOut' | 'loanIn';
export const LEAVING_REASONS: LeavingReason[] = ['refused', 'released', 'sold', 'wantsOut', 'loanIn'];
export interface LeavingMark {
  reason: LeavingReason;
  /** Date de jeu (ISO) du signalement. */
  since: string;
  /** Nom au moment du signalement, pour l'afficher même s'il a déjà quitté l'effectif. */
  name: string;
}
export type LeavingMarks = Record<string, LeavingMark>;

export interface MercatoReport {
  advice: MercatoAdvice[];
  /** Joueurs de l'effectif signalés partants : hors conseils, leur poste est à pourvoir. */
  leaving: FmPlayer[];
  byVerdict: Record<MercatoVerdict, MercatoAdvice[]>;
  /** Jeunes (21 ans ou moins), du plus prometteur au moins prometteur. */
  youth: MercatoAdvice[];
  /** Valeur cumulée des joueurs à vendre. */
  income: number;
  /** Salaires libérés par les départs conseillés (vente, fin de contrat, prêt), par semaine ou par mois selon le jeu. */
  wagesFreed: number;
  nowForm: string | null;
  projectForm: string | null;
  projectStyle: string | null;
}

export const YOUNG_MAX = 21;
/** Étoiles de potentiel à partir desquelles un jeune vaut le coup (le staff note par rapport au club). */
/** Repère fixe de potentiel quand aucun titulaire noté ne permet de comparer (les étoiles sont relatives à l'effectif). */
export const PROSPECT_STARS = 3;

/**
 * Joueur qui ne performe pas : assez de matchs joués cette saison (UNDER_APPS) pour juger, et une note moyenne à la
 * fois basse (sous UNDER_RATING) et nettement sous la moyenne des joueurs qui jouent (UNDER_GAP). Repères de
 * FM Immersion : sous 6,7 un joueur de champ déçoit dans FM, et 0,2 point d'écart sur une saison est net.
 */
export const UNDER_APPS = 6;
export const UNDER_RATING = 6.7;
export const UNDER_GAP = 0.2;

/** Note moyenne des joueurs qui jouent (au moins UNDER_APPS matchs), null s'il y en a moins de cinq. */
export function teamRating(list: readonly FmPlayer[]): number | null {
  const xs = list.flatMap((p) => ((p.apps ?? 0) >= UNDER_APPS && p.avgRating ? [p.avgRating] : []));
  return xs.length >= 5 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Raison « ne performe pas », ou null. */
export function underperforms(p: FmPlayer, team: number | null): Extract<MercatoReason, { id: 'underperforms' }> | null {
  const apps = p.apps ?? 0;
  const r = p.avgRating;
  if (team == null || !r || apps < UNDER_APPS || r >= UNDER_RATING || r > team - UNDER_GAP) return null;
  return { id: 'underperforms', rating: r, team: Math.round(team * 100) / 100, apps };
}

const NO_PLACE: Place = { tier: 2, pos: null, rank: null, need: 0, fit: null };

/** Adéquation moyenne avec et sans ballon d'un joueur au créneau. */
function slotFit(engine: TacticEngine, p: FmPlayer, sl: Slot): number | null {
  const a = engine.roleFit(p, sl.ip, 'ip', sl.pos);
  const b = engine.roleFit(p, sl.oop, 'oop', sl.pos);
  return a == null || b == null ? null : (a + b) / 2;
}

/**
 * Place de chaque joueur dans un onze : les titulaires du plan, puis une doublure par créneau (deux au but),
 * attribuées de la meilleure adéquation à la moins bonne, un joueur ne doublant qu'un seul poste.
 */
export function squadPlaces(engine: TacticEngine, slots: Slot[], list: FmPlayer[]): Map<string, Place> {
  const need = new Map<PosCode, number>();
  for (const sl of slots) need.set(sl.pos, (need.get(sl.pos) ?? 0) + 1);
  // Meilleure adéquation de chaque joueur à chaque poste du schéma.
  const fits = new Map<PosCode, { p: FmPlayer; fit: number }[]>();
  for (const pos of need.keys()) {
    const at = slots.filter((s) => s.pos === pos);
    const xs: { p: FmPlayer; fit: number }[] = [];
    for (const p of list) {
      if (!engine.canPlay(p, pos)) continue;
      const f = Math.max(...at.map((sl) => slotFit(engine, p, sl) ?? -1));
      if (f >= 0) xs.push({ p, fit: f });
    }
    fits.set(pos, xs.sort((a, b) => b.fit - a.fit));
  }
  const rankAt = (pos: PosCode, id: string) => {
    const i = fits.get(pos)?.findIndex((x) => x.p.id === id) ?? -1;
    return i < 0 ? null : i + 1;
  };
  const out = new Map<string, Place>();
  for (const sl of slots) {
    if (!sl.player || out.has(sl.player.id)) continue;
    out.set(sl.player.id, { tier: 0, pos: sl.pos, rank: rankAt(sl.pos, sl.player.id), need: need.get(sl.pos)!, fit: sl.fit });
  }
  const left = new Map([...need].map(([pos, n]) => [pos, pos === 'GB' ? 2 : n]));
  const pairs = [...fits].flatMap(([pos, xs]) => xs.map((x) => ({ pos, ...x }))).sort((a, b) => b.fit - a.fit);
  for (const { pos, p, fit } of pairs) {
    if (out.has(p.id) || !left.get(pos)) continue;
    left.set(pos, left.get(pos)! - 1);
    out.set(p.id, { tier: 1, pos, rank: rankAt(pos, p.id), need: need.get(pos)!, fit });
  }
  // En trop : son meilleur poste du schéma, là où il est le mieux classé.
  for (const p of list) {
    if (out.has(p.id)) continue;
    let best: Place | null = null;
    for (const [pos, xs] of fits) {
      const i = xs.findIndex((x) => x.p.id === p.id);
      if (i < 0) continue;
      const n = need.get(pos)!;
      if (!best || i + 1 - n < best.rank! - best.need) best = { tier: 2, pos, rank: i + 1, need: n, fit: xs[i]!.fit };
    }
    out.set(p.id, best ?? NO_PLACE);
  }
  return out;
}

/** Niveau du titulaire le plus faible à un poste du onze (niveau moyen des attributs, sur 20). */
function weakestStarter(slots: Slot[], pos: PosCode | null): FmPlayer | null {
  const xs = slots.filter((s) => s.pos === pos && s.player?.level != null).map((s) => s.player!);
  return xs.sort((a, b) => a.level! - b.level!)[0] ?? null;
}

export function mercatoAdvice(
  engine: TacticEngine,
  players: FmPlayer[],
  gameDate: string,
  coach: CoachPrefs = {},
  history: SquadAt[] = [],
  leavingIds: ReadonlySet<string> = new Set(),
  loanIds: ReadonlySet<string> = new Set(),
): MercatoReport | null {
  // Les partants signalés ne comptent plus : l'effectif se planifie sans eux (titulaires, doublures, contrats).
  // Les prêtés chez nous (`loanIds`) comptent, eux : ils jouent la saison ; seul leur avenir au club n'est pas à décider.
  const leaving = players.filter((p) => leavingIds.has(p.id));
  const list = players.filter((p) => Object.keys(p.attributes).length && !leavingIds.has(p.id));
  if (!list.length) return null;
  // Le mercato prépare l'effectif dans la durée : les blessés et suspendus comptent.
  const pick = bestTactic(engine, list, coach);
  const project = buildProject(engine, list, coach);
  const nowSlots = pick?.plan.slots ?? [];
  const projSlots = project?.slots ?? [];
  const nowPlaces = squadPlaces(engine, nowSlots, list);
  const projPlaces = squadPlaces(engine, projSlots, list);

  const team = teamRating(list);
  const advice = list.map((p): MercatoAdvice => {
    const now = nowPlaces.get(p.id) ?? NO_PLACE;
    const proj = projPlaces.get(p.id) ?? NO_PLACE;
    const tier = Math.min(now.tier, proj.tier) as Tier;
    const months = p.contractEnd ? monthsBetween(gameDate, p.contractEnd) : null;
    const age = p.age ?? 25;
    const young = age <= YOUNG_MAX;
    const levels: MercatoAdvice['proj'] = [projectLevel(p, 1, history), projectLevel(p, 2, history), projectLevel(p, 3, history)];
    const pot = p.stars?.potential ?? null;
    // Saisons avant d'égaler le plus faible titulaire de son poste, dans le onze du projet puis celui du jour.
    const home = proj.pos ?? now.pos ?? p.positions[0] ?? null;
    const starter = weakestStarter(projSlots, home) ?? weakestStarter(nowSlots, home);
    let overtakes: number | null = null;
    if (starter && starter.id !== p.id && p.level != null && starter.level != null) {
      if (p.level >= starter.level) overtakes = 0;
      else {
        const y = levels.findIndex((l) => l != null && l >= starter.level!);
        overtakes = y < 0 ? null : y + 1;
      }
    }
    const compat = project ? projectCompat(engine, project, p) : null;
    const off = compat?.compat === 'no';
    // Un jeune dont le profil ne colle pas au projet ne vaut pas le temps qu'on y mettrait, même avec du potentiel.
    // Les étoiles sont relatives à l'effectif (une grosse recrue les fait baisser pour tous) : un potentiel ne vaut que
    // comparé aux titulaires du même effectif, à la même date. Il compte s'il atteint le plus faible titulaire de son
    // poste ; sans titulaire noté pour comparer, on garde le repère fixe PROSPECT_STARS.
    // Avec le CA/PA réels (échelle fixe), on compare directement son PA au CA du titulaire.
    const realPa = p.pa != null && starter && starter.id !== p.id && starter.ca != null ? { pa: p.pa, ca: starter.ca } : null;
    const bar = starter && starter.id !== p.id && starter.stars?.current != null ? starter.stars.current : PROSPECT_STARS;
    const highPot = realPa ? realPa.pa >= realPa.ca : pot != null && pot >= bar;
    const prospect = young && !off && (highPot || (overtakes != null && overtakes <= 3) || tier === 0);
    const reasons: MercatoReason[] = [];
    if (now.tier === 0 && now.pos) reasons.push({ id: 'starterNow', pos: now.pos });
    if (proj.tier === 0 && proj.pos) reasons.push({ id: 'starterProject', pos: proj.pos });
    if (tier === 1) {
      const pl = proj.tier === 1 ? proj : now;
      if (pl.pos) reasons.push({ id: 'backupAt', pos: pl.pos });
    }
    if (tier === 2) {
      const pl = proj.pos ? proj : now;
      reasons.push(pl.pos && pl.rank ? { id: 'surplus', pos: pl.pos, rank: pl.rank, need: pl.need } : { id: 'noPosition' });
    }
    if (young && realPa) reasons.push(highPot ? { id: 'potentialPa', pa: realPa.pa, ca: realPa.ca } : { id: 'lowPotential' });
    else if (young && pot != null) reasons.push(highPot ? { id: 'potential', stars: pot } : { id: 'lowPotential' });
    if (young && overtakes != null && overtakes > 0 && starter) reasons.push({ id: 'overtakes', years: overtakes, starter: starter.name });
    if (months != null && months <= 12) reasons.push({ id: 'contract', months });
    if (isUnwanted(p.squadStatus)) reasons.push({ id: 'unwanted', status: p.squadStatus! });
    if (off) reasons.push({ id: 'offProject' });
    const under = underperforms(p, team);
    if (under) reasons.push(under);

    let verdict: MercatoVerdict;
    if (young) {
      if (prospect) {
        if (months != null && months <= 12) verdict = 'extend';
        else if (tier <= 1) verdict = 'develop';
        else if (age <= 18) {
          verdict = 'develop';
          reasons.push({ id: 'youthTeam' });
        } else verdict = 'loan';
      } else if (tier <= 1) verdict = 'backup';
      else verdict = (p.value ?? 1) > 0 ? 'sell' : 'release';
    } else if (tier === 0) {
      // Titulaire aujourd'hui mais hors du onze du projet, et plus en âge de s'y adapter : à remplacer à terme.
      // Profil hors projet : il joue tant qu'il est le meilleur, mais on ne prolonge pas et on prépare sa succession.
      if (off || (proj.tier > 0 && project && age >= 27)) {
        verdict = 'replace';
        if (now.pos && !off) reasons.push({ id: 'misfit', pos: now.pos });
      } else verdict = months != null && months <= 12 && age <= 30 ? 'extend' : 'core';
    } else if (tier === 1) {
      if (age >= 31 && months != null && months <= 6) {
        verdict = 'release';
        reasons.push({ id: 'decline', age });
      } else verdict = 'backup';
    } else {
      // Même à six mois de la fin, une vente au prochain mercato rapporte plus qu'un départ libre.
      verdict = (p.value ?? 1) > 0 ? 'sell' : 'release';
      if (age >= 30) reasons.push({ id: 'decline', age });
    }
    // Ne performe pas sur la saison : le mettre en vente, même titulaire (on cherche son remplaçant), sauf un jeune
    // prometteur qui apprend encore. Sans valeur marchande, il part libre en fin de contrat.
    if (under && !prospect && verdict !== 'release') verdict = (p.value ?? 1) > 0 ? 'sell' : months != null && months <= 12 ? 'release' : verdict;
    // Statut « indésirable » donné en jeu : il part, sauf s'il est titulaire (le statut est alors à revoir).
    if (isUnwanted(p.squadStatus) && tier > 0 && verdict !== 'release') verdict = 'sell';
    // Prêté chez nous : titulaire ou doublure pour la saison, rien à vendre, prolonger ni prêter ; son contrat n'est pas le nôtre.
    if (loanIds.has(p.id)) {
      verdict = tier === 0 ? 'core' : 'backup';
      return { player: p, verdict, reasons: [...reasons.filter((r) => r.id !== 'contract'), { id: 'loanIn' }], now, project: proj, months: null, proj: levels, young, prospect: false, overtakes, compat };
    }
    return { player: p, verdict, reasons, now, project: proj, months, proj: levels, young, prospect, overtakes, compat };
  });

  const order = (a: MercatoAdvice, b: MercatoAdvice) =>
    POS_ORDER.indexOf(a.player.positions[0] ?? 'BT') - POS_ORDER.indexOf(b.player.positions[0] ?? 'BT') || (b.player.level ?? 0) - (a.player.level ?? 0);
  const byVerdict = Object.fromEntries(MERCATO_ORDER.map((v) => [v, advice.filter((a) => a.verdict === v).sort(order)])) as Record<MercatoVerdict, MercatoAdvice[]>;
  const youth = advice
    .filter((a) => a.young)
    .sort((a, b) => Number(b.prospect) - Number(a.prospect) || (b.player.stars?.potential ?? -1) - (a.player.stars?.potential ?? -1) || (a.overtakes ?? 9) - (b.overtakes ?? 9) || (b.player.level ?? 0) - (a.player.level ?? 0));
  const goingOut = advice.filter((a) => a.verdict === 'sell' || a.verdict === 'release' || a.verdict === 'loan');
  return {
    advice,
    leaving,
    byVerdict,
    youth,
    income: byVerdict.sell.reduce((s, a) => s + (a.player.value ?? 0), 0),
    wagesFreed: [...goingOut.map((a) => a.player), ...leaving].reduce((s, p) => s + (p.wage ?? 0), 0),
    nowForm: pick?.form ?? null,
    projectForm: project?.form ?? null,
    projectStyle: project?.style.id ?? null,
  };
}


/* ---------- Contrats à décider ---------- */

/**
 * Décision pour un contrat qui se termine bientôt :
 * - `extend` : prolonger (durée conseillée en années) ;
 * - `extendShort` : prolonger d'un an seulement (titulaire âgé, ou titulaire hors projet le temps de trouver mieux) ;
 * - `sellNow` : vendre avant la fin du contrat plutôt que le perdre libre ;
 * - `letGo` : ne pas prolonger, il part libre.
 */
export type ContractCall = 'extend' | 'extendShort' | 'sellNow' | 'letGo';
export const CONTRACT_CALLS: ContractCall[] = ['extend', 'extendShort', 'sellNow', 'letGo'];
/** Fin de contrat (en mois) à partir de laquelle FM27 demande une décision. */
export const CONTRACT_DECIDE_MONTHS = 6;

export interface ContractDecision {
  advice: MercatoAdvice;
  call: ContractCall;
  /** Durée conseillée de la prolongation, en années (null si pas de prolongation). */
  years: number | null;
}

export function contractCall(a: MercatoAdvice): Pick<ContractDecision, 'call' | 'years'> {
  const age = a.player.age ?? 25;
  const tier = Math.min(a.now.tier, a.project.tier);
  const leave: ContractCall = (a.player.value ?? 1) > 0 ? 'sellNow' : 'letGo';
  const long = age <= 26 ? 3 : age <= 30 ? 2 : 1;
  // Profil hors projet : on ne s'engage pas sur la durée. Titulaire du jour : un an, le temps de trouver mieux.
  if (a.compat?.compat === 'no') return a.now.tier === 0 ? { call: 'extendShort', years: 1 } : { call: leave, years: null };
  if (isUnwanted(a.player.squadStatus) && tier > 0) return { call: leave, years: null };
  // Ne performe pas : on ne prolonge pas, on vend avant de le perdre libre.
  if (!a.prospect && a.reasons.some((r) => r.id === 'underperforms')) return { call: leave, years: null };
  if (a.prospect) return { call: 'extend', years: Math.max(3, long) };
  if (tier === 0) return age >= 31 ? { call: 'extendShort', years: 1 } : { call: 'extend', years: long };
  if (tier === 1) return age >= 31 ? { call: 'letGo', years: null } : age >= 29 ? { call: 'extendShort', years: 1 } : { call: 'extend', years: long };
  return { call: leave, years: null };
}

/** Contrats qui finissent dans `within` mois ou moins (ou déjà échus), avec la décision conseillée pour chacun. */
export function contractDecisions(r: MercatoReport, within = CONTRACT_DECIDE_MONTHS): ContractDecision[] {
  return r.advice
    .filter((a) => a.months != null && a.months <= within)
    .map((advice) => ({ advice, ...contractCall(advice) }))
    .sort((a, b) => CONTRACT_CALLS.indexOf(a.call) - CONTRACT_CALLS.indexOf(b.call) || (b.advice.player.level ?? 0) - (a.advice.player.level ?? 0));
}
