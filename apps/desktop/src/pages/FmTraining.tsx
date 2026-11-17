import { roleCeiling, snapshotWinterBreak,
  fm27ScheduleDays,
  fm27ScheduleName,
  CLUB_STATUSES,
  CONDITION_LEVELS,
  PART_TIME_DAYS,
  TRAINING_PHASES,
  addDays,
  autoPhase,
  buildProject,
  projectCompat,
  buildTrainingWeek,
  effectiveness,
  individualAdvice,
  matchStats,
  statsBoard,
  mentoringGroups,
  seasonWeeks,
  firstTeamBar,
  youthTeams,
  youthWeek,
  type YouthStatus,
  calendarFixtures,
  weekWorkload,
  nearestPreset,
  defaultMatchDays,
  mondayOf,
  sessionCategory,
  setupStatus,
  trainingFor,
  snapshotFixtures,
  weekMatches,
  type ClubStatus,
  type CycleWeek,
  type EffArea,
  type FmPlayer,
  type FmSnapshot,
  type IndividualIntensity,
  type IndividualSetup,
  type SetupField,
  type SetupStatus,
  type TacticEngine,
  type WorkPlan,
  type ProjectCompat,
  type SessionCategory,
  type SessionId,
  type TrainingPhase,
  type DayKind,
  type TrainingDay,
  type WhyId,
  HARVEST_WEEK_YIELD,
  SESSION_YIELD,
  DEFAULT_METHOD,
  focusAdvice,
  focusReview,
  keyAttrs,
  FOCUS_REVIEW_DAYS,
  type FocusKeep,
  growthOutlook,
  roleAdvice,
  teamAppsOf,
  teamIntensityFor,
  BUSY_WEEK_MATCHES,
  type FocusWhy,
  type GrowthOutlook,
  type GrowthVerdict,
  type RoleWhy,
  trainingYield,
  yieldDaysMissing,
  type SquadAt,
} from '@fm-immersion/module-fm';
import { projectStyle } from '@fm-immersion/module-fm';
import { invoke } from '@tauri-apps/api/core';
import { useContext, useMemo, useState, type ReactNode } from 'react';
import type { SeasonWeekKind } from '@fm-immersion/module-fm';
import { useTranslation } from 'react-i18next';
import { readScoped, useFmSaveScope, writeScoped } from '../lib/save-store';
import { ReserveContext, useTacticEngine } from './FmTactic';
import { Chips, CompatTag, Fit, Panel, Pos, Tag, useCoach, useFormat, useNames, More, PlayerLink, SectionTabs } from './FmUi';

/** Couleur des pastilles par catégorie de séance (texte toujours canard, sauf le match en bouton principal). */
const CAT_CLS: Record<SessionCategory, string> = {
  physical: 'bg-brun/15 text-canard',
  tactical: 'bg-canard/15 text-canard',
  matchPrep: 'bg-eau/60 text-canard',
  ballWork: 'bg-eau/20 text-canard',
  individual: 'bg-white text-canard ring-1 ring-canard/20',
  extra: 'bg-creme text-brun ring-1 ring-brun/30',
  match: 'bg-eau-fonce text-white',
};
/** Semaines montrées avant « Voir toute la saison ». */
const SEASON_PREVIEW = 8;
const KIND_TONE: Record<SeasonWeekKind, 'good' | 'info' | 'warn' | 'bad'> = {
  preseason: 'info',
  tactical: 'info',
  break: 'good',
  free: 'good',
  single: 'info',
  double: 'warn',
  congested: 'bad',
  offseason: 'good',
};
/** Fond et bandeau de chaque carte de jour, selon ce qu'on y fait. */
const DAY_BG: Record<DayKind, string> = { match: 'bg-eau/15', recovery: 'bg-white/60', prep: 'bg-white/60', dev: 'bg-white/80', off: 'bg-creme/60', rest: 'bg-creme' };
const DAY_HEAD: Record<DayKind, string> = {
  match: 'bg-eau-fonce text-white',
  recovery: 'bg-brun/15 text-canard',
  prep: 'bg-eau/40 text-canard',
  dev: 'bg-orange-clair text-canard',
  off: 'bg-creme text-brun',
  rest: 'bg-brun/10 text-canard',
};

/**
 * Séances d'un jour à recopier, regroupées par raison : deux séances qui ont la même raison n'en affichent qu'une,
 * et un jour de repos complet (Repos, Repos) ne montre qu'une pastille. Les créneaux vides restent vides en jeu.
 */
function daySessions(d: TrainingDay): { sessions: SessionId[]; why: WhyId | null }[] {
  const list = d.sessions.flatMap((s, i) => (s && s !== 'match' ? [{ s, why: d.why?.[i] ?? null }] : []));
  if (list.length > 1 && list.every((x) => x.s === 'rest')) return [{ sessions: ['rest'], why: list[0]!.why }];
  const out: { sessions: SessionId[]; why: WhyId | null }[] = [];
  for (const x of list) {
    const last = out.at(-1);
    if (last && last.why === x.why) last.sessions.push(x.s);
    else out.push({ sessions: [x.s], why: x.why });
  }
  return out;
}

const CATS: SessionCategory[] = ['tactical', 'ballWork', 'matchPrep', 'physical', 'individual', 'extra'];

function Session({ id }: { id: SessionId }) {
  const { t } = useTranslation();
  return <span className={`block rounded-lg px-2 py-1 text-xs font-bold leading-tight ${CAT_CLS[sessionCategory(id)]}`}>{t(`fm.train.session.${id}`)}</span>;
}

/**
 * Réglages individuels notés comme faits en jeu, par partie (retenus sur ce PC).
 * Ils étaient rangés par dossier du plugin, commun à toutes les parties : la plus ancienne partie les reprend.
 */
const SETUP_KEY = 'fmi.individual';
export function useAppliedSetups(folder: string) {
  const scope = useFmSaveScope();
  const [applied, setApplied] = useState(() => readScoped<Record<string, IndividualSetup>>(SETUP_KEY, scope, {}, `${SETUP_KEY}.${folder}`));
  const save = (next: Record<string, IndividualSetup>) => {
    setApplied(next);
    writeScoped(SETUP_KEY, scope, next);
  };
  return [applied, save] as const;
}

export interface SetupRow {
  plan: WorkPlan;
  /** Note de projet (A à E) du joueur. */
  compat: ProjectCompat;
  rec: IndividualSetup;
  advice: ReturnType<typeof individualAdvice>;
  status: SetupStatus;
  changed: SetupField[];
  /** Priorité choisie d'après les stats de match (centre de données) plutôt que les attributs du rôle. */
  focusFromStats: boolean;
  /** Pourquoi cette priorité, ces rôles, et ce que le joueur peut encore gagner. */
  focusWhy: FocusWhy;
  roleWhy: RoleWhy;
  devRole: 'dm' | 'am' | null;
  outlook: GrowthOutlook;
  /** Priorité gardée (moins de trois mois), à revoir (trois mois passés) ou plus adaptée à son rôle. */
  focusKeep: FocusKeep | null;
  /** Jours depuis que la priorité réglée en jeu a été choisie. */
  focusDays: number | null;
}
const STATUS_ORDER: Record<SetupStatus, number> = { change: 0, todo: 1, ok: 2 };

/** Conseil individuel du jour pour chaque joueur, comparé à ce qui est réglé en jeu. */
/** Séances de la table de rendement, par famille (voir `SESSION_YIELD`). */
const YIELD_GROUPS = {
  physical: ['conditioning', 'heavyConditioning', 'lightConditioning', 'recovery', 'rest'],
  ball: ['possessionBallWork', 'attackingBalanced', 'defendingBalanced', 'individualDevelopment'],
  tactical: ['pressingTrap', 'buildUpStrategy', 'chanceCreation', 'inPossessionShape', 'teamBonding'],
} as const;

export function useIndividualSetups(engine: TacticEngine, players: FmPlayer[], folder: string, matches: number, snap?: FmSnapshot) {
  const [coach] = useCoach();
  // Point le plus faible en match (bas de sa ligne, assez de minutes) : il passe avant l'attribut le plus faible du rôle.
  const statFocus = useMemo(() => {
    const out = new Map<string, string>();
    if (!snap) return out;
    for (const r of statsBoard(players, matchStats(snap)).players) if (r.focus) out.set(r.player.id, r.focus);
    return out;
  }, [players, snap]);
  const [applied, save] = useAppliedSetups(folder);
  const list = useMemo(() => players.filter((p) => Object.keys(p.attributes).length), [players]);
  const project = useMemo(() => buildProject(engine, list, coach), [engine, list, coach]);
  const teamApps = useMemo(() => teamAppsOf(players), [players]);
  const rows = useMemo<SetupRow[]>(() => {
    if (!project) return [];
    return project.plans
      .map((x) => {
        const advice = individualAdvice(x.player, { matches });
        const ip = x.slot ? (engine.roles.get(x.slot.ip) ?? null) : x.phase === 'ip' ? x.role : null;
        const oop = x.slot ? (engine.roles.get(x.slot.oop) ?? null) : x.phase === 'oop' ? x.role : null;
        const fromStats = statFocus.get(x.player.id) ?? null;
        const focus = focusAdvice(x.player, x.weak, fromStats);
        const roles = roleAdvice(x);
        // La priorité déjà réglée se garde trois mois, sauf si elle n'a plus de sens pour son rôle.
        const was = applied[x.player.id];
        const review = focusReview(was, focus.focus, {
          gameDate: snap?.gameDate ?? null,
          roleKeys: x.role ? keyAttrs(engine, x.role.code, x.phase, 8) : [],
          fromStats,
          age: x.player.age,
          gk: x.player.positions[0] === 'GB',
        });
        const rec: IndividualSetup = {
          ip: ip?.code ?? null,
          oop: oop?.code ?? null,
          focus: review.focus,
          intensity: advice.intensity,
        };
        return {
          plan: x,
          compat: projectCompat(engine, project, x.player),
          rec,
          advice,
          focusFromStats: !!fromStats && review.focus === fromStats,
          focusWhy: review.keep === 'kept' ? 'none' : focus.why,
          focusKeep: review.keep,
          focusDays: review.days,
          roleWhy: roles.why,
          devRole: roles.devRole,
          outlook: growthOutlook(x.player, teamApps),
          ...setupStatus(rec, applied[x.player.id]),
        };
      })
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  }, [project, engine, matches, applied, statFocus, teamApps, snap?.gameDate]);
  const mark = (ids: string[], on: boolean) => {
    const next = { ...applied };
    for (const r of rows) {
      const id = r.plan.player.id;
      if (!ids.includes(id)) continue;
      if (!on) {
        delete next[id];
        continue;
      }
      // La date compte depuis le dernier changement de priorité, pas depuis la dernière coche.
      const prev = applied[id];
      const since = prev && prev.focus === r.rec.focus ? (prev.since ?? snap?.gameDate) : snap?.gameDate;
      next[id] = { ...r.rec, ...(since ? { since } : {}) };
    }
    save(next);
  };
  return { rows, applied, mark };
}

/** Semaine d'entraînement type (méthode « Freedom » de FM Scout) adaptée au calendrier et au style visé. */
const INTENSITY_TONE: Record<IndividualIntensity, 'good' | 'info' | 'warn' | 'bad'> = { team: 'info', noWork: 'bad', rest: 'warn', half: 'warn', normal: 'info', double: 'good' };

export function FmTraining({ snap, players, folder, history = [] }: { snap: FmSnapshot; players: FmPlayer[]; folder: string; history?: SquadAt[] }) {
  const { t, i18n } = useTranslation();
  const f = useFormat();
  const { engine } = useTacticEngine(folder, players);
  const [coach, setCoach] = useCoach();
  const seasonStart = coach.seasonStart ?? 8;
  const clubStatus: ClubStatus = coach.clubStatus ?? 'pro';
  // Une seule proposition : le programme FM Immersion (progression mesurée + efficacité tactique + calendrier).
  const method = DEFAULT_METHOD;
  const trainingDays = clubStatus === 'pro' ? undefined : coach.trainingDays ?? PART_TIME_DAYS;
  // Semaine affichée, en semaines après la semaine en cours (0 = cette semaine) ; la vue saison permet d'en choisir une.
  const [offset, setOffset] = useState('0');
  const [allSeason, setAllSeason] = useState(false);
  const [phaseOverride, setPhase] = useState<TrainingPhase | null>(null);
  const [weekOverride, setWeek] = useState<CycleWeek | null>(null);
  const [manualDays, setManualDays] = useState<number[] | null>(null);
  const [eve, setEve] = useState<boolean | null>(null);

  const monday = addDays(mondayOf(snap.gameDate), Number(offset) * 7);
  // Trêve jamais réglée par le joueur : on la déduit du calendrier (cinq semaines sans match en hiver).
  const winterBreak = coach.winterBreak === undefined ? snapshotWinterBreak(snap) : coach.winterBreak;
  const auto = autoPhase(monday, seasonStart, winterBreak);
  const phase = phaseOverride ?? auto.phase;
  const week = weekOverride ?? (phaseOverride && phaseOverride !== auto.phase ? 1 : auto.week);
  const fixtures = useMemo(() => snapshotFixtures(snap), [snap]);
  // Calendrier complet lu par le plugin (toute la saison) : une semaine sans match connu n'a pas de match.
  const calendarComplete = useMemo(() => calendarFixtures(snap).length > 0, [snap]);
  // Au-delà du dernier match connu du calendrier, on revient aux jours cochés.
  const hasCalendar = calendarComplete || fixtures.some((f) => f.date >= monday);
  const cal = useMemo(() => weekMatches(fixtures, monday), [fixtures, monday]);
  const matchDays = manualDays ?? (hasCalendar ? cal.days : defaultMatchDays(phase, week, phase === 'A' || phase === 'B' || phase === 'C' ? 1 : 0));
  const before = eve ?? (hasCalendar ? cal.before : false);

  const style = projectStyle(engine, coach);
  // Zones à travailler : la n° 1 du style visé, puis les zones les moins comprises d'après le jeu, puis le reste du style.
  const styleAreas = style ? trainingFor(style) : [];
  const gauges = effectiveness(snap);
  const weakest = gauges?.weakest ?? [];
  const gaugesKnown = !!gauges;
  // Efficacité tactique globale : elle règle le nombre de séances tactiques de la semaine.
  const teOverall = gauges?.overall?.mid ?? null;
  // Puis ce que montrent les matchs (centre de données : passes ratées, pressing inefficace…).
  const fromMatches = useMemo(() => statsBoard(players, matchStats(snap)).areas, [players, snap]);
  const priorities = [...new Set<EffArea>([...styleAreas.slice(0, 1), ...weakest, ...fromMatches, ...styleAreas])];
  const names = useNames();
  const mentoring = useMemo(() => mentoringGroups(players), [players]);
  const attr = (k: string) => t(`fm.attr.${k}`, { defaultValue: k });
  const season = useMemo(
    () => seasonWeeks({ gameDate: snap.gameDate, fixtures, seasonStart, winterBreak, trainingDays, priorities, style: style?.id, method, weakAreas: weakest, gaugesKnown, teOverall, calendarComplete }),
    [snap.gameDate, fixtures, calendarComplete, seasonStart, winterBreak?.from, winterBreak?.to, trainingDays?.join(), priorities.join(), style?.id, method, weakest.join(), gaugesKnown, teOverall],
  );
  // Dernière semaine qu'on peut ouvrir avec les flèches : la fin de la saison calculée, au moins trois mois.
  const lastMonday = season.at(-1)?.monday;
  const maxOffset = Math.max(12, lastMonday ? Math.round((Date.parse(lastMonday) - Date.parse(mondayOf(snap.gameDate))) / (7 * 86_400_000)) : 0);
  const plan = useMemo(
    () => buildTrainingWeek({ monday, phase, week, matchDays, matchBeforeMonday: before, priorities, style: style?.id, trainingDays, method, weakAreas: weakest, gaugesKnown, teOverall }),
    [monday, phase, week, matchDays.join(), before, priorities.join(), style?.id, trainingDays?.join(), method, weakest.join(), gaugesKnown, teOverall],
  );
  // Séances réellement travaillées par famille (sans les créneaux de repos), pour la légende du planning.
  const realLoad: Partial<Record<SessionCategory, number>> = {};
  for (const d of plan.days) for (const x of d.sessions) if (x && x !== 'rest' && x !== 'match') realLoad[sessionCategory(x)] = (realLoad[sessionCategory(x)] ?? 0) + 1;
  // Résumé de la semaine : séances tactiques (efficacité), séances de progression (attributs), matchs.
  const whys = plan.days.flatMap((d) => d.why ?? []);
  const summary = {
    tactical: whys.filter((w) => w === 'press' || w === 'weak' || w === 'top' || w === 'rotate').length,
    grow: whys.filter((w) => w === 'grow' || w === 'devBlock' || w === 'noCondition' || w === 'indiv').length,
    matches: plan.days.filter((d) => d.kind === 'match').length,
  };
  // Semaine chargée : plus de double intensité (voir BUSY_WEEK_MATCHES).
  const busy = summary.matches >= BUSY_WEEK_MATCHES;
  const teamIntensity = teamIntensityFor(method, summary.matches);
  // Ouvrir une semaine donnée (flèches, ou clic dans La saison) : on revient sur l'onglet de la semaine.
  const [jump, setJump] = useState<{ id: string; n: number } | undefined>();
  const goToWeek = (o: number, open = false) => {
    setOffset(String(Math.max(0, o)));
    setManualDays(null);
    setEve(null);
    setPhase(null);
    setWeek(null);
    if (open) {
      setJump((j) => ({ id: 'week', n: (j?.n ?? 0) + 1 }));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
  const resetWeek = () => {
    setManualDays(null);
    setEve(null);
  };
  const toggleDay = (d: number) => setManualDays(matchDays.includes(d) ? matchDays.filter((x) => x !== d) : [...matchDays, d].sort());
  const label = 'flex flex-col text-xs font-bold text-canard/70';
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const monthName = new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: 'long' });
  const dayMonth = new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const setups = useIndividualSetups(engine, players, folder, plan.days.filter((d) => d.kind === 'match').length, snap);
  const todoCount = setups.rows.filter((r) => r.status !== 'ok').length;
  const changeCount = setups.rows.filter((r) => r.status === 'change').length;
  // Phrases de l'adjoint : zones tactiques de la semaine (hors pièges), rendement mesuré sur les instantanés.
  const zones = [...new Set(plan.days.flatMap((d) => d.sessions.filter((x, i) => x && x !== 'pressingTrap' && (d.why?.[i] === 'weak' || d.why?.[i] === 'top' || d.why?.[i] === 'rotate'))))] as SessionId[];
  const zoneList = [t('fm.train.session.pressingTrap'), ...zones.map((z) => t(`fm.train.session.${z}`))].join(', ');
  const measured = useMemo(() => trainingYield(history), [history]);
  const missingDays = useMemo(() => yieldDaysMissing(history), [history]);
  const signed = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
  const seasonal = 'ABC'.includes(plan.phase);
  const workload = weekWorkload(plan);
  const settingsSummary = t('fm.train.settingsSummary', {
    phase: `${t(`fm.train.phase.${plan.phase}`)} ${plan.week}`,
    status: t(`fm.train.status.${clubStatus}`),
    month: monthName.format(new Date(2026, seasonStart - 1, 1)),
    winter: winterBreak ? t('fm.train.settingsWinter') : '',
  });

  return (
    <SectionTabs
      id="training"
      jump={jump}
      sections={[
        {
          id: 'week',
          label: t('fm.train.sections.week'),
          node: (
            <>
              {/* 1. L'essentiel : ce que dit l'adjoint, puis les gestes à faire dans le jeu, numérotés. */}
              <Panel
                title={t('fm.train.coach.title')}
                action={
                  <div className="flex items-center gap-1.5" role="group" aria-label={t('fm.train.which')}>
                    <button type="button" className="btn-secondary px-2.5 py-1 text-sm disabled:opacity-40" disabled={Number(offset) <= 0} onClick={() => goToWeek(Number(offset) - 1)} aria-label={t('fm.train.prevWeek')}>
                      ‹
                    </button>
                    <span className="min-w-[8.5rem] text-center text-sm font-bold">
                      {offset === '0' ? t('fm.train.thisWeek') : offset === '1' ? t('fm.train.nextWeek') : t('fm.train.weekOfDate', { date: dayMonth.format(new Date(`${monday}T00:00:00Z`)) })}
                    </span>
                    <button type="button" className="btn-secondary px-2.5 py-1 text-sm disabled:opacity-40" disabled={Number(offset) >= maxOffset} onClick={() => goToWeek(Number(offset) + 1)} aria-label={t('fm.train.nextWeekBtn')}>
                      ›
                    </button>
                  </div>
                }
              >
                <p className="text-sm text-brun">{t('fm.train.coach.week', { date: dayMonth.format(new Date(`${monday}T00:00:00Z`)), code: plan.code })}</p>
                <p className="mt-1 text-base font-bold text-canard">
                  {plan.congested
                    ? t('fm.train.coach.congested', { matches: summary.matches })
                    : seasonal && plan.mode
                      ? t(`fm.train.mode.${plan.mode}`, { te: teOverall != null ? Math.round(teOverall) : '?', count: summary.tactical, grow: summary.grow, zones: zoneList })
                      : t(`fm.train.phaseHelp.${plan.phase}`)}
                </p>
                <SendToFm folder={folder} monday={monday} days={fm27ScheduleDays(plan)} />
                <p className="mt-3 text-xs font-bold uppercase tracking-wide text-canard/60">{t('fm.train.steps.title')}</p>
                <ol className="mt-1 space-y-1.5 text-sm">
                  {[
                    workload ? t('fm.train.steps.preset', { preset: t(`fm.train.preset.${nearestPreset(plan)}`), workload: t(`fm.train.workload.${workload}`) }) : t('fm.train.steps.presetRest', { preset: t(`fm.train.preset.${nearestPreset(plan)}`) }),
                    t('fm.train.steps.copy'),
                    t(busy ? 'fm.train.steps.intensityBusy' : 'fm.train.steps.intensity'),
                    ...(setups.rows.length > 0 ? [todoCount ? t('fm.train.steps.setups', { count: todoCount }) : t('fm.train.steps.setupsOk')] : []),
                  ].map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-orange text-xs font-bold text-canard">{i + 1}</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </Panel>

              {/* 2. La semaine jour par jour : seulement les séances à recopier, la raison sous chacune. */}
              <Panel title={t('fm.train.dayByDay')} action={<span className="text-xs text-brun">{t('fm.train.code', { code: plan.code })}</span>}>
                <div className="mb-3 flex flex-wrap gap-2 text-xs">
                  {CATS.filter((c) => c !== 'extra' && realLoad[c]).map((c) => (
                    <span key={c} className={`rounded-full px-2 py-0.5 font-bold ${CAT_CLS[c]}`}>
                      {t(`fm.train.cat.${c}`)} × {realLoad[c]}
                    </span>
                  ))}
                </div>
                <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
                  {plan.days.map((d) => {
                    const items = daySessions(d);
                    return (
                      <div key={d.date} className={`overflow-hidden rounded-xl ring-1 ring-canard/10 ${d.kind === 'off' ? 'opacity-60' : ''} ${DAY_BG[d.kind]}`}>
                        <div className={`px-2 py-1.5 ${DAY_HEAD[d.kind]}`}>
                          <p className="text-sm font-bold">
                            {t(`fm.train.days.${d.weekday}`)} <span className="font-normal opacity-80">{dayMonth.format(new Date(`${d.date}T00:00:00Z`))}</span>
                          </p>
                          <p className="text-xs font-bold opacity-80">
                            {t(`fm.train.kind.${d.kind}`)}
                            {d.kind === 'match' && cal.opponents[d.weekday] ? ` · ${cal.opponents[d.weekday]}` : ''}
                          </p>
                        </div>
                        {d.kind !== 'match' && (
                          <div className="space-y-2 p-2">
                            {items.map((it, i) => (
                              <div key={i}>
                                <div className="space-y-1">
                                  {it.sessions.map((s, j) => (
                                    <Session key={j} id={s} />
                                  ))}
                                </div>
                                {it.why && <p className="mt-1 text-[11px] leading-snug text-brun">{t(`fm.train.why.${it.why}`)}</p>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <More>{plan.theme == null && seasonal ? t('fm.train.coachHelp') : t(`fm.train.phaseHelp.${plan.phase}`)}</More>
              </Panel>

              {/* 3. Pourquoi cette semaine : le côté pédagogique, après la semaine elle-même. */}
              {seasonal && plan.lessons && plan.lessons.some((l) => l.id !== 'mode' && l.id !== 'modeUnknown') && (
                <Panel title={t('fm.train.coach.whyTitle')}>
                  <ul className="space-y-2 text-sm">
                    {plan.lessons
                      .filter((l) => l.id !== 'mode' && l.id !== 'modeUnknown')
                      .map((l) => (
                        <li key={l.id} className="rounded-lg bg-orange-clair/40 px-3 py-2">
                          {t(`fm.train.lesson.${l.id}`, l.params ?? {})}
                        </li>
                      ))}
                  </ul>
                  {(weakest.length > 0 || priorities.length > 0) && (
                    <More>
                      {weakest.length > 0 && <p>{t('fm.train.weakest', { list: weakest.map((a) => t(`fm.train.session.${a}`)).join(', ') })}</p>}
                      {priorities.length > 0 && <p className="mt-1">{t('fm.train.priorities', { list: priorities.map((a) => t(`fm.train.session.${a}`)).join(', ') })}</p>}
                    </More>
                  )}
                </Panel>
              )}

              <Panel title={t('fm.train.teamIntensity')}>
                {busy && <p className="mb-2 text-sm">{t('fm.train.busyIntensity', { count: summary.matches })}</p>}
                <div className="max-w-2xl">
                  {CONDITION_LEVELS.map((c) => (
                    <div key={c} className="flex flex-wrap items-center justify-between gap-2 border-b border-canard/5 py-1.5 text-sm last:border-0">
                      <span className="text-brun">{t(`fm.train.condition.${c}`)}</span>
                      <Tag tone={INTENSITY_TONE[teamIntensity[c]]}>{t(`fm.train.intensityLevel.${teamIntensity[c]}`)}</Tag>
                    </div>
                  ))}
                </div>
                <More>{t('fm.train.teamIntensityCoach')}</More>
              </Panel>

              <Panel title={t('fm.train.coach.yieldTitle')}>
              {measured ? (
                <>
                  {/* Le verdict d'abord ; les chiffres qui le justifient sont repliés. */}
                  <p className="mt-1 text-sm font-bold">
                    <Tag tone={measured.verdict === 'good' ? 'good' : measured.verdict === 'bad' ? 'bad' : 'warn'}>{t(`fm.train.coach.yieldVerdict.${measured.verdict}`)}</Tag>
                  </p>
                  <details className="mt-1">
                    <summary className="cursor-pointer select-none text-xs font-bold text-orange-fonce hover:underline">{t('fm.train.coach.yieldDetail')}</summary>
                  <p className="mt-1 text-sm">
                    {t('fm.train.coach.yield', { from: f.date(measured.from), to: f.date(measured.to), days: measured.days, players: measured.players, delta: signed.format(measured.perPlayer), month: signed.format(measured.perMonth), expected: signed.format(measured.expectedPerMonth) })}
                  </p>
                  <p className="mt-1 text-xs text-brun">
                    {t('fm.train.coach.yieldGroups', { technical: signed.format(measured.groups.technical), mental: signed.format(measured.groups.mental), physical: signed.format(measured.groups.physical) })}
                    {measured.young != null && measured.senior != null && <> {t('fm.train.coach.yieldAges', { young: signed.format(measured.young), senior: signed.format(measured.senior) })}</>}
                  </p>
                  {measured.attrs.length > 0 && measured.attrs[0]!.delta > 0 && (
                    <p className="mt-1 text-xs text-brun">{t('fm.train.coach.yieldAttrs', { list: measured.attrs.filter((a) => a.delta > 0).slice(0, 4).map((a) => `${attr(a.key)} ${signed.format(a.delta)}`).join(', ') })}</p>
                  )}
                  {measured.up.length > 0 && (
                    <p className="mt-1 text-xs text-eau-fonce">{t('fm.train.coach.yieldUp', { list: measured.up.slice(0, 5).map((g) => `${g.player.name} ${signed.format(g.delta)}`).join(', ') })}</p>
                  )}
                  {measured.down.length > 0 && (
                    <p className="mt-1 text-xs text-corail">{t('fm.train.coach.yieldDown', { list: measured.down.slice(0, 5).map((g) => `${g.player.name} ${signed.format(g.delta)}`).join(', ') })}</p>
                  )}
                  </details>
                </>
              ) : (
                <p className="mt-1 text-sm text-brun">{t('fm.train.coach.yieldSoon', { count: Math.max(1, missingDays) })}</p>
              )}
              <More>{t('fm.train.coach.yieldHelp')}</More>
              </Panel>

              <details className="rounded-2xl bg-white/40 ring-1 ring-canard/10">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold text-canard/70 hover:text-canard">
                  {t('fm.train.settings')} <span className="font-normal text-brun">· {settingsSummary}</span>
                </summary>
              <Panel title={t('fm.train.title')}>
                <div className="flex flex-wrap items-end gap-4">
                  <label className={label}>
                    {t('fm.train.phaseLabel')}
                    <select
                      className="input mt-1"
                      value={phaseOverride ?? ''}
                      onChange={(e) => {
                        setPhase((e.target.value || null) as TrainingPhase | null);
                        setWeek(null);
                        resetWeek();
                      }}
                    >
                      <option value="">{t('fm.train.auto', { code: `${t(`fm.train.phase.${auto.phase}`)} ${auto.week}` })}</option>
                      {TRAINING_PHASES.map((p) => (
                        <option key={p} value={p}>
                          {t(`fm.train.phase.${p}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={label}>
                    {t('fm.train.cycleWeek')}
                    <select className="input mt-1" value={week} onChange={(e) => setWeek(Number(e.target.value) as CycleWeek)}>
                      {[1, 2, 3, 4].map((w) => (
                        <option key={w} value={w}>
                          {phase}
                          {w}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={label}>
                    {t('fm.train.seasonStart')}
                    <select className="input mt-1" value={seasonStart} onChange={(e) => setCoach({ seasonStart: Number(e.target.value) })}>
                      {months.map((m) => (
                        <option key={m} value={m}>
                          {monthName.format(new Date(2026, m - 1, 1))}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className={label}>
                    {t('fm.train.clubStatus')}
                    <div className="mt-1">
                      <Chips value={clubStatus} options={CLUB_STATUSES.map((c) => [c, t(`fm.train.status.${c}`)] as [ClubStatus, string])} onChange={(v) => setCoach({ clubStatus: v })} />
                    </div>
                  </div>
                  <div className={label}>
                    <span className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={!!winterBreak}
                        onChange={(e) => {
                          setCoach({ winterBreak: e.target.checked ? { from: '12-28', to: '02-08' } : null });
                          setPhase(null);
                          setWeek(null);
                        }}
                      />
                      {t('fm.train.winterBreak')}
                    </span>
                    {winterBreak && (
                      <span className="mt-1 flex items-center gap-1.5 font-normal">
                        <input
                          type="date"
                          className="input"
                          aria-label={t('fm.train.winterFrom')}
                          value={`${monday.slice(0, 4)}-${winterBreak.from}`}
                          onChange={(e) => e.target.value && setCoach({ winterBreak: { ...winterBreak, from: e.target.value.slice(5) } })}
                        />
                        →
                        <input
                          type="date"
                          className="input"
                          aria-label={t('fm.train.winterTo')}
                          value={`${monday.slice(0, 4)}-${winterBreak.to}`}
                          onChange={(e) => e.target.value && setCoach({ winterBreak: { ...winterBreak, to: e.target.value.slice(5) } })}
                        />
                      </span>
                    )}
                  </div>
                </div>

                {trainingDays && (
                  <div className="mt-4">
                    <p className="text-xs font-bold text-canard/70">{t('fm.train.trainingDays')}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setCoach({ trainingDays: trainingDays.includes(d) ? trainingDays.filter((x) => x !== d) : [...trainingDays, d].sort() })}
                          className={`chip ${trainingDays.includes(d) ? 'chip-on' : ''}`}
                        >
                          {t(`fm.train.days.${d}`)}
                        </button>
                      ))}
                    </div>
                    <More>{t('fm.train.trainingDaysHelp')}</More>
                  </div>
                )}

                <div className="mt-4">
                  <p className="text-xs font-bold text-canard/70">
                    {t('fm.train.matches')} {hasCalendar && manualDays == null && <span className="font-normal text-brun">({t('fm.train.fromCalendar')})</span>}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleDay(d)}
                        className={`chip ${matchDays.includes(d) ? 'chip-on' : ''}`}
                      >
                        {t(`fm.train.days.${d}`)}
                      </button>
                    ))}
                    <label className="ml-2 flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={before} onChange={(e) => setEve(e.target.checked)} />
                      {t('fm.train.eve')}
                    </label>
                  </div>
                  {!hasCalendar && <p className="mt-1 text-xs text-brun">{t('fm.train.manual')}</p>}
                </div>
              </Panel>
              </details>

            </>
          ),
        },
        {
          id: 'season',
          label: t('fm.train.sections.season'),
          node: season.length > 0 ? (
            <>
              <Panel title={t('fm.train.season.title', { count: season.length })}>
                <p className="mb-2 text-sm text-brun">{calendarComplete ? t('fm.train.season.leadFull') : t('fm.train.season.lead', { known: season.filter((w) => !w.estimated).length })}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-canard/70">
                      <tr>
                        <th className="px-2 py-1">{t('fm.train.weekOf')}</th>
                        <th className="px-2 py-1">{t('fm.train.season.kindCol')}</th>
                        <th className="px-2 py-1">{t('fm.train.planCol')}</th>
                        <th className="px-2 py-1">{t('fm.train.season.matchesCol')}</th>
                        <th className="px-2 py-1">{t('fm.train.scheduleFocus')}</th>
                        <th className="px-2 py-1">{t('fm.train.workloadCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(allSeason ? season : season.slice(0, SEASON_PREVIEW)).map((w, i, list) => {
                        const month = w.monday.slice(0, 7);
                        const newMonth = i > 0 && list[i - 1]!.monday.slice(0, 7) !== month;
                        return (
                          <tr
                            key={w.monday}
                            onClick={() => goToWeek(Math.round((Date.parse(w.monday) - Date.parse(mondayOf(snap.gameDate))) / (7 * 86_400_000)), true)}
                            title={t('fm.train.season.open')}
                            className={`cursor-pointer border-t hover:bg-orange-clair/40 ${newMonth ? 'border-canard/25' : 'border-canard/5'} ${w.monday === monday ? 'bg-orange-clair/60' : ''}`}
                          >
                            <td className="whitespace-nowrap px-2 py-1.5">
                              {dayMonth.format(new Date(`${w.monday}T00:00:00Z`))}
                            </td>
                            <td className="px-2 py-1.5">
                              <Tag tone={KIND_TONE[w.kind]}>{t(`fm.train.season.kind.${w.kind}`)}</Tag>
                            </td>
                            <td className="px-2 py-1.5">
                              <b>{w.plan.code}</b> <span className="text-xs text-brun">{t(`fm.train.phase.${w.plan.phase}`)}</span>
                            </td>
                            <td className="px-2 py-1.5">
                              {w.estimated ? (
                                <span className="text-xs italic text-brun">{w.matches ? t('fm.train.season.assumed', { count: w.matches }) : '–'}</span>
                              ) : w.opponents.length ? (
                                <span className="text-xs">
                                  {w.opponents.map((o) => `${t(`fm.train.days.${o.weekday}`)} ${o.name ?? '?'}`).join(' · ')}
                                  {w.competitions.length ? <span className="text-brun"> ({w.competitions.join(', ')})</span> : null}
                                </span>
                              ) : (
                                '–'
                              )}
                            </td>
                            <td className="px-2 py-1.5 font-bold">{w.kind === 'offseason' ? '–' : t(`fm.train.preset.${w.preset}`)}</td>
                            <td className="px-2 py-1.5">{w.workload && w.kind !== 'offseason' ? <Tag tone={w.workload === 'heavy' ? 'good' : w.workload === 'medium' ? 'info' : 'warn'}>{t(`fm.train.workload.${w.workload}`)}</Tag> : '–'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {season.length > SEASON_PREVIEW ? (
                  <button type="button" className="btn-secondary mt-2 text-sm" onClick={() => setAllSeason(!allSeason)}>
                    {allSeason ? t('fm.train.season.less') : t('fm.train.season.more', { count: season.length })}
                  </button>
                ) : null}
                <More>{t('fm.train.season.help')}</More>
              </Panel>
            </>
          ) : null,
        },
        {
          id: 'individual',
          label: t('fm.train.sections.individual'),
          badge: todoCount ? <span className="rounded-full bg-orange px-1.5 text-xs font-bold text-canard">{todoCount}</span> : undefined,
          node: setups.rows.length > 0 ? (
            <>
              <Panel
                title={t('fm.train.individual')}
                action={
                  todoCount > 0 ? (
                    <button type="button" className="btn-secondary text-sm" onClick={() => setups.mark(setups.rows.filter((r) => r.status !== 'ok').map((r) => r.plan.player.id), true)}>
                      {t('fm.train.markAll')}
                    </button>
                  ) : undefined
                }
              >
                <p className="text-sm">
                  <b>{t('fm.train.setupDone', { done: setups.rows.length - todoCount, total: setups.rows.length })}</b>
                </p>
                <p className="mt-1 text-sm text-brun">{t('fm.train.indiv.lead')}</p>
                {(['change', 'todo', 'ok'] as SetupStatus[]).map((st) => {
                  const group = setups.rows.filter((r) => r.status === st);
                  if (!group.length) return null;
                  const cards = (
                    <div className="mt-2 space-y-2">
                      {group.map((r) => (
                        <SetupCard key={r.plan.player.id} row={r} was={setups.applied[r.plan.player.id]} engine={engine} onMark={(on) => setups.mark([r.plan.player.id], on)} />
                      ))}
                    </div>
                  );
                  return st === 'ok' ? (
                    <details key={st} className="mt-4">
                      <summary className="cursor-pointer select-none text-sm font-bold text-canard/70 hover:text-canard">{t('fm.train.indiv.group.ok', { count: group.length })}</summary>
                      {cards}
                    </details>
                  ) : (
                    <div key={st} className="mt-4">
                      <h3 className="text-sm font-bold text-canard">{t(`fm.train.indiv.group.${st}`, { count: group.length })}</h3>
                      {cards}
                    </div>
                  );
                })}
                <More>
                  <p>{t('fm.train.setupHelp')}</p>
                  <p className="mt-1">{t('fm.train.individualHelp')}</p>
                  <p className="mt-1">{t('fm.train.reasonHint')}</p>
                </More>
              </Panel>
            </>
          ) : null,
        },
        {
          id: 'learn',
          label: t('fm.train.sections.learn'),
          node: <LearnSection rows={setups.rows} teOverall={teOverall} />,
        },
        {
          id: 'youth',
          label: t('fm.train.sections.youth'),
          node: (
            <>
              <YouthPanel
                engine={engine}
                players={players}
                week={youthWeek({ gameDate: snap.gameDate, seasonStart, winterBreak, trainingDays, priorities, style: style?.id, method })}
              />

              <Panel title={t('fm.train.mentoring')}>
                {mentoring.groups.length ? (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {mentoring.groups.map((g) => (
                      <div key={g.mentor.id} className="rounded-xl bg-white/60 p-3 ring-1 ring-canard/10">
                        <p className="text-xs font-bold uppercase tracking-wide text-canard/50">{t('fm.train.mentor')}</p>
                        <p className="font-bold">
                          {g.mentor.name} <Pos player={g.mentor} />
                        </p>
                        <p className="text-xs text-brun">{[g.mentor.personality, g.mentor.hierarchy, g.mentor.age != null ? t('fm.train.age', { count: g.mentor.age }) : null].filter(Boolean).join(' · ')}</p>
                        <p className="mt-2 text-xs font-bold uppercase tracking-wide text-canard/50">{t('fm.train.mentees')}</p>
                        {g.mentees.map((y) => (
                          <p key={y.id} className="text-sm">
                            {y.name} <Pos player={y} /> <span className="text-xs text-brun">{[y.personality, y.age != null ? t('fm.train.age', { count: y.age }) : null].filter(Boolean).join(' · ')}</span>
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-brun">{t('fm.train.noMentoring')}</p>
                )}
                {mentoring.avoid.length > 0 && (
                  <p className="mt-3 text-sm">
                    <Tag tone="warn">{t('fm.train.avoid')}</Tag> {mentoring.avoid.map((p) => `${p.name} (${p.personality})`).join(', ')}
                  </p>
                )}
                {mentoring.unassigned.length > 0 && <p className="mt-2 text-xs text-brun">{t('fm.train.unassigned', { list: mentoring.unassigned.map((p) => p.name).join(', ') })}</p>}
                <More>{t('fm.train.mentoringHelp')}</More>
              </Panel>

              <details className="rounded-2xl bg-white/40 ring-1 ring-canard/10">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold text-canard/70 hover:text-canard">{t('fm.train.rules')}</summary>
              <Panel title={t('fm.train.rules')}>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <li key={i}>{t(`fm.train.rule${i}`)}</li>
                  ))}
                </ul>
                <More>{t('fm.train.source')}</More>
              </Panel>
              </details>
            </>
          ),
        },
      ]}
    />
  );
}


/** Banc d'essai FM27 de jamiebolden (Bradford, Premier League, trois saisons par réglage, 47 joueurs). */
const TE_TEST = [
  { id: 'none', points: 63.7, win: 48.2, injury: 362, growth: 7.0 },
  { id: 'some', points: 68.0, win: 50.9, injury: 469, growth: 7.0 },
  { id: 'lots', points: 69.3, win: 52.6, injury: 846, growth: 6.7 },
  { id: 'assistant', points: 50.0, win: 36.0, injury: 1072, growth: 6.7 },
] as const;

/**
 * « Comprendre » : ce que le moteur fait vraiment de l'entraînement, appliqué à l'effectif du joueur. Les chiffres
 * viennent des bancs d'essai de la communauté (aucune formule officielle).
 */
/** Écrit la semaine conseillée dans le dossier « schedules » de FM27 ; le joueur la charge lui-même dans le jeu. */
function SendToFm({ folder, monday, days }: { folder: string; monday: string; days: number[][] }) {
  const { t } = useTranslation();
  const name = fm27ScheduleName(monday);
  const [state, setState] = useState<{ key: string; ok: boolean; error?: string } | null>(null);
  const key = `${monday}|${JSON.stringify(days)}`;
  const shown = state?.key === key ? state : null;
  const send = () =>
    invoke<string>('fm_write_schedule', { folder, name, description: t('fm.train.send.description'), days })
      .then(() => setState({ key, ok: true }))
      .catch((e) => setState({ key, ok: false, error: String(e) }));
  return (
    <div className="mt-3 rounded-xl bg-orange-clair/50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary text-sm" onClick={send} disabled={!folder}>
          {t('fm.train.send.button')}
        </button>
        <span className="text-brun">{t('fm.train.send.help')}</span>
      </div>
      {shown?.ok && <p className="mt-2 font-bold text-canard">{t('fm.train.send.done', { name })}</p>}
      {shown && !shown.ok && <p className="mt-2 font-bold text-corail">{t('fm.train.send.error', { error: shown.error })}</p>}
    </div>
  );
}

function LearnSection({ rows, teOverall }: { rows: SetupRow[]; teOverall: number | null }) {
  const { t, i18n } = useTranslation();
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat(i18n.resolvedLanguage);
  const verdicts: GrowthVerdict[] = ['strong', 'good', 'limited', 'maintain', 'decline'];
  const counts = verdicts.map((v) => ({ v, list: rows.filter((r) => r.outlook.verdict === v).map((r) => r.plan.player) }));
  const minutes = rows.filter((r) => r.outlook.needsMinutes).map((r) => r.plan.player);
  const mode = teOverall == null ? 'unknown' : teOverall < 60 ? 'learn' : teOverall < 80 ? 'build' : 'keep';
  return (
    <>
      <Panel title={t('fm.train.learn.howTitle')}>
        <p className="text-sm">{t('fm.train.learn.howIntro')}</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {(['step1', 'step2'] as const).map((s) => (
            <div key={s} className="rounded-xl bg-white/60 p-3 ring-1 ring-canard/10">
              <p className="font-bold text-canard">{t(`fm.train.learn.${s}Title`)}</p>
              <p className="mt-1 text-sm">{t(`fm.train.learn.${s}`)}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs font-bold uppercase tracking-wide text-canard/60">{t('fm.train.learn.factorsTitle')}</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <li key={i}>{t(`fm.train.learn.factor${i}`)}</li>
          ))}
        </ul>
        <More>{t('fm.train.learn.howHelp')}</More>
      </Panel>

      {rows.length > 0 && (
        <Panel title={t('fm.train.learn.squadTitle')}>
          <p className="text-sm">{t('fm.train.learn.squadIntro')}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-5">
            {counts.map(({ v, list }) => (
              <div key={v} className="rounded-xl bg-white/60 p-2 ring-1 ring-canard/10">
                <Tag tone={OUTLOOK_TONE[v]}>{t(`fm.train.outlook.verdict.${v}`)}</Tag>
                <p className="mt-1 text-lg font-bold tabular-nums text-canard">{list.length}</p>
                <p className="text-xs leading-tight text-brun">{list.slice(0, 4).map((p) => p.name.split(' ').at(-1)).join(', ')}</p>
              </div>
            ))}
          </div>
          {minutes.length > 0 && (
            <p className="mt-3 text-sm">
              <Tag tone="warn">{t('fm.train.outlook.needsMinutes')}</Tag> {t('fm.train.learn.minutes', { list: minutes.map((p) => p.name).join(', ') })}
            </p>
          )}
          <p className="mt-3 text-sm">{t(`fm.train.learn.mode.${mode}`, { te: teOverall != null ? Math.round(teOverall) : '?' })}</p>
          <More>{t('fm.train.learn.squadHelp')}</More>
        </Panel>
      )}

      <Panel title={t('fm.train.learn.teTitle')}>
        <p className="text-sm">{t('fm.train.learn.teIntro')}</p>
        <div className="table-scroll mt-2">
          <table className="data-table">
            <thead className="text-left text-canard/70">
              <tr>
                <th className="px-2 py-1">{t('fm.train.learn.teSetup')}</th>
                <th className="px-2 py-1 text-right">{t('fm.train.learn.tePoints')}</th>
                <th className="px-2 py-1 text-right">{t('fm.train.learn.teWin')}</th>
                <th className="px-2 py-1 text-right">{t('fm.train.learn.teInjury')}</th>
                <th className="px-2 py-1 text-right">{t('fm.train.learn.teGrowth')}</th>
              </tr>
            </thead>
            <tbody>
              {TE_TEST.map((r) => (
                <tr key={r.id} className={`border-t border-canard/5 ${r.id === 'assistant' ? 'bg-corail/10' : ''}`}>
                  <td className="px-2 py-1.5 font-bold">{t(`fm.train.learn.te.${r.id}`)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nf1.format(r.points)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nf1.format(r.win)} %</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nf0.format(r.injury)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">+{nf1.format(r.growth)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          {[1, 2, 5, 6, 3, 4].map((i) => (
            <li key={i}>{t(`fm.train.learn.teLesson${i}`)}</li>
          ))}
        </ul>
        <More>{t('fm.train.learn.teHelp')}</More>
      </Panel>

      <Panel title={t('fm.train.learn.indivTitle')}>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {[1, 2, 3, 4, 5].map((i) => (
            <li key={i}>{t(`fm.train.learn.indiv${i}`)}</li>
          ))}
        </ul>
      </Panel>

      <YieldPanel />

      <Panel title={t('fm.train.learn.sourcesTitle')}>
        <p className="text-sm text-brun">{t('fm.train.learn.sources')}</p>
      </Panel>
    </>
  );
}

/** Ce que rapporte chaque séance aux attributs (mesure d'harvestgreen22). */
function YieldPanel() {
  const { t, i18n } = useTranslation();
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  return (
              <Panel title={t('fm.train.yield.title')}>
                <p className="text-sm">{t('fm.train.yield.intro', { best: nf1.format(HARVEST_WEEK_YIELD) })}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {(['physical', 'ball', 'tactical'] as const).map((g) => (
                    <div key={g} className="rounded-xl bg-white/60 p-2 ring-1 ring-canard/10">
                      <p className="text-xs font-bold text-canard/70">{t(`fm.train.yield.${g}`)}</p>
                      <ul className="mt-1 space-y-0.5 text-sm">
                        {YIELD_GROUPS[g].map((id) => (
                          <li key={id} className="flex justify-between gap-2">
                            <span>{t(`fm.train.session.${id}`)}</span>
                            <b className="tabular-nums text-canard">{nf1.format(SESSION_YIELD[id] ?? 0)}</b>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
                <More>{t('fm.train.yield.help')}</More>
              </Panel>
  );
}

const OUTLOOK_TONE: Record<GrowthVerdict, 'good' | 'info' | 'warn' | 'bad'> = { strong: 'good', good: 'good', limited: 'info', maintain: 'warn', decline: 'bad' };

/** Ce qu'un joueur peut encore gagner, et pourquoi (âge, marge sous son potentiel, temps de jeu, blessure). */
function Outlook({ o }: { o: GrowthOutlook }) {
  const { t } = useTranslation();
  const why = [
    o.age && t(`fm.train.outlook.age.${o.age}`),
    o.room && t(`fm.train.outlook.room.${o.room}`),
    o.minutes && t(`fm.train.outlook.minutes.${o.minutes}`),
    o.injured && t('fm.train.outlook.injured'),
  ].filter(Boolean);
  return (
    <span title={why.join(' · ')}>
      <Tag tone={OUTLOOK_TONE[o.verdict]}>{t(`fm.train.outlook.verdict.${o.verdict}`)}</Tag>
      {o.needsMinutes && <span className="mt-0.5 block text-[11px] font-bold leading-tight text-orange-fonce">{t('fm.train.outlook.needsMinutes')}</span>}
    </span>
  );
}

/** Un joueur de l'entraînement individuel : ses trois réglages, chacun avec sa raison, et la case « réglé en jeu ». */
function SetupCard({ row, was, engine, onMark }: { row: SetupRow; was: IndividualSetup | undefined; engine: TacticEngine; onMark: (on: boolean) => void }) {
  const { t } = useTranslation();
  const names = useNames();
  const { plan: x, compat, rec, advice: a, status, changed, focusFromStats, focusWhy, roleWhy, devRole, outlook, focusKeep, focusDays } = row;
  const attr = (k: string) => t(`fm.attr.${k}`, { defaultValue: k });
  const roleName = (code: string | null) => {
    const r = code ? engine.roles.get(code) : null;
    return r ? names.role(r) : '–';
  };
  const old = (f: SetupField) => {
    if (!was || !changed.includes(f)) return null;
    const v = was[f];
    const text = v == null ? '–' : f === 'focus' ? t(`fm.train.focus.${v}`) : f === 'intensity' ? t(`fm.train.intensityLevel.${v}`) : roleName(v);
    return <span className="mr-1 text-xs text-brun line-through">{text}</span>;
  };
  const why = [outlook.age && t(`fm.train.outlook.age.${outlook.age}`), outlook.room && t(`fm.train.outlook.room.${outlook.room}`), outlook.minutes && t(`fm.train.outlook.minutes.${outlook.minutes}`), outlook.injured && t('fm.train.outlook.injured')].filter(Boolean).join(', ');
  const field = 'text-[11px] font-bold uppercase tracking-wide text-canard/50';
  const note = 'mt-1 text-xs leading-snug text-brun';
  return (
    <div className={`rounded-xl p-3 ring-1 ${status === 'change' ? 'bg-ambre/10 ring-ambre/40' : 'bg-white/70 ring-canard/10'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <PlayerLink player={x.player} /> <Pos player={x.player} />
        </span>
        <span className="flex items-center gap-1.5 text-xs text-brun">
          {t('fm.train.outlook.col')} <Tag tone={OUTLOOK_TONE[outlook.verdict]}>{t(`fm.train.outlook.verdict.${outlook.verdict}`)}</Tag>
          {outlook.needsMinutes && <span className="font-bold text-orange-fonce">{t('fm.train.outlook.needsMinutes')}</span>}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-brun">
            {t('fm.proj.fit')} <Fit value={x.fit} />
          </span>
          <CompatTag c={compat} />
          <label className="flex cursor-pointer items-center gap-1.5 text-sm font-bold">
            <input type="checkbox" checked={status === 'ok'} onChange={(e) => onMark(e.target.checked)} />
            {t('fm.train.indiv.done')}
          </label>
        </span>
      </div>
      {why && <p className="mt-0.5 text-xs text-brun">{why}</p>}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div>
          <p className={field}>{t('fm.train.indiv.roles')}</p>
          <p className="text-sm">
            <span className="text-brun">{t('fm.train.indiv.ip')} </span>
            {old('ip')}
            <b>{roleName(rec.ip)}</b>
          </p>
          <p className="text-sm">
            <span className="text-brun">{t('fm.train.indiv.oop')} </span>
            {old('oop')}
            <b>{roleName(rec.oop)}</b>
          </p>
          <p className={note}>{roleWhy === 'youngBench' && devRole ? t('fm.train.roleWhy.youngBench', { role: t(`fm.train.devRole.${devRole}`) }) : t(`fm.train.roleWhy.${roleWhy}`)}</p>
        </div>
        <div>
          <p className={field}>{t('fm.train.focusCol')}</p>
          <p className="text-sm">
            {old('focus')}
            <b>{rec.focus ? t(`fm.train.focus.${rec.focus}`) : '–'}</b> {focusFromStats && <Tag>{t('fm.train.focusFromStats')}</Tag>}
          </p>
          {focusKeep === 'kept' ? (
            <p className={note}>{focusDays != null ? t('fm.train.focusKeep.kept', { count: focusDays, left: Math.max(1, FOCUS_REVIEW_DAYS - focusDays) }) : t('fm.train.focusKeep.keptNoDate')}</p>
          ) : (
            <>
              {focusKeep && <p className="mt-1 text-xs font-bold leading-snug text-orange-fonce">{t(`fm.train.focusKeep.${focusKeep}`, { count: focusDays ?? 0 })}</p>}
              {focusWhy !== 'none' && <p className={note}>{t(`fm.train.focusWhy.${focusWhy}`)}</p>}
            </>
          )}
          {x.weak.length > 0 && <p className="mt-0.5 text-xs text-brun">{t('fm.train.indiv.weak', { list: x.weak.map((w) => `${attr(w.key)} ${Math.round(w.value)}`).join(', ') })}</p>}
        </div>
        <div>
          <p className={field}>{t('fm.train.intensity')}</p>
          <p className="text-sm">
            {old('intensity')}
            <Tag tone={INTENSITY_TONE[a.intensity]}>{t(`fm.train.intensityLevel.${a.intensity}`)}</Tag>
          </p>
          <p className={note}>{[t(`fm.train.reason.${a.reason}`), a.rusty ? t('fm.train.rusty') : null].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
    </div>
  );
}

const YOUTH_TONE: Record<YouthStatus, 'good' | 'info' | 'warn' | 'bad'> = { promote: 'good', loan: 'warn', develop: 'info', low: 'bad' };

/**
 * Jeunes et équipe B : semaine type orientée progression, puis pour chaque joueur le rôle du projet à apprendre, la
 * priorité individuelle et ce qu'il faut en faire (monter, prêter, garder, libérer). Calendrier des jeunes non lu.
 */
function YouthPanel({ engine, week, players }: { engine: TacticEngine; week: ReturnType<typeof youthWeek>; players: FmPlayer[] }) {
  const { t } = useTranslation();
  const names = useNames();
  const [coach] = useCoach();
  const reserve = useContext(ReserveContext);
  const list = useMemo(() => reserve.filter((p) => Object.keys(p.attributes).length > 0), [reserve]);
  const project = useMemo(() => (list.length ? buildProject(engine, list, coach) : null), [engine, list, coach]);
  // Repère : niveau des titulaires de l'équipe première dans le même projet de jeu.
  const bar = useMemo(() => {
    const first = buildProject(engine, players.filter((p) => !p.team && Object.keys(p.attributes).length > 0), coach);
    return first ? firstTeamBar(first.slots) : null;
  }, [engine, players, coach]);
  const teams = useMemo(() => (project ? youthTeams(project.plans, bar ?? project.threshold) : []), [project, bar]);
  const [picked, setPicked] = useState<string | null>(null);
  const attr = (k: string) => t(`fm.attr.${k}`, { defaultValue: k });
  if (!teams.length) return null;
  const team = teams.find((x) => x.team === picked) ?? teams[0]!;
  const summary = (['promote', 'loan', 'low'] as const).filter((k) => team.counts[k] > 0).map((k) => t(`fm.train.youth.count.${k}`, { count: team.counts[k] }));
  return (
    <Panel title={t('fm.train.youth.title')}>
      {teams.length > 1 && (
        <div className="mb-3">
          <Chips value={team.team} options={teams.map((x) => [x.team, `${x.team} (${x.rows.length})`] as [string, string])} onChange={setPicked} />
        </div>
      )}
      <p className="text-sm">
        {t('fm.train.youth.week', {
          code: week.plan.code,
          preset: t(`fm.train.preset.${week.preset}`),
          workload: week.workload ? t(`fm.train.workload.${week.workload}`) : t('fm.train.youth.noWorkload'),
        })}
      </p>
      {summary.length > 0 && <p className="mt-1 text-sm font-bold">{summary.join(' · ')}</p>}
      <div className="table-scroll mt-3">
        <table className="data-table wide">
          <thead className="text-left text-canard/70">
            <tr>
              <th className="px-2 py-1">{t('fm.prog.player')}</th>
              <th className="px-2 py-1">{t('fm.train.youth.statusCol')}</th>
              <th className="px-2 py-1">{t('fm.train.youth.roleCol')}</th>
              <th className="px-2 py-1">{t('fm.train.focusCol')}</th>
              <th className="px-2 py-1 text-right">{t('fm.train.youth.potentialCol')}</th>
              <th className="px-2 py-1 text-right">{t('fm.proj.fit')}</th>
            </tr>
          </thead>
          <tbody>
            {team.rows.map(({ plan: x, status, focus }) => (
              <tr key={x.player.id} className="border-t border-canard/5">
                <td className="px-2 py-1.5 font-bold">
                  <PlayerLink player={x.player} /> <Pos player={x.player} />{' '}
                  {x.player.age != null && <span className="text-xs font-normal text-brun">{t('fm.train.age', { count: x.player.age })}</span>}
                </td>
                <td className="px-2 py-1.5" title={t(`fm.train.youth.statusHint.${status}`)}>
                  <Tag tone={YOUTH_TONE[status]}>{t(`fm.train.youth.status.${status}`)}</Tag>
                </td>
                <td className="px-2 py-1.5">{x.role ? names.role(x.role) : '–'}</td>
                <td className="px-2 py-1.5">
                  {focus ? <b>{t(`fm.train.focus.${focus}`)}</b> : '–'}
                  <span className="ml-1.5 text-xs text-brun">{x.weak.map((w) => `${attr(w.key)} ${Math.round(w.value)}`).join(', ')}</span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{x.player.level != null ? (roleCeiling(x.player.level, x.player) ?? x.player.level).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–'}</td>
                <td className="px-2 py-1.5 text-right">
                  <Fit value={x.fit} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More>{t('fm.train.youth.help')}</More>
    </Panel>
  );
}
