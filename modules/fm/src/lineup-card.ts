import { daysUntil } from './fixtures';
import { gameLineup } from './lineup';
import { parsePositions, type PosCode } from './positions';
import type { FmSnapshot } from './snapshot';
import { spreadXY } from './tactic';

/*
 * Carte « compo d'avant-match » : le onze du jour sur un terrain, avec la photo de chaque joueur, le schéma, le coach
 * et le rapport du jeu sur l'adversaire. Montrée dans FM27 à l'entrée du match (plugin) et envoyée sur Discord au
 * début du direct. Ici seulement les données ; le dessin est fait par l'interface.
 */

export interface LineupCardPlayer {
  id: string | null;
  name: string;
  /** Nom affiché sous la photo : nom de famille, ou initiale + nom si deux titulaires le partagent. */
  short: string;
  number: number | null;
  pos: PosCode | null;
  /** Place sur le terrain en % (x de gauche à droite, y de notre but en bas vers le but adverse en haut). */
  x: number;
  y: number;
}

export interface LineupCard {
  /** Un match = une clé (date de jeu, club, adversaire) : le plugin ne montre qu'une fois chaque carte. */
  key: string;
  club: string;
  opponent: string;
  home: boolean | null;
  competition: string | null;
  gameDate: string;
  /** Schéma « 4-2-3-1 » (sans les mots du jeu). */
  formation: string | null;
  mentality: string | null;
  coach: string | null;
  players: LineupCardPlayer[];
  /** Rapport du jeu sur l'adversaire (`adv*` de chemins.json), quand il est lu. */
  opp: { position: string | null; manager: string | null; formation: string | null; mentality: string | null } | null;
  /** Joueurs adverses à surveiller (trois au plus). */
  watch: string[];
  /** Avis du jeu sur l'adversaire (« Nous sommes meilleurs… »). */
  threat: string | null;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
/** Texte lisible du jeu (pas une référence brute « SI.Bindable… », sans balises). */
const txt = (v: unknown) => (typeof v === 'string' && v.trim() && !/^(SI|FM)\./.test(v.trim()) ? v.replace(/<[^>]*>/g, '').trim() : null);

/** Place de chaque poste sur le terrain (%), notre but en bas. */
const XY: Record<PosCode, [number, number]> = {
  GB: [50, 90],
  DG: [14, 70],
  DC: [50, 74],
  DD: [86, 70],
  DLG: [14, 52],
  MDF: [50, 55],
  DLD: [86, 52],
  MG: [14, 40],
  MC: [50, 43],
  MD: [86, 40],
  MOG: [16, 24],
  MOC: [50, 27],
  MOD: [84, 24],
  BT: [50, 8],
};

/** « 4-2-3-1 MD MO Jeu large » → « 4-2-3-1 ». */
export function formationDigits(text: unknown): string | null {
  const m = typeof text === 'string' ? text.match(/\d(?:-\d){2,4}/) : null;
  return m ? m[0] : null;
}

const lastName = (name: string) => name.trim().split(/\s+/).at(-1) ?? name;

/** Noms courts des titulaires : nom de famille, « M. Nom » quand deux le partagent. */
function shortNames(names: string[]): string[] {
  const count = new Map<string, number>();
  for (const n of names) count.set(lastName(n).toLowerCase(), (count.get(lastName(n).toLowerCase()) ?? 0) + 1);
  return names.map((n) => {
    const last = lastName(n);
    return (count.get(last.toLowerCase()) ?? 0) > 1 && n.trim().includes(' ') ? `${n.trim()[0]}. ${last}` : last;
  });
}

/** Le prochain match de l'instantané se joue-t-il aujourd'hui ? */
export function matchToday(snap: unknown): boolean {
  return daysUntil(obj(obj(snap).nextMatch).inDays) === 0;
}

/**
 * Carte du prochain match à partir des instantanés (le plus récent en dernier) : la compo vient du plus récent qui la
 * donne (réglage « Lire la compo » du plugin), le rapport sur l'adversaire du plus récent qui le donne pour ce même
 * adversaire (le bloc `custom` manque parfois d'un instantané à l'autre). Null sans prochain match ni compo complète.
 */
export function lineupCard(history: readonly unknown[]): LineupCard | null {
  const snaps = history.filter((s): s is Raw => !!s && typeof s === 'object');
  const last = snaps.at(-1);
  if (!last) return null;
  const club = txt(last.club);
  const next = obj(last.nextMatch);
  const opponent = txt(next.opponent);
  const gameDate = txt(last.gameDate);
  if (!club || !opponent || !gameDate) return null;
  const sameMatch = (s: Raw) => txt(s.club) === club && txt(obj(s.nextMatch).opponent) === opponent;
  const withLineup = [...snaps].reverse().find((s) => sameMatch(s) && Array.isArray(s.lineup) && s.lineup.length >= 11);
  if (!withLineup) return null;
  const slots = gameLineup(withLineup as FmSnapshot)?.slice(0, 11);
  if (!slots || slots.length < 11) return null;
  const roster = new Map<string, Raw>();
  for (const p of Array.isArray(withLineup.players) ? withLineup.players : []) {
    const o = obj(p);
    if (o.id != null) roster.set(String(o.id), o);
  }
  const rows = slots.map((s) => {
    const p = s.playerId ? roster.get(s.playerId) : undefined;
    const name = s.playerName ?? txt(p?.name) ?? '';
    const pos = s.pos ?? parsePositions(txt(p?.bestPosition) ?? txt(p?.positionsText))[0] ?? null;
    const n = Number(p?.squadNumber);
    return { id: s.playerId, name, pos, number: Number.isInteger(n) && n > 0 ? n : null };
  });
  if (rows.some((r) => !r.name)) return null;
  // Deux titulaires au même poste (deux D (C)) côte à côte, puis l'écartement règle les autres chevauchements ;
  // postes inconnus rangés au milieu.
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const r of rows) total.set(r.pos ?? '?', (total.get(r.pos ?? '?') ?? 0) + 1);
  const base = rows.map((r): [number, number] => {
    const k = r.pos ?? '?';
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    const [x, y] = r.pos ? XY[r.pos] : [50, 45];
    return [Math.max(10, Math.min(90, x + (i - ((total.get(k) ?? 1) - 1) / 2) * 26)), y];
  });
  // Lignes réparties à intervalles égaux sur la hauteur : cinq lignes de champ (4-1-2-2-1) ne se chevauchent plus.
  // Postes proches en hauteur (latéraux et axiaux, D (G) à 70 et D (C) à 74) forment une même ligne.
  const ys = [...new Set(base.map(([, y]) => y))].sort((a, b) => a - b);
  const lineOf = new Map<number, number>();
  let line = -1;
  ys.forEach((y, i) => {
    if (i === 0 || y - ys[i - 1]! > 6) line++;
    lineOf.set(y, line);
  });
  const even = (y: number) => (line < 1 ? y : 6 + ((92 - 6) * lineOf.get(y)!) / line);
  const pts = spreadXY(
    base.map(([x, y]) => [x, even(y)]),
    18,
    10,
  );
  const shorts = shortNames(rows.map((r) => r.name));
  const players = rows.map((r, i) => ({ ...r, short: shorts[i]!, x: pts[i]![0], y: pts[i]![1] }));

  const withReport = [...snaps].reverse().find((s) => sameMatch(s) && txt(obj(obj(s.custom).equipe).advEntraineur));
  const e = obj(obj(withReport?.custom).equipe);
  const opp =
    withReport != null
      ? { position: txt(e.advClassement), manager: txt(e.advEntraineur), formation: formationDigits(e.advFormationPref), mentality: txt(e.advMentalite) }
      : null;
  const watch = [0, 1, 2, 3, 4].map((i) => txt(e[`advEff${i}Nom`])).filter((x): x is string => !!x).slice(0, 3);
  const coach = [...snaps].reverse().map((s) => txt(obj(obj(s.custom).partie).coachNom)).find(Boolean) ?? null;
  const tactic = obj(withLineup.tactic);
  const location = txt(next.location);
  return {
    key: `${gameDate}|${club}|${opponent}`,
    club,
    opponent,
    home: location ? (/domicile|home/i.test(location) ? true : /ext[ée]rieur|away/i.test(location) ? false : null) : null,
    competition: txt(next.competition),
    gameDate,
    formation: formationDigits(tactic.formation),
    mentality: txt(tactic.mentality),
    coach,
    players,
    opp,
    watch,
    threat: txt(next.threatLevel),
  };
}
