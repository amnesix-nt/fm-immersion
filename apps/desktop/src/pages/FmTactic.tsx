import {
  FORMATIONS,
  POS_LABEL,
  lineOf,
  STYLE_FORMS,
  TacticEngine,
  bestTactic,
  builtPlan,
  builtStyle,
  rankTactics,
  knownFormation,
  mergeReference,
  opponentReport,
  rankForMatch,
  matchPlan,
  oppositionInstructions,
  styleOfGameTactic,
  SWITCH_POINTS,
  phaseXY,
  planFromLineup,
  playerInstructions,
  instructionBudget,
  tactAbility,
  shapeOf,
  slotPos,
  oopFit,
  spreadXY,
  unavailable,
  styleBlock,
  tacticReferenceSchema,
  type BalanceCheck,
  type FmPlayer,
  type FmSnapshot,
  type GameSlot,
  type FormationPlan,
  type ProjectTemplate,
  type Phase,
  type PosCode,
  type TacticReference,
} from '@fm-immersion/module-fm';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { competitionWeight, formationOfPositions, formationOfSlots, gameFormationOf, gameInstructions, gameLineup, gamePlayerInstructions, instructionLoad, isCongested, lineupAdvice, LOAD_WINDOW_DAYS, matchdayPlan, matchResults, matchReview, matchStats, recentLoad, snapshotFixtures, summarize, tacticSlots, tacticTodo, teamAdvice, TEAM_INSTRUCTIONS_FM27, type PlayerStats } from '@fm-immersion/module-fm';
import { GamePiLine, LineupAdviceCard, MatchReviewCard, PhysicalCard, PiState, TeamAdviceBlock, TodoCard } from './FmTacticAdvice';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LINE_COLOR, Pitch, PosBadge } from './FmFoot';
import { readBuiltTactics } from './FmBuilder';
import { readScoped, useFmSaveScope, writeScoped } from '../lib/save-store';
import { fitPct, More, PlayerLink, TeamCards, useCoachRaw, SectionStack, ProjectTemplateContext } from './FmUi';

// v2 : le choix automatique (meilleure tactique applicable) devient la valeur par défaut.
const PREFS_KEY = 'fmi.tactic.v2';
/** Signalé quand la tactique choisie (ou une tactique construite) change. */
export const TACTIC_EVENT = 'fmi:tactic';
interface Prefs {
  style?: string;
  form?: string;
  phase?: Phase;
  /** Onze affiché : celui lu dans le jeu (par défaut quand il existe) ou celui calculé par FM Immersion. */
  source?: 'game' | 'simloom' | 'built';
  /** Tactique construite (Construire) choisie quand source = 'built'. */
  built?: string;
}

/** Repères locaux (`simloom-roles.json` dans le dossier du plugin) s'ils existent et sont valides. */
async function loadLocalReference(folder: string): Promise<{ ref: TacticReference | null; error: boolean }> {
  if (!folder) return { ref: null, error: false };
  try {
    const text = await invoke<string | null>('fm_read_reference', { folder });
    if (!text) return { ref: null, error: false };
    return { ref: tacticReferenceSchema.parse(JSON.parse(text)), error: false };
  } catch {
    return { ref: null, error: true };
  }
}

/** Moteur tactique avec les repères maison, remplacés par les repères locaux du joueur s'il en a. */
export function useTacticEngine(folder: string, _players: FmPlayer[] = []) {
  const { data: local } = useQuery({ queryKey: ['fm', 'reference', folder], queryFn: () => loadLocalReference(folder), staleTime: 60_000 });
  // Notes sur 20 calculées sur les attributs, échelle fixe pour toute l'appli (les étoiles du jeu sont relatives à
  // l'effectif et ne permettent pas de comparer une recrue d'un autre club).
  const engine = useMemo(() => new TacticEngine(mergeReference(local?.ref)).absolute(), [local?.ref]);
  return { engine, local };
}

/**
 * Style, schéma et onze choisis en Tactique > Composition (retenus d'une vue à l'autre) :
 * les autres vues de l'effectif s'appuient dessus pour rester cohérentes.
 */
/** Réserve et jeunes du club (joueurs avec `team`), fournis par l'écran de la partie : appelés quand un poste reste vide. */
export const ReserveContext = createContext<FmPlayer[]>([]);

export function useTacticChoice(players: FmPlayer[], folder: string, gameFormation: string | null, lineup: GameSlot[] | null = null, gameTactic: string | null = null) {
  const { engine, local } = useTacticEngine(folder, players);
  const reserveAll = useContext(ReserveContext);
  const reserve = useMemo(() => reserveAll.filter((p) => !unavailable(p) && Object.keys(p.attributes).length > 0), [reserveAll]);
  // Choix retenus par partie : chaque carrière a son style et son schéma.
  const scope = useFmSaveScope();
  const [prefs, setPrefs] = useState<Prefs>(() => readScoped<Prefs>(PREFS_KEY, scope, {}));
  const update = (p: Prefs) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    writeScoped(PREFS_KEY, scope, next);
    // Les autres écrans ouverts (dont le projet de jeu de toute l'appli) suivent le nouveau choix.
    window.dispatchEvent(new Event(TACTIC_EVENT));
  };
  const [builtRev, setBuiltRev] = useState(0);
  useEffect(() => {
    const on = () => {
      setPrefs(readScoped<Prefs>(PREFS_KEY, scope, {}));
      setBuiltRev((n) => n + 1);
    };
    window.addEventListener(TACTIC_EVENT, on);
    return () => window.removeEventListener(TACTIC_EVENT, on);
  }, [scope]);
  const avail = useMemo(() => players.filter((p) => !unavailable(p) && Object.keys(p.attributes).length > 0), [players]);
  // Classement commun à tous les onglets : chaque style avec la note d'équipe de son meilleur onze.
  const ranked = useMemo(() => rankTactics(engine, avail, reserve), [engine, avail, reserve]);
  const [coach] = useCoachRaw();
  // Sans choix du joueur : la meilleure tactique applicable, ou le projet dès qu'il devient le meilleur.
  // Tactique de base : celle jouée dans FM27 (d'après son nom), gardée tant qu'une autre ne gagne pas nettement.
  const base = useMemo(() => styleOfGameTactic(gameTactic, engine.ref.styles), [gameTactic, engine]);
  const gameForm0 = knownFormation(gameFormation);
  const pick = useMemo(() => bestTactic(engine, avail, coach, ranked, base, gameForm0), [engine, avail, coach, ranked, base, gameForm0]);
  // Tactiques construites dans Tactique > Construire : on peut en choisir une à la place d'un style.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const builtList = useMemo(() => readBuiltTactics(scope), [scope, builtRev]);
  const built = prefs.source === 'built' ? (builtList.find((b) => b.id === prefs.built) ?? null) : null;
  const builtStyleRef = useMemo(() => (built ? builtStyle(built) : null), [built]);
  const auto = !prefs.style && !built;
  const style = builtStyleRef ?? (auto ? pick?.style : ranked.find((r) => r.style.id === prefs.style)?.style) ?? ranked[0]?.style;
  const gameForm = gameForm0;
  const natural = (style && STYLE_FORMS[style.id]?.filter((f) => FORMATIONS[f])) || ['4-3-3'];
  const form = prefs.form && FORMATIONS[prefs.form] ? prefs.form : auto && pick ? pick.form : (gameForm ?? natural[0] ?? '4-3-3');
  const plans = useMemo(() => ranked.find((r) => r.style.id === style?.id)?.plans ?? [], [ranked, style]);
  const gamePlan = useMemo(() => (lineup ? planFromLineup(engine, lineup, players, gameForm ?? gameFormation, reserve) : null), [engine, lineup, players, gameForm, gameFormation, reserve]);
  const builtPlanA = useMemo(() => (built ? builtPlan(engine, built, avail, reserve) : null), [engine, built, avail, reserve]);
  const fromGame = !!gamePlan && prefs.source !== 'simloom' && !built;
  const plan = builtPlanA ?? (fromGame ? gamePlan : plans.find((p) => p.form === form));
  const shownForm = builtPlanA ? builtPlanA.form : fromGame ? gamePlan.form || form : form;
  return { engine, local, prefs, update, avail, reserve, ranked, style, natural, form: shownForm, plans, plan, gamePlan, fromGame, auto, pick, built, builtList };
}

/**
 * Projet de jeu de toute l'appli : la tactique choisie en Tactique (lue dans le jeu, conseillée, choisie par style ou
 * construite), réduite à son style, son schéma et le rôle de chaque poste.
 */
export function ProjectProvider({ players, folder, gameFormation, lineup, gameTactic, children }: { players: FmPlayer[]; folder: string; gameFormation: string | null; lineup: GameSlot[] | null; gameTactic: string | null; children: ReactNode }) {
  const { engine, style, form, plan, fromGame, auto, built, avail } = useTacticChoice(players, folder, gameFormation, lineup, gameTactic);
  const template = useMemo<ProjectTemplate | null>(() => {
    if (!style) return null;
    const source: ProjectTemplate['source'] = built ? 'built' : fromGame ? 'game' : auto ? 'auto' : 'style';
    const full = (p: FormationPlan | null | undefined) => p && p.slots.length === 11 && p.slots.every((s) => s.ip && s.oop);
    // Rôles du jeu inconnus à un poste : on retombe sur ceux du style dans le même schéma.
    const src = full(plan) ? plan! : FORMATIONS[form] ? engine.formationPlan(form, style, avail) : null;
    if (!full(src)) return null;
    return { style, form, source, slots: src!.slots.map((s) => ({ pos: s.pos, ...(s.posOOP ? { posOOP: s.posOOP } : {}), ip: s.ip, oop: s.oop })) };
  }, [engine, style, form, plan, fromGame, auto, built, avail]);
  return <ProjectTemplateContext.Provider value={template}>{children}</ProjectTemplateContext.Provider>;
}

const DOT: Record<BalanceCheck['status'], string> = { good: 'bg-eau', warn: 'bg-ambre', bad: 'bg-corail' };

/** Tactique : style conseillé, schéma, onze par rôles, formes avec et sans ballon, équilibre. */
type TacticProps = { matches?: { gameDate: string; data: FmSnapshot }[]; snap?: FmSnapshot; players: FmPlayer[]; folder: string; gameFormation: string | null; lineup: GameSlot[] | null; lineupStatus?: string | null; go?: (view: string) => void; part?: 'lineup' | 'instructions' };

/** Les tactiques enregistrées dans FM27 (trois emplacements) : celle qui est active, et celle que le joueur regarde. */
interface SlotChoice {
  names: string[];
  active: string | null;
  /** Tactique affichée (l'active, ou une autre retrouvée dans les instantanés). */
  shown: string | null;
  /** Date de jeu de l'instantané d'où vient la tactique affichée, quand ce n'est pas l'active. */
  seen: string | null;
  /** Tactique demandée que le plugin n'a encore jamais lue (jamais active pendant un instantané). */
  missing: string | null;
  pick: (name: string) => void;
}

/**
 * Tactique : le plugin ne lit que la tactique active dans FM27. Pour regarder une autre des trois tactiques du joueur,
 * on reprend le dernier instantané où elle était active (son onze, ses rôles, ses consignes), avec l'effectif d'aujourd'hui.
 */
export function FmTactic(props: TacticProps) {
  const { snap, matches } = props;
  const [wanted, setWanted] = useState<string | null>(null);
  const active = typeof snap?.tactic?.name === 'string' ? snap.tactic.name : null;
  const names = useMemo(() => {
    const raw = (snap?.tactic as { slotNames?: unknown } | null | undefined)?.slotNames;
    return Array.isArray(raw) ? [...new Set(raw.filter((n): n is string => typeof n === 'string' && n.trim().length > 0))] : [];
  }, [snap]);
  const old = useMemo(() => {
    if (!wanted || wanted === active || !snap) return null;
    const hit = [...(matches ?? [])].reverse().find((m) => m.data.tactic?.name === wanted && gameLineup(m.data));
    if (!hit) return null;
    const custom = { ...((snap.custom as Record<string, unknown> | undefined) ?? {}), tactique: (hit.data.custom as Record<string, unknown> | undefined)?.tactique };
    const merged = { ...snap, tactic: hit.data.tactic, lineup: (hit.data as { lineup?: unknown }).lineup, custom } as FmSnapshot;
    const lineup = gameLineup(merged);
    const named = gameFormationOf(merged.tactic);
    const gameFormation = (named && knownFormation(named)) || (lineup ? formationOfPositions(lineup.map((x) => x.pos)) : null) || formationOfSlots(tacticSlots(merged.tactic)) || named;
    return { snap: merged, lineup, gameFormation, date: hit.gameDate };
  }, [wanted, active, snap, matches]);
  const slots: SlotChoice | undefined =
    names.length > 1 ? { names, active, shown: old ? wanted : active, seen: old?.date ?? null, missing: wanted && wanted !== active && !old ? wanted : null, pick: setWanted } : undefined;
  return <FmTacticView {...props} {...(old ? { snap: old.snap, lineup: old.lineup, gameFormation: old.gameFormation } : {})} slots={slots} />;
}

function FmTacticView({ snap, players, folder, gameFormation, lineup, lineupStatus, go, part, matches, slots }: TacticProps & { slots?: SlotChoice }) {
  // Sous-onglet affiché : le onze (et ses consignes d'équipe) ou les consignes individuelles ; les deux sans `part`.
  const showLineup = part !== 'instructions';
  const showPi = part !== 'lineup';
  const gameTactic = typeof snap?.tactic?.name === 'string' ? snap.tactic.name : null;
  const { t, i18n } = useTranslation();
  const en = i18n.resolvedLanguage === 'en';
  const { engine, local, prefs, update, avail, reserve, ranked, style, natural, form, plans, plan: planA, gamePlan, fromGame, auto, pick, built, builtList } = useTacticChoice(players, folder, gameFormation, lineup, gameTactic);
  const phase: Phase = prefs.phase ?? 'ip';
  // Équipe B : le meilleur onze possible sans les titulaires de l'équipe A, même schéma et même style
  // (rotation, coupes, matchs rapprochés). Au poste, toujours le meilleur joueur restant.
  const [team, setTeam] = useState<'A' | 'B'>('A');
  const planB = useMemo(() => {
    if (!planA || !style) return null;
    const starters = new Set(planA.slots.flatMap((sl) => (sl.player ? [sl.player.id] : [])));
    if (built) return builtPlan(engine, built, avail.filter((p) => !starters.has(p.id)), reserve.filter((p) => !starters.has(p.id)));
    const bForm = FORMATIONS[form] ? form : (pick?.form ?? '4-3-3');
    return engine.formationPlan(bForm, style, avail.filter((p) => !starters.has(p.id)), reserve.filter((p) => !starters.has(p.id)));
  }, [engine, planA, style, form, pick, avail, reserve, built]);
  const plan = team === 'B' && planB ? planB : planA;
  const opp = useMemo(() => (snap ? opponentReport(snap) : null), [snap]);
  // Tactique du match : la meilleure combinaison style × schéma contre le prochain adversaire.
  // Une base, des ajustements : on part de la tactique de base, un changement doit rapporter plus qu'il ne coûte.
  const forMatch = useMemo(() => (opp ? rankForMatch(ranked, opp, pick ? { style: pick.style.id, form: pick.form } : null) : []), [ranked, opp, pick]);
  const best = forMatch[0];
  // Réglages du match : consignes d'équipe, mentalité et marquage à changer contre cet adversaire, dans le style retenu.
  const threat = typeof (snap?.nextMatch as { threatLevel?: unknown } | null | undefined)?.threatLevel === 'string' ? ((snap!.nextMatch as { threatLevel: string }).threatLevel) : null;
  const adjust = useMemo(() => (opp && style && planA ? matchPlan(style, opp, planA, threat) : null), [opp, style, planA, threat]);
  // Écran Adversaire du jeu : consignes joueur par joueur sur leurs joueurs clés et leur relance.
  const oppRows = useMemo(() => (opp ? oppositionInstructions(opp, style) : []), [opp, style]);
  const footRead = !!opp && opp.squad.some((p) => p.foot);
  const baseKey = pick ? `${pick.style.id}|${pick.form}` : null;
  // Poste survolé : mis en évidence à la fois sur le terrain et dans la liste.
  const [hover, setHover] = useState<number | null>(null);

  // Ce que le plugin a lu de la tactique réglée dans FM27 : consignes d'équipe, consignes individuelles par joueur, charge.
  const gameTi = useMemo(() => gameInstructions(snap), [snap]);
  const gamePi = useMemo(() => gamePlayerInstructions(snap), [snap]);
  const load = useMemo(() => instructionLoad(snap), [snap]);
  // L'avis de l'adjoint porte sur le onze de base (équipe A) : rôles à revoir, titulaires, joueurs à relancer, doublures.
  const advice = useMemo(() => (planA ? lineupAdvice(engine, planA, avail, built ? 'built' : fromGame ? 'game' : 'suggested') : null), [engine, planA, avail, built, fromGame]);
  // Physique et rotation : titulaires à ménager avant le prochain match (risque de blessure, condition, matchs enchaînés).
  const physical = useMemo(() => {
    if (!planA || !snap) return null;
    const next = summarize(snap, players).nextMatch;
    const rotate = competitionWeight(next?.competition, { congested: isCongested(snapshotFixtures(snap), snap.gameDate) }).rotate;
    return matchdayPlan(engine, planA, players, { rotate, inDays: next?.inDays ?? null, load: recentLoad(matchResults(matches ?? []), snap.gameDate) }).watch;
  }, [engine, planA, players, snap, matches]);
  // Onze du jeu : on part des consignes réglées dans FM27, pas de celles d'un style que le joueur n'a pas choisi.
  const tiBase: 'style' | 'game' = fromGame && gameTi && Object.keys(gameTi.ti).length > 0 ? 'game' : 'style';
  // Ce que les derniers matchs disent de la tactique jouée, et les stats de la saison de chaque joueur.
  const review = useMemo(() => matchReview(matches ?? [], gameTactic), [matches, gameTactic]);
  const seasonStats = useMemo(() => (snap ? matchStats(snap) : new Map<string, PlayerStats>()), [snap]);
  // Les corrections tirées des matchs ne valent que pour la tactique qui les a joués : celle du jeu.
  const tiAdvice = useMemo(() => (planA && style ? teamAdvice(planA, style, gameTi, tiBase, tiBase === 'game' && review.scoped ? review.findings : []) : null), [planA, style, gameTi, tiBase, review]);
  const gameTiLabels = useMemo(() => {
    const of = (oop: boolean) => TEAM_INSTRUCTIONS_FM27.filter((d) => (d.phase === 'oop' || d.code === 'DefensiveTransition') === oop).flatMap((d) => {
      const l = gameTi ? d.options[gameTi.ti[d.id] ?? -1] : null;
      return l ? [l] : [];
    });
    return { ip: of(false), oop: of(true) };
  }, [gameTi]);

  if (!avail.length || !style || !plan) return <p className="card mt-6 text-brun">{t('fm.tac.noAttributes')}</p>;

  const block = styleBlock(style);
  // Complexité : moins l'effectif lit le jeu, moins on charge chaque joueur de consignes individuelles.
  const budget = instructionBudget(style, tactAbility(avail), load.understanding);
  // « À changer dans FM27 » : tout ce que les conseils demandent de modifier dans la tactique du jeu, en une liste.
  // (calcul direct : on est après le retour anticipé, un hook n'a pas sa place ici)
  const todo = (() => {
    if (!planA || !fromGame) return [];
    const players = planA.slots.flatMap((sl) => {
      if (!sl.player) return [];
      const st = seasonStats.get(sl.player.id);
      const supported = playerInstructions(engine, sl, style, planA.slots, 3, st).list;
      return [{ player: sl.player, list: budget < 3 ? playerInstructions(engine, sl, style, planA.slots, budget, st).list : supported, supported, game: gamePi.get(sl.player.id) ?? null }];
    });
    return tacticTodo({ team: tiBase === 'game' ? tiAdvice : null, lineup: advice, players, budget });
  })();
  // Rôle avec ballon : FM27 fixe la mission d'après le rôle, on l'affiche à côté (« Milieu axial (Soutien) »).
  const roleName = (code: string, ph?: Phase) => {
    const r = engine.roles.get(code);
    const name = (en ? r?.en : r?.fr) ?? r?.fr ?? code;
    return ph === 'ip' && r?.duty ? `${name} (${t(`fm.tac.duty.${r.duty}`)})` : name;
  };
  const styleName = (s: typeof style) => (en && s.nameEn ? s.nameEn : s.name);
  const nf = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Avec des étoiles lues dans le jeu, les notes sont sur l'échelle du jeu : on les montre en étoiles (10 = 0, 20 = 5).
  const note = fitPct;
  const field = plan.slots.filter((s) => s.pos !== 'GB');
  const shape = (ph: Phase) => shapeOf(field.map((s) => phaseXY(s, ph, block)));
  // Écarts minimum entre deux joueurs (en % du terrain) à la taille des pastilles, gardées dans le terrain.
  const shown = spreadXY(plan.slots.map((s) => phaseXY(s, phase, block)), 27, 11).map(([x, y]) => [Math.min(86, Math.max(14, x)), Math.min(93, Math.max(6, y))] as [number, number]);
  const other: Phase = phase === 'ip' ? 'oop' : 'ip';
  // Lignes du tableau rangées comme on lit un terrain : gardien, défense, milieu, attaque ; de gauche à droite dans chaque ligne.
  const ROW_ORDER: readonly PosCode[] = ['GB', 'DLG', 'DG', 'DC', 'DD', 'DLD', 'MDF', 'MG', 'MC', 'MD', 'MOG', 'MOC', 'MOD', 'BT'];
  const rows = plan.slots
    .map((_, i) => i)
    .sort((a, b) => ROW_ORDER.indexOf(plan.slots[a]!.pos) - ROW_ORDER.indexOf(plan.slots[b]!.pos) || plan.slots[a]!.x - plan.slots[b]!.x);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* D'abord : de quelle tactique parle-t-on ? La tienne (lue dans FM27) ou la proposition de l'appli. */}
        {gamePlan && (
          <div className="flex gap-1" role="tablist">
            {(['game', 'simloom'] as const).map((src) => (
              <button
                key={src}
                type="button"
                role="tab"
                aria-selected={!built && (src === 'game') === fromGame}
                onClick={() => update({ source: src })}
                className={`chip ${!built && (src === 'game') === fromGame ? 'chip-on' : ''}`}
              >
                {t(`fm.tac.source.${src}`)}
              </button>
            ))}
          </div>
        )}
        {fromGame && slots ? (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('fm.tac.slots.label')}>
            {slots.names.map((n) => (
              <button key={n} type="button" role="tab" aria-selected={n === slots.shown} onClick={() => slots.pick(n)} className={`chip ${n === slots.shown ? 'chip-on' : ''}`}>
                {n}
                {n === slots.active && <span className="ml-1.5 text-xs font-normal opacity-80">{t('fm.tac.slots.active')}</span>}
              </button>
            ))}
          </div>
        ) : (
          fromGame && gameTactic && <span className="text-sm font-bold text-canard">{gameTactic}</span>
        )}
        {/* Style et schéma ne se choisissent que pour la proposition de l'appli : ta tactique FM27 a déjà les siens. */}
        {!fromGame && (<>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm font-bold" title={style.summary ?? undefined}>
          {t('fm.tac.style')}
          <select
            className="input py-1.5 font-normal"
            value={built ? `built:${built.id}` : auto ? '' : style.id}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('built:')) update({ source: 'built', built: v.slice(6) });
              else update({ style: v || undefined, form: undefined, ...(built ? { source: 'simloom' as const, built: undefined } : {}) });
            }}
          >
            <option value="">{t('fm.tac.auto')}</option>
            <optgroup label={t('fm.tac.styles')}>
              {ranked.map((r) => (
                <option key={r.style.id} value={r.style.id}>
                  {styleName(r.style)} · {note(r.fit)}
                </option>
              ))}
            </optgroup>
            {builtList.length > 0 && (
              <optgroup label={t('fm.tac.myTactics')}>
                {builtList.map((b) => (
                  <option key={b.id} value={`built:${b.id}`}>
                    {b.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm font-bold">
          {t('fm.tac.formation')}
          <select className="input py-1.5 font-normal" value={form} disabled={fromGame || !!built} onChange={(e) => update({ form: e.target.value })}>
            {(fromGame || built) && !plans.some((p) => p.form === form) && <option value={form}>{form || gameFormation}</option>}
            {plans.map((p) => (
              <option key={p.form} value={p.form}>
                {p.form} · {note(p.score)}
              </option>
            ))}
          </select>
        </label>
        </>)}
        {auto && pick && !fromGame && (
          <span className="rounded-md bg-eau/20 px-1.5 py-0.5 text-xs font-bold text-canard">{t(pick.kept ? 'fm.tac.baseKept' : pick.project ? 'fm.tac.projectBest' : 'fm.tac.bestNow')}</span>
        )}
        {auto && pick?.kept && !fromGame && (
          <div className="-mt-2 w-full">
            <More>{t('fm.tac.baseKeptHelp', { other: `${pick.kept.form} ${styleName(pick.kept.style)}`, gain: nf1.format(Math.max(0, pick.kept.gain)), need: nf1.format(SWITCH_POINTS) })}</More>
          </div>
        )}
        {gameFormation && <span className="rounded-md bg-eau/20 px-1.5 py-0.5 text-xs text-canard">{t('fm.tac.inGame', { form: gameFormation })}</span>}
        {fromGame && slots?.seen && (
          <p className="w-full rounded-xl bg-orange-clair/60 px-3 py-2 text-sm text-canard">
            {t('fm.tac.slots.preview', { name: slots.shown ?? '', date: new Date(slots.seen).toLocaleDateString(i18n.resolvedLanguage), active: slots.active ?? '' })}
          </p>
        )}
        {fromGame && slots?.missing && <p className="w-full rounded-xl bg-ambre/20 px-3 py-2 text-sm text-canard">{t('fm.tac.slots.missing', { name: slots.missing, active: slots.active ?? '' })}</p>}
        {local?.ref && <span className="rounded-md bg-eau/20 px-1.5 py-0.5 text-xs text-canard">{t('fm.tac.localRef')}</span>}
        {local?.error && <span className="rounded-md bg-corail/15 px-1.5 py-0.5 text-sm text-canard">{t('fm.tac.localRefError')}</span>}
      </div>
      

      {showLineup && (
      <SectionStack
        sections={[
          {
            id: 'xi',
            label: t('fm.tac.sections.xi'),
            node: (
              <>
              {/* D'abord ce que disent les matchs et ce qu'il faut changer dans le jeu ; le onze et son détail ensuite. */}
              {team === 'A' && (
                <div className={`grid items-start gap-4 ${fromGame && review.recent.length ? 'xl:grid-cols-[2fr_3fr]' : ''}`}>
                  <MatchReviewCard review={review} tactic={gameTactic} fromGame={fromGame} />
                  {fromGame && planA && <TodoCard items={todo} plan={planA} engine={engine} tactic={gameTactic} />}
                </div>
              )}
              {/* Le onze : terrain compact à gauche, liste prête à appliquer dans FM27 à droite. Survoler l'un met l'autre en évidence. */}
              <section className="card">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold">
                      {team === 'B' ? plan.form : form} · {fromGame && team === 'A' && gameTactic ? gameTactic : styleName(style)} <span className="text-sm font-normal text-brun">{t('fm.tac.fit', { value: note(plan.score) })}</span>
                    </h2>
                    <div className="flex gap-1" role="tablist" aria-label={t('fm.tac.team.label')}>
                      {(['A', 'B'] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="tab"
                          aria-selected={team === k}
                          onClick={() => setTeam(k)}
                          className={`chip ${team === k ? 'chip-on' : ''}`}
                        >
                          {t(`fm.tac.team.${k}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {team === 'B' && planB && planA && (
                    <p className="mt-1 text-sm text-brun">{t('fm.tac.team.help', { a: note(planA.score), b: note(planB.score) })}</p>
                  )}
                  <p className="mt-1 text-sm text-brun">
                    <span className="mr-2 rounded-md bg-eau/20 px-1.5 py-0.5 text-xs font-bold text-canard">{t(fromGame ? 'fm.tac.fromGame' : 'fm.tac.suggested')}</span>
                    {t(fromGame ? 'fm.tac.fromGameHelp' : gamePlan ? 'fm.tac.suggestedHelpGame' : 'fm.tac.suggestedHelp')}
                  </p>
                  {!gamePlan && lineupStatus && lineupStatus !== 'lue' && <p className="mt-1 text-xs text-brun">{t('fm.tac.lineupStatus', { status: lineupStatus })}</p>}

                {/* La phase montrée sur le terrain, choisie en tête avec une phrase qui dit ce qu'on regarde. */}
                <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="inline-flex rounded-xl bg-creme p-1" role="tablist" aria-label={t('fm.tac.xi.phaseLabel')}>
                    {(['ip', 'oop'] as const).map((ph) => (
                      <button
                        key={ph}
                        type="button"
                        role="tab"
                        aria-selected={phase === ph}
                        onClick={() => update({ phase: ph })}
                        className={`rounded-lg px-4 py-2 text-base font-bold transition ${phase === ph ? 'bg-canard text-white shadow' : 'text-canard hover:bg-white'}`}
                      >
                        {t(`fm.tac.phase.${ph}`)} <span className="ml-1 font-normal opacity-75">{shape(ph)}</span>
                      </button>
                    ))}
                  </div>
                  <p className="min-w-[14rem] flex-1 text-sm text-brun">{t(`fm.tac.xi.phaseHelp.${phase}`)}</p>
                </div>

                <div className="mt-4 grid items-start gap-8 xl:grid-cols-[minmax(20rem,27rem)_minmax(0,1fr)]">
                  {/* Terrain : une pastille par joueur, poste à la couleur de sa ligne et nom. */}
                  <div>
                    <Pitch className="mx-auto w-full max-w-[27rem]">
                      {/* Au survol seulement : d'où part le joueur dans l'autre phase. */}
                      {hover != null && plan.slots[hover] && (() => {
                        const [x1, y1] = phaseXY(plan.slots[hover]!, other, block);
                        const [x2, y2] = shown[hover] ?? [x1, y1];
                        return Math.hypot(x1 - x2, y1 - y2) > 2 ? (
                          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
                            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#FFB547" strokeWidth="0.6" strokeDasharray="1.5 1" />
                            <ellipse cx={x1} cy={y1} rx="1.6" ry="1.1" fill="none" stroke="#FFB547" strokeWidth="0.5" />
                          </svg>
                        ) : null;
                      })()}
                      {plan.slots.map((sl, i) => {
                        const [x, y] = shown[i] ?? [sl.x, sl.y];
                        const code = phase === 'ip' ? sl.ip : sl.oop;
                        const off = !!sl.player && !sl.player.positions.includes(sl.pos);
                        const c = LINE_COLOR[lineOf(slotPos(sl, phase))];
                        return (
                          <button
                            key={i}
                            type="button"
                            title={`${roleName(code, phase)}${off ? ` · ${t('fm.tac.offPos')}` : ''}`}
                            onMouseEnter={() => setHover(i)}
                            onMouseLeave={() => setHover(null)}
                            onFocus={() => setHover(i)}
                            onBlur={() => setHover(null)}
                            className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 transition-all duration-500 ${hover === i ? 'z-10 scale-110' : ''}`}
                            style={{ left: `${x}%`, top: `${y}%` }}
                          >
                            {/* Le poste FM27 du créneau dans la phase montrée (FM27 en donne un avec ballon, un sans) : le rôle déplace la pastille, jamais le poste. */}
                            <span
                              className={`whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold leading-none shadow ring-2 ${c.bg} ${c.text} ${hover === i ? 'ring-white' : off ? 'ring-corail' : 'ring-white/40'}`}
                            >
                              {POS_LABEL[slotPos(sl, phase)]}
                            </span>
                            <span className="max-w-[8rem] truncate rounded-md bg-white px-2 py-0.5 text-sm font-bold text-canard shadow">
                              {sl.player ? shortName(sl.player.name) : t('fm.tac.nobody')}
                            </span>
                          </button>
                        );
                      })}
                    </Pitch>
                  </div>

                  {/* Liste à recopier dans FM27 : une ligne par poste, rangée du gardien aux attaquants, les deux rôles et la doublure sous le titulaire. */}
                  <div className="min-w-0">
                    <h3 className="font-semibold">{t('fm.tac.xi.title')}</h3>
                    <div className="mt-2 overflow-x-auto">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{t('fm.tac.xi.pos')}</th>
                            <th>{t('fm.tac.xi.player')}</th>
                            <th>{t('fm.tac.xi.role')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((i) => {
                            const sl = plan.slots[i]!;
                            const p = sl.player;
                            const fitOf = (ph: Phase) => (p ? (ph === 'ip' ? engine.roleFit(p, sl.ip, 'ip', sl.pos) : oopFit(engine, p, sl.oop, sl.pos, sl.posOOP)) : null);
                            return (
                              <tr key={i} className={hover === i ? 'bg-creme/70' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                                <td>
                                  <PosBadge pos={sl.pos} />
                                </td>
                                <td className="font-bold text-canard">
                                  {p ? <PlayerLink player={p} /> : <span className="text-corail">{t('fm.tac.nobody')}</span>}
                                  {p?.team && <span className="ml-2 text-xs font-normal text-orange-fonce">{t('fm.tac.fromTeam', { team: p.team })}</span>}
                                  {p && !p.positions.includes(sl.pos) && <span className="ml-2 text-xs font-normal text-brun">{t('fm.tac.offPos')}</span>}
                                  {(plan.subs[i] ?? [])[0] && (
                                    <div className="text-xs font-normal text-brun">
                                      {t('fm.tac.xi.backupOf', { name: (plan.subs[i] ?? [])[0]!.name })}
                                      {(plan.subs[i] ?? [])[0]!.team && <span className="ml-1 text-orange-fonce">{t('fm.tac.fromTeam', { team: (plan.subs[i] ?? [])[0]!.team })}</span>}
                                    </div>
                                  )}
                                </td>
                                <td>
                                  {(['ip', 'oop'] as const).map((ph) => (
                                    <div key={ph} className="flex flex-wrap items-baseline gap-x-2">
                                      <span className="text-xs text-brun">{t(`fm.tac.phase.${ph}`)}</span>
                                      {ph === 'oop' && sl.posOOP && sl.posOOP !== sl.pos && <PosBadge pos={sl.posOOP} />}
                                      <span className="text-canard">{roleName(ph === 'ip' ? sl.ip : sl.oop, ph)}</span>
                                      {p && <span className="text-xs font-bold text-brun">{note(fitOf(ph))}</span>}
                                    </div>
                                  ))}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <More>{t(fromGame ? 'fm.tac.pitchHelpGame' : 'fm.tac.pitchHelp')}</More>
                  </div>
                </div>
              </section>
              {team === 'A' && advice && planA && <LineupAdviceCard advice={advice} plan={planA} engine={engine} />}
              {team === 'A' && physical && planA && <PhysicalCard watch={physical} plan={planA} windowDays={LOAD_WINDOW_DAYS} />}
              </>
            ),
          },
          {
            id: 'match',
            label: t('fm.tac.sections.match', { name: opp?.name ?? t('fm.opp.club') }),
            fold: true,
            node:
              opp && !fromGame ? (
                <>
              {opp && best && !fromGame && (
                <section className="card">
                  <h2 className="text-xl font-semibold">{t('fm.tac.matchTitle', { name: opp.name ?? t('fm.opp.club') })}</h2>
                  {pick && `${best.style.id}|${best.form}` === baseKey ? (
                    <p className="mt-1 text-sm">{t('fm.tac.matchSame', { form: pick.form, style: styleName(pick.style) })}</p>
                  ) : (
                    <p className="mt-1 text-sm">
                      {t('fm.tac.matchBest', { form: best.form, style: styleName(best.style), base: pick ? `${pick.form} ${styleName(pick.style)}` : '–' })}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-brun">
                    {t('fm.tac.matchScore', { base: note(best.base), bonus: (best.bonus >= 0 ? '+' : '') + nf1.format(best.bonus) })}
                  </p>
                  {best.reasons.length > 0 && (
                    <ul className="mt-2 space-y-1 text-sm">
                      {best.reasons.map((r) => (
                        <li key={r.id}>• {t(`fm.tac.why.${r.id}`, { every: r.every, minutes: r.minutes })}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(prefs.style !== best.style.id || form !== best.form) && (
                      <button type="button" className="btn-primary px-3 py-1.5 text-sm" onClick={() => update({ style: best.style.id, form: best.form, source: 'simloom' })}>
                        {t('fm.tac.matchShow')}
                      </button>
                    )}
                    {!auto && (
                      <button type="button" className="btn-secondary px-3 py-1.5 text-sm" onClick={() => update({ style: undefined, form: undefined })}>
                        {t('fm.tac.matchBase')}
                      </button>
                    )}
                  </div>
                  <More>{t(opp.formations.faced?.length ? 'fm.tac.matchHelpMeasured' : 'fm.tac.matchHelp')}</More>
                </section>
              )}

              {opp && adjust && !fromGame && (
                <section className="card">
                  <h2 className="text-xl font-semibold">{t('fm.tac.adjust.title', { name: opp.name ?? t('fm.opp.club') })}</h2>
                  <p className="mt-1 text-sm text-brun">{t('fm.tac.adjust.intro')}</p>
                  {!adjust.mentality && !adjust.team.length && !adjust.marking.length ? (
                    <p className="mt-2 text-sm">{t('fm.tac.adjust.none')}</p>
                  ) : (
                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                      <div>
                        {adjust.mentality && (
                          <p className="mb-2 text-sm">
                            <b>{t('fm.tac.adjust.mentality', { to: adjust.mentality.to, from: adjust.mentality.from })}</b>
                            <span className="ml-1 text-xs text-brun">{t(`fm.tac.adjust.reason.${adjust.mentality.reason}`)}</span>
                          </p>
                        )}
                        {adjust.team.length > 0 && (
                          <>
                            <p className="text-xs font-bold uppercase tracking-wide text-canard/50">{t('fm.tac.adjust.teamTitle')}</p>
                            <ul className="mt-1 space-y-1.5 text-sm">
                              {/* Une carte par raison : les consignes qu'elle justifie, listées dessous, sans répéter la phrase. */}
                              {[...new Set(adjust.team.map((a) => a.reason))].map((reason) => (
                                <li key={reason} className="rounded-xl bg-creme/50 px-3 py-2">
                                  <p className="text-xs text-brun first-letter:uppercase">{t(`fm.tac.adjust.reason.${reason}`)}</p>
                                  {adjust.team
                                    .filter((a) => a.reason === reason)
                                    .map((a) => (
                                      <p key={a.title} className="mt-1">
                                        <span className="mr-2 rounded-md bg-eau/20 px-1.5 py-0.5 text-xs font-bold text-canard">{t(`fm.style.${a.phase}`)}</span>
                                        <span className="text-brun">{a.title} :</span> <b>{a.label}</b>
                                        {a.replaces && <span className="ml-1 text-xs text-brun">{t('fm.tac.adjust.replaces', { label: a.replaces })}</span>}
                                      </p>
                                    ))}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                      {adjust.marking.length > 0 && (
                        <div>
                          <p className="text-xs font-bold uppercase tracking-wide text-canard/50">{t('fm.tac.adjust.markingTitle')}</p>
                          <ul className="mt-1 space-y-1.5 text-sm">
                            {adjust.marking.map((mk) => (
                              <li key={mk.target} className="rounded-xl bg-creme/50 px-3 py-2">
                                {t(`fm.tac.adjust.marking.${mk.reason}${mk.player ? '' : 'NoSlot'}`, { target: mk.target, positions: mk.positions ?? '', player: mk.player ?? '' })}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  <More>{t('fm.tac.adjust.help')}</More>
                </section>
              )}

              {opp && !fromGame && (
                <section className="card">
                  <h2 className="text-xl font-semibold">{t('fm.tac.oppScreen.title', { name: opp.name ?? t('fm.opp.club') })}</h2>
                  <p className="mt-1 text-sm text-brun">{t('fm.tac.oppScreen.intro')}</p>
                  {oppRows.length ? (
                    <div className="mt-3 table-scroll">
                      <table className="data-table">
                        <thead className="text-left text-canard/70">
                          <tr>
                            <th className="px-2 py-1">{t('fm.tac.oppScreen.player')}</th>
                            <th className="px-2 py-1">{t('fm.tac.oppScreen.positions')}</th>
                            <th className="px-2 py-1">{t('fm.tac.oppScreen.marking')}</th>
                            <th className="px-2 py-1">{t('fm.tac.oppScreen.pressing')}</th>
                            <th className="px-2 py-1">{t('fm.tac.oppScreen.tackling')}</th>
                            <th className="px-2 py-1">{t('fm.tac.oppScreen.foot')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {oppRows.map((r) => (
                            <tr key={r.name} className="border-t border-canard/5">
                              <td className="px-2 py-1.5">
                                <b>{r.name}</b>
                                <span className="block text-xs text-brun">{r.reasons.map((x) => t(`fm.tac.oppScreen.reason.${x}`)).join(' · ')}</span>
                              </td>
                              <td className="px-2 py-1.5 text-brun">{r.positions ?? '–'}</td>
                              <td className="px-2 py-1.5">{r.marking ? <b>{t('fm.tac.oppScreen.always')}</b> : '–'}</td>
                              <td className="px-2 py-1.5">{r.pressing ? <b>{t(`fm.tac.oppScreen.${r.pressing}`)}</b> : '–'}</td>
                              <td className="px-2 py-1.5">{r.tackling ? <b>{t(`fm.tac.oppScreen.${r.tackling}`)}</b> : '–'}</td>
                              <td className="px-2 py-1.5">{r.weakFoot ? <b>{t(`fm.tac.oppScreen.${r.weakFoot}`)}</b> : '–'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm">{t('fm.tac.oppScreen.none')}</p>
                  )}
                  {!footRead && <p className="mt-2 text-xs text-brun">{t('fm.tac.oppScreen.footHint')}</p>}
                  <More>{t('fm.tac.oppScreen.help')}</More>
                </section>
              )}
                </>
              ) : null,
          },
          {
            id: 'balance',
            label: t('fm.tac.sections.balanceFold'),
            fold: true,
            node: (
              <>
              <div className="grid gap-4">
                <section className="card">
                  <h2 className="text-xl font-semibold">{t('fm.tac.balance')}</h2>
                  <ul className="mt-3 space-y-3">
                    {engine.balance(plan, style).map((c) => (
                      <li key={c.id} className="flex gap-3">
                        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.status]}`} aria-hidden />
                        <div className="text-sm">
                          <b className="text-canard">{t(`fm.tac.check.${c.id}.title`)}</b>{' '}
                          <span className="text-brun">{checkText(t, c, (x) => nf1.format(x))}</span>
                          {c.status !== 'good' && t(`fm.tac.check.${c.id}.tip`, { defaultValue: '' }) && (
                            <div className="mt-0.5 text-canard">→ {t(`fm.tac.check.${c.id}.tip`)}</div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <More>{t('fm.tac.balanceHelp')}</More>

                  <h3 className="mt-6 font-semibold">{t('fm.tac.forms')}</h3>
                  <ol className="mt-2 space-y-1 text-sm">
                    {plans.slice(0, 6).map((p) => (
                      <li key={p.form}>
                        <button
                          type="button"
                          onClick={() => update({ form: p.form, source: 'simloom' })}
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left ${p.form === form ? 'bg-eau/20' : 'hover:bg-creme'}`}
                        >
                          <span className="font-bold text-canard">
                            {p.form}
                            {natural.includes(p.form) && <span className="ml-2 text-xs font-normal text-eau-fonce">{t('fm.tac.natural')}</span>}
                            {p.holes > 0 && <span className="ml-2 text-xs font-normal text-corail">{t('fm.tac.holes', { count: p.holes })}</span>}
                          </span>
                          <span className="text-brun">{note(p.score)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              </div>
              </>
            ),
          },
        ]}
      />
      )}

      {showPi && (
      <>
                <section className="card">
                  <h2 className="text-xl font-semibold">{t('fm.tac.teamTitle', { style: tiBase === 'game' ? (gameTactic ?? t('fm.tac.tiAdvice.gameTactic')) : styleName(style) })}</h2>
                  {tiBase === 'game' ? (
                    <p className="mt-1 text-sm text-brun">{t('fm.tac.tiAdvice.gameIntro')}</p>
                  ) : (
                    style.mentality && <p className="mt-1 text-sm">{t('fm.style.mentality', { value: style.mentality })}</p>
                  )}
                  <div className="mt-3">
                    {tiBase === 'game' ? <TeamCards inPossession={gameTiLabels.ip} outOfPossession={gameTiLabels.oop} /> : <TeamCards inPossession={style.inPossession} outOfPossession={style.outOfPossession} />}
                  </div>
                  <p className="mt-3 text-xs text-brun">{t(tiBase === 'game' ? 'fm.tac.tiAdvice.gameHelp' : 'fm.tac.teamHelp')}</p>
                  {tiAdvice && <TeamAdviceBlock advice={tiAdvice} base={tiBase} load={load} />}
                </section>
      <section className="card">
        <h2 className="text-xl font-semibold">{t('fm.pi.title')}</h2>
        <p className="mt-1 text-sm text-brun">
          {load.understanding != null ? t('fm.pi.budgetGame', { count: budget, understanding: Math.round(load.understanding) }) : budget < 3 ? t('fm.pi.budgetLow', { count: budget }) : t('fm.pi.budgetFull')}
        </p>
        {load.player != null && load.player >= 60 && (load.understanding ?? 100) < 50 && (
          <p className="mt-2 rounded-xl bg-ambre/20 px-3 py-2 text-sm">{t('fm.pi.heavy', { complexity: Math.round(load.player), understanding: Math.round(load.understanding!) })}</p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {plan.slots
            .filter((sl) => sl.player)
            .map((sl, i) => {
              const adv = playerInstructions(engine, sl, style, plan.slots, budget, sl.player ? seasonStats.get(sl.player.id) : null);
              // Ce que le joueur a déjà réglé dans FM27 pour lui (toutes compos), et ce que son rôle impose.
              const inGame = gamePi.get(sl.player!.id) ?? null;
              const gameKeys = inGame ? [...inGame.mine, ...inGame.imposed] : null;
              return (
                <div key={i} className="rounded-xl bg-creme/50 px-3 py-2 text-sm">
                  <div className="flex items-baseline gap-2">
                    <PosBadge pos={sl.pos} />
                    <PlayerLink player={sl.player!} className="font-bold text-canard" />
                  </div>
                  <p className="mb-1 mt-0.5 text-xs text-brun">
                    {roleName(sl.ip, 'ip')} · {roleName(sl.oop)}
                    {sl.game?.custom && <span className="ml-1 rounded-full bg-canard/10 px-1.5 text-canard">{t('fm.pi.custom')}</span>}
                  </p>
                  {inGame ? (
                    <GamePiLine mine={inGame.mine} supported={budget < 3 ? playerInstructions(engine, sl, style, plan.slots, 3, sl.player ? seasonStats.get(sl.player.id) : null).list : adv.list} budget={budget} />
                  ) : (
                    sl.game && (sl.game.instructions.ip.length > 0 || sl.game.instructions.oop.length > 0) && (
                      <p className="mb-1 text-xs text-canard">
                        <b>{t('fm.pi.inGame')}</b> {[...sl.game.instructions.ip, ...sl.game.instructions.oop].join(' · ')}
                      </p>
                    )
                  )}
                  {adv.list.length ? (
                    adv.list.map((x) => (
                      <div key={x.id} className="py-0.5">
                        <span className={`mr-1 rounded-md px-1.5 py-0.5 text-xs font-bold ${x.phase === 'ip' ? 'bg-eau/30 text-canard' : 'bg-canard/10 text-canard'}`}>
                          {t(`fm.pi.${x.phase}`)}
                        </span>
                        <b className="text-canard">{t(`fm.pi.id.${x.id}`)}</b>{' '}
                        <span className="text-xs text-brun">{t(`fm.pi.why.${x.why}`, fmtVals(x.vals, nf1))}</span>
                        <PiState x={x} keys={gameKeys} />
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-brun">{t('fm.pi.nothing')}</p>
                  )}
                  {adv.switches.map((w) => (
                    <p key={w.to} className="mt-1 text-xs text-canard">
                      →{' '}
                      {t('fm.pi.switch', {
                        phase: t(w.phase === 'ip' ? 'fm.pi.phaseIp' : 'fm.pi.phaseOop'),
                        from: roleName(w.from),
                        to: roleName(w.to),
                        what: t(`fm.pi.id.${w.unlocks}`),
                      })}
                    </p>
                  ))}
                </div>
              );
            })}
        </div>
        <p className="mt-3 text-xs text-brun">{t('fm.pi.help')}</p>
        <More>{t('fm.pi.locks')}</More>
      </section>
      </>
      )}
    </div>
  );
}

/** Nom court pour le terrain : « A. Guardado Navarrete » plutôt que le nom complet. */
const shortName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]![0]}. ${parts.slice(1).join(' ')}` : name;
};

/** Valeurs d'une raison : les notes sur 20 au format de la langue. */
const fmtVals = (vals: Record<string, number | string>, nf: Intl.NumberFormat) =>
  Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, typeof v === 'number' ? nf.format(v) : v]));

/** Détail d'un contrôle d'équilibre, avec ses valeurs. */
function checkText(t: (k: string, o?: Record<string, unknown>) => string, c: BalanceCheck, fmt: (x: number) => string): string {
  const p = c.params;
  const v = (x: unknown) => (typeof x === 'number' ? fmt(x) : '–');
  switch (c.id) {
    case 'width':
      return p.side ? t(`fm.tac.check.width.missing.${String(p.side)}`) : t('fm.tac.check.width.ok');
    case 'creation':
    case 'cover':
      return t(`fm.tac.check.${c.id}.text`, { count: p.count as number });
    case 'box':
      return t('fm.tac.check.box.text', { count: p.count as number }) + (p.finisher ? t('fm.tac.check.box.finisher', { name: p.finisher, value: v(p.value) }) : '');
    case 'pace':
      return t(p.highLine ? 'fm.tac.check.pace.textHigh' : 'fm.tac.check.pace.text', { value: v(p.value) });
    case 'press':
    case 'aerial':
      return t(`fm.tac.check.${c.id}.text`, { value: v(p.value) });
    case 'fitness': {
      const names = (p.names as string[]) ?? [];
      return names.length ? t('fm.tac.check.fitness.tired', { names: names.join(', ') }) : t('fm.tac.check.fitness.ok');
    }
  }
}
