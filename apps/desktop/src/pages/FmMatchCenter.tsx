import {
  activeSituations,
  backForMatch,
  competitionRules,
  eligibilityOf,
  competitionWeight,
  isCongested,
  isFriendly,
  fmLiveSchema,
  liveCoachState,
  liveSubs,
  matchdayPlan,
  matchResults,
  recentLoad,
  matchTweaks,
  plannedSubs,
  ruleChecks,
  snapshotFixtures,
  substitutionPlan,
  spreadXY,
  summarize,
  type FmPlayer,
  type FmSnapshot,
  type GameSlot,
} from '@fm-immersion/module-fm';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Stadium } from '../components/PageHero';
import { Avatar, Gauge, LINE_COLOR, Pitch } from './FmFoot';
import { useTacticChoice } from './FmTactic';
import { fitPct, PlayerLink, useNames } from './FmUi';

/** Nom de famille pour le terrain (les pastilles sont petites). */
const last = (name: string) => name.trim().split(/\s+/).at(-1) ?? name;

/**
 * Haut de l'accueil, façon avant-match : le prochain match et les suivants, le onze probable sur le terrain
 * (même calcul que Tactique > Composition) et l'état de l'équipe (condition, rythme, absents).
 */
export function FmMatchCenter({
  snap,
  players,
  folder,
  gameFormation,
  lineup,
  gameTactic,
  go,
  matches,
  aside,
  asideAfter,
  afterHero,
}: {
  snap: FmSnapshot;
  players: FmPlayer[];
  folder: string;
  gameFormation: string | null;
  lineup: GameSlot[] | null;
  gameTactic: string | null;
  go: (view: string) => void;
  /** Instantanés de la partie, pour compter les matchs enchaînés. */
  matches?: { gameDate: string; data: FmSnapshot }[];
  /** Colonne de gauche, à côté du onze probable (le briefing de l'adjoint). */
  aside?: ReactNode;
  /** Sous la colonne de gauche (prochains matchs). */
  asideAfter?: ReactNode;
  /** Sous le bandeau du match (cartes de l'accueil : point du staff, gazette). */
  afterHero?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  const lang = i18n.resolvedLanguage;
  const s = useMemo(() => summarize(snap, players), [snap, players]);
  const fixtures = useMemo(() => snapshotFixtures(snap), [snap]);
  const { plan: basePlan, style, engine } = useTacticChoice(players, folder, gameFormation, lineup, gameTactic);
  const rules = competitionRules(s.nextMatch?.competition);
  // Poids du match : coupe ou calendrier chargé = faire tourner, championnat / Europe = meilleur onze.
  const weight = competitionWeight(s.nextMatch?.competition, { congested: isCongested(fixtures, snap.gameDate) });
  // Matchs enchaînés : titularisations des derniers jours, d'après les instantanés.
  const load = useMemo(() => recentLoad(matchResults(matches ?? []), snap.gameDate), [matches, snap.gameDate]);
  // Onze du prochain match : le onze de base corrigé de la condition (et de la rotation en coupe ou calendrier chargé).
  const matchday = useMemo(() => (basePlan ? matchdayPlan(engine, basePlan, players, { rotate: weight.rotate, inDays: s.nextMatch?.inDays ?? null, load }) : null), [engine, basePlan, players, weight.rotate, s.nextMatch?.inDays, load]);
  const plan = matchday?.plan ?? basePlan;
  const changes = matchday?.changes ?? [];
  const subs = useMemo(() => (plan ? substitutionPlan(plan, plannedSubs(rules)) : []), [plan, rules]);
  const benchPlayers = plan ? [...new Map(plan.subs.flatMap((l) => l.slice(0, 1)).map((p) => [p.id, p])).values()].slice(0, rules.bench ?? 9) : [];
  const eligibility = useMemo(() => eligibilityOf(snap), [snap]);
  const checks = plan ? ruleChecks(plan, rules, benchPlayers, eligibility) : [];
  // Mode « en direct » : la minute et le score viennent du relevé du plugin (archivix-live.json, réécrit toutes
  // les 15 s pendant le match, lu ici toutes les 10 s, lecture locale seulement) ; sans relevé du match du club,
  // ou si le coach reprend la main, il les saisit lui-même.
  const { data: liveRaw } = useQuery({
    queryKey: ['fm', 'live', folder],
    queryFn: () => invoke<string | null>('fm_read_live', { folder }),
    enabled: !!folder,
    refetchInterval: 10_000,
  });
  const game = useMemo(() => {
    if (!liveRaw) return null;
    try {
      const l = fmLiveSchema.safeParse(JSON.parse(liveRaw));
      return l.success ? liveCoachState(l.data, snap.club, s.nextMatch?.opponent, Date.now()) : null;
    } catch {
      return null;
    }
  }, [liveRaw, snap.club, s.nextMatch?.opponent]);
  const [manual, setManual] = useState(false);
  const [live, setLive] = useState(false);
  // Feuille de match repliée en une ligne, sauf la veille et le jour du match (ou pendant le direct).
  const [sheetOpen, setSheetOpen] = useState(false);
  const [minute, setMinute] = useState(0);
  const [diff, setDiff] = useState(0);
  const [tired, setTired] = useState(false);
  const [opponentChanged, setOpponentChanged] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());
  const fromGame = !!game && !manual;
  // Un match du club commence dans le jeu : la feuille passe d'elle-même en direct.
  const gameKey = game ? `${game.side}|${game.opponent}` : null;
  useEffect(() => {
    if (!gameKey) return;
    setLive(true);
    setDone(new Set());
  }, [gameKey]);
  const liveState = fromGame ? { minute: game.minute, diff: game.diff, tired, opponentChanged } : { minute, diff, tired, opponentChanged };
  const active = live ? activeSituations(liveState) : [];
  const subState = live ? liveSubs(subs, liveState, done) : subs.map(() => 'later' as const);
  const toggleDone = (slot: number) =>
    setDone((d) => {
      const n = new Set(d);
      if (n.has(slot)) n.delete(slot);
      else n.add(slot);
      return n;
    });
  const chip = (on: boolean) => `chip ${on ? 'chip-on' : ''}`;
  const tweaks = useMemo(() => matchTweaks(style?.id), [style]);
  const nm = s.nextMatch;
  const rating = new Intl.NumberFormat(lang, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const suspended = players.filter((p) => p.suspension);
  // Blessés encore absents le jour du match ; ceux qui seront rétablis d'ici là sont listés à part.
  const injured = players.filter((p) => p.injury && !backForMatch(p));
  const back = players.filter((p) => backForMatch(p));
  const xy = plan
    ? spreadXY(
        plan.slots.map((sl) => [sl.x, sl.y] as [number, number]),
        22,
        12,
      ).map(([x, y]) => [Math.min(86, Math.max(14, x)), Math.min(90, Math.max(8, y))] as const)
    : [];

  const when = nm?.inDays == null ? null : nm.inDays === 0 ? t('fm.mc.today') : nm.inDays === 1 ? t('fm.mc.tomorrow') : t('fm.mc.inDaysLong', { count: nm.inDays });
  const sides = nm ? (nm.home === false ? [nm.opponent, snap.club] : [snap.club, nm.opponent]) : [];
  const absent = [...injured, ...suspended, ...back];

  return (
    <section className="space-y-4">
      {/* Prochain match : bandeau sombre, l'information qu'on cherche en premier. */}
      <div className="relative overflow-hidden rounded-2xl bg-canard text-white">
        <Stadium className="pointer-events-none absolute inset-y-0 right-0 hidden h-full w-[55%] md:block" />
        <div className="relative max-w-xl p-6 md:p-7">
          {nm ? (
            <>
              <p className="text-xs font-bold uppercase tracking-widest text-orange">
                {[when, nm.home != null && t(nm.home ? 'fm.mc.home' : 'fm.mc.away')].filter(Boolean).join(' · ') || t('fm.mc.next')}
              </p>
              <p className="mt-2 font-display text-3xl font-semibold leading-tight md:text-4xl">
                {sides[0]} <span className="text-white/50">–</span> {sides[1]}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
                {nm.competition && <span className="rounded-full bg-white/10 px-2.5 py-1">{nm.competition}</span>}
                {nm.inDays != null && nm.inDays > 1 && <span className="rounded-full bg-white/10 px-2.5 py-1 tabular-nums">J-{nm.inDays}</span>}
              </div>
              {nm.staffView && <p className="mt-3 max-w-md text-sm italic text-white/75">« {nm.staffView} »</p>}
            </>
          ) : (
            <>
              <p className="text-xs font-bold uppercase tracking-widest text-orange">{t('fm.mc.next')}</p>
              <p className="mt-2 text-white/70">{t('fm.sum.noMatch')}</p>
            </>
          )}
          {/* Une action principale : l'adversaire (préparer le match vient après, en lien). */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {nm && (
              <button type="button" className="rounded-lg bg-orange px-5 py-2.5 font-bold text-canard hover:brightness-105" onClick={() => go('opponent')}>
                {t('fm.mc.seeOpponent')}
              </button>
            )}
            <button
              type="button"
              className={nm ? 'rounded-lg px-3 py-2 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white' : 'rounded-lg bg-orange px-5 py-2.5 font-bold text-canard hover:brightness-105'}
              onClick={() => go('tactic')}
            >
              {t('fm.mc.prepareMatch')} →
            </button>
          </div>
        </div>
      </div>

      {afterHero}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          {aside}
          {asideAfter}
        </div>

        {/* Onze probable sur le terrain, et l'état de l'équipe juste dessous. */}
        <div className="card p-4">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-lg">{t('fm.mc.xi')}</h2>
            {plan && (
              <span className="text-sm font-bold tabular-nums text-eau-fonce" title={t('fm.mc.fit')}>
                {fitPct(plan.score)}
              </span>
            )}
          </div>
          <p className="mb-3 text-xs text-brun">{[plan?.form, style && names.style(style)].filter(Boolean).join(' · ')}</p>
          <Pitch className="mx-auto w-full max-w-[17rem]">
            {plan?.slots.map((sl, i) => {
              const [x, y] = xy[i]!;
              return (
                <span key={i} className="absolute flex w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center" style={{ left: `${x}%`, top: `${y}%` }}>
                  {sl.player ? <Avatar player={sl.player} size="sm" /> : <span className="h-7 w-7 rounded-full border-2 border-dashed border-white/70" aria-hidden />}
                  <span className="mt-0.5 max-w-full truncate rounded bg-canard/85 px-1 text-[0.65rem] font-bold leading-4 text-white">{sl.player ? last(sl.player.name) : t('fm.tac.nobody')}</span>
                </span>
              );
            })}
          </Pitch>
          {plan && plan.subs.some((l) => l.length) && (
            <p className="mt-3 text-xs text-brun">
              <b className="text-canard">{t('fm.mc.bench')}</b>{' '}
              {[...new Map(plan.subs.flatMap((l) => l.slice(0, 1)).map((p) => [p.id, p])).values()]
                .slice(0, 7)
                .map((p) => last(p.name))
                .join(', ')}
            </p>
          )}
          {changes.length > 0 && (
            <div className="mt-3 rounded-lg bg-orange-clair/60 p-2.5 text-xs">
              <p className="font-bold text-canard">{t(weight.rotate ? 'fm.mc.rotationTitle' : 'fm.mc.changesTitle')}</p>
              <ul className="mt-1 space-y-0.5">
                {changes.map((c) => (
                  <li key={c.slot} className="text-canard">
                    <b>{last(c.out.name)}</b> → {c.in ? <b>{last(c.in.name)}</b> : t('fm.tac.nobody')}{' '}
                    <span className="text-brun">
                      ({c.reason === 'unavailable' || c.reason === 'risk' || c.reason === 'chained' ? t(`fm.mc.why.${c.reason}`) : t('fm.mc.why.condition', { pct: Math.round(c.out.condition ?? 0) })})
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-brun">{t('fm.mc.changesHint')}</p>
            </div>
          )}
          <div className="mt-4 space-y-3 border-t border-canard/10 pt-4">
            <Gauge value={s.condition} label={t('fm.sum.condition')} />
            <Gauge value={s.sharpness} label={t('fm.sum.sharpness')} />
            <div className="grid grid-cols-3 gap-2 text-center">
              {(
                [
                  [t('fm.mc.injured'), injured.length, injured.length ? 'text-corail' : ''],
                  [t('fm.mc.suspended'), suspended.length, suspended.length ? 'text-corail' : ''],
                  [t('fm.mc.rating'), s.rating == null ? '–' : rating.format(s.rating), ''],
                ] as const
              ).map(([label, value, tone]) => (
                <div key={label} className="rounded-lg bg-canard/5 p-2">
                  <p className={`font-display text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
                  <p className="text-xs text-brun">{label}</p>
                </div>
              ))}
            </div>
            {absent.length > 0 && (
              <ul className="space-y-1 text-sm">
                {absent.slice(0, 6).map((p) => (
                  <li key={p.id + (p.injury ? 'i' : 's')} className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${backForMatch(p) ? 'bg-eau-fonce' : p.injury ? 'bg-corail' : LINE_COLOR.GB.bg}`} aria-hidden />
                    <PlayerLink player={p} />
                    <span className="truncate text-xs text-brun">
                      {backForMatch(p) ? t('fm.mc.backForMatch', { days: p.injuryDays }) : p.injury ? p.injury + (p.injuryDays ? ` (${p.injuryDays} j)` : '') : p.suspension}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {s.topScorer && (
              <p className="text-sm text-brun">
                {t('fm.mc.topScorer')} <b className="text-canard">{s.topScorer.name}</b> ({s.topScorer.goals})
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Feuille de match : remplacements prévus et ajustements selon le score. */}
      {plan && !(sheetOpen || live || !!game || (nm?.inDays != null && nm.inDays <= 1)) && (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm">
            <b className="text-canard">{t('fm.matchSheet.title')}</b>{' '}
            <span className="text-brun">{t('fm.matchSheet.folded', { subs: subs.length, tweaks: tweaks.length })}</span>
          </p>
          <button type="button" className="chip" onClick={() => setSheetOpen(true)}>
            {t('fm.matchSheet.open')}
          </button>
        </div>
      )}
      {plan && (sheetOpen || live || !!game || (nm?.inDays != null && nm.inDays <= 1)) && (
        <div className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2>{t('fm.matchSheet.title')}</h2>
            <button type="button" className={chip(live)} aria-pressed={live} onClick={() => setLive((v) => !v)}>
              {t(live ? 'fm.matchSheet.live.on' : 'fm.matchSheet.live.start')}
            </button>
          </div>
          <p className="mb-3 text-xs text-brun">{t(live ? (fromGame ? 'fm.matchSheet.live.helpGame' : 'fm.matchSheet.live.help') : 'fm.matchSheet.help')}</p>
          {live && (
            <div className="mb-3 space-y-2 rounded-lg bg-eau/10 p-3 text-sm">
              {game && (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full bg-corail px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">{t(game.final ? 'fm.matchSheet.live.gameFinal' : 'fm.matchSheet.live.gameLive')}</span>
                  <span className="font-bold text-canard">
                    {t(game.side === 'home' ? 'fm.matchSheet.live.vsHome' : 'fm.matchSheet.live.vsAway', { opponent: game.opponent })}
                  </span>
                  <span className="font-display text-xl font-semibold tabular-nums text-canard">
                    {game.goalsFor} - {game.goalsAgainst}
                  </span>
                  {!game.final && <span className="tabular-nums text-brun">{game.minute}'</span>}
                  <button type="button" className={chip(manual)} aria-pressed={manual} onClick={() => setManual((v) => !v)}>
                    {t('fm.matchSheet.live.manual')}
                  </button>
                </div>
              )}
              {!fromGame && (
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 font-bold text-canard">
                  {t('fm.matchSheet.live.minute')}
                  <input type="range" min={0} max={95} step={5} value={minute} onChange={(e) => setMinute(Number(e.target.value))} className="w-40 accent-[#8F5400]" />
                  <span className="w-10 tabular-nums">{minute}'</span>
                </label>
                <div className="flex items-center gap-1">
                  <span className="font-bold text-canard">{t('fm.matchSheet.live.score')}</span>
                  <button type="button" className={chip(false)} onClick={() => setDiff((d) => d - 1)} aria-label={t('fm.matchSheet.live.conceded')}>
                    −
                  </button>
                  <span className="w-24 text-center font-bold tabular-nums">
                    {diff > 0 ? t('fm.matchSheet.live.ahead', { n: diff }) : diff < 0 ? t('fm.matchSheet.live.behind', { n: -diff }) : t('fm.matchSheet.live.level')}
                  </span>
                  <button type="button" className={chip(false)} onClick={() => setDiff((d) => d + 1)} aria-label={t('fm.matchSheet.live.scored')}>
                    +
                  </button>
                </div>
              </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={chip(tired)} aria-pressed={tired} onClick={() => setTired((v) => !v)}>
                  {t('fm.matchSheet.when.tired')}
                </button>
                <button type="button" className={chip(opponentChanged)} aria-pressed={opponentChanged} onClick={() => setOpponentChanged((v) => !v)}>
                  {t('fm.matchSheet.when.opponentChange')}
                </button>
              </div>
            </div>
          )}
          {isFriendly(s.nextMatch?.competition) ? (
            <p className="mb-3 rounded-lg bg-orange-clair p-2.5 text-sm text-canard">{t('fm.matchSheet.friendly')}</p>
          ) : (
            <div className="mb-3 rounded-lg bg-canard/5 p-2.5 text-sm">
              {s.nextMatch && (
                <p className={`mb-1 ${weight.rotate ? 'text-brun' : 'font-bold text-canard'}`}>
                  {weight.reason === 'cup' || weight.reason === 'congested' ? t(`fm.matchSheet.weight.${weight.reason}`) : weight.importance === 'high' ? t('fm.matchSheet.weight.high', { competition: s.nextMatch.competition ?? '' }) : null}
                </p>
              )}
              <p>
                <b className="text-canard">{t('fm.matchSheet.rules', { competition: s.nextMatch?.competition ?? t('fm.matchSheet.competition') })}</b>{' '}
                {t('fm.matchSheet.subsRule', { count: rules.subs, windows: rules.windows ?? '–' })}
              </p>
              {checks.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {checks.map((c) => (
                    <li key={c.id} className={c.status === 'bad' ? 'font-bold text-corail' : c.status === 'ok' ? 'text-eau-fonce' : 'text-brun'}>
                      {t(`fm.matchSheet.check.${c.id}`, { need: c.need, have: c.have ?? '?' })} · {t(c.status === 'ok' && c.verified ? 'fm.matchSheet.status.okVerified' : `fm.matchSheet.status.${c.status}`)}
                    </li>
                  ))}
                </ul>
              )}
              {rules.unverified && <p className="mt-1 text-xs text-brun">{t('fm.matchSheet.unverified')}</p>}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-bold text-canard">{t('fm.matchSheet.subs')}</p>
              {subs.length ? (
                <ul className="space-y-1.5 text-sm">
                  {subs.map((c, i) => (
                    <li
                      key={c.slot}
                      className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg ${subState[i] === 'now' ? 'bg-eau/15 p-1.5 ring-1 ring-eau-fonce/40' : subState[i] === 'done' ? 'opacity-50 line-through' : ''}`}
                    >
                      {live ? (
                        <input type="checkbox" className="h-4 w-4 accent-[#8F5400]" checked={subState[i] === 'done'} onChange={() => toggleDone(c.slot)} aria-label={t('fm.matchSheet.live.done')} />
                      ) : null}
                      <span className="w-10 shrink-0 font-bold tabular-nums text-eau-fonce">{c.minute}'</span>
                      <PlayerLink player={c.out} focus="form" />
                      <span className="text-brun" aria-hidden>
                        →
                      </span>
                      <PlayerLink player={c.in} />
                      {subState[i] === 'now' && <span className="text-xs font-bold uppercase text-eau-fonce">{t('fm.matchSheet.live.now')}</span>}
                      <span className="w-full pl-12 text-xs text-brun">{t(`fm.matchSheet.reason.${c.reason}`)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-brun">{t('fm.matchSheet.noSubs')}</p>
              )}
            </div>
            <div>
              <p className="mb-2 text-sm font-bold text-canard">{t('fm.matchSheet.tweaks')}</p>
              <dl className="space-y-1.5 text-sm">
                {tweaks.map((x) => (
                  <div key={x.situation} className={live ? (active.includes(x.situation) ? 'rounded-lg bg-eau/15 p-1.5 ring-1 ring-eau-fonce/40' : 'opacity-45') : ''}>
                    <dt className="font-bold text-canard">
                      {t(`fm.matchSheet.when.${x.situation}`)}
                      {live && active.includes(x.situation) && <span className="ml-2 text-xs uppercase text-eau-fonce">{t('fm.matchSheet.live.now')}</span>}
                    </dt>
                    <dd className="text-brun">{x.tweaks.length ? x.tweaks.map((k) => t(`fm.matchSheet.tweak.${k}`)).join(' + ') : t('fm.matchSheet.followStaff')}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

