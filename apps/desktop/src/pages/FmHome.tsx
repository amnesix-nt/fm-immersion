import { snapshotWinterBreak,
  nextMatchCountdown,
  PART_TIME_DAYS,
  currentTrainingWeek,
  effectiveness,
  snapshotFixtures,
  homeOverview,
  officialResults,
  nearestPreset,
  offseasonDue,
  playingTime,
  trainingAlerts,
  trainingFor,
  type FmPlayer,
  type FmSnapshot,
  type GameSlot,
  type SquadAt,
  tacticAdvice,
} from '@fm-immersion/module-fm';
import { projectStyle } from '@fm-immersion/module-fm';
import { useMemo, useState, type ReactNode } from 'react';
import { useCareer, useCareerStore } from '../lib/career';
import { useFmSaveScope } from '../lib/save-store';
import { useTranslation } from 'react-i18next';
import { GazetteUne, StaffPoint, staffStory } from '../components/HomeCards';
import { FmBriefing } from './FmBriefing';
import { FmDecisions, useDecisions } from './FmDecisions';
import { Avatar } from './FmFoot';
import { FmMatchCenter } from './FmMatchCenter';
import { FmOffseason } from './FmOffseason';
import { FmSummary } from './FmSummary';
import { useTacticChoice } from './FmTactic';
import { useIndividualSetups } from './FmTraining';
import { Empty, fitPct, Level, Panel, PlayerName, Pos, Row, Tag, useCoach, type Tone } from './FmUi';

const KIND_TONE: Record<string, Tone> = {
  injured: 'bad',
  suspended: 'bad',
  contract: 'warn',
  condition: 'warn',
  status: 'info',
};

/** Accueil de la partie : chiffres clés, ce qui est à traiter, styles adaptés, meilleurs joueurs et jeunes. */
export function FmHome({
  snap,
  players,
  folder,
  history,
  entries,
  go,
  gameFormation = null,
  lineup = null,
  gameTactic = null,
  onTodo,
  board = null,
}: {
  snap: FmSnapshot;
  players: FmPlayer[];
  folder: string;
  history?: SquadAt[];
  /** Instantanés de la partie (temps de jeu de la saison pour le briefing). */
  entries?: { gameDate: string; data: FmSnapshot }[];
  go: (view: string) => void;
  gameFormation?: string | null;
  lineup?: GameSlot[] | null;
  gameTactic?: string | null;
  /** Écrans où le briefing laisse quelque chose à faire. */
  onTodo?: (views: string[]) => void;
  /** Voyants du centre de contrôle, sous le fil du jour et le bandeau du match. */
  board?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const en = i18n.resolvedLanguage === 'en';
  const h = useMemo(() => homeOverview(players, snap.gameDate), [players, snap.gameDate]);
  // Même classement que l'onglet Composition : note d'équipe du meilleur onze de chaque style.
  const { engine, ranked } = useTacticChoice(players, folder, null);
  // Onze prévu du prochain match (même calcul que la feuille de match) : le briefing parle des titulaires.
  const { plan } = useTacticChoice(players, folder, gameFormation, lineup, gameTactic);
  const starters = useMemo(() => new Set(plan?.slots.flatMap((sl) => (sl.player ? [sl.player.id] : [])) ?? []), [plan]);
  const playtime = useMemo(() => playingTime(players, entries ?? []).rows, [players, entries]);
  const tactic = useMemo(() => tacticAdvice(entries ?? []), [entries]);
  // Le détail (chiffres, tableaux) est replié : le briefing et la feuille de match suffisent au quotidien.
  const [detail, setDetail] = useState(() => {
    try {
      return localStorage.getItem('fmi.homeDetail') === '1';
    } catch {
      return false;
    }
  });
  const toggleDetail = () =>
    setDetail((d) => {
      try {
        localStorage.setItem('fmi.homeDetail', d ? '0' : '1');
      } catch {
        /* stockage indisponible */
      }
      return !d;
    });
  const [coach] = useCoach();
  const style = projectStyle(engine, coach);
  const week = useMemo(
    () =>
      currentTrainingWeek({
        gameDate: snap.gameDate,
        fixtures: snapshotFixtures(snap),
        seasonStart: coach.seasonStart,
        winterBreak: coach.winterBreak === undefined ? snapshotWinterBreak(snap) : coach.winterBreak,
        trainingDays: (coach.clubStatus ?? 'pro') === 'pro' ? undefined : (coach.trainingDays ?? PART_TIME_DAYS),
        priorities: style ? trainingFor(style) : [],
        style: style?.id,
        // Même semaine que l'écran Entraînement : zones faibles et efficacité tactique lues dans le jeu.
        weakAreas: effectiveness(snap)?.weakest ?? [],
        gaugesKnown: !!effectiveness(snap),
        teOverall: effectiveness(snap)?.overall?.mid ?? null,
      }),
    [snap, coach.seasonStart, coach.winterBreak, coach.clubStatus, coach.trainingDays, style],
  );
  const tr = useMemo(() => trainingAlerts(players), [players]);
  const decisionList = useDecisions(snap, players, folder, history);
  const setups = useIndividualSetups(engine, players, folder, week.days.filter((d) => d.kind === 'match').length, snap);
  const toChange = setups.rows.filter((r) => r.status === 'change').map((r) => r.plan.player);
  const short = (list: FmPlayer[]) => list.map((p) => p.name.split(' ').at(-1)).join(', ');
  const link = (view: string, label: string) => (
    <button type="button" className="shrink-0 whitespace-nowrap text-sm font-bold text-orange-fonce hover:underline" onClick={() => go(view)}>
      {label} →
    </button>
  );
  const alertText = (a: (typeof h.alerts)[number]) =>
    a.kind === 'injured'
      ? a.detail
      : a.kind === 'contract'
        ? a.months <= 0
          ? t('fm.contracts.expired')
          : t('fm.home.endsIn', { count: a.months })
        : a.kind === 'condition'
          ? `${Math.round(a.condition)} %`
          : a.detail;
  // Les joueurs fatigués sont déjà regroupés dans le cadre Entraînement : pas de doublon ligne par ligne ici.
  // Condition physique : un seul résumé (« 8 joueurs sous 80 % ») au lieu d'une ligne par joueur.
  const tired = h.alerts.filter((a) => a.kind === 'condition').map((a) => a.player);
  const alerts = h.alerts.filter((a) => a.kind !== 'condition');
  const shown = alerts.slice(0, 8);

  const threadShown = useHasDecision(snap.gameDate) && detail;
  const { saveId } = useCareer();
  const staff = useMemo(() => staffStory(players), [players]);
  return (
    <div className="space-y-4">
      <FmMatchCenter
        snap={snap}
        players={players}
        folder={folder}
        gameFormation={gameFormation}
        lineup={lineup}
        gameTactic={gameTactic}
        go={go}
        matches={entries}
        afterHero={
          <div className={`grid gap-4 ${staff ? 'lg:grid-cols-2' : ''}`}>
            <StaffPoint players={players} />
            <GazetteUne saveId={saveId} />
          </div>
        }
        aside={
          <FmBriefing
            key={snap.gameDate}
            snap={snap}
            players={players}
            starters={starters}
            decisions={decisionList}
            playtime={playtime}
            setupsToChange={toChange.length}
            offseason={offseasonDue(snap, coach.seasonStart ?? 8)}
            go={go}
            onTodo={onTodo}
            tactic={tactic}
            hideMatch
            noQuote
          />
        }
        asideAfter={<FixturesCard snap={snap} entries={entries ?? []} go={go} hideLast={threadShown} />}
      />
      {board}
      <FmOffseason snap={snap} players={players} list={decisionList} go={go} />
      <button type="button" className="chip" aria-expanded={detail} onClick={toggleDetail}>
        {t(detail ? 'fm.brief.detailHide' : 'fm.brief.detail')}
      </button>
      {detail && <DayThread snap={snap} entries={entries ?? []} go={go} />}
      {detail && <FmDecisions list={decisionList} go={go} />}
      {detail && <FmSummary snap={snap} players={players} />}
      {detail && (<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6 xl:[&>*]:col-span-2 xl:[&>*:nth-last-child(-n+2)]:col-span-3">
        <Panel title={t('fm.home.todo')} action={link('squad', t('fm.views.squad'))}>
          {h.contracts && (
            <button type="button" className="mb-1 w-full text-left" onClick={() => go('contracts')}>
              <Row>
                <span>
                  <Tag tone="warn">{t('fm.home.kind.contract')}</Tag> <b>{t('fm.home.contracts', { count: h.contracts.length })}</b>
                  <br />
                  <span className="text-xs text-brun">{h.contracts.map((p) => p.name.split(' ').at(-1)).join(', ')}</span>
                </span>
                <span className="text-xs font-bold text-eau-fonce">{t('fm.home.see')} →</span>
              </Row>
            </button>
          )}
          {tired.length > 0 && (
            <Row>
              <span>
                <Tag tone="warn">{t('fm.home.kind.condition')}</Tag> <b>{t('fm.home.tired', { count: tired.length })}</b>
                <br />
                <span className="text-xs text-brun">{short(tired)}</span>
              </span>
            </Row>
          )}
          {shown.length ? (
            shown.map((a, i) => (
              <Row key={i}>
                <span>
                  <Tag tone={KIND_TONE[a.kind]}>{t(`fm.home.kind.${a.kind}`)}</Tag> <PlayerName player={a.player} />
                </span>
                <span className="text-xs text-brun">{alertText(a)}</span>
              </Row>
            ))
          ) : !h.contracts && !tired.length ? (
            <Empty>{t('fm.home.nothing')}</Empty>
          ) : null}
          {alerts.length > shown.length && <p className="mt-1 text-xs text-brun">{t('fm.home.more', { count: alerts.length - shown.length })}</p>}
        </Panel>

        <Panel title={t('fm.home.training')} action={link('training', t('fm.views.training'))}>
          <Row>
            <span>
              <b>{t('fm.train.code', { code: week.code })}</b>
              {week.theme && <span className="text-xs text-brun"> · {t(`fm.train.theme.${week.theme}`)}</span>}
            </span>
          </Row>
          <p className="mb-1 text-xs text-brun">
            {t('fm.home.trainingPreset', {
              preset: t(`fm.train.preset.${nearestPreset(week)}`),
            })}
          </p>
          {toChange.length > 0 && (
            <Row>
              <span>
                <Tag tone="warn">{t('fm.home.kind.setup')}</Tag> <b>{t('fm.home.setupChanges', { count: toChange.length })}</b>
                <br />
                <span className="text-xs text-brun">{short(toChange)}</span>
              </span>
            </Row>
          )}
          {tr.rusty.length > 0 && (
            <Row>
              <span>
                <Tag tone="info">{t('fm.home.kind.sharpness')}</Tag> <b>{t('fm.home.rusty', { count: tr.rusty.length })}</b>
                <br />
                <span className="text-xs text-brun">{short(tr.rusty)}</span>
              </span>
            </Row>
          )}
        </Panel>

        {ranked.length > 0 && (
          <Panel title={t('fm.home.styles')} action={link('tactic', t('fm.views.tactic'))}>
            {ranked.slice(0, 3).map(({ style, fit }) => (
              <Row key={style.id}>
                <span>
                  <b>{en && style.nameEn ? style.nameEn : style.name}</b> {style.mentality && <span className="text-xs text-brun">{style.mentality}</span>}
                </span>
                <span className="text-sm font-bold tabular-nums">{fitPct(fit)}</span>
              </Row>
            ))}
            <p className="mt-2 text-xs text-brun">
              {t('fm.home.leastFit', {
                name: (en && ranked.at(-1)!.style.nameEn) || ranked.at(-1)!.style.name,
              })}
            </p>
          </Panel>
        )}

        <Panel title={t('fm.home.best')}>
          {h.top.map((p) => (
            <Row key={p.id}>
              <span className="flex items-center gap-2">
                <Avatar player={p} size="sm" /> <PlayerName player={p} /> <Pos player={p} />
              </span>
              <Level value={p.level} />
            </Row>
          ))}
        </Panel>

        <Panel title={t('fm.home.young')}>
          {h.young.length ? (
            h.young.map((p) => (
              <Row key={p.id}>
                <span className="flex items-center gap-2">
                  <Avatar player={p} size="sm" /> <PlayerName player={p} /> <Pos player={p} />
                </span>
                <span className="flex items-center gap-2 text-xs text-brun">
                  {t('fm.contracts.age', { count: p.age ?? 0 })} <Level value={p.level} />
                </span>
              </Row>
            ))
          ) : (
            <Empty>{t('fm.home.noYoung')}</Empty>
          )}
        </Panel>
      </div>)}
    </div>
  );
}

const OUTCOME_TONE = { W: 'bg-eau-fonce', D: 'bg-ambre', L: 'bg-corail' } as const;

/**
 * Le fil du jour, en haut de l'accueil quand une décision attend : dernier match → prochain adversaire → décision
 * du jour (le message le plus urgent du briefing). Quand rien n'attend, il disparaît et le bandeau du match mène.
 */
/** Une décision attend-elle (message du briefing à traiter, hors prochain match et simples infos) ? */
function useHasDecision(gameDate: string) {
  const scope = useFmSaveScope();
  const brief = useCareerStore((s) => s.brief);
  return brief.at === `${scope.saveId}|${gameDate}` && brief.items.some((x) => !/^(nextMatch|friendly):/.test(x.key) && x.tone !== 'info');
}

function DayThread({ snap, entries, go }: { snap: FmSnapshot; entries: { gameDate: string; data: FmSnapshot }[]; go: (view: string) => void }) {
  const { t } = useTranslation();
  const scope = useFmSaveScope();
  const brief = useCareerStore((s) => s.brief);
  const last = useMemo(() => officialResults(entries).filter((r) => r.matches === 1).at(-1) ?? null, [entries]);
  const rank = (tone: string) => (tone === 'bad' ? 0 : tone === 'warn' ? 1 : 2);
  const items = brief.at === `${scope.saveId}|${snap.gameDate}` ? brief.items.filter((x) => !/^(nextMatch|friendly):/.test(x.key) && x.tone !== 'info') : [];
  const decision = [...items].sort((a, b) => rank(a.tone) - rank(b.tone))[0];
  if (!decision) return null;
  const nm = (snap.nextMatch ?? null) as Record<string, unknown> | null;
  const opponent = typeof nm?.opponent === 'string' ? nm.opponent : null;
  const loc = String(nm?.location ?? '').toLowerCase();
  const home = /dom|home/.test(loc) ? true : /ext|away/.test(loc) ? false : null;
  const days = nextMatchCountdown(snap) ?? NaN;
  const where = (h: boolean | null) => (h == null ? '' : ` (${t(h ? 'fm.mc.homeShort' : 'fm.mc.awayShort')})`);
  const arrow = (
    <span aria-hidden className="hidden self-center text-xl text-orange-fonce md:block">
      →
    </span>
  );
  const step = 'flex min-w-0 flex-1 flex-col gap-1 rounded-xl p-3 text-left';
  const label = 'text-xs font-bold uppercase tracking-wide text-brun';
  return (
    <section aria-label={t('fm.home.thread.label')} className="card flex flex-col gap-2 p-3 md:flex-row md:items-stretch">
      <button type="button" className={`${step} hover:bg-creme`} onClick={() => go('results')}>
        <span className={label}>{t('fm.home.lastResult')}</span>
        {last ? (
          <span className="flex items-center gap-2">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white ${last.outcome ? OUTCOME_TONE[last.outcome] : 'bg-brun'}`}>
              {last.outcome ? t(`fm.results.outcome.${last.outcome}`) : '?'}
            </span>
            <span className="truncate">
              <b>{last.goalsFor != null && last.goalsAgainst != null ? `${last.goalsFor}-${last.goalsAgainst} ` : ''}</b>
              {last.opponent ?? '–'}
              <span className="text-brun">{where(last.home)}</span>
            </span>
          </span>
        ) : (
          <span className="text-sm text-brun">{t('fm.home.thread.noLast')}</span>
        )}
      </button>
      {arrow}
      <button type="button" className={`${step} hover:bg-creme`} onClick={() => go('opponent')}>
        <span className={label}>{t('fm.home.thread.next')}</span>
        {opponent ? (
          <span className="truncate">
            <b>{opponent}</b>
            <span className="text-brun">{where(home)}</span>
            {Number.isFinite(days) && <span className="text-brun"> · {days === 0 ? t('fm.mc.today') : days === 1 ? t('fm.mc.tomorrow') : t('fm.mc.inDaysLong', { count: days })}</span>}
          </span>
        ) : (
          <span className="text-sm text-brun">{t('fm.home.thread.noNext')}</span>
        )}
        {opponent && <span className="mt-auto text-xs font-bold text-orange-fonce">{t('fm.home.thread.opponent')} →</span>}
      </button>
      {arrow}
      <button
        type="button"
        className={`${step} border-l-4 ${decision.tone === 'bad' ? 'border-corail' : 'border-orange'} bg-orange-clair/60 hover:bg-orange-clair md:flex-[1.6]`}
        onClick={() => go(decision.view)}
      >
        <span className={label}>{t('fm.home.thread.decision')}</span>
        <span className="line-clamp-2 text-sm">{decision.text}</span>
        <span className="mt-auto text-xs font-bold text-orange-fonce">{decision.action} →</span>
      </button>
    </section>
  );
}

/** Dernier résultat et prochains matchs, sous le briefing de l'accueil. */
function FixturesCard({ snap, entries, go, hideLast = false }: { snap: FmSnapshot; entries: { gameDate: string; data: FmSnapshot }[]; go: (view: string) => void; hideLast?: boolean }) {
  const { t, i18n } = useTranslation();
  const found = useMemo(() => officialResults(entries).filter((r) => r.matches === 1).at(-1) ?? null, [entries]);
  // Le fil du jour montre déjà le dernier résultat : pas de doublon ici.
  const last = hideLast ? null : found;
  const next = useMemo(() => snapshotFixtures(snap).filter((f) => f.date >= snap.gameDate).slice(1, 4), [snap]);
  const day = new Intl.DateTimeFormat(i18n.resolvedLanguage, { weekday: 'short', day: 'numeric', month: 'short' });
  if (!last && !next.length) return null;
  const where = (home: boolean | null) => (home == null ? '' : t(home ? 'fm.mc.homeShort' : 'fm.mc.awayShort'));
  return (
    <section className="card p-5" aria-labelledby="fm-home-fixtures">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="fm-home-fixtures" className="text-lg">
          {t('fm.home.fixtures')}
        </h2>
        <button type="button" className="text-sm font-bold text-orange-fonce hover:underline" onClick={() => go('calendar')}>
          {t('fm.mc.calendar')} →
        </button>
      </div>
      <ul className="mt-2 divide-y divide-canard/10 text-sm">
        {last && (
          <li className="flex items-center gap-3 py-2">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white ${last.outcome ? OUTCOME_TONE[last.outcome] : 'bg-brun'}`}>
              {last.outcome ? t(`fm.results.outcome.${last.outcome}`) : '?'}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="text-xs font-bold uppercase tracking-wide text-brun">{t('fm.home.lastResult')}</span>
              <br />
              <b className="text-canard">{last.opponent ?? '–'}</b> {last.home != null && <span className="text-brun">({where(last.home)})</span>}
            </span>
            {last.goalsFor != null && last.goalsAgainst != null && (
              <span className="font-display text-lg font-semibold tabular-nums text-canard">
                {last.goalsFor}-{last.goalsAgainst}
              </span>
            )}
          </li>
        )}
        {next.map((f, i) => (
          <li key={i} className="flex items-center gap-3 py-2">
            <span className="w-24 shrink-0 text-xs tabular-nums text-brun first-letter:uppercase">{day.format(new Date(f.date))}</span>
            <span className="min-w-0 flex-1 truncate text-canard">
              {f.opponent ?? '–'} {f.home != null && <span className="text-brun">({where(f.home)})</span>}
            </span>
            {f.competition && <span className="hidden truncate text-xs text-brun sm:inline">{f.competition}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
