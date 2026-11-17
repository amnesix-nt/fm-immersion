import { roleCeiling,
  ATTR_GROUPS,
  buildProject,
  engineValue,
  HIDDEN_ATTRS,
  hiddenNotes,
  levelSeries,
  matchStatsFull,
  mercatoAdvice,
  monthsLeft,
  playerMatches,
  playerSeasons,
  playingTime,
  POS_LABEL,
  projectCompat,
  roleMatrix,
  storedTargets,
  statsBoard,
  STAT_METRICS,
  type FmPlayer,
  type FmSnapshot,
  type PosCode,
  type SquadAt,
  type StatKey,
} from '@fm-immersion/module-fm';
import { Face } from '../components/Face';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fmData } from '../lib/data';
import { readScoped, useFmSaveScope, writeScoped } from '../lib/save-store';
import { CMP_KEY } from './FmCompare';
import { useTranslation } from 'react-i18next';
import { AttrValue, Avatar, Gauge, LINE_COLOR, PosBadge, PositionMap, ProfileRadar, profileAxes, RankBar } from './FmFoot';
import { LeaveButton, useLeaving } from './FmLeaving';
import { TONE, useReason } from './FmMercato';
import { Spark } from './FmProgression';
import { useTacticEngine } from './FmTactic';
import { Chips, CompatTag, EngineTag, engineSource, engineWeighted, fitPct, Level, PlanGradeCard, signed, Tag, useCoach, useFormat, useNames, type SheetFocus } from './FmUi';

const PCT = new Set<StatKey>(['passPct', 'tacklePct', 'headerPct', 'shotsOnTargetPct', 'savePct']);

type Tab = 'overview' | 'attributes' | 'matches' | 'career';

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Couleur d'une note de match (sur 10), comme dans le jeu : vert au-dessus de 7, rouge sous 6. */
const ratingTone = (r: number | null) => (r == null ? 'bg-canard/10 text-brun' : r >= 7.5 ? 'bg-eau-fonce text-white' : r >= 7 ? 'bg-eau-soutenu text-canard' : r >= 6.3 ? 'bg-eau/40 text-canard' : r >= 6 ? 'bg-ambre/40 text-canard' : 'bg-corail text-white');

/** Couleur de la barre d'un attribut sur 20. */
const barTone = (v: number) => (v >= 16 ? 'bg-eau-fonce' : v >= 13 ? 'bg-eau-soutenu' : v >= 10 ? 'bg-canard/40' : v >= 7 ? 'bg-ambre/70' : 'bg-corail');

/** Chiffre clé de la fiche (bandeau sous l'en-tête). */
function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'warn' }) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-canard/55">{label}</dt>
      <dd className={`font-display text-xl font-semibold tabular-nums ${tone === 'bad' ? 'text-corail' : tone === 'warn' ? 'text-orange-fonce' : 'text-canard'}`}>{value}</dd>
      {sub && <dd className="text-xs text-brun">{sub}</dd>}
    </div>
  );
}

function Section({ title, help, action, children, className = '' }: { title: ReactNode; help?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`}>
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        {title}
        {action && <span className="ml-auto font-normal">{action}</span>}
      </h3>
      {help && <p className="text-xs text-brun">{help}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * Fiche joueur, façon fiche du jeu : bandeau d'identité et chiffres clés, puis quatre onglets.
 * Vue d'ensemble (forme, derniers matchs, profil, postes, note de projet, mercato), Attributs (barres sur 20, écart à
 * sa ligne et évolution depuis le suivi, indice moteur), Matchs (stats en percentiles avec la médiane de la ligne,
 * derniers matchs, temps de jeu), Carrière (saisons suivies, progression du niveau et du CA).
 * Un joueur d'un autre club (`extra`, demandé depuis FM27) a la même fiche, avec sa place s'il venait chez nous.
 */
export function FmPlayerSheet({
  id,
  players,
  extra,
  snap,
  history,
  folder,
  gameDate,
  onClose,
  focus,
  entries = [],
  go,
}: {
  id: string;
  players: FmPlayer[];
  /** Joueur hors de l'effectif (autre club), lu dans la base du jeu ou les cibles. */
  extra?: (FmPlayer & { club?: string | null }) | null;
  snap: FmSnapshot;
  history: SquadAt[];
  folder: string;
  gameDate: string;
  onClose: () => void;
  /** Raison de l'ouverture : la section correspondante passe en tête. */
  focus?: SheetFocus;
  /** Instantanés de la partie, pour le temps de jeu, les saisons et les derniers matchs. */
  entries?: { gameDate: string; data: FmSnapshot }[];
  /** Change d'écran du club (comparateur) ; absent, l'action est masquée. */
  go?: (view: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const f = useFormat();
  const names = useNames();
  const reason = useReason();
  const [coach] = useCoach();
  const { engine } = useTacticEngine(folder, players);
  const own = players.find((x) => x.id === id);
  const p: (FmPlayer & { club?: string | null }) | undefined = own ?? (extra?.id === id ? extra : undefined);
  const external = !own;
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasAttrs = !!p && Object.keys(p.attributes).length > 0;
  // Meilleur rôle à chaque poste (avec ballon) : sert à la carte des postes et à la liste des rôles.
  const cells = useMemo(() => (p && hasAttrs ? (roleMatrix(engine, [p], 'ip').rows[0]?.cells ?? []) : []), [engine, p, hasAttrs]);
  const fits = useMemo(() => Object.fromEntries(cells.filter((c) => c).map((c) => [c!.pos, c!.fit])) as Partial<Record<PosCode, number>>, [cells]);
  const roles = cells
    .filter((c): c is NonNullable<typeof c> => !!c && (c.natural || c.tryIt))
    .sort((a, b) => b.fit - a.fit)
    .slice(0, 4);
  const axes = useMemo(() => (p ? profileAxes(p) : []), [p]);
  // Joueurs de l'effectif de la même ligne : repères du radar et des attributs.
  const lineMates = useMemo(() => (p ? players.filter((x) => x.line === p.line && x.id !== p.id && Object.keys(x.attributes).length) : []), [players, p]);
  const lineAvg = useMemo(() => {
    if (!lineMates.length) return undefined;
    const ms = lineMates.map(profileAxes);
    return axes.map((_, i) => {
      const v = ms.map((m) => m[i]?.value).filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    });
  }, [lineMates, axes]);
  const attrAvg = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [, keys] of ATTR_GROUPS)
      for (const k of keys) {
        const v = lineMates.map((m) => m.attributes[k]).filter((x): x is number => x != null);
        if (v.length) out[k] = v.reduce((a, b) => a + b, 0) / v.length;
      }
    return out;
  }, [lineMates]);
  // Évolution de chaque attribut depuis la première lecture où il était connu.
  const attrFirst = useMemo(() => {
    const out: Record<string, number> = {};
    for (const h of history) {
      const q = h.players.find((x) => x.id === id);
      if (!q) continue;
      for (const [k, v] of Object.entries(q.attributes)) if (!(k in out)) out[k] = v;
    }
    return out;
  }, [history, id]);
  const board = useMemo(() => {
    const full = matchStatsFull(snap);
    return statsBoard(players, new Map([...full].map(([k, m]) => [k, m.stats])));
  }, [snap, players]);
  const stats = external ? null : (board.players.find((r) => r.player.id === id) ?? null);
  const { ids: leavingIds, loanIds } = useLeaving();
  const advice = useMemo(
    () => (external ? null : (mercatoAdvice(engine, players, gameDate, coach, history, leavingIds, loanIds)?.advice.find((a) => a.player.id === id) ?? null)),
    [external, engine, players, gameDate, coach, history, id, leavingIds, loanIds],
  );
  // Note de projet (A à E) : même projet que le mercato (effectif avec attributs, partants exclus).
  const project = useMemo(() => buildProject(engine, players.filter((x) => Object.keys(x.attributes).length && !leavingIds.has(x.id)), coach), [engine, players, coach, leavingIds]);
  const fitProject = useMemo(() => advice?.compat ?? (project && p && hasAttrs ? projectCompat(engine, project, p) : null), [advice, project, p, hasAttrs, engine]);
  const engineVal = useMemo(() => (p ? engineValue(p) : null), [p]);
  const series = useMemo(() => levelSeries(history, id), [history, id]);
  const caSeries = useMemo(() => history.map((h) => h.players.find((x) => x.id === id)?.ca ?? null), [history, id]);
  const seasons = useMemo(() => (external ? [] : playerSeasons(entries, id)), [external, entries, id]);
  const matches = useMemo(() => (external ? [] : playerMatches(entries, id, 10)), [external, entries, id]);
  const scope = useFmSaveScope();
  const play = useMemo(() => (external ? null : (playingTime(players, entries).rows.find((r) => r.player.id === id) ?? null)), [external, players, entries, id]);
  const { data: targetRows } = useQuery({ queryKey: ['fm', scope.saveId, 'targets', gameDate], queryFn: () => fmData.targets(scope.saveId), enabled: focus === 'contract' });
  if (!p) return null;

  // Place dans le groupe : rang de niveau parmi les joueurs qui jouent au même poste principal (lui compris).
  const main = p.positions[0];
  const mates = [...players.filter((x) => main && x.positions.includes(main) && x.id !== p.id), p].sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  const place = main ? mates.findIndex((x) => x.id === p.id) + 1 : 0;
  const bestOurs = mates.find((x) => x.id !== p.id) ?? null;
  // Cibles suivies qui jouent au même poste : de quoi trancher une prolongation.
  const rivals = storedTargets(targetRows ?? [], players).filter((x) => !x.dismissed && x.id !== p.id && main && x.positions.includes(main));
  const months = monthsLeft(p, gameDate);
  const compare = () => {
    const prev = readScoped<string[]>(CMP_KEY, scope, []).filter((x) => x !== p.id);
    writeScoped(CMP_KEY, scope, [p.id, ...prev].slice(0, 3));
    onClose();
    go?.('compare');
  };
  const isGk = p.positions.includes('GB');
  const groups = ATTR_GROUPS.filter(([g]) => (isGk ? g !== 'technical' : g !== 'goalkeeping'));
  const nf = (d: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtStat = (k: StatKey, v: number) => (PCT.has(k) ? `${nf(0).format(v)} %` : nf(k === 'distance90' ? 1 : 2).format(v));
  const metrics = stats ? STAT_METRICS.filter((m) => p.line && m.lines.includes(p.line) && stats.stats[m.key] != null) : [];
  // Médiane de sa ligne pour chaque stat (joueurs avec assez de minutes).
  const lineMedian = (k: StatKey) => median(board.players.filter((r) => r.enough && r.player.line === p.line && r.stats[k] != null).map((r) => r.stats[k]!));
  const line = LINE_COLOR[p.line ?? 'MIL'];
  const levels = series.filter((x): x is number => x != null);
  const cas = caSeries.filter((x): x is number => x != null);
  const current = seasons.find((s) => s.current) ?? null;
  const attrLabel = (k: string) => t(`fm.attr.${k}`, { defaultValue: k });
  // Attributs classés : ses meilleurs et ses moins bons (hors ceux du gardien pour un joueur de champ, et inversement).
  const shown = groups.flatMap(([, keys]) => keys.filter((k) => p.attributes[k] != null).map((k) => [k, p.attributes[k]!] as const));
  const top = [...shown].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const low = [...shown].sort((a, b) => a[1] - b[1]).slice(0, 4);
  const changes = shown
    .map(([k, v]) => [k, attrFirst[k] != null ? v - attrFirst[k]! : 0] as const)
    .filter(([, d]) => d !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const paKnown = p.pa != null && p.pa > 0;

  // Forme du moment et saison en cours.
  const formSection = (
    <Section title={t('fm.foot.form')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Gauge value={p.condition} label={t('fm.col.condition')} />
        <Gauge value={p.sharpness} label={t('fm.foot.sharpness')} />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
        {(
          [
            [t('fm.foot.apps'), current?.apps ?? p.apps, current?.starts != null ? t('fm.sheet.startsShort', { count: current.starts }) : null],
            [t('fm.sheet.minutes'), current?.minutes != null ? nf(0).format(current.minutes) : null, null],
            [t('fm.foot.goals'), current?.goals ?? p.goals, null],
            [t('fm.sheet.assists'), current?.assists, null],
            [t('fm.foot.rating'), p.avgRating != null ? nf(2).format(p.avgRating) : null, null],
            [t('fm.sheet.potmShort'), current?.potm, null],
          ] as [string, ReactNode, string | null][]
        ).map(([k, v, sub]) => (
          <div key={k} className="rounded-lg bg-creme/70 py-1.5">
            <dd className="font-display text-xl font-semibold tabular-nums">{v ?? '–'}</dd>
            <dt className="text-xs text-brun">{k}</dt>
            {sub && <dd className="text-[11px] text-brun">{sub}</dd>}
          </div>
        ))}
      </dl>
      {matches.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-bold uppercase tracking-wide text-canard/55">{t('fm.sheet.lastRatings')}</p>
          <ol className="mt-1 flex flex-row-reverse justify-end gap-1">
            {matches.slice(0, 8).map((m, i) => (
              <li
                key={`${m.date}|${i}`}
                title={`${f.date(m.date)} · ${m.opponent ?? ''} · ${m.goalsFor ?? '?'}-${m.goalsAgainst ?? '?'}`}
                className={`w-11 rounded-md py-1 text-center text-sm font-bold tabular-nums ${ratingTone(m.rating)}`}
              >
                {m.rating != null ? nf(1).format(m.rating) : '–'}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Section>
  );
  // Temps de jeu de la saison face au statut promis.
  const playSection = play && (
    <Section title={t('fm.sheet.playtime')}>
      {play.share != null ? (
        <>
          <div className="flex items-center gap-3">
            <span className="relative block h-2.5 flex-1 overflow-hidden rounded-full bg-canard/10">
              <span className="absolute inset-y-0 left-0 rounded-full bg-eau-fonce" style={{ width: `${Math.round(play.share * 100)}%` }} />
              {play.expected != null && <span className="absolute inset-y-[-2px] w-0.5 bg-orange-fonce" style={{ left: `${Math.round(play.expected * 100)}%` }} aria-hidden />}
            </span>
            <b className="tabular-nums">{Math.round(play.share * 100)} %</b>
          </div>
          <p className="mt-2 text-sm">{t('fm.sheet.playShare', { pct: Math.round(play.share * 100), starts: play.starts, available: play.available })}</p>
        </>
      ) : (
        <p className="text-sm">{t('fm.sheet.noPlay')}</p>
      )}
      {play.expected != null && <p className="mt-1 text-xs text-brun">{t('fm.sheet.promised', { pct: Math.round(play.expected * 100), status: p.squadStatus ?? '' })}</p>}
    </Section>
  );

  const contractSection = focus === 'contract' && !external && (
    <section className="card border-l-4 border-orange p-4" aria-labelledby="sheet-contract">
      <h3 id="sheet-contract" className="font-semibold">
        {t('fm.sheet.contractTitle')}
      </h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-brun">{t('fm.sheet.deadline')}</dt>
          <dd className="font-bold">
            {f.date(p.contractEnd)}
            {months != null && <span className="block text-xs font-normal text-brun">{months <= 0 ? t('fm.contracts.expired') : t('fm.home.endsIn', { count: months })}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-brun">{t('fm.col.wage')}</dt>
          <dd className="font-bold">{f.money(p.wage)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-brun">{t('fm.sheet.status')}</dt>
          <dd className="font-bold">{p.squadStatus ?? '–'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-brun">{t('fm.sheet.place')}</dt>
          <dd className="font-bold">{place > 0 && main ? t('fm.sheet.placeValue', { place, count: mates.length, pos: POS_LABEL[main] }) : '–'}</dd>
        </div>
      </dl>
      {play && play.share != null && <p className="mt-2 text-sm">{t('fm.sheet.playShare', { pct: Math.round(play.share * 100), starts: play.starts, available: play.available })}</p>}
      <p className="mt-2 text-sm">
        <span className="font-bold">{t('fm.sheet.rivals')} </span>
        {rivals.length ? rivals.map((x) => `${x.name}${x.level != null ? ` (${nf(1).format(x.level)})` : ''}`).join(', ') : t('fm.sheet.noRivals')}
      </p>
    </section>
  );

  // Joueur d'un autre club : où il se placerait chez nous.
  const oursSection = external && (
    <section className="card border-l-4 border-orange p-4">
      <h3 className="font-semibold">{t('fm.sheet.withUs')}</h3>
      <p className="mt-1 text-sm">
        {main && place > 0 ? t('fm.sheet.withUsPlace', { place, count: mates.length, pos: POS_LABEL[main] }) : t('fm.sheet.withUsNone')}
      </p>
      {bestOurs && main && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-brun">
          {t('fm.sheet.bestOurs', { name: bestOurs.name, pos: POS_LABEL[main] })} <Level value={bestOurs.level} />
          {p.level != null && bestOurs.level != null && <b className="text-canard">({signed(Math.round((p.level - bestOurs.level) * 10) / 10)})</b>}
        </p>
      )}
      <p className="mt-2 text-xs text-brun">{t('fm.sheet.externalNote')}</p>
    </section>
  );

  const profileSection = hasAttrs && (
    <section className="card grid gap-4 p-4 sm:grid-cols-[1fr_auto]">
      <div>
        <h3 className="font-semibold">{t('fm.foot.profile')}</h3>
        <p className="text-xs text-brun">{t('fm.foot.profileHelp')}</p>
        <div className="mt-2 flex justify-center">
          <ProfileRadar axes={axes} compare={lineAvg} />
        </div>
      </div>
      <div className="flex flex-col items-center">
        <h3 className="self-start font-semibold">{t('fm.sheet.roles')}</h3>
        <div className="mt-2 w-48">
          <PositionMap player={p} fits={fits} label={fitPct} />
        </div>
        <ul className="mt-3 w-full space-y-1 text-sm">
          {roles.map((c) => (
            <li key={c.pos} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <PosBadge pos={c.pos} /> {names.role(c.role)}
              </span>
              <b className="tabular-nums">{fitPct(c.fit)}</b>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );

  const overview = (
    <>
      {contractSection}
      {oursSection}
      {!external && formSection}
      {hasAttrs && (
        <Section title={t('fm.sheet.keyAttrs')}>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                [t('fm.sheet.strengths'), top, 'good'],
                [t('fm.sheet.weaknesses'), low, 'bad'],
              ] as const
            ).map(([title, list, tone]) => (
              <div key={title}>
                <p className={`text-xs font-bold uppercase tracking-wide ${tone === 'good' ? 'text-eau-fonce' : 'text-corail'}`}>{title}</p>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {list.map(([k, v]) => (
                    <li key={k} className="flex items-center justify-between gap-2">
                      <span className="truncate">{attrLabel(k)}</span>
                      <AttrValue value={v} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}
      {profileSection}
      {/* Note de projet : le profil colle-t-il à notre façon de jouer ? */}
      {project && fitProject && (
        <Section title={t('fm.grade.heading')}>
          <PlanGradeCard c={fitProject} project={project} engine={engine} />
        </Section>
      )}
      {!external && (
        <Section
          title={
            <>
              {t('fm.sheet.mercato')}
              {advice && (
                <>
                  <Tag tone={TONE[advice.verdict]}>{t(`fm.merc.verdict.${advice.verdict}`)}</Tag> <CompatTag c={advice.compat} />
                </>
              )}
            </>
          }
          action={<LeaveButton player={p} gameDate={gameDate} />}
        >
          {advice ? (
            <>
              <p className="text-sm text-brun">{advice.reasons.map(reason).join(' · ')}</p>
              {advice.proj[1] != null && (
                <p className="mt-2 flex items-center gap-1.5 text-sm text-brun">
                  {t('fm.sheet.inTwo')} <Level value={p.level} /> → <Level value={advice.proj[1]} />
                </p>
              )}
            </>
          ) : leavingIds.has(p.id) ? (
            <p className="text-sm text-brun">{t('fm.leave.sheet')}</p>
          ) : null}
        </Section>
      )}
    </>
  );

  const attributes = hasAttrs ? (
    <>
      <Section title={t('fm.foot.attributes')} help={lineMates.length ? t('fm.sheet.attrHelp') : undefined}>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          {groups.map(([g, keys]) => {
            const ks = keys.filter((k) => p.attributes[k] != null);
            const avg = ks.length ? ks.reduce((a, k) => a + p.attributes[k]!, 0) / ks.length : null;
            return (
              <div key={g}>
                <p className="mb-1 flex justify-between text-xs font-bold uppercase tracking-wide text-canard/60">
                  {t(`fm.attrGroup.${g}`)} {avg != null && <span className="tabular-nums">{nf(1).format(avg)}</span>}
                </p>
                {ks.map((k) => {
                  const v = p.attributes[k]!;
                  const d = attrAvg[k] != null ? Math.round(v - attrAvg[k]!) : null;
                  const since = attrFirst[k] != null ? v - attrFirst[k]! : 0;
                  return (
                    <div key={k} className="grid grid-cols-[1fr_3rem_1.75rem_1.5rem] items-center gap-1.5 py-px text-sm">
                      <span className="truncate text-canard">
                        {attrLabel(k)}
                        {since !== 0 && <span className={`ml-1 text-xs font-bold ${since > 0 ? 'text-eau-fonce' : 'text-corail'}`}>{since > 0 ? '▲' : '▼'}</span>}
                      </span>
                      <span className="block h-1.5 overflow-hidden rounded-full bg-canard/10" aria-hidden>
                        <span className={`block h-full rounded-full ${barTone(v)}`} style={{ width: `${(v / 20) * 100}%` }} />
                      </span>
                      <AttrValue value={v} />
                      <span className={`text-right text-xs tabular-nums ${d == null || d === 0 ? 'text-brun/60' : d > 0 ? 'text-eau-fonce' : 'text-corail'}`}>{d == null ? '' : signed(d)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </Section>
      {/* Attributs cachés : lus dans la mémoire du jeu avec le CA/PA (option du joueur). */}
      {p.hidden && (
        <Section title={t('fm.hidden.title')} help={t('fm.hidden.help')}>
          <div className="grid gap-x-6 sm:grid-cols-3">
            {HIDDEN_ATTRS.filter((k) => p.hidden![k] != null).map((k) => {
              const v = p.hidden![k]!;
              return (
                <div key={k} className="grid grid-cols-[1fr_3rem_1.75rem] items-center gap-1.5 py-px text-sm">
                  <span className="truncate text-canard">{attrLabel(k)}</span>
                  <span className="block h-1.5 overflow-hidden rounded-full bg-canard/10" aria-hidden>
                    <span className={`block h-full rounded-full ${barTone(k === 'Dirtiness' || k === 'InjuryProneness' ? 21 - v : v)}`} style={{ width: `${(v / 20) * 100}%` }} />
                  </span>
                  <AttrValue value={v} />
                </div>
              );
            })}
          </div>
          {hiddenNotes(p.hidden).length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {hiddenNotes(p.hidden).map((n) => (
                <li key={n}>
                  <Tag tone={n === 'bigGames' ? 'good' : 'warn'}>{t(`fm.hidden.note.${n}`)}</Tag>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {/* Indice moteur : le poids réel de ses attributs dans le moteur de FM27 (tests de la communauté). */}
      <Section title={<>{t('fm.engine.heading')} {engineVal && <EngineTag v={engineVal} />}</>} help={t('fm.engine.help')}>
        {!engineVal ? (
          <p className="text-sm text-brun">{t('fm.engine.none')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {engineVal.strengths.length > 0 && <li>{t('fm.engine.strengths', { list: engineVal.strengths.map((x) => `${attrLabel(x.attr)} ${x.value} (${signed(Math.round(x.effect))})`).join(', ') })}</li>}
            {engineVal.weaknesses.length > 0 && <li>{t('fm.engine.weaknesses', { list: engineVal.weaknesses.map((x) => `${attrLabel(x.attr)} ${x.value} (${signed(Math.round(x.effect))})`).join(', ') })}</li>}
            {engineVal.belowMin.length > 0 && (
              <li>
                <Tag tone="warn">{t('fm.engine.belowMin', { list: engineVal.belowMin.map((x) => `${attrLabel(x.attr)} ${x.value}`).join(', ') })}</Tag>
              </li>
            )}
            {!engineVal.strengths.length && !engineVal.weaknesses.length && !engineVal.belowMin.length && <li className="text-brun">{t('fm.engine.none')}</li>}
            {engineWeighted(t, engineVal) && <li className="text-xs text-brun">{engineWeighted(t, engineVal)}</li>}
            {engineSource(t, engineVal, i18n.resolvedLanguage) && <li className="text-xs text-brun">{engineSource(t, engineVal, i18n.resolvedLanguage)}</li>}
          </ul>
        )}
      </Section>
    </>
  ) : (
    <p className="card p-4 text-sm text-brun">{t('fm.sheet.noAttrs')}</p>
  );

  const matchTab = (
    <>
      {stats && stats.minutes > 0 && metrics.length > 0 ? (
        <Section title={t('fm.sheet.stats', { minutes: stats.minutes })} help={t('fm.sheet.statsHelp')}>
          <div className="grid grid-cols-[minmax(8rem,12rem)_1fr_4.5rem_4.5rem] items-center gap-x-3 gap-y-2 text-sm">
            <span />
            <span className="text-xs text-brun">{t('fm.sheet.rankInLine')}</span>
            <span className="text-right text-xs text-brun">{t('fm.sheet.him')}</span>
            <span className="text-right text-xs text-brun">{t('fm.sheet.lineMedian')}</span>
            {metrics.map((m) => {
              const mark = stats.marks[m.key];
              const med = lineMedian(m.key);
              return (
                <div key={m.key} className="contents">
                  <span className="truncate text-canard">{t(`fm.stats.col.${m.key}`)}</span>
                  {mark ? <RankBar rank={mark.rank} /> : <span className="text-xs text-brun">–</span>}
                  <span className="text-right font-bold tabular-nums">{fmtStat(m.key, stats.stats[m.key]!)}</span>
                  <span className="text-right tabular-nums text-brun">{med != null ? fmtStat(m.key, med) : '–'}</span>
                </div>
              );
            })}
          </div>
          {stats.focus && (
            <p className="mt-3 text-sm">
              <Tag tone="warn">{t('fm.sheet.focus')}</Tag> {t(`fm.train.focus.${stats.focus}`)}
            </p>
          )}
          {!stats.enough && <p className="mt-2 text-xs text-brun">{t('fm.sheet.fewMinutes')}</p>}
        </Section>
      ) : (
        <p className="card p-4 text-sm text-brun">{external ? t('fm.sheet.externalNote') : t('fm.sheet.noStats')}</p>
      )}
      {!external && (
        <Section title={t('fm.sheet.lastMatches')} help={t('fm.sheet.lastMatchesHelp')}>
          {matches.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-brun">
                  <tr>
                    <th className="py-1 font-normal">{t('fm.sheet.col.date')}</th>
                    <th className="font-normal">{t('fm.sheet.col.opponent')}</th>
                    <th className="font-normal">{t('fm.sheet.col.score')}</th>
                    <th className="font-normal">{t('fm.sheet.col.played')}</th>
                    <th className="text-right font-normal">{t('fm.foot.goals')}</th>
                    <th className="text-right font-normal">{t('fm.sheet.col.rating')}</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m, i) => (
                    <tr key={`${m.date}|${i}`} className="border-t border-canard/5 odd:bg-creme/50">
                      <td className="py-1.5 pr-2 tabular-nums">{f.date(m.date)}</td>
                      <td className="pr-2">
                        <span className="font-semibold">{m.opponent ?? '?'}</span>
                        <span className="block text-xs text-brun">
                          {m.home == null ? '' : m.home ? t('fm.mc.homeShort') : t('fm.mc.awayShort')}
                          {m.competition ? ` · ${m.competition}` : ''}
                        </span>
                      </td>
                      <td className="whitespace-nowrap pr-2 tabular-nums">
                        {m.outcome && <Tag tone={m.outcome === 'W' ? 'good' : m.outcome === 'L' ? 'bad' : 'info'}>{t(`fm.results.outcome.${m.outcome}`)}</Tag>} {m.goalsFor ?? '?'}-{m.goalsAgainst ?? '?'}
                      </td>
                      <td className="whitespace-nowrap pr-2 text-brun">
                        {m.started ? t('fm.sheet.started') : t('fm.sheet.sub')} · {m.minutes}'
                      </td>
                      <td className="text-right tabular-nums">{m.goals || ''}</td>
                      <td className="text-right">
                        <span className={`inline-block w-10 rounded py-0.5 text-center font-bold tabular-nums ${ratingTone(m.rating)}`}>{m.rating != null ? nf(1).format(m.rating) : '–'}</span>
                        {m.potm && (
                          <span className="ml-1 text-orange-fonce" title={t('fm.sheet.potm')}>
                            ★
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-brun">{t('fm.sheet.noMatches')}</p>
          )}
        </Section>
      )}
      {playSection}
    </>
  );

  const careerTab = (
    <>
      {!external && (
        <Section title={t('fm.sheet.seasons')} help={t('fm.sheet.seasonsHelp')}>
          {seasons.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead className="text-xs text-brun">
                  <tr>
                    <th className="py-1 text-left font-normal">{t('fm.sheet.col.season')}</th>
                    <th className="text-right font-normal">{t('fm.foot.apps')}</th>
                    <th className="text-right font-normal">{t('fm.sheet.minutes')}</th>
                    <th className="text-right font-normal">{t('fm.foot.goals')}</th>
                    <th className="text-right font-normal">{t('fm.sheet.assists')}</th>
                    <th className="text-right font-normal">xG</th>
                    <th className="text-right font-normal">{t('fm.sheet.col.rating')}</th>
                    <th className="text-right font-normal">{t('fm.sheet.potmShort')}</th>
                  </tr>
                </thead>
                <tbody>
                  {seasons.map((s, i) => (
                    <tr key={`${s.label}|${i}`} className="border-t border-canard/5 odd:bg-creme/50">
                      <td className="py-1.5 pr-2">
                        <span className="font-semibold">{s.current ? t('fm.sheet.currentSeason') : s.label}</span>
                        <span className="block text-xs text-brun">{s.club}</span>
                      </td>
                      <td className="text-right">
                        {s.apps ?? '–'}
                        {s.starts != null && <span className="text-xs text-brun"> ({s.starts})</span>}
                      </td>
                      <td className="text-right">{s.minutes != null ? nf(0).format(s.minutes) : '–'}</td>
                      <td className="text-right font-bold">{s.goals ?? '–'}</td>
                      <td className="text-right">{s.assists ?? '–'}</td>
                      <td className="text-right">{s.xg != null ? nf(1).format(s.xg) : '–'}</td>
                      <td className="text-right">{s.rating != null ? nf(2).format(s.rating) : '–'}</td>
                      <td className="text-right">{s.potm ?? '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-brun">{t('fm.sheet.noSeasons')}</p>
          )}
        </Section>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Section title={t('fm.sheet.progress')}>
          {levels.length > 1 ? (
            <div className="flex flex-col items-start gap-2">
              <Spark values={series} />
              <span className="text-sm text-brun">
                {nf(1).format(levels[0]!)} → <b className="text-canard">{nf(1).format(levels.at(-1)!)}</b>
              </span>
            </div>
          ) : (
            <p className="text-sm text-brun">{t('fm.prog.onePoint')}</p>
          )}
          {advice?.proj[1] != null && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-brun">
              {t('fm.sheet.inTwo')} <Level value={p.level} /> → <Level value={advice.proj[1]} />
            </p>
          )}
        </Section>
        <Section title={t('fm.sheet.caTitle')} help={t('fm.sheet.caHelp')}>
          {p.ca != null ? (
            <>
              <p className="font-display text-2xl font-semibold tabular-nums">
                {p.ca}
                <span className="text-base text-brun"> / {paKnown ? p.pa : '?'}</span>
              </p>
              {paKnown && (
                <span className="mt-2 block h-2 overflow-hidden rounded-full bg-canard/10" aria-hidden>
                  <span className="block h-full rounded-full bg-orange" style={{ width: `${Math.min(100, (p.ca / p.pa!) * 100)}%` }} />
                </span>
              )}
              {cas.length > 1 && (
                <p className="mt-2 text-sm text-brun">
                  {t('fm.sheet.caSince', { from: cas[0], to: cas.at(-1) })} <b className="text-canard">({signed(cas.at(-1)! - cas[0]!)})</b>
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-brun">{t('fm.sheet.caUnknown')}</p>
          )}
        </Section>
      </div>
      {!external && (
        <Section title={t('fm.sheet.attrChanges')} help={t('fm.sheet.attrChangesHelp')}>
          {changes.length ? (
            <ul className="flex flex-wrap gap-1.5 text-sm">
              {changes.slice(0, 16).map(([k, d]) => (
                <li key={k} className={`rounded-full px-2.5 py-0.5 font-semibold ${d > 0 ? 'bg-eau/40 text-canard' : 'bg-corail/15 text-corail'}`}>
                  {attrLabel(k)} {signed(d)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-brun">{t('fm.sheet.noAttrChanges')}</p>
          )}
        </Section>
      )}
    </>
  );

  const tabs: [Tab, string][] = [
    ['overview', t('fm.sheet.tab.overview')],
    ['attributes', t('fm.sheet.tab.attributes')],
    ['matches', t('fm.sheet.tab.matches')],
    ['career', t('fm.sheet.tab.career')],
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-canard/30" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={p.name} className="h-full w-full max-w-4xl overflow-y-auto bg-creme shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Bandeau d'identité, comme l'en-tête de la fiche du jeu. */}
        <header className="relative bg-canard px-6 pb-5 pt-6 text-white">
          <span className={`absolute inset-x-0 top-0 h-1.5 ${line.bg}`} aria-hidden />
          <button type="button" className="absolute right-4 top-4 rounded-full px-2 text-2xl text-white/70 hover:bg-white/10 hover:text-white" onClick={onClose} aria-label={t('fm.sheet.close')}>
            ×
          </button>
          <div className="flex items-center gap-4">
            <Avatar player={p} size="lg" />
            <div className="min-w-0">
              <h2 className="flex items-center gap-3 truncate text-3xl font-semibold text-white">
                {!external && <Face id={p.id} name={p.name} size={56} className="ring-2 ring-orange" />}
                <span className="truncate">{p.name}</span>
              </h2>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-white/80">
                {p.positions.map((pos) => (
                  <PosBadge key={pos} pos={pos} />
                ))}
                {p.age != null && <span>· {t('fm.contracts.age', { count: p.age })}</span>}
                {p.foot && <span>· {t('fm.foot.foot', { foot: p.foot })}</span>}
                {p.squadStatus && <span>· {p.squadStatus}</span>}
              </p>
              {(external || p.personality || p.hierarchy) && (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-white/80">
                  {external && <span className="rounded-full bg-orange px-2 py-0.5 text-xs font-bold text-canard">{p.club ? t('fm.sheet.otherClubNamed', { club: p.club }) : t('fm.sheet.otherClub')}</span>}
                  {p.personality && <span>{p.personality}</span>}
                  {p.hierarchy && <span>· {p.hierarchy}</span>}
                </p>
              )}
            </div>
            <div className="ml-auto pr-8 text-right">
              <p className="text-xs uppercase tracking-wide text-white/60">{t('fm.col.level')}</p>
              <p className="font-display text-4xl font-semibold tabular-nums">{p.level != null ? nf(1).format(p.level) : '–'}</p>
              {p.level != null && (roleCeiling(p.level, p) ?? 0) - p.level >= 0.4 && (
                <p className="text-sm text-white/80">{t('fm.sheet.potential', { value: nf(1).format(roleCeiling(p.level, p)!) })}</p>
              )}
            </div>
          </div>
          {(p.injury || p.suspension) && (
            <p className="mt-3 flex flex-wrap gap-2">
              {p.injury && <Tag tone="bad">{p.injury + (p.injuryDays ? ` (${p.injuryDays} j)` : '')}</Tag>}
              {p.suspension && <Tag tone="bad">{t('fm.home.kind.suspended')}</Tag>}
            </p>
          )}
        </header>

        <div className="space-y-4 p-5">
          {/* Chiffres clés. */}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={t('fm.sheet.caPa')} value={p.ca != null ? `${p.ca} / ${paKnown ? p.pa : '?'}` : '–'} sub={p.ca == null ? t('fm.sheet.caOff') : undefined} />
            <Stat label={t('fm.sheet.value')} value={f.money(p.value)} />
            <Stat label={t('fm.col.wage')} value={f.money(p.wage)} />
            <Stat
              label={t('fm.col.contract')}
              value={f.date(p.contractEnd)}
              sub={months != null ? (months <= 0 ? t('fm.contracts.expired') : t('fm.home.endsIn', { count: months })) : undefined}
              tone={months != null && months <= 6 ? 'bad' : months != null && months <= 12 ? 'warn' : undefined}
            />
            <Stat label={t('fm.sheet.place')} value={main && place > 0 ? `${place} / ${mates.length}` : '–'} sub={main ? POS_LABEL[main] : undefined} />
            {external ? <Stat label={t('fm.sheet.projectShort')} value={<CompatTag c={fitProject} compact />} /> : <Stat label={t('fm.sheet.morale')} value={p.morale ?? '–'} />}
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <Chips value={tab} options={tabs} onChange={setTab} />
            {go && !external && (
              <button type="button" className="chip ml-auto" onClick={compare}>
                {t('fm.sheet.compareTo')}
              </button>
            )}
          </div>

          {tab === 'overview' && overview}
          {tab === 'attributes' && attributes}
          {tab === 'matches' && matchTab}
          {tab === 'career' && careerTab}
        </div>
      </aside>
    </div>
  );
}
