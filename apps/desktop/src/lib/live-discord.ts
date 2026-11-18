import { type FmLive, fmLiveSchema, gameLastMatch, isFriendly, lineupCard, isOwnGoal, isPenalty, liveAssists, liveCardList, type LiveCardNews, type LiveDisallowedNews, type LiveGoalNews, liveIsFresh, liveKey, liveNews, parseScorers } from '@fm-immersion/module-fm';
import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { aiLiveComment, type LiveMoment } from './ai';
import { rememberClubLooks } from './club-look';
import { useCareer } from './career';
import { useFmFolder } from './fm-sync';
import { editDiscord, getLiveEnabled, getWebhook, isWebhook, postDiscord, sendDiscordImage } from './discord';
import { getLineupDiscord, lineupPayload, lineupPng } from './lineup-card-live';

const LIVE_RED = 0xd93c3c;
const GOOD = 0x2e9e5b;
const ORANGE = 0xffb547;

const score = (l: FmLive) => `${l.homeScore ?? 0} - ${l.awayScore ?? 0}`;

/** Minute de jeu (« 62 min. » → 62, « 90+3' » → 93), ou null (« FDM », vide). */
export function minuteOf(text: string | null | undefined): number | null {
  const m = /(\d+)(?:\s*\+\s*(\d+))?/.exec(text ?? '');
  return m ? Number(m[1]) + Number(m[2] ?? 0) : null;
}

/** Barre de progression du match sur 90 minutes : « ▰▰▰▰▰▰▱▱▱▱ ». */
export function progressBar(minute: number | null, slots = 10) {
  const n = minute == null ? 0 : Math.max(0, Math.min(slots, Math.round((minute / 90) * slots)));
  return '▰'.repeat(n) + '▱'.repeat(slots - n);
}

/** Un but du déroulé : minute, équipe, buteur. */
export interface TimelineGoal {
  minute: number;
  side: 'home' | 'away';
  name: string;
  time: string;
  /** But contre son camp : `name` est le joueur fautif, `side` l'équipe qui en profite. */
  own: boolean;
}

/**
 * Buts dans l'ordre du match. Le jeu liste les buteurs de l'équipe à domicile d'abord, autant que de buts marqués ;
 * null si le texte ne correspond pas au score (le jeu ne l'a pas encore mis à jour).
 */
export function timeline(l: FmLive): TimelineGoal[] | null {
  const goals = parseScorers(l.scorers);
  const h = l.homeScore ?? 0;
  if (goals.length !== h + (l.awayScore ?? 0)) return null;
  return goals
    .map((g, i) => ({ minute: minuteOf(g.time) ?? 0, side: i < h ? ('home' as const) : ('away' as const), name: g.name, time: g.time, own: isOwnGoal(g.time) }))
    .sort((a, b) => a.minute - b.minute);
}

/** Club du joueur dans ce match : 'home', 'away' ou null s'il n'y joue pas. */
const mySide = (l: FmLive, club: string | null) => (club === l.home ? 'home' : club === l.away ? 'away' : null);

/** Nombre de variantes de chaque phrase de commentateur dans les fichiers de langue. */
const VARIANTS = 3;

/** Petit hachage stable : la même phrase reste affichée tant que rien ne se passe. */
function pick(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.abs(h) % VARIANTS;
}

/** Situation après un but, vue par l'équipe qui marque : ouverture du score, égalisation, prise d'avance, break, réduction de l'écart. */
export function goalSituation(forGoals: number, against: number) {
  if (forGoals === 1 && against === 0) return 'opener';
  if (forGoals === against) return 'equalise';
  if (forGoals === against + 1) return 'lead';
  if (forGoals > against) return 'extend';
  return 'reduce';
}

/** Moment du match, pour le commentaire quand aucun but ne vient de tomber. */
export function matchPhase(minute: number | null) {
  if (minute == null || minute < 3) return 'kickoff';
  if (minute < 25) return 'early';
  if (minute < 44) return 'mid';
  if (minute <= 46) return 'half';
  if (minute < 75) return 'second';
  if (minute < 90) return 'late';
  return 'stoppage';
}

/* ---------- Contexte d'avant-match ---------- */

/**
 * Ce que le commentateur sait avant le coup d'envoi, lu une fois par match dans l'instantané du plugin : compétition,
 * classement du club, avis du jeu sur l'adversaire, buts de la saison de nos joueurs. Le relevé du direct (plugin)
 * ne donne que le score, la minute et les buteurs : pas de possession ni de tirs.
 */
export interface LiveContext {
  competition: string | null;
  friendly: boolean;
  /** Place du club au classement avant le match. */
  position: number | null;
  /** Phrase du jeu sur l'adversaire (« Il ne sera pas évident de battre … »). */
  threat: string | null;
  /** Buts de la saison avant le match, par nom de famille (en minuscules). */
  goals: Record<string, number>;
  topScorer: { name: string; goals: number } | null;
  /** Rapport sur l'adversaire (`adv*` de chemins.json), quand le plugin le lit. */
  opponent: { position: string | null; manager: string | null; formation: string | null; scorer: string | null; scorerGoals: number | null } | null;
  /** Compo lue par le plugin (réglage LireCompo), dans l'ordre des postes, ou null. */
  lineup: string[] | null;
  /** Nos joueurs : identifiant FM par nom (pour retrouver la photo d'un buteur noté « M. Fábry »). */
  people: { id: string; name: string }[];
}

/** Identifiant du joueur désigné par le texte du jeu (« M. Fábry », « Fábry ») : même nom de famille, même initiale. */
export function personIdFor(ctx: LiveContext | null, text: string): string | null {
  if (!ctx) return null;
  const parts = text.trim().split(/\s+/);
  const last = (parts.at(-1) ?? '').toLowerCase();
  const initial = parts.length > 1 ? parts[0]![0]!.toLowerCase() : null;
  const hits = ctx.people.filter((p) => lastName(p.name) === last && (!initial || p.name[0]!.toLowerCase() === initial));
  return hits.length === 1 ? hits[0]!.id : null;
}

const lastName = (name: string) => (name.trim().split(/\s+/).at(-1) ?? '').toLowerCase();

export function liveContext(snap: unknown): LiveContext {
  const s = (snap ?? {}) as { nextMatch?: Record<string, unknown> | null; players?: unknown[]; custom?: { equipe?: Record<string, unknown> }; lineup?: unknown };
  const next = s.nextMatch ?? null;
  const e = s.custom?.equipe ?? {};
  const txt = (v: unknown) => (typeof v === 'string' && v.trim() && !/^(SI|FM)\./.test(v) ? v.replace(/<[^>]*>/g, '').trim() : null);
  const advGoals = Number(e.advButs);
  const opponent =
    txt(e.advClassement) || txt(e.advEntraineur) || txt(e.advButeur)
      ? { position: txt(e.advClassement), manager: txt(e.advEntraineur), formation: txt(e.advFormationPref), scorer: txt(e.advButeur), scorerGoals: Number.isFinite(advGoals) && advGoals > 0 ? Math.round(advGoals) : null }
      : null;
  const lineup = Array.isArray(s.lineup) ? (s.lineup as { playerName?: unknown }[]).map((x) => txt(x.playerName)).filter((x): x is string => !!x) : [];
  const competition = typeof next?.competition === 'string' && next.competition.trim() ? next.competition.trim() : null;
  const pos = Number(s.custom?.equipe?.classementPosition);
  const goals: Record<string, number> = {};
  const people: LiveContext['people'] = [];
  let top: LiveContext['topScorer'] = null;
  for (const raw of Array.isArray(s.players) ? s.players : []) {
    const p = raw as { id?: unknown; name?: unknown; goals?: unknown };
    if (typeof p.name === 'string' && p.id != null && p.id !== '') people.push({ id: String(p.id), name: p.name });
    const g = Number(p.goals);
    if (typeof p.name !== 'string' || !Number.isFinite(g)) continue;
    goals[lastName(p.name)] = g;
    if (g > 0 && (!top || g > top.goals)) top = { name: p.name, goals: g };
  }
  return {
    competition,
    friendly: isFriendly(competition),
    position: Number.isInteger(pos) && pos > 0 ? pos : null,
    threat: typeof next?.threatLevel === 'string' && next.threatLevel.trim() ? next.threatLevel.trim() : null,
    goals,
    topScorer: top,
    opponent,
    lineup: lineup.length >= 11 ? lineup.slice(0, 11) : null,
    people,
  };
}

/**
 * Avant-match, dans l'encart tant qu'aucun but n'est tombé : compétition, classement des deux équipes, hommes en forme,
 * l'entraîneur adverse et son schéma, l'avis du jeu, et la compo si le plugin la lit.
 */
export function prematchLines(t: TFunction, l: FmLive, club: string | null, ctx: LiveContext | null): { lines: string[]; lineup: string | null } {
  const side = mySide(l, club);
  const opponentName = side === 'home' ? l.away : side === 'away' ? l.home : null;
  const lines: string[] = [];
  if (ctx?.competition) lines.push(`🏆 ${ctx.competition}`);
  if (ctx && !ctx.friendly && club && (ctx.position || ctx.opponent?.position)) {
    const ours = ctx.position ? t('live.prematch.ourPosition', { club, position: ctx.position }) : '';
    const theirs = ctx.opponent?.position && opponentName ? t('live.prematch.theirPosition', { club: opponentName, position: ctx.opponent.position }) : '';
    lines.push(`📊 ${[ours, theirs].filter(Boolean).join(' · ')}`);
  }
  const form: string[] = [];
  if (ctx?.topScorer && !ctx.friendly) form.push(t('live.prematch.top', { name: ctx.topScorer.name, count: ctx.topScorer.goals }));
  if (ctx?.opponent?.scorer && opponentName) {
    form.push(ctx.opponent.scorerGoals ? t('live.prematch.theirTop', { club: opponentName, name: ctx.opponent.scorer, count: ctx.opponent.scorerGoals }) : t('live.prematch.theirTopNoGoals', { club: opponentName, name: ctx.opponent.scorer }));
  }
  if (form.length) lines.push(`🔥 ${form.join(' · ')}`);
  if (ctx?.opponent?.manager && opponentName) {
    lines.push(`🧠 ${t(ctx.opponent.formation ? 'live.prematch.managerFormation' : 'live.prematch.manager', { club: opponentName, manager: ctx.opponent.manager, formation: ctx.opponent.formation })}`);
  }
  if (ctx?.threat) lines.push(`💬 ${ctx.threat}`);
  return { lines, lineup: ctx?.lineup ? ctx.lineup.join(' · ') : null };
}

/** Relevé du direct complété par l'appli (compétition, contexte et, après le match, ses chiffres lus dans l'instantané). */
type LiveIn = FmLive & { competition?: unknown; context?: LiveContext | null; stats?: MatchStats | null };
const contextOf = (l: FmLive) => (l as LiveIn).context ?? null;
const statsOf = (l: FmLive) => (l as LiveIn).stats ?? null;

/** Chiffres du dernier match joué (domicile, extérieur), lus dans l'instantané une fois le match fini. */
export interface MatchStats {
  possession: [number, number] | null;
  shots: [number, number] | null;
  onTarget: [number, number] | null;
  xg: [number, number] | null;
  motm: { name: string; rating: number | null } | null;
}

/**
 * Chiffres du match qui vient de finir, lus dans l'instantané (`gameLastMatch`, module fm). Le jeu ne les remplit
 * qu'une fois le match terminé, et sa date est un objet opaque : on reconnaît le match par son score, pour un
 * instantané écrit au plus tard une semaine de jeu après le direct.
 */
export function lastMatchStats(snap: unknown, l: FmLive): MatchStats | null {
  const s = (snap ?? {}) as { gameDate?: unknown };
  if (!l.final || typeof s.gameDate !== 'string' || !l.gameDate) return null;
  const days = (Date.parse(s.gameDate) - Date.parse(l.gameDate)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0 || days > 7) return null;
  const g = gameLastMatch(snap);
  if (!g || g.homeScore !== (l.homeScore ?? 0) || g.awayScore !== (l.awayScore ?? 0)) return null;
  return { possession: g.possession, shots: g.shots, onTarget: g.onTarget, xg: g.xg, motm: g.motm };
}

/** Lignes « En chiffres » tirées des stats du jeu : possession, tirs (cadrés), xG, homme du match. */
export function statsLines(t: TFunction, st: MatchStats): string[] {
  const pct = (n: number) => `${Math.round(n)} %`;
  const xg = (n: number) => n.toFixed(2).replace('.', ',');
  const lines: string[] = [];
  if (st.possession) lines.push(t('live.figures.possession', { home: pct(st.possession[0]), away: pct(st.possession[1]) }));
  if (st.shots) lines.push(t('live.figures.shots', { home: st.shots[0], away: st.shots[1], homeOn: st.onTarget?.[0] ?? '?', awayOn: st.onTarget?.[1] ?? '?' }));
  if (st.xg) lines.push(t('live.figures.xg', { home: xg(st.xg[0]), away: xg(st.xg[1]) }));
  if (st.motm) lines.push(st.motm.rating != null ? t('live.figures.motm', { name: st.motm.name, rating: st.motm.rating.toFixed(1).replace('.', ',') }) : t('live.figures.motmNoRating', { name: st.motm.name }));
  return lines;
}

/** Buts d'un même joueur dans ce match jusqu'à ce but compris (doublé, triplé). */
function goalsInMatch(tl: TimelineGoal[] | null, goal: TimelineGoal) {
  return (tl ?? []).filter((g) => g.side === goal.side && g.name === goal.name && g.minute <= goal.minute).length;
}

/**
 * Le fait qui donne du relief à la phrase : doublé ou triplé, total de buts de la saison du buteur (nos joueurs, hors
 * amicaux), classement et avis du jeu au coup d'envoi, longue période sans but. Chaîne vide si rien à dire.
 */
export function commentaryFact(t: TFunction, l: FmLive, club: string | null, goal: TimelineGoal | null, fresh: boolean): string {
  const ctx = contextOf(l);
  const side = mySide(l, club);
  const tl = timeline(l);
  const minute = minuteOf(l.minute);
  if (goal && fresh) {
    if (goal.own) return '';
    const n = goalsInMatch(tl, goal);
    if (n >= 3) return t('live.fact.hattrick', { scorer: goal.name });
    if (n === 2) return t('live.fact.brace', { scorer: goal.name });
    if (ctx && !ctx.friendly && side === goal.side) {
      const before = ctx.goals[lastName(goal.name)];
      if (before != null) return t('live.fact.tally', { count: before + n });
    }
    return '';
  }
  if (matchPhase(minute) === 'kickoff' && ctx) {
    const parts = [ctx.position && !ctx.friendly && club ? t(ctx.position === 1 ? 'live.fact.leader' : 'live.fact.position', { club, position: ctx.position }) : '', ctx.threat ?? ''];
    return parts.filter(Boolean).join(' ');
  }
  const last = lastOf(tl);
  const since = minute == null ? null : minute - (last?.minute ?? 0);
  if (since != null && since >= 30 && !l.final) return last ? t('live.fact.drought', { count: since }) : '';
  return '';
}

/** Les chiffres du match qu'on peut tirer du relevé : buts par mi-temps, premier buteur, but le plus tardif. */
export function matchFigures(t: TFunction, l: FmLive): string | null {
  const tl = timeline(l);
  const st = statsOf(l);
  const game = st ? statsLines(t, st) : [];
  if (!tl || !tl.length) return game.length ? game.join('\n') : null;
  const half = (first: boolean) => {
    const g = tl.filter((x) => (first ? x.minute <= 45 || /^45\s*\+/.test(x.time) : x.minute > 45 && !/^45\s*\+/.test(x.time)));
    return `${g.filter((x) => x.side === 'home').length} - ${g.filter((x) => x.side === 'away').length}`;
  };
  const first = tl[0]!;
  const lines = [t('live.figures.halves', { first: half(true), second: half(false) }), t('live.figures.first', { scorer: first.name, minute: first.time })];
  const pens = tl.filter((g) => /^pen/i.test(g.time)).length;
  if (pens) lines.push(t('live.figures.penalties', { count: pens }));
  // Passeurs décisifs du rapport de match (plugin 0.5.4, connus à la fin) : « 🅰️ A. Mojžiš → M. Fábry (37') ».
  const assists = liveAssists(l).map((a) => `${a.assist}${a.player ? ` → ${a.player}` : ''}${a.time ? ` (${a.time})` : ''}`);
  if (assists.length) lines.push(`🅰️ ${t('live.figures.assists', { names: assists.join(', ') })}`);
  return [...game, ...lines].join('\n');
}

/** Un but reste « l'actualité » du commentateur pendant ces minutes de jeu, puis il reparle du match. */
const GOAL_NEWS_MINUTES = 6;

/**
 * Phrase du commentateur : but qui vient de tomber (pour ou contre le club du joueur, selon la situation), sinon le
 * moment du match (début, mi-temps, money time…) et le score, ou la fin du match (victoire, nul, défaite). Choisie
 * parmi plusieurs variantes, stable pendant une dizaine de minutes pour ne pas changer à chaque relevé.
 */
export function commentary(t: TFunction, l: FmLive, club: string | null, goal: TimelineGoal | null): string {
  const minute = minuteOf(l.minute);
  const fresh = !!goal && (minute == null || minute - goal.minute <= GOAL_NEWS_MINUTES);
  const fact = l.final ? '' : commentaryFact(t, l, club, goal, fresh);
  const base = baseCommentary(t, l, club, goal);
  return fact ? `${base} ${fact}` : base;
}

function baseCommentary(t: TFunction, l: FmLive, club: string | null, goal: TimelineGoal | null): string {
  const side = mySide(l, club);
  const minute = minuteOf(l.minute);
  const vars = { home: l.home, away: l.away, score: score(l) };
  if (l.final) {
    const k = pick(`${liveKey(l)}|${score(l)}|f`);
    if (!side) return t(`live.say.final_${k}`, vars);
    const mine = (side === 'home' ? l.homeScore : l.awayScore) ?? 0;
    const theirs = (side === 'home' ? l.awayScore : l.homeScore) ?? 0;
    const o = mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
    return t(`live.say.final${o}_${k}`, { ...vars, club, opponent: side === 'home' ? l.away : l.home });
  }
  if (goal && (minute == null || minute - goal.minute <= GOAL_NEWS_MINUTES)) {
    const k = pick(`${liveKey(l)}|${score(l)}|${goal.time}`);
    const team = goal.side === 'home' ? l.home : l.away;
    const f = (goal.side === 'home' ? l.homeScore : l.awayScore) ?? 0;
    const a = (goal.side === 'home' ? l.awayScore : l.homeScore) ?? 0;
    const who = side && side !== goal.side ? 'against' : 'for';
    // Contre son camp : le nom est celui du fautif, pas d'un buteur de l'équipe qui en profite.
    if (goal.own) return t(`live.say.${who}_ownGoal_${k}`, { ...vars, team, scorer: goal.name, minute: goal.time.replace(/^\S+\s*/, '') });
    return t(`live.say.${who}_${goalSituation(f, a)}_${k}`, { ...vars, team, scorer: goal.name, minute: goal.time });
  }
  const phase = matchPhase(minute);
  const k = pick(`${liveKey(l)}|${score(l)}|${phase}|${Math.floor((minute ?? 0) / 10)}`);
  if (phase === 'kickoff') return t(`live.say.kickoff_${k}`, vars);
  const h = l.homeScore ?? 0;
  const a = l.awayScore ?? 0;
  if (h === a) return t(`live.say.${phase}_level_${k}`, { ...vars, minute });
  const [leader, trailer] = h > a ? [l.home, l.away] : [l.away, l.home];
  // Score dit du côté de l'équipe qui mène : « Malženice mène 2 - 1 ».
  return t(`live.say.${phase}_lead_${k}`, { ...vars, score: `${Math.max(h, a)} - ${Math.min(h, a)}`, minute, leader, trailer });
}

/** Dernier but du déroulé (le plus tardif), ou null. */
const lastOf = (tl: TimelineGoal[] | null) => (tl && tl.length ? tl[tl.length - 1]! : null);

/** Compétition du match (lue dans l'instantané du plugin par l'appli, pas dans le relevé du direct). */
const competitionOf = (l: FmLive) => {
  const c = (l as LiveIn).competition;
  return typeof c === 'string' && c.trim() ? c.trim() : null;
};

/** Encart du direct, modifié à chaque relevé. `club` = club du joueur (couleur et ton du commentaire). */
export function scoreboardPayload(t: TFunction, l: FmLive, club: string | null, opts: { image?: boolean; moment?: LiveHighlight | null } = {}) {
  const tl = timeline(l);
  const side = mySide(l, club);
  let color = LIVE_RED;
  if (l.final && side) {
    const mine = (side === 'home' ? l.homeScore : l.awayScore) ?? 0;
    const theirs = (side === 'home' ? l.awayScore : l.homeScore) ?? 0;
    color = mine > theirs ? GOOD : mine < theirs ? LIVE_RED : ORANGE;
  }
  const minute = minuteOf(l.minute);
  const clock = l.final ? `🏁 ${t('live.ended')}` : minute != null ? `⏱️ ${minute}'  ${progressBar(minute)}` : `⏱️ ${t('live.kickoff')}`;
  const lines = (tl ?? []).map((g) => {
    const mine = side ? g.side === side : true;
    return `\`${g.time.replace(/^pen\.?\s*/i, '').padStart(5)}\` ${mine ? '⚽' : '🥅'} **${g.name}** · ${g.side === 'home' ? l.home : l.away}${/^pen/i.test(g.time) ? ` (${t('live.penalty')})` : ''}`;
  });
  const figures = matchFigures(t, l);
  // Cartons de la feuille de match (plugin 0.5.2) : « 🟨 M. Fábry · Malženice ».
  const cards = liveCardList(l).map((c) => cardLine(t, l, c));
  // Avant-match : seulement au début (ensuite le déroulé et les chiffres prennent la place).
  const pre = !tl?.length && !l.final ? prematchLines(t, l, club, contextOf(l)) : null;
  // Temps fort du moment (but, carton, mi-temps, fin) en tête de l'encart, avec la phrase du commentateur (IA comprise).
  const moment = opts.moment && highlightIsFresh(opts.moment, l) ? opts.moment : null;
  return {
    username: 'FM Immersion',
    embeds: [
      {
        author: { name: [l.final ? t('live.finalTag') : t('live.liveTag'), competitionOf(l)?.toUpperCase()].filter(Boolean).join('  ·  ') },
        title: `${l.home}  ${score(l)}  ${l.away}`,
        // Avec l'image, la phrase du commentateur n'est que dans l'image (pas deux fois) ; l'horloge s'efface devant
        // le temps fort « coup de sifflet final ».
        description: [
          moment?.final ? '' : clock,
          moment?.line ?? '',
          opts.image ? '' : `🎙️ *${moment?.said ?? commentary(t, l, club, lastOf(tl))}*`,
        ]
          .filter(Boolean)
          .join('\n\n') || clock,
        color,
        // Avec l'image, tout est dessus (déroulé, cartons, chiffres) : l'encart se réduit au titre, au temps fort et à
        // l'image, pour qu'elle prenne toute la place.
        fields: opts.image ? [] : [
          ...(lines.length
            ? [{ name: t('live.timeline'), value: lines.join('\n').slice(0, 1000) }]
            : l.scorers
              ? [{ name: t('live.scorers'), value: l.scorers.slice(0, 1000) }]
              : []),
          ...(cards.length ? [{ name: t('live.cards'), value: cards.join('\n').slice(0, 1000) }] : []),
          ...(figures ? [{ name: t('live.figures.title'), value: figures.slice(0, 1000) }] : []),
          ...(pre?.lines.length ? [{ name: t('live.prematch.title'), value: pre.lines.join('\n').slice(0, 1000) }] : []),
          ...(pre?.lineup ? [{ name: t('live.prematch.lineup'), value: pre.lineup.slice(0, 1000) }] : []),
        ],
        ...(opts.image ? { image: { url: 'attachment://direct.png' } } : {}),
        footer: {
          text: [l.gameDate && new Date(`${l.gameDate}T12:00:00`).toLocaleDateString(), 'FM Immersion'].filter(Boolean).join('  ·  '),
        },
      },
    ],
    ...(opts.image ? { attachments: [{ id: 0, filename: 'direct.png' }] } : {}),
  };
}

/** Ligne d'un carton dans l'encart : « 🟥 **P. Kováč** · Humenné (74') », ou « 🟥 Expulsion · Humenné (74') » sans nom. */
export function cardLine(t: TFunction, l: FmLive, c: Omit<LiveCardNews, 'kind'>): string {
  const who = c.player ? `**${c.player}**` : t(c.card === 'red' ? 'live.redUnknown' : 'live.yellowUnknown');
  return `${c.card === 'red' ? '🟥' : '🟨'} ${who} · ${c.side === 'home' ? l.home : l.away}${c.time ? ` (${c.time})` : ''}`;
}

/** Temps fort du match : but (pour ou contre, penalty, contre son camp, passeur), carton, but refusé, mi-temps, fin. */
export type Moment = LiveGoalNews | LiveCardNews | LiveDisallowedNews | { kind: 'half' } | { kind: 'final' };

/**
 * Temps fort mis en avant dans l'encart (un seul message, modifié) : sa ligne de titre, la phrase du commentateur
 * (IA ou toute faite), et de quoi savoir quand il n'est plus l'actualité (minute et score du moment).
 */
export interface LiveHighlight {
  line: string;
  said: string | null;
  minute: number | null;
  score: string;
  final: boolean;
}

/** Le temps fort reste en tête tant que le score n'a pas bougé, quelques minutes de jeu (toujours, une fois le match fini). */
export function highlightIsFresh(h: LiveHighlight, l: FmLive): boolean {
  if (h.score !== score(l)) return false;
  if (l.final) return h.final;
  const m = minuteOf(l.minute);
  return h.minute == null || m == null || m - h.minute <= GOAL_NEWS_MINUTES;
}

/** Minute affichée d'un but sans son préfixe (« pen 36' » → « 36' », « c.s.c. 26' » → « 26' »). */
const bareTime = (time: string) => (isPenalty(time) || isOwnGoal(time) ? time.replace(/^\S+\s*/, '') : time);

/** Ligne de titre d'un temps fort, en gras dans l'encart : « ⚽ **BUUUT pour Malženice ! (11')** ». */
export function momentLine(t: TFunction, l: FmLive, club: string | null, m: Moment): string {
  const side = mySide(l, club);
  const tl = timeline(l) ?? [];
  if (m.kind === 'goal') {
    const team = m.side === 'home' ? l.home : l.away;
    const goal = (m.scorer && tl.find((g) => g.name === m.scorer!.name && g.time === m.scorer!.time)) ?? null;
    const mine = side ? m.side === side : true;
    const own = !!goal?.own || isOwnGoal(m.scorer?.time);
    const penalty = m.penalty || isPenalty(goal?.time);
    const minute = bareTime(goal?.time ?? m.scorer?.time ?? l.minute ?? '');
    const key = own
      ? mine
        ? 'live.moment.ownGoalFor'
        : 'live.moment.ownGoalAgainst'
      : penalty
        ? mine
          ? 'live.moment.penaltyFor'
          : 'live.moment.penaltyAgainst'
        : mine
          ? 'live.moment.goalFor'
          : 'live.moment.goalAgainst';
    const assist = m.assist && !own ? `\n🅰️ ${t('live.moment.assist', { name: m.assist })}` : '';
    return `${mine ? '⚽' : '😬'} **${t(key, { team, minute, player: m.scorer?.name ?? '' })}**${assist}`;
  }
  if (m.kind === 'card') {
    const team = m.side === 'home' ? l.home : l.away;
    const mine = side ? m.side === side : true;
    const red = m.card === 'red';
    const key = red ? (mine ? 'live.moment.redFor' : 'live.moment.redAgainst') : mine ? 'live.moment.yellowFor' : 'live.moment.yellowAgainst';
    const minute = minuteOf(m.time) ?? minuteOf(l.minute) ?? '';
    return `${red ? '🟥' : '🟨'} **${t(m.player ? key : `${key}Unknown`, { player: m.player ?? '', team, minute })}**`;
  }
  if (m.kind === 'disallowed') {
    const team = m.side === 'home' ? l.home : l.away;
    const mine = side ? m.side === side : true;
    return `❌ **${t(mine ? 'live.moment.disallowedFor' : 'live.moment.disallowedAgainst', { team, score: score(l) })}**`;
  }
  if (m.kind === 'half') return `⏸️ **${t('live.moment.half')}**`;
  return `🏁 **${t('live.moment.final')}**`;
}

/** Temps forts entre deux relevés du même match : buts, cartons, passage à la mi-temps, fin. */
export function momentsBetween(prev: FmLive, cur: FmLive): Moment[] {
  const news = liveNews(prev, cur);
  const out: Moment[] = news.filter((n): n is LiveGoalNews | LiveCardNews | LiveDisallowedNews => n.kind === 'goal' || n.kind === 'card' || n.kind === 'disallowed');
  const pm = minuteOf(prev.minute);
  const cm = minuteOf(cur.minute);
  // Mi-temps : la minute passe 45 (ou le jeu affiche un texte sans minute, « MT ») sans but ni fin.
  const half = pm != null && pm < 45 && !cur.final && (cm == null ? pm >= 40 : cm >= 45 && cm <= 50);
  if (half && !out.some((m) => m.kind === 'goal')) out.push({ kind: 'half' });
  if (news.some((n) => n.kind === 'final')) out.push({ kind: 'final' });
  return out;
}

/** Ordre d'importance des temps forts arrivés entre deux relevés : on met en avant le plus marquant. */
const RANK: Record<Moment['kind'], number> = { final: 4, goal: 3, disallowed: 3, card: 2, half: 1 };

/**
 * Temps fort à mettre en tête de l'encart parmi ceux du relevé (le plus marquant, le dernier but s'il y en a
 * plusieurs), avec la phrase de l'IA du joueur quand elle est branchée (but, mi-temps, fin). Null s'il n'y en a pas.
 */
async function highlightOf(t: TFunction, l: FmLive, club: string | null, moments: Moment[], lang?: string): Promise<LiveHighlight | null> {
  if (!moments.length) return null;
  const m = moments.reduce((best, x) => (RANK[x.kind] >= RANK[best.kind] ? x : best));
  const said = m.kind === 'card' || m.kind === 'disallowed' ? null : await aiLiveComment(liveMoment(t, l, club, m), lang).catch(() => null);
  const tl = timeline(l) ?? [];
  const goal = m.kind === 'goal' && m.scorer ? tl.find((g) => g.name === m.scorer!.name && g.time === m.scorer!.time) : null;
  return {
    line: momentLine(t, l, club, m),
    said: said ?? (m.kind === 'half' ? commentary(t, { ...l, minute: '45 min.' }, club, lastOf(tl)) : null),
    minute: m.kind === 'half' ? 45 : (goal?.minute ?? (m.kind === 'card' ? minuteOf(m.time) : null) ?? minuteOf(l.minute)),
    score: score(l),
    final: m.kind === 'final',
  };
}

/**
 * Ce que l'IA reçoit pour un temps fort : le fait déjà établi par l'appli (buteur, minute, score), la phrase toute
 * faite du commentateur, le déroulé et le contexte d'avant-match. Rien d'autre.
 */
export function liveMoment(t: TFunction, l: FmLive, club: string | null, m: Moment): LiveMoment {
  const tl = timeline(l) ?? [];
  const sideName = (s: 'home' | 'away') => (s === 'home' ? l.home : l.away);
  let fact: string;
  if (m.kind === 'goal') {
    const goal = (m.scorer && tl.find((g) => g.name === m.scorer!.name && g.time === m.scorer!.time)) ?? null;
    const mine = club ? sideName(m.side) === club : null;
    fact = [
      `But${m.penalty || isPenalty(goal?.time) ? ' sur penalty' : ''} pour ${sideName(m.side)}`,
      goal?.own ? ` : contre son camp de ${goal.name}, joueur de ${sideName(m.side === 'home' ? 'away' : 'home')} (${bareTime(goal.time)})` : goal ? ` : ${goal.name} (${goal.time})` : '',
      m.assist ? `, passe décisive de ${m.assist}` : '',
      `. Score : ${score(l)}.`,
      mine == null ? '' : mine ? ` C'est un but POUR ${club}.` : ` C'est un but CONTRE ${club}.`,
    ].join('');
  } else if (m.kind === 'half') fact = `Mi-temps, score ${score(l)}.`;
  else if (m.kind === 'card') fact = `Carton ${m.card === 'red' ? 'rouge' : 'jaune'}${m.player ? ` pour ${m.player}` : ''} (${sideName(m.side)}). Score : ${score(l)}.`;
  else if (m.kind === 'disallowed') fact = `But refusé pour ${sideName(m.side)}. Score : ${score(l)}.`;
  else fact = `Coup de sifflet final, score final ${score(l)}.${matchFigures(t, { ...l, final: true }) ? ` Chiffres : ${matchFigures(t, { ...l, final: true })}` : ''}`;
  const said = m.kind === 'goal' ? commentary(t, l, club, lastOf(tl)) : commentary(t, m.kind === 'half' ? { ...l, minute: '45 min.' } : { ...l, final: true }, club, lastOf(tl));
  const ctx = contextOf(l);
  const context = ctx
    ? [
        ctx.position && club && !ctx.friendly ? `${club} est ${ctx.position}e du championnat` : '',
        ctx.topScorer ? `meilleur buteur de ${club ?? 'l\'équipe'} : ${ctx.topScorer.name} (${ctx.topScorer.goals} buts)` : '',
        ctx.threat ?? '',
        ctx.friendly ? 'match amical' : '',
      ].filter(Boolean)
    : [];
  return {
    home: l.home,
    away: l.away,
    score: score(l),
    minute: l.minute ?? null,
    club,
    competition: competitionOf(l),
    fact,
    said,
    timeline: [
      ...tl.map((g) => `${g.time} but ${g.name} (${sideName(g.side)})`),
      ...liveCardList(l).map((c) => `${c.time ? `${c.time} ` : ''}carton ${c.card === 'red' ? 'rouge' : 'jaune'}${c.player ? ` ${c.player}` : ''} (${sideName(c.side)})`),
    ],
    context,
  };
}

/** Image du tableau de score (PNG), dessinée par l'interface ; absente dans les tests. */
export type LiveRender = (l: FmLive, club: string | null, comment: string) => Promise<Uint8Array | null>;

/** Où en est le direct : match suivi, message du tableau de score, dernier relevé envoyé. Gardé pour un redémarrage. */
interface LiveState {
  key: string;
  messageId: string | null;
  last: FmLive;
  done: boolean;
  /** Chiffres du jeu ajoutés à l'encart après le match (une seule fois). */
  stats?: boolean;
  /** Dernier temps fort mis en tête de l'encart. */
  highlight?: LiveHighlight | null;
}

const STATE_KEY = 'fmi.discord.liveState';

function loadState(): LiveState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as LiveState) : null;
  } catch {
    return null;
  }
}

function saveState(s: LiveState) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* sans stockage : on garde l'état en mémoire */
  }
}

/** Envoie (sans identifiant) ou modifie l'encart, avec son image quand on sait la dessiner. Renvoie l'identifiant du message. */
async function publish(t: TFunction, l: FmLive, club: string | null, messageId: string | null, render?: LiveRender, highlight: LiveHighlight | null = null): Promise<string | null> {
  const fresh = highlight && highlightIsFresh(highlight, l) ? highlight : null;
  const png = render ? await render(l, club, fresh?.said ?? commentary(t, l, club, lastOf(timeline(l)))).catch(() => null) : null;
  if (png) {
    return invoke<string>('discord_live_image', {
      webhook: getWebhook(),
      messageId,
      payload: scoreboardPayload(t, l, club, { image: true, moment: fresh }),
      png: Array.from(png),
    });
  }
  const board = scoreboardPayload(t, l, club, { moment: fresh });
  if (!messageId) return postDiscord(board);
  await editDiscord(messageId, board);
  return messageId;
}

/** Match terminé sans relevé final : score du jeu (domicile, extérieur) s'il est lu dans l'instantané. */
export interface MatchEnded {
  score: [number, number] | null;
}

/** Relevé sans nouvelle écriture depuis ce délai : le plugin n'écrit plus, le match est fini (ou le jeu est fermé). */
const ENDED_AFTER_MS = 3 * 60_000;

/**
 * Le match du relevé est-il fini ? Le plugin n'écrit plus pendant un match fini : un relevé « en cours » qui n'a pas
 * bougé depuis trois minutes à la 85e ou après, ou dont la date de jeu est dépassée dans l'instantané, ou dont le
 * score est celui du dernier match joué de l'instantané (même jour de jeu, prochain match plus tard), est terminé.
 * Null tant qu'on ne peut pas conclure.
 */
export function matchEnded(l: FmLive, snap: unknown, now: number): MatchEnded | null {
  if (liveIsFresh(l, now) || l.final) return null;
  const age = now - Date.parse(l.updatedAt);
  const s = (snap ?? {}) as { gameDate?: unknown; nextMatch?: { inDays?: unknown } | null };
  // Score du dernier match de l'instantané, même sans ses chiffres (gameLastMatch les exige) : lu tel quel.
  const e = ((snap ?? {}) as { custom?: { equipe?: Record<string, unknown> } }).custom?.equipe ?? {};
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);
  const hs = n(e.dernierMatchScoreDomicile);
  const as = n(e.dernierMatchScoreExterieur);
  const last: [number, number] | null = hs != null && as != null ? [hs, as] : null;
  const later = typeof s.gameDate === 'string' && !!l.gameDate && s.gameDate > l.gameDate;
  const sameDay = typeof s.gameDate === 'string' && !!l.gameDate && s.gameDate === l.gameDate;
  const nextIsToday = typeof s.nextMatch?.inDays === 'string' && /aujourd|today/i.test(s.nextMatch.inDays);
  const scoreSeen = !!last && last[0] === (l.homeScore ?? 0) && last[1] === (l.awayScore ?? 0);
  if (later) return { score: scoreSeen ? last : null };
  if (sameDay && scoreSeen && !nextIsToday) return { score: last };
  if (Number.isFinite(age) && age >= ENDED_AFTER_MS && (minuteOf(l.minute) ?? 0) >= 85) return { score: scoreSeen ? last : null };
  return null;
}

/** Un relevé du direct : nouveau match → encart ; ensuite le même message est modifié (score, minute, commentaire, fin). */
export async function liveStep(
  t: TFunction,
  l: FmLive,
  club: string | null,
  state: LiveState | null,
  now = Date.now(),
  render?: LiveRender,
  ended: MatchEnded | null = null,
  lang?: string,
  /** Au coup d'envoi d'un nouveau match, avant le tableau de score (compo d'avant-match). Une erreur n'arrête rien. */
  kickoff?: () => Promise<void>,
): Promise<LiveState | null> {
  const key = liveKey(l);
  // Après le match : les chiffres du jeu arrivent avec l'instantané suivant (jusqu'à quelques minutes plus tard,
  // le relevé n'est alors plus « frais ») ; on complète l'encart une seule fois.
  if (state?.done && !state.stats && state.key === key && state.messageId && statsOf(l)) {
    try {
      await publish(t, l, club, state.messageId, render, state.highlight ?? null);
      return { ...state, last: l, stats: true };
    } catch {
      return state;
    }
  }
  if (!liveIsFresh(l, now)) {
    // Le plugin a cessé d'écrire (le jeu ne répond plus sur le match une fois fini) sans jamais marquer « final » :
    // on clôt nous-mêmes l'encart avec le dernier score connu, corrigé par l'instantané s'il donne le résultat.
    if (ended && state && state.key === key && !state.done && state.messageId) {
      const closed: FmLive = { ...state.last, ...l, final: true, inMatch: false, minute: 'FDM', ...(ended.score ? { homeScore: ended.score[0], awayScore: ended.score[1] } : {}) };
      try {
        const highlight = await highlightOf(t, closed, club, [{ kind: 'final' }], lang);
        await publish(t, closed, club, state.messageId, render, highlight);
        return { key, messageId: state.messageId, last: closed, done: true, highlight };
      } catch {
        return state;
      }
    }
    return state;
  }
  if (!state || state.key !== key) {
    if (l.final) return { key, messageId: null, last: l, done: true }; // match déjà fini quand l'appli l'a vu
    if (kickoff) await kickoff().catch((e) => console.warn('Compo d’avant-match :', e));
    // Un seul message par match : l'avant-match y figure jusqu'au premier but.
    const messageId = await publish(t, l, club, null, render);
    return { key, messageId, last: l, done: false };
  }
  if (state.done) return state;
  const changed =
    liveNews(state.last, l).length > 0 ||
    JSON.stringify([state.last.minute, state.last.homeScore, state.last.awayScore, state.last.scorers, state.last.final, liveCardList(state.last), liveAssists(state.last)]) !==
      JSON.stringify([l.minute, l.homeScore, l.awayScore, l.scorers, l.final, liveCardList(l), liveAssists(l)]);
  let messageId = state.messageId;
  let highlight = state.highlight ?? null;
  if (changed) {
    // Pas de nouveau message pour un temps fort : il passe en tête de l'encart, qui est modifié.
    highlight = (await highlightOf(t, l, club, momentsBetween(state.last, l), lang)) ?? highlight;
    try {
      if (!messageId) throw new Error('aucun tableau');
      messageId = await publish(t, l, club, messageId, render, highlight);
    } catch {
      // Encart effacé du salon (ou jamais envoyé) : on en poste un nouveau plutôt que de rester bloqué.
      messageId = await publish(t, l, club, null, render, highlight).catch(() => null);
    }
  }
  return { key, messageId, last: l, done: !!l.final, highlight };
}

/**
 * Direct des matchs sur Discord, monté une fois pour toute l'appli : toutes les 10 s, lit le relevé du plugin
 * (archivix-live.json) si le joueur a activé le direct et relié un salon. Rien n'est lu ni envoyé sinon.
 */
export function useLiveDiscord() {
  const { t, i18n } = useTranslation();
  const busy = useRef(false);
  // Dossier du plugin de la carrière suivie (celui choisi dans les réglages, sinon celui trouvé sur le PC).
  const { saveId } = useCareer();
  const folderNow = useFmFolder(saveId);
  const folderRef = useRef(folderNow);
  folderRef.current = folderNow;
  const saveIdRef = useRef(saveId);
  saveIdRef.current = saveId;
  useEffect(() => {
    let state = loadState();
    // Compétition du match en cours (« Match Amical »…), lue une fois par match dans l'instantané du plugin.
    let comp: { key: string; context: LiveContext | null; snap: unknown } | null = null;
    // Chiffres du match fini : instantané relu au plus une fois par minute tant qu'ils manquent.
    let statsAt = 0;
    const render: LiveRender = async (l, club, comment) => {
      const { drawLiveBoard } = await import('./live-image');
      const { canvasPng } = await import('./gazette-une');
      const { loadFace } = await import('./player-face');
      // Photos des buteurs : nos joueurs, retrouvés dans l'effectif de l'instantané (« M. Fábry » → son visage).
      const faces = new Map<string, CanvasImageSource | null>();
      // Et l'homme du match, une fois les chiffres du jeu arrivés.
      const motm = (l as { stats?: MatchStats | null }).stats?.motm?.name;
      for (const name of [...(timeline(l) ?? []).map((g) => g.name), ...(motm ? [motm] : [])]) {
        const g = { name };
        if (faces.has(g.name)) continue;
        const id = personIdFor(contextOf(l), g.name);
        faces.set(g.name, id ? await loadFace(id).catch(() => null) : null);
      }
      return canvasPng(await drawLiveBoard(t, l, club, comment, i18n.resolvedLanguage, undefined, faces));
    };
    const tick = async () => {
      if (busy.current || !getLiveEnabled() || !isWebhook(getWebhook())) return;
      busy.current = true;
      try {
        const folder = folderRef.current || (await invoke<string | null>('fm_default_folder'));
        if (!folder) return;
        const raw = await invoke<string | null>('fm_read_live', { folder });
        if (!raw) return;
        const live = fmLiveSchema.safeParse(JSON.parse(raw));
        if (!live.success) return;
        const statusRaw = await invoke<string | null>('fm_read_status', { folder }).catch(() => null);
        const club = statusRaw ? ((JSON.parse(statusRaw) as { club?: string | null }).club ?? null) : null;
        const key = liveKey(live.data);
        if (comp?.key !== key) {
          const snapRaw = await invoke<string | null>('fm_read_snapshot', { folder }).catch(() => null);
          const snap = snapRaw ? JSON.parse(snapRaw) : null;
          // Couleurs et identifiants des deux équipes (calendrier de l'instantané) pour le tableau en image.
          if (snap) rememberClubLooks([snap]);
          const context = snap ? liveContext(snap) : null;
          comp = { key, context, snap };
        }
        let ended: MatchEnded | null = null;
        if (state && state.key === key && !state.done && !liveIsFresh(live.data, Date.now())) {
          const snapRaw = await invoke<string | null>('fm_read_snapshot', { folder }).catch(() => null);
          ended = matchEnded(live.data, snapRaw ? JSON.parse(snapRaw) : null, Date.now());
        }
        let stats: MatchStats | null = null;
        if (live.data.final && state?.done && !state.stats && state.key === key && Date.now() - statsAt >= 60_000) {
          statsAt = Date.now();
          const snapRaw = await invoke<string | null>('fm_read_snapshot', { folder }).catch(() => null);
          stats = snapRaw ? lastMatchStats(JSON.parse(snapRaw), live.data) : null;
        }
        // Compo d'avant-match juste avant le tableau de score, si le plugin a lu le onze de ce match.
        const snapNow = comp.snap;
        const kickoff = getLineupDiscord()
          ? async () => {
              const card = lineupCard([snapNow]);
              if (!card || (card.opponent !== live.data.home && card.opponent !== live.data.away)) return;
              const png = await lineupPng(t, card, { lang: i18n.resolvedLanguage, saveId: saveIdRef.current });
              await sendDiscordImage(lineupPayload(t, card), png);
            }
          : undefined;
        const next = await liveStep(t, { ...live.data, competition: comp.context?.competition ?? null, context: comp.context, stats } as FmLive, club, state, Date.now(), render, ended, i18n.resolvedLanguage, kickoff);
        if (next && next !== state) {
          state = next;
          saveState(next);
        }
      } catch (e) {
        console.warn('Direct Discord :', e);
      } finally {
        busy.current = false;
      }
    };
    const id = window.setInterval(tick, 10_000);
    void tick();
    return () => window.clearInterval(id);
  }, [t, i18n]);
}

/**
 * Exemple d'encart pour l'écran Discord, avant d'activer le direct : notre club mène 2-0 à l'heure de jeu, juste
 * après un but, tel que les amis du joueur le verront (même fonction que le vrai direct, sans IA).
 */
export function livePreviewPayload(t: TFunction, club: string, opponent: string) {
  const scorer = t('discord.preview.scorer');
  const base = { schema: 'archivix-live/1', updatedAt: '', gameDate: null, home: club, away: opponent, final: false, inMatch: true } as FmLive;
  const prev = { ...base, homeScore: 1, awayScore: 0, minute: '55 min.', scorers: `${scorer} 23'` } as FmLive;
  const cur = { ...prev, homeScore: 2, minute: '58 min.', scorers: `${scorer} 23', 57'` } as FmLive;
  const m = momentsBetween(prev, cur).find((x) => x.kind === 'goal');
  const moment: LiveHighlight | null = m ? { line: momentLine(t, cur, club, m), said: null, minute: 57, score: score(cur), final: false } : null;
  return scoreboardPayload(t, cur, club, { moment });
}
