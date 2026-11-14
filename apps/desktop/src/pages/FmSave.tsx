import { GameCompatBanner, GameCompatCard } from '../components/GameCompat';
import { AiSettingsCard } from '../components/AiSettingsCard';
import { aiFor } from '../lib/ai';
import { PageTitle } from '../components/PageTitle';
import { roleCeiling,
  buildProject,
  engineValue,
  isUnwanted,
  monthsBetween,
  moraleLevel,
  compatMap,
  PLAN_LETTERS,
  type PlanLetter,
  gameFormationOf,
  gameLineup,
  forNextMatch,
  loanedOutIds,
  nextMatchInDays,
  normalizePlayer,
  withStaffOpinion,
  squadSnapshot,
  withAbilities,
  withExtended,
  firstTeamSnapshot,
  type FmPlayer,
  type GameSlot,
  type FmSnapshot,
  type Line,
  type SquadAt,
  formationOfPositions,
  formationOfSlots,
  tacticSlots,
  knownFormation,
} from '@fm-immersion/module-fm';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useUi } from '../lib/ui-store';
import { TodayCards } from '../components/TodayCards';
import { shownGameDate, useCareer, useCareerStore } from '../lib/career';
import { CLUB_PAGES, clubPath, pageOf, PARTS, TABS, type ClubPage } from '../lib/club-nav';
import { fmData } from '../lib/data';
import { useHistory } from '../lib/fm-cache';
import { importMissingHistory, type FmHistoryFile } from '../lib/fm-history';
import { useFmFolder } from '../lib/fm-sync';
import { FmOtherSaveError, type FmSaveFile } from '../lib/fm';
import { FmSaveScopeContext, type FmSaveScope } from '../lib/save-store';
import { FmAnalysis } from './FmAnalysis';
import { FmBridge, FmBridgeOptions } from './FmBridge';
import { useGameStatus } from '../lib/game';
import { FmMemory } from './FmMemory';
import { FmMercato } from './FmMercato';
import { FmCalendar } from './FmCalendar';
import { FmCompare } from './FmCompare';
import { FmContracts } from './FmContracts';
import { FmDepth } from './FmDepth';
import { FmSquadPitch } from './FmSquadPitch';
import { FmDressing } from './FmDressing';
import { FmEffectiveness } from './FmEffectiveness';
import { FmFinances } from './FmFinances';
import { FmHome } from './FmHome';
import { FmLoans } from './FmLoans';
import { FmShirts } from './FmShirts';
import { FmOpponent } from './FmOpponent';
import { FmPlaytime } from './FmPlaytime';
import { FmProgression } from './FmProgression';
import { FmProject } from './FmProject';
import { FmRoles } from './FmRoles';
import { FmStaff } from './FmStaff';
import { FmStats } from './FmStats';
import { FmResults } from './FmResults';
import { FmDiagnosis } from './FmDiagnosis';
import { FmStyle } from './FmStyle';
import { FmBuilder } from './FmBuilder';
import { FmAcademy } from './FmAcademy';
import { FmTactic, ProjectProvider, ReserveContext, useTacticEngine } from './FmTactic';
import { FmTargets } from './FmTargets';
import { FmScouting } from './FmScouting';
import { FmTraining } from './FmTraining';
import { FmWages } from './FmWages';
import { CompatTag, EngineTag, GradeLetter, HelpHost, PlayerLink, PlayerSheetContext, useCoach, type SheetFocus } from './FmUi';
import { FmPlayerSheet } from './FmPlayerSheet';

const LINES: Line[] = ['GB', 'DEF', 'MIL', 'ATT'];

/** Nom d'un écran : son nom propre s'il regroupe plusieurs parties, sinon celui de la partie. */
const pageLabel = (t: (k: string, o?: Record<string, unknown>) => string, v: string) => t(`fm.pages.${v}`, { defaultValue: t(`fm.views.${v}`) });

/**
 * Carrière suivie, vue par écran : « Aujourd'hui » (`page="home"`), un écran du club (`/club/:view`, la partie
 * demandée d'un écran regroupé) ou « Plugin et réglages » (`page="settings"`). La lecture du plugin tourne pour
 * toute l'appli (`useFmSync`) ; ici, on affiche.
 */
export function FmSave({ page }: { page?: 'home' | 'settings' }) {
  const params = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { saveId, save, fmSaves } = useCareer();
  const key = ['fm', saveId] as const;

  // Les réglages d'écran d'avant le lien partie ↔ sauvegarde reviennent à la plus ancienne partie FM.
  const scope = useMemo<FmSaveScope | null>(() => {
    if (!saveId) return null;
    const oldest = [...fmSaves].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return { saveId, inheritsLegacy: oldest?.id === saveId };
  }, [fmSaves, saveId]);
  const { data: snapshot, isLoading } = useQuery({
    queryKey: [...key, 'latest'],
    queryFn: () => fmData.latest(saveId),
    enabled: !!saveId,
  });
  const { data: all } = useHistory(saveId);
  const { data: settings } = useQuery({
    queryKey: [...key, 'settings'],
    queryFn: () => fmData.settings(saveId),
    enabled: !!saveId,
  });

  // Écran affiché et, pour un écran regroupé, la partie demandée (sous-onglet) ; sinon sa première partie.
  const current = page ?? params.view ?? 'home';
  const view = page === 'settings' ? 'settings' : pageOf(current);
  const go = (v: string) => {
    navigate(clubPath(v));
    window.scrollTo({ top: 0 });
  };
  // Fiche joueur ouverte depuis n'importe quel nom cliquable.
  const [sheet, setSheetState] = useState<{ id: string; focus?: SheetFocus } | null>(null);
  const setSheet = useCallback((id: string, focus?: SheetFocus) => setSheetState({ id, focus }), []);
  // Fiche demandée par la recherche rapide (Ctrl+K).
  const wanted = useUi((s) => s.openPlayer);
  const setWanted = useUi((s) => s.setOpenPlayer);
  // Joueur d'un autre club demandé depuis FM27.
  const external = useUi((s) => s.externalPlayer);
  const setExternal = useUi((s) => s.setExternalPlayer);
  useEffect(() => {
    if (!wanted) return;
    setSheet(wanted);
    setWanted(null);
  }, [wanted, setWanted, setSheet]);
  const folder = useFmFolder(saveId);
  // Ce que le briefing laisse à faire, par écran : une pastille dans la barre latérale (remise à zéro à chaque nouvelle date).
  const setTodo = useCareerStore((s) => s.setTodo);
  const todoAt = `${saveId}|${snapshot?.gameDate ?? ''}`;
  const reportTodo = useCallback((views: string[]) => setTodo({ at: todoAt, views }), [todoAt, setTodo]);

  // Effectif sous contrat (hors essais) : salaires, contrats, finances. Les joueurs prêtés ailleurs et ceux de la
  // réserve ou des jeunes (`team`) n'entrent pas dans les compos ni l'analyse : `players` est l'équipe première
  // présente au club.
  const contracted = useMemo(() => (snapshot ? withStaffOpinion(withAbilities(withExtended(squadSnapshot(snapshot.data))).players.map(normalizePlayer)) : []), [snapshot]);
  const players = useMemo(() => {
    const out = snapshot ? loanedOutIds(snapshot.data) : new Set<string>();
    const present = contracted.filter((p) => !p.team && !out.has(p.id));
    // Un blessé rétabli d'ici le prochain match compte pour les compos de ce match.
    return snapshot ? forNextMatch(present, nextMatchInDays(snapshot.data)) : present;
  }, [snapshot, contracted]);
  // Réserve et jeunes présents au club : appelés par les compos quand l'équipe première ne couvre pas un poste.
  const reserve = useMemo(() => {
    const out = snapshot ? loanedOutIds(snapshot.data) : new Set<string>();
    return contracted.filter((p) => p.team && !out.has(p.id));
  }, [snapshot, contracted]);
  const history = useMemo<SquadAt[]>(
    () =>
      (all ?? []).map((h) => ({
        gameDate: h.gameDate,
        players: withAbilities(firstTeamSnapshot(squadSnapshot(h.data as FmSnapshot))).players.map(normalizePlayer),
      })),
    [all],
  );
  const lineup = useMemo(() => gameLineup(snapshot?.data), [snapshot?.data]);
  // Schéma joué : le nom de la tactique s'il désigne un schéma connu, sinon les onze postes lus dans le onze du jeu.
  const gameFormation = useMemo(() => {
    const named = gameFormationOf(snapshot?.data.tactic);
    // Plugin 0.5.5 : les onze postes de la tactique de l'équipe (« 4-1-5 MD 2MO Jeu large » n'est pas un nom de schéma).
    return (named && knownFormation(named)) || (lineup ? formationOfPositions(lineup.map((s) => s.pos)) : null) || formationOfSlots(tacticSlots(snapshot?.data.tactic)) || named;
  }, [snapshot?.data.tactic, lineup]);
  // Contenu de chaque écran ; un onglet en affiche une ou plusieurs parties (voir PARTS).
  const part = (v: string) => {
    if (!snapshot) return null;
    switch (v) {
      case 'home':
        return (
          <FmHome
            snap={snapshot.data}
            players={players}
            folder={folder}
            history={history}
            entries={all as { gameDate: string; data: FmSnapshot }[] | undefined}
            go={go}
            gameFormation={gameFormation}
            lineup={lineup}
            gameTactic={typeof snapshot.data.tactic?.name === 'string' ? snapshot.data.tactic.name : null}
            onTodo={reportTodo}
            board={<ControlBoard saveId={saveId} go={go} />}
          />
        );
      case 'squad':
        return <SquadViews players={players} folder={folder} gameDate={snapshot.gameDate} gameFormation={gameFormation} lineup={lineup} gameTactic={typeof snapshot.data.tactic?.name === 'string' ? snapshot.data.tactic.name : null} />;
      case 'analysis':
        return <FmAnalysis players={players} gameDate={snapshot.gameDate} />;
      case 'stats':
        return <FmStats snap={snapshot.data} players={players} history={all as { gameDate: string; data: FmSnapshot }[] | undefined} />;
      case 'compare':
        return <FmCompare saveId={saveId} snap={snapshot.data} players={players} folder={folder} history={history} />;
      case 'playtime':
        return <FmPlaytime players={players} history={all as { gameDate: string; data: FmSnapshot }[] | undefined} />;
      case 'dressing':
        return <FmDressing players={players} />;
      case 'loans':
        return <FmLoans snap={snapshot.data} />;
      case 'academy':
        return <FmAcademy players={players} folder={folder} gameDate={snapshot.gameDate} />;
      case 'numbers':
        return <FmShirts players={players} folder={folder} gameFormation={gameFormation} gameTactic={typeof snapshot.data.tactic?.name === 'string' ? snapshot.data.tactic.name : null} />;
      case 'tactic':
        return (
          <FmTactic
            matches={all as { gameDate: string; data: FmSnapshot }[] | undefined}
            part="lineup"
            snap={snapshot.data}
            go={go}
            players={players}
            folder={folder}
            gameFormation={gameFormation}
            lineup={lineup}
            lineupStatus={(snapshot.data as { collecte?: { compo?: string } }).collecte?.compo ?? null}
          />
        );
      case 'instructions':
        return (
          <FmTactic
            matches={all as { gameDate: string; data: FmSnapshot }[] | undefined}
            part="instructions"
            snap={snapshot.data}
            go={go}
            players={players}
            folder={folder}
            gameFormation={gameFormation}
            lineup={lineup}
            lineupStatus={(snapshot.data as { collecte?: { compo?: string } }).collecte?.compo ?? null}
          />
        );
      case 'opponent':
        return <FmOpponent snap={snapshot.data} go={go} />;
      case 'diagnosis':
        return (
          <FmDiagnosis
            snap={snapshot.data}
            players={players}
            folder={folder}
            gameFormation={gameFormation}
            lineup={lineup}
            gameTactic={typeof snapshot.data.tactic?.name === 'string' ? snapshot.data.tactic.name : null}
            history={all as { gameDate: string; data: FmSnapshot }[] | undefined}
          />
        );
      case 'results':
        return <FmResults players={players} history={all as { gameDate: string; data: FmSnapshot }[] | undefined} />;
      case 'calendar':
        return <FmCalendar snap={snapshot.data} players={players} />;
      case 'roles':
        return <FmRoles players={players} folder={folder} />;
      case 'builder':
        return <FmBuilder snap={snapshot.data} players={players} folder={folder} />;
      case 'style':
        return <FmStyle players={players} folder={folder} />;
      case 'effectiveness':
        return <FmEffectiveness snap={snapshot.data} history={history} go={go} />;
      case 'project':
        return <FmProject snap={snapshot.data} players={players} folder={folder} history={history} />;
      case 'training':
        return <FmTraining snap={snapshot.data} players={players} folder={folder} history={history} />;
      case 'staff':
        return <FmStaff />;
      case 'mercato':
        return <FmMercato saveId={saveId} snap={snapshot.data} players={players} folder={folder} gameDate={snapshot.gameDate} history={history} />;
      case 'scouting':
        return <FmScouting saveId={saveId} snap={snapshot.data} players={players} folder={folder} gameDate={snapshot.gameDate} history={history} />;
      case 'targets':
        return <FmTargets saveId={saveId} snap={snapshot.data} players={players} folder={folder} go={go} />;
      case 'depth':
        return (
          <FmDepth
            players={players}
            folder={folder}
            gameFormation={gameFormation}
            gameTactic={typeof snapshot.data.tactic?.name === 'string' ? snapshot.data.tactic.name : null}
            lineup={lineup}
            gameDate={snapshot.gameDate}
            history={history}
          />
        );
      case 'finances':
        return <FmFinances snap={snapshot.data} players={contracted} />;
      case 'wages':
        return <FmWages players={contracted} gameDate={snapshot.gameDate} />;
      case 'contracts':
        return <FmContracts players={contracted} gameDate={snapshot.gameDate} />;
      case 'progression':
        return <FmProgression history={history} />;
      default:
        return null;
    }
  };
  const sync = useCareerStore((s) => s.sync);
  const dateFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'long' });
  const longDateFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const stampFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'short' });
  const freeSince = sync.free ? (settings?.fmFreeSince ?? sync.free) : null;

  // Lecture à la demande (bouton « Lire la partie maintenant », ou import confirmé d'un autre club).
  const importSnap = useMutation({
    mutationFn: async (opts: { force?: boolean; folder?: string } = {}) => {
      const from = opts.folder ?? folder;
      const text = await invoke<string>('fm_read_snapshot', { folder: from });
      if (from !== settings?.fmFolder) await fmData.setFolder(saveId, from);
      return fmData.importSnapshot(saveId, JSON.parse(text), opts);
    },
    onSuccess: () => {
      useCareerStore.getState().setSync({ other: null });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['saves'] });
    },
    onError: (e) => useCareerStore.getState().setSync({ other: e instanceof FmOtherSaveError ? e : null }),
  });
  const other = sync.other;
  const position = (snapshot?.data as { custom?: { equipe?: { classementTexte?: unknown } } } | undefined)?.custom?.equipe?.classementTexte;

  if (!saveId) return null;
  return (
    <div className="fm min-h-screen">
      {/* En-tête de la carrière : club, date de jeu, état de la lecture du plugin, lecture à la demande. */}
      <header className="sticky top-0 z-40 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-canard/10 bg-white px-6 py-3 xl:px-10">
        {snapshot ? (
          <>
            <span className="font-extrabold">{snapshot.club}</span>
            <span className="text-sm text-brun">
              {typeof position === 'string' && position ? `${position} · ` : ''}
              {dateFmt.format(new Date(shownGameDate(snapshot, sync.now) ?? snapshot.gameDate))}
            </span>
          </>
        ) : (
          <span className="font-extrabold">{save?.name}</span>
        )}
        {freeSince && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-creme px-2 py-0.5 text-sm font-bold">
            <span className="inline-block h-2 w-2 rounded-full bg-ambre" aria-hidden />
            {t('fm.saveFile.free', { date: dateFmt.format(new Date(freeSince)) })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <GameState />
          {snapshot && (
            <span className="flex items-center gap-1.5 text-xs text-brun" title={t('fm.autoImport')}>
              <span className={`h-2 w-2 rounded-full ${importSnap.isError && !other ? 'bg-corail' : 'bg-eau'}`} aria-hidden />
              {t('fm.sync', { time: stampFmt.format(new Date(snapshot.importedAt)) })}
            </span>
          )}
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1 text-sm" disabled={importSnap.isPending || !folder} onClick={() => importSnap.mutate({})}>
            <svg viewBox="0 0 24 24" className={`h-4 w-4 fill-none stroke-current ${importSnap.isPending ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4" />
            </svg>
            {t('layout.readNow')}
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[96rem] px-6 py-5 xl:px-10">
        {other && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-corail/40" role="alert">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-ambre" aria-hidden />
            <span className="text-canard">
              {other.career ? t('fm.saveFile.otherCareer', { club: other.club, career: other.career }) : t('fm.saveFile.other', { club: other.club, expected: other.expected })}
            </span>
            <button type="button" className="btn-secondary px-3 py-1 text-xs" disabled={importSnap.isPending} onClick={() => importSnap.mutate({ force: true })}>
              {t('fm.saveFile.importAnyway', { club: other.club })}
            </button>
          </div>
        )}
        {importSnap.isError && !other && (
          <p className="mb-4 text-sm text-corail">{t('fm.importError', { reason: String(importSnap.error?.message ?? importSnap.error) })}</p>
        )}

        {view === 'settings' ? (
          <SettingsPage
            saveId={saveId}
            folder={folder}
            settings={settings}
            club={settings?.fmClub ?? snapshot?.club ?? null}
            importing={importSnap.isPending}
            onImport={(f) => importSnap.mutate({ folder: f })}
          />
        ) : (
          <>
            {!isLoading && !snapshot && (
              <div className="card flex flex-col items-center gap-3 py-10 text-center">
                <p className="max-w-md text-brun">{t('fm.empty')}</p>
                <Link to="/reglages" className="btn-primary">
                  {t('layout.openSettings')}
                </Link>
              </div>
            )}
            {snapshot && players.length > 0 && scope && (
              <FmSaveScopeContext.Provider value={scope}>
                <ReserveContext.Provider value={reserve}>
                  <ProjectProvider players={players} folder={folder} gameFormation={gameFormation} lineup={lineup} gameTactic={typeof snapshot.data.tactic?.name === 'string' ? snapshot.data.tactic.name : null}>
                  <PlayerSheetContext.Provider value={setSheet}>
                    {view === 'home' ? (
                      <>
                        <header className="mb-4">
                          <h1 className="text-3xl font-semibold">{t('layout.today.title')}</h1>
                          <p className="mt-1 text-lg text-brun">
                            {snapshot.data.club && <>{snapshot.data.club} · </>}
                            <span className="inline-block first-letter:uppercase">{longDateFmt.format(new Date(shownGameDate(snapshot, sync.now) ?? snapshot.gameDate))}</span>
                          </p>
                        </header>
                        <GameCompatBanner />
                        {part('home')}
                        <TodayCards saveId={saveId} />
                      </>
                    ) : (
                      <>
                        <ViewHeader view={view} part={PARTS[view].includes(current) ? current : view} />
                        {/* Le Mercato ouvre sur sa propre priorité en grand : la boîte de l'adjoint y ferait doublon. */}
                        {(PARTS[view].includes(current) ? current : view) !== 'mercato' && <AssistantSays page={view} saveId={saveId} go={go} />}
                        <PageParts page={view} current={current} go={go} render={part} />
                      </>
                    )}
                    {sheet && (
                      <FmPlayerSheet
                        key={`${sheet.id}|${sheet.focus ?? ''}`}
                        id={sheet.id}
                        focus={sheet.focus}
                        players={players}
                        extra={external}
                        snap={snapshot.data}
                        history={history}
                        entries={all as { gameDate: string; data: FmSnapshot }[] | undefined}
                        folder={folder}
                        gameDate={snapshot.gameDate}
                        go={go}
                        onClose={() => {
                          setSheetState(null);
                          setExternal(null);
                        }}
                      />
                    )}
                  </PlayerSheetContext.Provider>
                  </ProjectProvider>
                </ReserveContext.Provider>
              </FmSaveScopeContext.Provider>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** « Plugin et réglages » : dossier du plugin, sauvegarde liée, lecture du CA/PA, historique, plugin et mémoire. */
function SettingsPage({
  saveId,
  folder,
  settings,
  club,
  importing,
  onImport,
}: {
  saveId: string;
  folder: string;
  settings: Awaited<ReturnType<typeof fmData.settings>> | undefined;
  club: string | null;
  importing: boolean;
  onImport: (folder: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const key = ['fm', saveId] as const;
  const [input, setInput] = useState(folder);
  useEffect(() => setInput(folder), [folder]);
  const stampFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'short' });
  const setSync = useCareerStore((s) => s.setSync);
  // Rappel stable : le plugin signale son état à chaque changement, pas à chaque rendu.
  const onHealth = useCallback((ok: boolean) => {
    if (useCareerStore.getState().sync.bridgeOk !== ok) setSync({ bridgeOk: ok });
  }, [setSync]);

  // Sauvegardes .fm du joueur (dossier games, à côté de celui du plugin), pour lier la partie à l'une d'elles.
  const { data: saveFiles } = useQuery({
    queryKey: ['fm', 'save-files', folder],
    queryFn: () => invoke<FmSaveFile[]>('fm_list_saves', { folder }),
    enabled: !!folder,
    refetchInterval: 60_000,
  });
  const linked = settings?.fmSaveFile ?? '';
  const linkedFile = saveFiles?.find((f) => f.name === linked);
  const link = useMutation({
    mutationFn: (name: string) => fmData.linkSave(saveId, name || null),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...key, 'settings'] }),
  });

  // Connecter FM27 : une seule prochaine étape, dans l'ordre où elles se font.
  const bridgeOk = useCareerStore((s) => s.sync.bridgeOk);
  const next = bridgeOk === false ? 'plugin' : !linked ? 'save' : !club ? 'read' : 'done';

  return (
    <div className="space-y-6">
      <PageTitle eyebrow={t('layout.groups.game')} title={t('layout.nav.settings')}>
        {t('layout.settingsIntro')}{' '}
        <Link to="/parties" className="font-bold text-orange-fonce hover:underline">
          {t('layout.manageCareers')}
        </Link>
      </PageTitle>

      <section className="card space-y-4 p-5" aria-labelledby="connect-fm">
        <h2 id="connect-fm" className="text-lg">{t('layout.connect.title')}</h2>
        <NextStep step={next} club={club} />
        <FmBridge dataFolder={folder} onHealth={onHealth} />
        {/* Une fois tout relié, l'état en tableau (comme la maquette) ; le formulaire se replie, à portée pour changer. */}
        {next === 'done' && (
          <table className="w-full max-w-2xl text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-brun">
              <tr>
                <th className="px-3 py-2 font-bold">{t('layout.connect.table.setting')}</th>
                <th className="px-3 py-2 font-bold">{t('layout.connect.table.value')}</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['club', club ?? '–'],
                ['save', linked.replace(/\.fm$/i, '')],
                ['saved', linkedFile?.modifiedMs != null ? stampFmt.format(new Date(linkedFile.modifiedMs)) : '–'],
                ['read', t('layout.connect.table.readAuto')],
                ['abilities', t(settings?.fmReadAbilities ? 'layout.connect.table.on' : 'layout.connect.table.off')],
                ['backups', t(settings?.fmBackups ? 'layout.connect.table.on' : 'layout.connect.table.off')],
                ['ai', t(aiFor('gazette') ? 'layout.connect.table.on' : 'layout.connect.table.off')],
              ].map(([k, v]) => (
                <tr key={k} className="border-t border-canard/5 odd:bg-creme/40">
                  <td className="px-3 py-1.5">{t(`layout.connect.table.${k}`)}</td>
                  <td className="px-3 py-1.5 font-bold">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Fold folded={next === 'done'} label={t('layout.connect.change')}>
        <label className="block text-sm font-bold text-canard">
          {t('fm.saveFile.label')}
          <select
            className="input mt-1 block max-w-[20rem] py-1.5 font-normal"
            value={linked}
            disabled={link.isPending}
            onChange={(e) => link.mutate(e.target.value)}
            title={t('fm.saveFile.help')}
          >
            <option value="">{t('fm.saveFile.none')}</option>
            {linked && !linkedFile && <option value={linked}>{t('fm.saveFile.missing', { name: linked })}</option>}
            {saveFiles?.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name.replace(/\.fm$/i, '')}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs font-normal text-brun">
            {linkedFile?.modifiedMs != null ? t('fm.saveFile.saved', { date: stampFmt.format(new Date(linkedFile.modifiedMs)) }) : t('fm.saveFile.help')}
          </span>
        </label>
        <form
          className="flex flex-wrap items-end gap-x-5 gap-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            onImport(input);
          }}
        >
          <label className="block min-w-[18rem] flex-1 text-sm font-bold text-canard">
            {t('fm.folder')}
            <input className="input mt-1 w-full font-normal" required value={input} onChange={(e) => setInput(e.target.value)} />
            <span className="mt-1 block text-xs font-normal text-brun">{t('fm.folderHelp')}</span>
          </label>
          <div className="flex items-center gap-3">
            <button className="btn-primary px-4 py-1.5 text-sm" disabled={importing || !input}>
              {t('fm.import')}
            </button>
            <span className="text-xs text-brun">{t('fm.autoImport')}</span>
          </div>
        </form>
        </Fold>
      </section>

      <GameCompatCard />

      {/* Réglages rarement touchés : repliés, l'écran montre d'abord l'état et la prochaine étape. */}
      <details className="group space-y-4" aria-labelledby="advanced">
        <summary id="advanced" className="cursor-pointer font-display text-lg font-semibold">
          {t('layout.connect.advanced')} <span className="font-sans text-sm font-normal text-brun group-open:hidden">· {t('layout.connect.advancedMore')}</span>
        </summary>
        <div className="card space-y-3 p-4">
          <label className="flex items-center gap-1.5 text-sm text-canard" title={t('fm.abilities.help')}>
            <input
              type="checkbox"
              checked={!!settings?.fmReadAbilities}
              onChange={async (e) => {
                await fmData.updateSettings(saveId, { fmReadAbilities: e.target.checked });
                qc.invalidateQueries({ queryKey: [...key, 'settings'] });
              }}
            />
            {t('fm.abilities.toggle')}
          </label>
          <FmHistoryImport saveId={saveId} folder={folder} club={club} />
          <FmMemory />
        </div>
        <FmBridgeOptions />
        <AiSettingsCard />
      </details>
    </div>
  );
}

/** Replie son contenu derrière un lien quand `folded` ; sinon l'affiche tel quel. */
function Fold({ folded, label, children }: { folded: boolean; label: string; children: ReactNode }) {
  if (!folded) return <>{children}</>;
  return (
    <details className="space-y-4">
      <summary className="cursor-pointer text-sm font-bold text-orange-fonce hover:underline">{label}</summary>
      <div className="mt-3 space-y-4">{children}</div>
    </details>
  );
}

/** Prochaine étape pour relier FM27 : installer le plugin, choisir la sauvegarde, lancer la première lecture. */
export function NextStep({ step, club }: { step: 'career' | 'plugin' | 'save' | 'read' | 'done'; club?: string | null }) {
  const { t } = useTranslation();
  const done = step === 'done';
  return (
    <p className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${done ? 'bg-eau/15' : 'bg-orange-clair'}`} role="status">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${done ? 'bg-eau-fonce' : 'bg-orange-fonce'}`} aria-hidden />
      <span>
        <b>{t(done ? 'layout.connect.ready' : 'layout.connect.next')}</b> {t(`layout.connect.step.${step}`, { club: club ?? '' })}
      </span>
    </p>
  );
}

/** Parties d'un écran : une rangée de pastilles, une partie par onglet (celle choisie en bleu nuit). */
function PageParts({ page, current, go, render }: { page: ClubPage; current: string; go: (v: string) => void; render: (v: string) => ReactNode }) {
  const { t } = useTranslation();
  const parts = PARTS[page];
  const active = parts.includes(current) ? current : parts[0]!;
  const tabs = TABS[page].flat();
  return (
    <>
      {tabs.length > 1 && (
        <div className="sticky top-[3.25rem] z-30 -mx-1 mb-4 flex flex-wrap gap-1.5 bg-creme px-1 py-2" role="tablist" aria-label={t('fm.onThisPage')}>
          {tabs.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={v === active}
              onClick={() => go(v)}
              className={`rounded-md px-3 py-1.5 text-sm font-bold ${v === active ? 'bg-canard text-white' : 'bg-white text-canard ring-1 ring-canard/10 hover:bg-orange-clair'}`}
            >
              {t(`fm.tabNames.${v}`)}
            </button>
          ))}
        </div>
      )}
      <section key={active} role={tabs.length > 1 ? 'tabpanel' : undefined}>
        <HelpHost>{render(active)}</HelpHost>
      </section>
    </>
  );
}

/**
 * L'adjoint parle en tête de chaque écran du club : les messages encore ouverts du briefing qui concernent cet
 * écran, chacun avec son bouton ; sinon une phrase pour dire que rien ne presse ici.
 */
function AssistantSays({ page, saveId, go }: { page: ClubPage; saveId: string; go: (v: string) => void }) {
  const { t } = useTranslation();
  const brief = useCareerStore((s) => s.brief);
  if (!brief.at.startsWith(`${saveId}|`)) return null;
  const lines = brief.items.filter((x) => pageOf(x.view) === page);
  const others = brief.items.length - lines.length;
  return (
    <aside className="mb-5 flex gap-4 rounded-xl border-l-4 border-orange bg-white p-4 ring-1 ring-canard/10" aria-label={t('layout.assistant.label')}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-canard font-extrabold text-white" aria-hidden>
        {t('layout.assistant.initial')}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-extrabold">{t(lines.length ? 'layout.assistant.todo' : 'layout.assistant.label', { count: lines.length })}</p>
        {lines.length ? (
          <ul className="mt-1 space-y-2">
            {lines.map((x, i) => (
              <li key={x.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={`h-2 w-2 shrink-0 rounded-full ${x.tone === 'bad' ? 'bg-corail' : x.tone === 'warn' ? 'bg-ambre' : 'bg-eau'}`} aria-hidden />
                <span className="min-w-0 flex-1 text-[0.95rem]">{x.text}</span>
                <button type="button" className={i === 0 ? 'btn-primary px-3 py-1 text-sm' : 'btn-secondary px-3 py-1 text-sm'} onClick={() => go(x.view)}>
                  {x.action}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[0.95rem] text-brun">{t(`layout.assistant.calm.${page}`)}</p>
        )}
        {others > 0 && (
          <Link to="/" className="mt-2 inline-block text-sm font-bold text-orange-fonce hover:underline">
            {t('layout.assistant.elsewhere', { count: others })}
          </Link>
        )}
      </div>
    </aside>
  );
}

/** En-tête commun aux écrans du club : groupe, nom de l'écran et la question à laquelle il répond. */
function ViewHeader({ view, part }: { view: string; part: string }) {
  const { t } = useTranslation();
  return (
    <header className="mb-2">
      {/* Comme la maquette : l'écran en surtitre, la partie ouverte en titre, puis ce qu'on y regarde. */}
      <p className="text-xs font-bold uppercase tracking-wide text-canard/50">{t(`layout.navShort.${pageOf(view)}`, { defaultValue: pageLabel(t, view) })}</p>
      <h1 className="text-3xl font-semibold">{t(`fm.tabNames.${part}`, { defaultValue: pageLabel(t, view) })}</h1>
      <p className="mt-1 max-w-3xl text-sm text-brun">{t(`fm.intro.${part}`)}</p>
    </header>
  );
}

/** Effectif : tableau détaillé (par défaut, comme la maquette) ou vue terrain par poste ; le choix est gardé d'une visite à l'autre. */
function SquadViews({ players, folder, gameDate, gameFormation, lineup, gameTactic }: { players: FmPlayer[]; folder: string; gameDate: string; gameFormation: string | null; lineup: GameSlot[] | null; gameTactic: string | null }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'pitch' | 'table'>(() => {
    try {
      return localStorage.getItem('fmi.squadView') === 'pitch' ? 'pitch' : 'table';
    } catch {
      return 'table';
    }
  });
  const choose = (m: 'pitch' | 'table') => {
    setMode(m);
    try {
      localStorage.setItem('fmi.squadView', m);
    } catch {
      /* stockage indisponible : le choix vaut pour cette visite */
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-1" role="tablist" aria-label={t('fm.squadPitch.label')}>
        {(['table', 'pitch'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={mode === k}
            onClick={() => choose(k)}
            className={`chip ${mode === k ? 'chip-on' : ''}`}
          >
            {t(`fm.squadPitch.${k}`)}
          </button>
        ))}
      </div>
      {mode === 'pitch' ? <FmSquadPitch players={players} folder={folder} gameFormation={gameFormation} lineup={lineup} gameTactic={gameTactic} /> : <SquadTable players={players} folder={folder} gameDate={gameDate} />}
    </div>
  );
}

type SortKey = 'name' | 'age' | 'level' | 'grade' | 'engine' | 'condition' | 'contractEnd' | 'wage' | 'apps' | 'goals' | 'avgRating';

function SquadTable({ players, folder, gameDate }: { players: FmPlayer[]; folder: string; gameDate: string }) {
  const { t, i18n } = useTranslation();
  // Compatibilité de chaque profil avec le projet de jeu (style visé dans « Mon projet »).
  const { engine } = useTacticEngine(folder, players);
  const [coach] = useCoach();
  const compat = useMemo(() => {
    const list = players.filter((p) => Object.keys(p.attributes).length);
    return compatMap(engine, buildProject(engine, list, coach), list);
  }, [engine, players, coach]);
  // Indice moteur (tests d'attributs FM27) de chaque joueur de champ.
  const engineVals = useMemo(() => new Map(players.map((p) => [p.id, engineValue(p)])), [players]);
  const [line, setLine] = useState<Line | null>(null);
  // Filtre par note de projet (A à E) : une lettre à la fois, un second clic l'enlève.
  const [letter, setLetter] = useState<PlanLetter | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'level',
    desc: true,
  });
  const money = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
  });
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const nf2 = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // « À surveiller » : blessé ou suspendu, fin de contrat dans six mois ou moins, indésirable, moral bas.
  const [watch, setWatch] = useState(false);
  const watched = (p: FmPlayer) =>
    !!p.injury || !!p.suspension || isUnwanted(p.squadStatus) || (p.contractEnd != null && monthsBetween(gameDate, p.contractEnd) <= 6) || (moraleLevel(p.morale) ?? 3) <= 1;

  const rows = useMemo(() => {
    const byLine = line ? players.filter((p) => p.line === line) : players;
    const byLetter = letter ? byLine.filter((p) => compat.get(p.id)?.grade.letter === letter) : byLine;
    const list = watch ? byLetter.filter(watched) : byLetter;
    const val = (p: FmPlayer) => (sort.key === 'grade' ? (compat.get(p.id)?.grade.score ?? null) : sort.key === 'engine' ? (engineVals.get(p.id)?.index ?? null) : p[sort.key]);
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [players, line, sort, watch, gameDate, letter, compat, engineVals]);

  const head = (key: SortKey, label: string, help?: string) => (
    <th className="whitespace-nowrap px-3 py-2 text-left" title={help}>
      <button
        type="button"
        className="font-bold hover:text-canard"
        onClick={() =>
          setSort((s) => ({
            key,
            desc: s.key === key ? !s.desc : key !== 'name',
          }))
        }
      >
        {label}
        {sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
      </button>
    </th>
  );

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {[null, ...LINES].map((l) => (
            <button
              key={l ?? 'all'}
              type="button"
              onClick={() => setLine(l)}
              className={`chip ${line === l ? 'chip-on' : ''}`}
            >
              {t(`fm.line.${l ?? 'all'}`)} · {l ? players.filter((p) => p.line === l).length : players.length}
            </button>
          ))}
          <button type="button" aria-pressed={watch} onClick={() => setWatch((w) => !w)} className={`chip ${watch ? 'chip-on' : ''}`}>
            {t('fm.squadTable.watch')} · {players.filter(watched).length}
          </button>
        </div>
        {compat.size > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" title={t('fm.compat.help')}>
            <span className="text-xs font-bold text-canard/60">{t('fm.squadTable.byGrade')}</span>
            {PLAN_LETTERS.map((l) => {
              const n = players.filter((p) => compat.get(p.id)?.grade.letter === l).length;
              return (
                <button
                  key={l}
                  type="button"
                  aria-pressed={letter === l}
                  disabled={!n}
                  onClick={() => setLetter((x) => (x === l ? null : l))}
                  className={`flex items-center gap-1 rounded-lg px-1 py-0.5 text-xs font-bold disabled:opacity-40 ${letter === l ? 'ring-2 ring-orange' : ''}`}
                >
                  <GradeLetter letter={l} /> {n}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="card mt-4 overflow-x-auto p-0">
        <table className="data-table">
          <thead className="border-b border-canard/10 text-canard/70">
            <tr>
              {head('name', t('fm.col.name'))}
              <th className="px-3 py-2 text-left font-bold">{t('fm.col.positions')}</th>
              {head('age', t('fm.col.age'))}
              {head('level', t('fm.col.level'))}
              {head('grade', t('fm.col.compat'), t('fm.compat.help'))}
              {head('engine', t('fm.col.engine'), t('fm.engine.help'))}
              {head('condition', t('fm.col.condition'))}
              {head('apps', t('fm.col.apps'))}
              {head('goals', t('fm.col.goals'))}
              {head('avgRating', t('fm.col.avgRating'))}
              {head('contractEnd', t('fm.col.contract'))}
              {head('wage', t('fm.col.wage'))}
              <th className="px-3 py-2 text-left font-bold">{t('fm.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const soon = p.contractEnd != null && monthsBetween(gameDate, p.contractEnd) <= 6;
              const absent = p.injury ?? (p.suspension ? (p.suspension === 'Suspendu' ? t('fm.home.kind.suspended') : `${t('fm.home.kind.suspended')} : ${p.suspension}`) : null);
              return (
                <tr key={p.id} className="border-b border-canard/5 odd:bg-creme/40">
                  <td className="max-w-[16rem] px-3 py-1.5 font-bold">
                    <span className="block whitespace-nowrap">
                      <PlayerLink player={p} />
                    </span>
                    {absent && (
                      <span className="mt-0.5 block truncate text-xs font-normal text-corail" title={absent}>
                        ✚ {absent}
                      </span>
                    )}
                  </td>
                  <td className="min-w-[8rem] max-w-[11rem] px-3 py-1.5 text-brun">{p.positionsLabel.replace(/ \(/g, '\u00a0(')}</td>
                  <td className="px-3 py-1.5 tabular-nums">{p.age ?? '–'}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-bold tabular-nums">
                    {p.level != null ? nf1.format(p.level) : '–'}
                    {p.level != null && (roleCeiling(p.level, p) ?? 0) - p.level >= 0.4 && (
                      <span className="ml-2 text-xs font-normal text-eau-fonce" title={t('fm.col.starsHelp')}>
                        → {nf1.format(roleCeiling(p.level, p)!)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <CompatTag c={compat.get(p.id)} compact />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <EngineTag v={engineVals.get(p.id)} />
                  </td>
                  <td className={`px-3 py-1.5 tabular-nums ${p.condition != null && p.condition < 85 ? 'font-bold text-corail' : ''}`}>{p.condition != null ? `${Math.round(p.condition)} %` : '–'}</td>
                  <td className="px-3 py-1.5 tabular-nums">{p.apps ?? '–'}</td>
                  <td className="px-3 py-1.5 tabular-nums">{p.goals ?? '–'}</td>
                  <td className="px-3 py-1.5 tabular-nums">{p.avgRating != null && p.avgRating > 0 ? nf2.format(p.avgRating) : '–'}</td>
                  <td className={`whitespace-nowrap px-3 py-1.5 ${soon ? 'font-bold text-orange-fonce' : ''}`} title={soon ? t('fm.squadTable.contractSoon') : undefined}>
                    {p.contractEnd ? date.format(new Date(p.contractEnd)) : '–'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{p.wage != null ? money.format(p.wage) : '–'}</td>
                  <td className="px-3 py-1.5 text-xs leading-tight text-brun">{p.squadStatus ?? '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}


/**
 * Reprise d'une carrière déjà suivie : le plugin garde un instantané par jour de jeu (`archivix-AAAA-MM-JJ.json`).
 * On les regroupe par club et le joueur choisit lequel importer dans cette partie (du plus ancien au plus récent).
 * Les jours déjà présents ne sont pas réimportés ; un fichier sans aucun nom de joueur (lecture ratée) est ignoré.
 */
export function FmHistoryImport({ saveId, folder, club }: { saveId: string; folder: string; club: string | null }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const { data: files } = useQuery({
    queryKey: ['fm', 'history-files', folder],
    queryFn: () => invoke<FmHistoryFile[]>('fm_history_list', { folder }),
    enabled: !!folder,
  });
  const { data: known } = useQuery({
    queryKey: ['fm', saveId, 'history'],
    queryFn: () => fmData.history(saveId),
  });
  const groups = useMemo(() => {
    const have = new Set((known ?? []).map((h) => h.gameDate.slice(0, 10)));
    const by = new Map<string, FmHistoryFile[]>();
    for (const f of files ?? []) if (f.club) by.set(f.club, [...(by.get(f.club) ?? []), f]);
    return [...by.entries()]
      .map(([name, list]) => ({ name, list, missing: list.filter((f) => !have.has(f.gameDate)) }))
      .sort((a, b) => (a.name === club ? -1 : b.name === club ? 1 : b.list.at(-1)!.gameDate.localeCompare(a.list.at(-1)!.gameDate)));
  }, [files, known, club]);
  const run = useMutation({
    mutationFn: async (list: FmHistoryFile[]) => {
      let imported = 0;
      setProgress({ done: 0, total: list.length });
      for (const [i, f] of list.entries()) {
        const raw = JSON.parse(await invoke<string>('fm_history_read', { folder, gameDate: f.gameDate })) as { players?: { name?: string }[] };
        if (raw.players?.some((p) => p.name)) {
          await fmData.importSnapshot(saveId, raw, { force: true });
          imported++;
        }
        setProgress({ done: i + 1, total: list.length });
      }
      return imported;
    },
    onSettled: () => {
      setProgress(null);
      qc.invalidateQueries({ queryKey: ['fm', saveId] });
      qc.invalidateQueries({ queryKey: ['saves'] });
    },
  });
  if (!groups.length) return null;
  const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const day = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));
  return (
    <div className="border-t border-canard/10 pt-3">
      <h3 className="text-sm font-bold text-canard">{t('fm.history.title')}</h3>
      <p className="mt-0.5 text-xs text-brun">{t('fm.history.help')}</p>
      <ul className="mt-2 space-y-1.5">
        {groups.map((g) => (
          <li key={g.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-canard">
            <span className="font-bold">{g.name}</span>
            <span className="text-brun">
              {t('fm.history.range', { count: g.list.length, from: day(g.list[0]!.gameDate), to: day(g.list.at(-1)!.gameDate) })}
            </span>
            {g.missing.length ? (
              <button type="button" className="btn-secondary px-3 py-1 text-xs" disabled={run.isPending} onClick={() => run.mutate(g.missing)}>
                {t('fm.history.import', { count: g.missing.length })}
              </button>
            ) : (
              <span className="text-xs text-eau-fonce">{t('fm.history.done')}</span>
            )}
          </li>
        ))}
      </ul>
      {progress && <p className="mt-2 text-xs text-brun">{t('fm.history.progress', progress)}</p>}
      {run.isSuccess && !progress && <p className="mt-2 text-xs text-eau-fonce">{t('fm.history.result', { count: run.data })}</p>}
      {run.isError && <p className="mt-2 text-xs text-corail">{t('fm.importError', { reason: String(run.error?.message ?? run.error) })}</p>}
    </div>
  );
}

/**
 * Barre d'état du centre de contrôle : FM27 ouvert ou fermé, et le plugin s'il demande une action (lien vers ses
 * réglages). La lecture de la partie suit, à droite.
 */
function GameState() {
  const { t } = useTranslation();
  const { status } = useGameStatus();
  const bridgeOk = useCareerStore((s) => s.sync.bridgeOk);
  if (!status?.gameFound) return null;
  return (
    <>
      <span className="flex items-center gap-1.5 text-xs text-brun">
        <span className={`h-2 w-2 rounded-full ${status.running ? 'bg-eau' : 'bg-canard/25'}`} aria-hidden />
        {t(status.running ? 'layout.state.open' : 'layout.state.closed')}
      </span>
      {bridgeOk === false && (
        <Link to="/reglages" className="flex items-center gap-1.5 text-xs font-bold text-orange-fonce hover:underline">
          <span className="h-2 w-2 rounded-full bg-ambre" aria-hidden />
          {t('layout.state.plugin')}
        </Link>
      )}
    </>
  );
}

/**
 * Tableau de commande en tête de l'accueil : un voyant par écran du club (ce que l'adjoint laisse à faire, le plus
 * urgent d'abord) et un pour le jeu (FM27 ouvert, plugin). Chaque voyant a une seule action.
 */
function ControlBoard({ saveId, go }: { saveId: string; go: (v: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const brief = useCareerStore((s) => s.brief);
  const bridgeOk = useCareerStore((s) => s.sync.bridgeOk);
  const { status } = useGameStatus();
  // Le prochain match a son bandeau juste en dessous : pas de voyant pour lui.
  const items = brief.at.startsWith(`${saveId}|`) ? brief.items.filter((x) => !/^(nextMatch|friendly):/.test(x.key)) : [];
  const rank = (tone: string) => (tone === 'bad' ? 0 : tone === 'warn' ? 1 : 2);
  const dot = (tone: string) => (tone === 'bad' ? 'bg-corail' : tone === 'warn' ? 'bg-ambre' : 'bg-eau');
  const tile = (key: string, label: string, tone: string, text: string, action: string, onClick: () => void) => (
    <button key={key} type="button" onClick={onClick} className="card flex min-w-0 flex-col gap-1 p-3 text-left hover:ring-orange/40">
      <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brun">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot(tone)}`} aria-hidden />
        {label}
      </span>
      <span className="line-clamp-2 text-sm text-canard">{text}</span>
      <span className="mt-auto text-xs font-bold text-orange-fonce">{action} →</span>
    </button>
  );
  const pluginBad = bridgeOk === false;
  return (
    <nav className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label={t('layout.board.label')}>
      {CLUB_PAGES.map((page) => {
        const open = items.filter((x) => pageOf(x.view) === page);
        const first = [...open].sort((a, b) => rank(a.tone) - rank(b.tone))[0];
        return first
          ? tile(page, t(`layout.nav.${page}`), first.tone === 'bad' ? 'bad' : 'warn', open.length > 1 ? t('layout.board.more', { text: first.text, count: open.length - 1 }) : first.text, first.action, () => go(first.view))
          : tile(page, t(`layout.nav.${page}`), 'good', t('layout.board.calm'), t('layout.board.open'), () => go(page));
      })}
      {tile(
        'game',
        t('layout.board.game'),
        pluginBad ? 'warn' : status?.running ? 'good' : 'idle',
        pluginBad ? t('layout.state.plugin') : t(status?.running ? 'layout.state.open' : 'layout.state.closed'),
        t('layout.nav.settings'),
        () => navigate('/reglages'),
      )}
    </nav>
  );
}

/**
 * « Plugin et réglages » sans carrière : la première étape est de créer sa carrière, mais le plugin peut déjà être
 * installé (il écrit dans le dossier par défaut de FM27).
 */
export function SettingsWithoutCareer() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setCreateSaveOpen = useUi((s) => s.setCreateSaveOpen);
  const { data: folder } = useQuery({ queryKey: ['fm', 'default-folder'], queryFn: () => invoke<string | null>('fm_default_folder') });
  return (
    <div className="mx-auto w-full max-w-[96rem] space-y-6 px-6 py-5 xl:px-10">
      <h1 className="text-3xl font-semibold">{t('layout.nav.settings')}</h1>
      <section className="card space-y-4 p-5" aria-labelledby="connect-fm">
        <h2 id="connect-fm" className="text-lg">{t('layout.connect.title')}</h2>
        <NextStep step="career" />
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setCreateSaveOpen(true);
            navigate('/parties');
          }}
        >
          {t('layout.connect.createCareer')}
        </button>
        {folder && <FmBridge dataFolder={folder} />}
      </section>
      <GameCompatCard />
    </div>
  );
}
