import { CONTRACT_CALLS, MERCATO_ORDER, POS_LABEL, POS_ORDER, lineOf, type Line, type PosCode, askingPrice, buildProject, clubFinances, contractDecisions, engineValue, financeState, mercatoAdvice, recruitmentNeeds, type ContractCall, type FmPlayer, type Project, type Target, type TacticEngine, teamPlan, storedTargets, type TeamPlanLimits, marketModel, bestSlotFit, targetPrice, roleCeiling, valueScore, slotFit, registrationContext, registrationCheck, regStatus, signingBlock, type RegistrationContext, reliability, type PriceVerdict, type FmSnapshot, type MercatoAdvice, type MercatoReason, type MercatoReport, type MercatoVerdict, type RecruitNeed, type SquadAt, type ClubFinances } from '@fm-immersion/module-fm';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { fmData } from '../lib/data';
import { useNavigate } from 'react-router-dom';
import { clubPath } from '../lib/club-nav';
import { useTacticEngine } from './FmTactic';
import { LeaveButton, useLeaving } from './FmLeaving';
import { NeedsPanel } from './FmNeeds';
import { DivisionLevelPanel, ReplacementFinder } from './FmReplacement';
import { CompatTag, EngineTag, Empty, Kpi, Level, Panel, Pos, Tag, useCoach, useFormat, useNames, type Tone, More, PlayerLink, Chips, ReliabilityLine } from './FmUi';

export const TONE: Record<MercatoVerdict, Tone> = { sell: 'bad', release: 'bad', loan: 'warn', extend: 'warn', develop: 'good', replace: 'warn', backup: 'info', core: 'good' };
/** Groupes affichés en détail : ce qui demande une décision au mercato. */
const ACTION: MercatoVerdict[] = ['sell', 'release', 'loan', 'extend', 'replace'];
/** Groupes où l'on cherche un remplaçant : le joueur part, ou il faut mieux à son poste. */
const REPLACE: MercatoVerdict[] = ['sell', 'release', 'replace'];

/** Fins de contrat à six mois ou moins : à régler avant que le joueur puisse signer ailleurs. */
const URGENT_MONTHS = 6;
/** Une décision individuelle, ouverte sous son groupe : une ligne, une raison courte, le détail au clic. */
type PlanRow = { key: string; head: ReactNode; tag: ReactNode; line: string; detail: ReactNode };
type PlanKind = 'extendUrgent' | 'recruit1' | 'sell' | 'release' | 'recruit2' | 'loan' | 'extend' | 'recruit3';
/** Ordre de priorité des groupes : du plus pressé au confort de banc. */
const PLAN_ORDER: PlanKind[] = ['extendUrgent', 'recruit1', 'sell', 'release', 'recruit2', 'loan', 'extend', 'recruit3'];
/** Au-delà de ce rang, des finances serrées passent en tête (rien de plus pressé qu'elles). */
type PlanChip = { key: string; pos: PosCode | null; label: string; sub?: string };
type PlanGroup = { kind: PlanKind; rows: PlanRow[]; chips: PlanChip[]; why: string };
/** Groupes à régler d'abord : numéro en rouge. */
const URGENT_KINDS: PlanKind[] = ['extendUrgent', 'recruit1'];
/** Noms montrés d'emblée sur la ligne d'un groupe (le reste en « et N autres »). */
const CHIPS_MAX = 6;
/** Couleur des pastilles de noms, comme dans « Ton effectif pour la suite ». */
const KIND_CHIP: Record<PlanKind, string> = {
  extendUrgent: 'border-orange-fonce/50 bg-orange-clair',
  extend: 'border-orange-fonce/50 bg-orange-clair',
  recruit1: 'border-dashed border-corail text-corail',
  recruit2: 'border-dashed border-orange-fonce text-orange-fonce',
  recruit3: 'border-dashed border-canard/40 text-brun',
  sell: 'border-corail/50 bg-corail/10',
  release: 'border-corail/50 bg-corail/10',
  loan: 'border-ambre bg-ambre/15',
};

/** Les décisions d'un groupe, une par ligne ; un clic ouvre la ligne sur place. */
function PlanRows({ rows }: { rows: PlanRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-canard/10 border-t border-canard/10">
      {rows.map((row) => {
        const isOpen = open === row.key;
        return (
          <li key={row.key}>
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : row.key)} className={`flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-orange-clair/40 ${isOpen ? 'bg-orange-clair/40' : ''}`}>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 font-bold">{row.head}</span>
              <span className="hidden min-w-0 flex-[2] truncate text-sm text-brun md:block">{row.line}</span>
              <span className="shrink-0">{row.tag}</span>
            </button>
            {isOpen && <div className="space-y-1.5 px-4 pb-3 text-sm">{row.detail}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Le plan du mercato, hiérarchisé : 1) la priorité, en grand, avec l'argent disponible ; 2) les décisions regroupées
 * par type, dans l'ordre où les prendre (une ligne par groupe) ; 3) au clic, chaque joueur ou poste ; le reste est replié.
 */
function MercatoPlan({ r, pr, engine, pool, needs, fin, gameDate, onMarked, reg, snapshots }: { r: MercatoReport; pr: Project | null; engine: TacticEngine; pool: Target[]; needs: RecruitNeed[]; fin: ClubFinances | null; gameDate: string; onMarked: (id: string) => void; reg: RegistrationContext | null; snapshots: number }) {
  // Liste d'inscription : effectif qui reste (les partants signalés n'y sont plus).
  const squad = useMemo(() => r.advice.map((a) => a.player), [r]);
  const regCheck = useMemo(() => (reg ? registrationCheck(squad, (p) => regStatus({ id: p.id, nationality: reg.nationality.get(p.id) }, reg.elig, reg.country), reg.rules) : null), [squad, reg]);
  const { t } = useTranslation();
  const f = useFormat();
  const reason = useReason();
  const navigate = useNavigate();
  const attr = (k: string) => t(`fm.attr.${k}`, { defaultValue: k });
  const [open, setOpen] = useState<PlanKind | null>(null);

  const needRow = (n: RecruitNeed, i: number): PlanRow => ({
    key: `need-${n.pos}-${i}`,
    head: (
      <>
        <span className="pill">{POS_LABEL[n.pos]}</span>
        {n.player && <span className="truncate font-normal text-brun">{n.player.name}</span>}
      </>
    ),
    tag: <Tag tone={n.priority === 1 ? 'bad' : n.priority === 2 ? 'warn' : undefined}>{t(`fm.needs.priority.${n.priority}`)}</Tag>,
    line: n.why[0] ? t(`fm.needs.why.${n.why[0]}`, { name: n.player?.name ?? '' }) : '',
    detail: (
      <>
        {n.why.length > 1 && <p>{n.why.slice(1).map((w) => t(`fm.needs.why.${w}`, { name: n.player?.name ?? '' })).join(' ')}</p>}
        {n.attrs.length > 0 && <p className="text-brun">{t('fm.needs.attrs', { list: n.attrs.map(attr).join(', ') })}</p>}
        {n.player && <PlayerLink player={n.player} />}
      </>
    ),
  });
  const playerRow = (a: MercatoAdvice, v: MercatoVerdict): PlanRow => ({
    key: `${v}-${a.player.id}`,
    head: (
      <>
        <span className="truncate">{a.player.name}</span> <Pos player={a.player} />
      </>
    ),
    tag:
      v === 'extend' ? (a.months != null && a.months <= URGENT_MONTHS ? <Tag tone="bad">{t('fm.merc.board.urgent')}</Tag> : null) : <Tag tone={TONE[v]}>{t(`fm.merc.verdict.${v}`)}</Tag>,
    line:
      v === 'extend'
        ? [t('fm.contracts.age', { count: a.player.age ?? 0 }), a.player.contractEnd ? t('fm.merc.board.until', { date: f.date(a.player.contractEnd) }) : null].filter(Boolean).join(' · ')
        : a.reasons[0]
          ? reason(a.reasons[0])
          : '',
    detail: (
      <>
        <p className="text-brun">{a.reasons.map(reason).join(' · ')}</p>
        <p className="flex flex-wrap items-center gap-2">
          <PlayerLink player={a.player} />
          {v === 'sell' && <PriceTag a={a} />}
          {v !== 'extend' && <LeaveButton player={a.player} gameDate={gameDate} onMarked={onMarked} />}
        </p>
      </>
    ),
  });

  const extend = [...r.byVerdict.extend].sort((x, y) => (x.months ?? 99) - (y.months ?? 99));
  const urgentExt = extend.filter((a) => a.months != null && a.months <= URGENT_MONTHS);
  const laterExt = extend.filter((a) => !(a.months != null && a.months <= URGENT_MONTHS));
  const lastEnd = (xs: MercatoAdvice[]) => xs.map((a) => a.player.contractEnd).filter(Boolean).sort().at(-1);
  const extWhy = (xs: MercatoAdvice[]) => (lastEnd(xs) ? t('fm.merc.plan.why.extend', { date: f.date(lastEnd(xs)!) }) : '');
  const byPrio = (p: number) => needs.map((n, i) => ({ n, i })).filter((x) => x.n.priority === p);
  const recruit = (p: number): PlanGroup => {
    const xs = byPrio(p);
    return { kind: `recruit${p}` as PlanKind, rows: xs.map((x) => needRow(x.n, x.i)), chips: xs.map((x) => ({ key: `n-${x.i}`, pos: x.n.pos, label: t('fm.merc.view.toRecruit'), sub: x.n.player ? t('fm.merc.plan.chipAfter', { name: x.n.player.name }) : undefined })), why: xs[0]?.n.why[0] ? t(`fm.needs.why.${xs[0].n.why[0]}`, { name: xs[0].n.player?.name ?? '' }) : '' };
  };
  // Prix demandé d'un vendu, sur sa pastille.
  const askText = (a: MercatoAdvice) => {
    const price = askingPrice(a.player, a.months);
    return price ? t('fm.merc.plan.chipAsk', { amount: f.money(price.ask) }) : undefined;
  };
  const players = (kind: PlanKind, v: MercatoVerdict, xs: MercatoAdvice[], why?: string): PlanGroup => ({
    kind,
    rows: xs.map((a) => playerRow(a, v)),
    chips: xs.map((a) => ({
      key: a.player.id,
      pos: a.project.pos ?? a.now.pos ?? a.player.positions[0] ?? null,
      label: a.player.name,
      sub: v === 'extend' ? (a.player.contractEnd ? f.date(a.player.contractEnd) : undefined) : v === 'sell' ? askText(a) : undefined,
    })),
    why: why ?? (xs[0]?.reasons[0] ? reason(xs[0].reasons[0]) : ''),
  });
  const groups = [
    players('extendUrgent', 'extend', urgentExt, extWhy(urgentExt)),
    recruit(1),
    players('sell', 'sell', r.byVerdict.sell),
    players('release', 'release', r.byVerdict.release),
    recruit(2),
    players('loan', 'loan', r.byVerdict.loan),
    players('extend', 'extend', laterExt, extWhy(laterExt)),
    recruit(3),
  ].filter((g) => g.rows.length);

  const tight = fin ? financeState(fin).tight : false;
  // Argent du plan : budget transferts + ventes possibles ; marge salariale + salaires libérés (inconnu = sans limite).
  const limits = useMemo<TeamPlanLimits>(
    () => ({
      budget: fin && fin.transferBudget != null ? Math.max(0, fin.transferBudget) + r.income : null,
      wageRoom: fin && fin.wageRoom != null ? Math.max(0, fin.wageRoom + r.wagesFreed) : null,
    }),
    [fin, r.income, r.wagesFreed],
  );
  // Bandeau d'argent (refonte « lisible » du 16/11/2026) : les quatre chiffres sur une ligne, au lieu de quatre cadres.
  const money: { key: string; label: string; value: string; sub?: string; bad?: boolean }[] = [
    ...(fin ? [{ key: 'tb', label: t('fm.merc.view.kpi.transfer'), value: f.money(fin.transferBudget) }] : []),
    ...(fin && fin.wageRoom != null ? [{ key: 'wr', label: t('fm.merc.view.kpi.wage'), value: f.money(fin.wageRoom), sub: t('fm.merc.view.kpi.perMonth'), bad: fin.wageRoom < 0 }] : []),
    { key: 'in', label: t('fm.merc.view.kpi.income'), value: f.money(r.income), sub: t('fm.merc.view.kpi.incomeSub', { wages: f.money(r.wagesFreed) }) },
    ...(fin ? [{ key: 'bal', label: t('fm.merc.view.kpi.balance'), value: f.money(fin.balance), bad: (fin.balance ?? 0) < 0 }] : []),
  ];
  // Liste d'inscription : un cadre seulement s'il y a un problème ; sinon une pastille dans le bandeau, qui l'ouvre au clic.
  const regOk = !!regCheck && regCheck.issues.length === 0;
  const [showReg, setShowReg] = useState(false);

  return (
    <div className="space-y-4">
      {/* 1. L'argent disponible, sur une ligne. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl bg-canard px-5 py-3 text-white">
        {money.map((m, i) => (
          <div key={m.key} className={`min-w-0 ${i > 0 ? 'sm:border-l sm:border-white/20 sm:pl-6' : ''}`} title={m.key === 'in' ? m.sub : undefined}>
            <p className="text-[11px] font-bold uppercase tracking-wider text-white/70">{m.label}</p>
            <p className={`font-display text-xl font-semibold tabular-nums ${m.bad ? 'text-[#FF9C9C]' : ''}`}>
              {m.value}
              {m.key === 'wr' && <span className="ml-1 text-sm font-normal text-white/70">{m.sub}</span>}
            </p>
          </div>
        ))}
        {reg && regCheck && regOk && (
          <button type="button" aria-expanded={showReg} onClick={() => setShowReg(!showReg)} className="ml-auto rounded-full bg-eau/25 px-3 py-1 text-xs font-bold text-white hover:bg-eau/40">
            ✓ {t('fm.merc.reg.ok')}
            {regCheck.free != null && regCheck.free >= 0 && <> · {t('fm.merc.reg.free', { count: regCheck.free })}</>}
          </button>
        )}
      </div>
      {tight && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-l-4 border-ambre bg-ambre/10 px-4 py-2 text-sm">
          <span className="font-bold">{t('fm.merc.plan.tightTitle')}</span>
          <span className="text-brun">{t('fm.merc.plan.tightText')}</span>
          <button type="button" className="font-bold text-orange-fonce hover:underline" onClick={() => navigate(clubPath('finances'))}>
            {t('fm.merc.plan.seeFinances')}
          </button>
        </p>
      )}
      {reg && regCheck && (!regOk || showReg) && <Registration reg={reg} c={regCheck} />}

      {/* 2. Les décisions d'abord, dans l'ordre ; les noms visibles, le détail s'ouvre sous le groupe. */}
      {groups.length > 0 ? (
        <section className="card !p-0" aria-labelledby="merc-next">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-4">
            <h2 id="merc-next" className="font-display text-xl font-semibold">{t('fm.merc.plan.decisions')}</h2>
            <p className="text-sm text-brun">{t('fm.merc.plan.decisionsSub', { count: groups.length })}</p>
          </div>
          <ol className="divide-y divide-canard/10 border-t border-canard/10">
            {groups.map((g, i) => {
              const isOpen = open === g.kind;
              return (
                <li key={g.kind}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : g.kind)} className={`flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-orange-clair/40 ${isOpen ? 'bg-orange-clair/40' : ''}`}>
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-extrabold tabular-nums text-white ${URGENT_KINDS.includes(g.kind) ? 'bg-corail' : 'bg-canard'}`}>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">
                        <span className="font-bold">{t(`fm.merc.plan.verb.${g.kind}`)}</span>
                        {g.why && <span className="text-sm text-brun"> · {g.why}</span>}
                      </span>
                      {/* Les noms tout de suite visibles, sans ouvrir le groupe. */}
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        {g.chips.slice(0, CHIPS_MAX).map((c) => (
                          <span key={c.key} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm ${KIND_CHIP[g.kind]}`}>
                            {c.pos && <span className="text-[11px] font-bold text-canard/60">{POS_LABEL[c.pos]}</span>}
                            <span className="font-semibold">{c.label}</span>
                            {c.sub && <span className="text-xs text-brun">{c.sub}</span>}
                          </span>
                        ))}
                        {g.chips.length > CHIPS_MAX && <span className="self-center text-sm text-brun">{t('fm.merc.plan.chipsMore', { count: g.chips.length - CHIPS_MAX })}</span>}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-bold text-orange-fonce">{isOpen ? '▴' : t('fm.merc.plan.see', { count: g.rows.length })}</span>
                  </button>
                  {isOpen && <PlanRows rows={g.rows} />}
                </li>
              );
            })}
          </ol>
        </section>
      ) : (
        <p className="card text-sm">
          <span className="font-bold">{t('fm.merc.plan.calmTitle')}</span> <span className="text-brun">{t('fm.merc.plan.calmText')}</span>
        </p>
      )}

      {/* 3. Le niveau du onze face à la note visée, et l'argent réparti pour combler l'écart. */}
      {pr && <TeamTarget pr={pr} engine={engine} pool={pool} limits={limits} squad={squad} snapshots={snapshots} blockOf={reg && regCheck ? (p) => signingBlock(regCheck, regStatus(p, reg.elig, reg.country), p.age) : undefined} />}

      {/* 4. Vue d'ensemble : tout l'effectif par ligne, avec ce qui reste, part, se prolonge et manque. */}
      <SquadOverview r={r} needs={needs} />
    </div>
  );
}

/**
 * Le onze face à la note visée, avec la formule de l'ancienne appli du coach : moyenne du onze, note visée, puis
 * les recrues abordables (parmi tes cibles suivies) qui font monter la moyenne, de la plus utile à la moins utile,
 * jusqu'à passer la barre.
 */
function TeamTarget({ pr: pr0, engine: engine0, pool, limits, blockOf, squad, snapshots }: { pr: Project; engine: TacticEngine; pool: Target[]; limits: TeamPlanLimits; blockOf?: (p: Target) => 'full' | 'nonEu' | null; squad: FmPlayer[]; snapshots: number }) {
  const rel = useMemo(() => reliability(squad, { snapshots, targets: pool.map((p) => ({ knowledge: p.scout?.knowledge ?? null })) }), [squad, snapshots, pool]);
  // Notes absolues (attributs seuls, comme FM Notebook) : les étoiles du jeu sont relatives à l'effectif et ne disent
  // pas si une recrue d'un autre club apporte quelque chose.
  const { engine, pr } = useMemo(() => {
    const abs = engine0.absolute();
    return { engine: abs, pr: { ...pr0, slots: pr0.slots.map((sl) => ({ ...sl, fit: sl.player ? slotFit(abs, sl.player, sl) : null })) } };
  }, [engine0, pr0]);
  const { t } = useTranslation();
  const f = useFormat();
  const names = useNames();
  const [coach, setCoach] = useCoach();
  const now = pr.slots.reduce((s, sl) => s + (sl.fit ?? 0), 0) / (pr.slots.length || 11);
  // Notes proposées dans l'unité affichée (sur 20 en interne) : par demi-étoile, ou par 5 %.
  // Notes sur 20 dans le rôle (comme FM Notebook) : les étoiles, relatives à l'effectif, ne disent pas si une recrue apporte.
  const options = Array.from({ length: 17 }, (_, i) => 10 + i / 2);
  // Par défaut, le palier juste au-dessus de la moyenne actuelle : un objectif atteignable.
  const T = coach.teamTarget ?? options.find((o) => o > now + 0.01) ?? options.at(-1)!;
  const plan = useMemo(() => teamPlan(engine, pr, pool, T, limits), [engine, pr, pool, T, limits]);
  // Moneyball : juste prix calibré sur tes cibles chiffrées ; « sous les radars » = bonne note pour bien moins cher.
  const scored = useMemo(
    () => pool.map((p) => ({ p, best: bestSlotFit(engine, pr, p), ...targetPrice(p) })).filter((x) => x.best != null && Object.keys(x.p.attributes).length),
    [engine, pr, pool],
  );
  const market = useMemo(() => marketModel(scored.map((x) => ({ fit: x.best!.fit, price: x.price }))), [scored]);
  const radar = market
    ? scored
        .map((x) => ({ ...x, v: market.verdict(x.best!.fit, x.price) }))
        .filter((x) => x.v?.verdict === 'bargain')
        .sort((a, b) => a.v!.ratio - b.v!.ratio)
        .slice(0, 5)
    : [];
  const done = plan.xiAvg >= T;
  const rows = plan.toTarget.length ? plan.toTarget : plan.upgrades.slice(0, 6);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<CandSort>('status');
  // Potentiel du onze : moyenne des plafonds des titulaires dans leur rôle.
  const xiCeil = pr.slots.reduce((s, sl) => s + (roleCeiling(sl.fit, sl.player ?? { age: null, ca: null, pa: null, stars: null }) ?? sl.fit ?? 0), 0) / (pr.slots.length || 11);
  type Cand = { key: string; status: CandStatus; pos: PosCode; player: Target; starter: FmPlayer | null; starterFit: number; fit: number; delta: number; after: number | null; price: number | null; isEst: boolean; wage: number | null; knowledge: number | null; ceil: number; starterCeil: number };
  const cands: Cand[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<Cand, 'ceil' | 'starterCeil'>) => {
    if (seen.has(c.player.id)) return;
    seen.add(c.player.id);
    const ceil = roleCeiling(c.fit, c.player) ?? c.fit;
    const starterCeil = c.starter ? (roleCeiling(c.starterFit, c.starter) ?? c.starterFit) : c.starterFit;
    cands.push({ ...c, ceil, starterCeil });
  };
  for (const u of rows) add({ key: `p-${u.player.id}`, status: 'plan', pos: u.slot.pos, player: u.player, starter: u.starter, starterFit: u.starterFit, fit: u.fit, delta: u.delta, after: u.after, price: u.price, isEst: u.priceIsEst, wage: u.wage, knowledge: u.knowledge });
  for (const x of radar) {
    const sl = x.best!.slot;
    add({ key: `r-${x.p.id}`, status: 'bargain', pos: sl.pos, player: x.p, starter: sl.player, starterFit: sl.fit ?? 0, fit: x.best!.fit, delta: x.best!.fit - (sl.fit ?? 0), after: null, price: x.price, isEst: x.isEst, wage: x.p.wage ?? null, knowledge: x.p.scout?.knowledge ?? null });
  }
  for (const u of plan.tooDear) add({ key: `d-${u.player.id}`, status: 'dear', pos: u.slot.pos, player: u.player, starter: u.starter, starterFit: u.starterFit, fit: u.fit, delta: u.delta, after: null, price: u.price, isEst: u.priceIsEst, wage: u.wage, knowledge: u.knowledge });
  for (const u of plan.unpriced) add({ key: `u-${u.player.id}`, status: 'unpriced', pos: u.slot.pos, player: u.player, starter: u.starter, starterFit: u.starterFit, fit: u.fit, delta: u.delta, after: null, price: null, isEst: false, wage: u.wage, knowledge: u.knowledge });
  const verdict = done ? 'done' : plan.reached ? 'reachable' : 'out';
  const sorted =
    sort === 'status'
      ? cands
      : [...cands].sort((a, b) =>
          sort === 'now' ? b.fit - a.fit : sort === 'potential' ? b.ceil - a.ceil || b.fit - a.fit : valueScore(b.fit, b.delta, b.price) - valueScore(a.fit, a.delta, a.price),
        );

  return (
    <section className="card" aria-labelledby="merc-target">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="merc-target" className="font-display text-xl font-semibold" title={t('fm.merc.target.help', { style: names.style(pr.style), form: pr.form })}>
            {t('fm.merc.target.titleNow', { value: n20(plan.xiAvg) })}
          </h2>
          <p className="text-sm text-brun">{names.style(pr.style)} · {pr.form}</p>
        </div>
        <label className="text-xs font-bold text-canard">
          {t('fm.merc.target.aim')}{' '}
          <select className="input ml-1 inline-block w-auto py-1 font-normal" value={T} onChange={(e) => setCoach({ teamTarget: Number(e.target.value) })}>
            {(options.includes(T) ? options : [...options, T].sort((a, b) => a - b)).map((v) => (
              <option key={v} value={v}>{n20(v)} / 20</option>
            ))}
          </select>
        </label>
      </div>

      {/* Où on est, où on vise, où on peut arriver : trois repères sur une même règle (au lieu de trois cadres). */}
      <Gauge now={plan.xiAvg} aim={T} reach={plan.reachable} verdict={verdict} recruits={plan.toTarget.length} />
      <p className="mt-1 text-xs text-brun">
        {t('fm.merc.target.ready', { count: pr.slots.filter((s) => s.fit != null && s.fit >= T).length })} · {t('fm.merc.target.floor', { value: n20(plan.floor) })}
        {xiCeil - plan.xiAvg >= 0.1 && <span className="text-eau-fonce"> · {t('fm.merc.target.xiCeil', { value: n20(xiCeil) })}</span>}
      </p>
      <p className="mt-2 text-xs text-brun">
        {limits.budget == null ? t('fm.merc.target.capNone') : t('fm.merc.target.cap', { amount: f.money(limits.budget) })}
        {limits.wageRoom != null && <> · {t('fm.merc.target.wageCap', { amount: f.money(limits.wageRoom) })}</>} · {t('fm.merc.target.pool', { count: pool.length })}
        {rows.length > 0 && !done && <> · {t('fm.merc.target.spent', { amount: f.money(rows.reduce((a, u) => a + (u.price ?? 0), 0)), wages: f.money(rows.reduce((a, u) => a + (u.wage ?? 0), 0)) })}</>}
      </p>

      <ReliabilityLine r={rel} />

      {/* Une seule liste de cibles, chacune avec son statut : dans le plan, bonne affaire, trop chère, prix à chiffrer. */}
      {done && <p className="mt-3 text-sm text-brun">{t('fm.merc.target.doneText')}</p>}
      {!pool.length ? (
        <p className="mt-3 text-sm text-brun">{t('fm.merc.target.noPool')}</p>
      ) : !cands.length ? (
        <p className="mt-3 text-sm text-brun">{t('fm.merc.target.noUpgrade')}</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold">{t('fm.merc.target.listTitle')}</p>
            <div className="flex items-center gap-2 text-xs text-brun">
              {t('fm.merc.target.sort.label')}
              <Chips<CandSort> value={sort} onChange={setSort} options={CAND_SORTS.map((k) => [k, t(`fm.merc.target.sort.${k}`)])} />
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-canard/15 text-left text-xs uppercase tracking-wide text-canard/60">
                <th className="py-1.5 pr-3">{t('fm.merc.target.col.pos')}</th>
                <th className="py-1.5 pr-3">{t('fm.merc.target.col.recruit')}</th>
                <th className="py-1.5 pr-3" title={`${t('fm.merc.target.col.fitHint')} · ${t('fm.merc.target.col.potentialHint')}`}>{t('fm.merc.target.col.fit')}</th>
                <th className="py-1.5 pr-3">{t('fm.merc.target.col.gain')}</th>
                <th className="py-1.5 pr-3 text-right">{t('fm.merc.target.col.price')}</th>
                <th className="py-1.5">{t('fm.merc.target.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {(showAll ? sorted : sorted.slice(0, CAND_MAX)).map((c) => {
                // Salaire et connaissance des recruteurs : en info-bulle de la ligne, pour garder six colonnes.
                const tip = [c.wage != null && `${t('fm.merc.target.col.wage')} : ${f.money(c.wage)}`, c.knowledge != null && `${t('fm.merc.target.col.known')} ${Math.round(c.knowledge)} %`].filter(Boolean).join(' · ');
                return (
                <tr key={c.key} title={tip || undefined} className={`border-b border-canard/5 last:border-0 ${c.status === 'plan' ? 'bg-eau/10' : ''}`}>
                  <td className="py-1.5 pr-3"><span className="pill">{POS_LABEL[c.pos]}</span></td>
                  <td className="py-1.5 pr-3">
                    <PlayerLink player={c.player} />
                    {c.knowledge != null && c.knowledge < 50 && <span className="ml-1.5 rounded bg-ambre/30 px-1 text-[11px] font-bold" title={t('fm.merc.target.knownLow')}>{t('fm.merc.target.knownShort', { value: Math.round(c.knowledge) })}</span>}
                    {c.starter && <span className="block text-xs text-brun">{t(c.delta > 0 ? 'fm.merc.target.replaces' : 'fm.merc.target.backupOf', { name: c.starter.name, fit: c.starterCeil - c.starterFit >= 0.4 ? `${n20(c.starterFit)} → ${n20(c.starterCeil)}` : n20(c.starterFit) })}</span>}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums">
                    <Note v={c.fit} aim={T} />
                    {c.ceil - c.fit >= 0.4 && <span className="ml-1.5 font-bold text-eau-fonce">→ {n20(c.ceil)}</span>}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {c.delta > 0 ? <span className="font-bold text-eau-fonce">+{n20(c.delta)}</span> : <span className="text-brun">{t('fm.merc.target.depth')}</span>}
                    {c.after != null && <span className="block text-xs text-brun">{t('fm.merc.target.afterShort', { value: n20(c.after) })}</span>}
                    {c.ceil - c.starterCeil > Math.max(0, c.delta) + 0.3 && <span className="block text-xs text-eau-fonce">{t('fm.merc.target.later', { gain: `${c.ceil - c.starterCeil > 0 ? '+' : ''}${n20(c.ceil - c.starterCeil)}` })}</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {c.price == null ? '–' : `${c.isEst ? '~' : ''}${f.money(c.price)}`}
                    {market && c.status !== 'bargain' && <PriceTag2 v={market.verdict(c.fit, c.price)?.verdict ?? null} />}
                    {c.status === 'bargain' && limits.budget != null && c.price != null && c.price > limits.budget && <span className="block text-xs text-corail">{t('fm.merc.target.overBudget')}</span>}
                  </td>
                  <td className="py-1.5">
                    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold ${STATUS_CLS[c.status]}`}>{t(`fm.merc.target.status.${c.status}`)}</span>
                    {blockOf?.(c.player) && <span className="mt-1 block whitespace-nowrap text-[11px] font-bold text-corail">{t(`fm.merc.reg.block.${blockOf(c.player)}`)}</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {cands.length > CAND_MAX && (
            <button type="button" className="mt-1 text-sm font-bold text-orange-fonce hover:underline" onClick={() => setShowAll(!showAll)}>
              {showAll ? t('fm.merc.target.less') : t('fm.merc.target.more', { count: cands.length - CAND_MAX })}
            </button>
          )}
          <p className="mt-2 text-xs text-brun">{t('fm.merc.target.scaleHelp')}</p>
          <p className="mt-1 text-xs text-brun">{market ? t('fm.merc.target.marketHelp', { count: market.n }) : t('fm.merc.target.marketNone')}</p>
        </div>
      )}
    </section>
  );
}

/** Liste d'inscription du championnat (règles reprises de FM Notebook) : places, formés localement, hors UE. */
function Registration({ reg, c }: { reg: RegistrationContext; c: ReturnType<typeof registrationCheck> }) {
  const { t } = useTranslation();
  const R = c.rules;
  const generic = R.key === 'generic';
  const n = (v: number | null) => (v == null ? '?' : String(v));
  const tile = (label: string, value: string, sub: string, bad: boolean) => (
    <div className={`rounded-lg p-3 ${bad ? 'bg-corail/10' : 'bg-canard/5'}`}>
      <p className="text-xs font-bold uppercase tracking-wide text-canard/60">{label}</p>
      <p className={`mt-1 font-display text-2xl font-semibold tabular-nums ${bad ? 'text-corail' : ''}`}>{value}</p>
      <p className="text-xs text-brun">{sub}</p>
    </div>
  );
  return (
    <section className="card" aria-labelledby="merc-reg">
      <h2 id="merc-reg" className="font-display text-xl font-semibold">{t('fm.merc.reg.title')}</h2>
      <p className="text-sm text-brun">{generic ? t('fm.merc.reg.generic', { league: reg.league ?? t('fm.merc.reg.unknownLeague') }) : t(`fm.merc.reg.rule.${R.key}`)}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile(
          t('fm.merc.reg.seniors'),
          c.maxSeniors == null ? String(c.seniors) : `${c.seniors} / ${c.maxSeniors}`,
          c.free == null ? t('fm.merc.reg.noCap') : c.free >= 0 ? t('fm.merc.reg.free', { count: c.free }) : t('fm.merc.reg.over', { count: -c.free }),
          c.issues.includes('full'),
        )}
        {tile(
          t('fm.merc.reg.homeGrown'),
          R.hgTotal == null ? n(c.homeGrown) : `${n(c.homeGrown)} / ${R.hgTotal}`,
          R.hgClub == null ? t('fm.merc.reg.hgClubFree', { count: c.homeGrownClub ?? 0 }) : t('fm.merc.reg.hgClub', { have: n(c.homeGrownClub), need: R.hgClub }),
          c.issues.includes('hgShort') || c.issues.includes('hgClubShort'),
        )}
        {tile(t('fm.merc.reg.nonEu'), R.nonEuCap == null ? n(c.nonEu) : `${n(c.nonEu)} / ${R.nonEuCap}`, R.nonEuCap == null ? t('fm.merc.reg.noNonEuCap') : t('fm.merc.reg.nonEuCap', { count: R.nonEuCap }), c.issues.includes('nonEuOver'))}
        {tile(t('fm.merc.reg.u21'), String(c.u21), t('fm.merc.reg.u21Sub'), false)}
      </div>
      {c.homeGrown == null && <p className="mt-2 text-xs text-brun">{t('fm.merc.reg.unknownHg')}</p>}
    </section>
  );
}

type CandStatus = 'plan' | 'bargain' | 'dear' | 'unpriced';
const STATUS_CLS: Record<CandStatus, string> = {
  plan: 'bg-eau-fonce text-white',
  bargain: 'bg-eau/40 text-canard',
  dear: 'bg-corail/15 text-canard',
  unpriced: 'bg-canard/10 text-canard',
};
const CAND_MAX = 8;
type CandSort = 'status' | 'now' | 'potential' | 'value';
const CAND_SORTS: CandSort[] = ['status', 'now', 'potential', 'value'];

/**
 * Jauge du onze : la moyenne d'aujourd'hui, la note visée et ce qu'on atteint avec les recrues abordables, sur une même
 * règle de notes sur 20 (bornes arrondies autour des trois valeurs).
 */
function Gauge({ now, aim, reach, verdict, recruits }: { now: number; aim: number; reach: number; verdict: 'done' | 'reachable' | 'out'; recruits: number }) {
  const { t } = useTranslation();
  const lo = Math.floor(Math.min(now, aim, reach) - 0.5);
  const hi = Math.max(lo + 3, Math.ceil(Math.max(now, aim, reach) + 0.5));
  const at = (v: number) => `${((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100}%`;
  const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  // Atteignable : seulement s'il dit autre chose qu'aujourd'hui.
  const showReach = verdict !== 'done' && reach - now >= 0.05;
  const dot = 'absolute h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgba(15,27,45,0.3)]';
  const lab = 'absolute -translate-x-1/2 whitespace-nowrap text-xs font-bold';
  return (
    <div className="mt-3">
      <div className="relative h-[4.5rem]">
        {/* Visé au-dessus de la règle, aujourd'hui et atteignable en dessous : les étiquettes ne se chevauchent pas. */}
        <span className={`${lab} top-0`} style={{ left: at(aim) }}>{t('fm.merc.target.gauge.aim', { value: n20(aim) })}</span>
        <div className="absolute inset-x-0 top-[1.6rem] h-2.5 rounded-full bg-gradient-to-r from-corail/25 via-ambre/25 to-eau/40" />
        <span className={`${dot} top-[1.35rem] bg-orange`} style={{ left: at(aim) }} />
        <span className={`${dot} top-[1.35rem] bg-canard`} style={{ left: at(now) }} />
        {showReach && <span className={`${dot} top-[1.35rem] ${verdict === 'out' ? 'bg-corail' : 'bg-eau'}`} style={{ left: at(reach) }} />}
        <span className={`${lab} top-[2.6rem]`} style={{ left: at(now) }}>{t('fm.merc.target.gauge.now', { value: n20(now) })}</span>
        {showReach && (
          <span className={`${lab} top-[3.6rem] ${verdict === 'out' ? 'text-corail' : 'text-eau-fonce'}`} style={{ left: at(reach) }}>
            {t(`fm.merc.target.gauge.${verdict}`, { value: n20(reach), count: recruits })}
          </span>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-brun">
        {ticks.map((x) => <span key={x}>{x}</span>)}
      </div>
      {verdict === 'done' && <p className="mt-1 text-sm font-bold text-eau-fonce">{t('fm.merc.target.verdict.done')}</p>}
      {verdict === 'out' && <p className="mt-1 text-sm font-bold text-corail">{t('fm.merc.target.verdict.out', { count: recruits })}</p>}
    </div>
  );
}

/** Note sur 20 à une décimale. */
const n20 = (v: number | null | undefined) => (v == null ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
/** Pastille de note sur 20 colorée face à la note visée : au-dessus, juste en dessous, loin en dessous. */
function Note({ v, aim }: { v: number; aim: number }) {
  const cls = v >= aim ? 'bg-eau-fonce text-white' : v >= aim - 1 ? 'bg-eau/40 text-canard' : v >= aim - 2 ? 'bg-canard/10 text-canard' : 'bg-corail/20 text-canard';
  return <span className={`num-pill ${cls}`}>{n20(v)}</span>;
}

/** Verdict de prix face au marché de tes cibles : bonne affaire ou cher (rien quand le prix est dans la norme). */
function PriceTag2({ v }: { v: PriceVerdict | null }) {
  const { t } = useTranslation();
  if (!v || v === 'fair') return null;
  return <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[11px] font-bold ${v === 'bargain' ? 'bg-eau/40 text-canard' : 'bg-corail/15 text-canard'}`}>{t(`fm.merc.target.price.${v}`)}</span>;
}

type Status = 'stay' | 'upgrade' | 'extend' | 'leave';
const STATUS_ORDER: Status[] = ['stay', 'upgrade', 'extend', 'leave'];
const STATUS_OF: Record<MercatoVerdict, Status> = { core: 'stay', develop: 'stay', backup: 'stay', replace: 'upgrade', extend: 'extend', sell: 'leave', release: 'leave', loan: 'leave' };
const CHIP: Record<Status, string> = {
  stay: 'border-eau-fonce/40 bg-eau/15',
  upgrade: 'border-ambre bg-ambre/15',
  extend: 'border-orange-fonce/50 bg-orange-clair',
  leave: 'border-corail/50 bg-corail/10 text-canard/70 line-through decoration-corail/60',
};
const LINES: Line[] = ['GB', 'DEF', 'MIL', 'ATT'];

/** Vue d'ensemble de l'effectif : une ligne par secteur, chaque joueur avec son sort au mercato, et les postes à pourvoir. */
function SquadOverview({ r, needs }: { r: MercatoReport; needs: RecruitNeed[] }) {
  const { t } = useTranslation();
  const f = useFormat();
  const reason = useReason();
  type Item = { id: string; name: string; pos: PosCode | null; status: Status; note: string; title: string; rank: number };
  const items: Item[] = [
    ...r.advice.map((a) => {
      const status = STATUS_OF[a.verdict];
      const pos = a.project.pos ?? a.now.pos ?? a.player.positions[0] ?? null;
      const note =
        status === 'extend' ? (a.player.contractEnd ? f.date(a.player.contractEnd) : '') : status === 'leave' || status === 'upgrade' ? t(`fm.merc.verdict.${a.verdict}`) : a.verdict === 'develop' ? t('fm.merc.view.young') : '';
      return { id: a.player.id, name: a.player.name, pos, status, note, title: a.reasons.map(reason).join(' · '), rank: a.project.rank ?? a.now.rank ?? 99 };
    }),
    ...r.leaving.map((p) => ({ id: p.id, name: p.name, pos: p.positions[0] ?? null, status: 'leave' as Status, note: t('fm.merc.view.marked'), title: '', rank: 99 })),
  ];
  const lineItems = (l: Line) =>
    items
      .filter((x) => x.pos && lineOf(x.pos) === l)
      .sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) || POS_ORDER.indexOf(x.pos!) - POS_ORDER.indexOf(y.pos!) || x.rank - y.rank);
  const lineNeeds = (l: Line) => needs.filter((n) => lineOf(n.pos) === l).sort((x, y) => x.priority - y.priority);
  const count = (s: Status) => items.filter((x) => x.status === s).length;
  const urgentNeeds = needs.filter((n) => n.priority < 3).length;

  return (
    <section className="card" aria-labelledby="merc-view">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="merc-view" className="font-display text-xl font-semibold">{t('fm.merc.view.title')}</h2>
        <p className="text-sm text-brun">
          {t('fm.merc.view.summary', { total: items.length, stay: count('stay') + count('upgrade'), extend: count('extend'), leave: count('leave') })} · {needs.length ? t('fm.merc.view.needs', { count: needs.length }) : t('fm.merc.view.noNeeds')}
          {urgentNeeds > 0 && <> ({t('fm.merc.view.needsUrgent', { count: urgentNeeds })})</>}
        </p>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-brun" aria-label={t('fm.merc.view.legend')}>
        {STATUS_ORDER.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={`inline-block h-3 w-5 rounded border ${CHIP[s]}`} /> {t(`fm.merc.view.status.${s}`)}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-5 rounded border border-dashed border-canard/50" /> {t('fm.merc.view.status.need')}
        </li>
      </ul>
      <div className="mt-3 divide-y divide-canard/10 border-t border-canard/10">
        {LINES.map((l) => {
          const xs = lineItems(l);
          const ns = lineNeeds(l);
          const kept = xs.filter((x) => x.status !== 'leave').length;
          return (
            <div key={l} className="grid gap-2 py-3 sm:grid-cols-[9rem_1fr]">
              <div>
                <p className="font-bold">{t(`fm.line.${l}`)}</p>
                <p className="text-xs text-brun">{t('fm.merc.view.lineCount', { kept, total: xs.length })}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {xs.map((x) => (
                  <span key={x.id} title={x.title || undefined} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm ${CHIP[x.status]}`}>
                    {x.pos && <span className="text-[11px] font-bold text-canard/60 no-underline">{POS_LABEL[x.pos]}</span>}
                    <span className="font-semibold">{x.name}</span>
                    {x.note && <span className="text-xs text-brun">{x.note}</span>}
                  </span>
                ))}
                {ns.map((n, i) => (
                  <span key={`n-${n.pos}-${i}`} className={`inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-sm ${n.priority === 1 ? 'border-corail text-corail' : n.priority === 2 ? 'border-orange-fonce text-orange-fonce' : 'border-canard/40 text-brun'}`}>
                    <span className="text-[11px] font-bold">{POS_LABEL[n.pos]}</span>
                    <span className="font-semibold">{t('fm.merc.view.toRecruit')}</span>
                    <span className="text-xs">{t(`fm.needs.priority.${n.priority}`)}</span>
                  </span>
                ))}
                {!xs.length && !ns.length && <span className="text-sm text-brun">–</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Prix conseillé pour la liste des transferts : prix demandé et plancher, raisons en infobulle. */
function PriceTag({ a }: { a: MercatoAdvice }) {
  const { t } = useTranslation();
  const f = useFormat();
  const price = askingPrice(a.player, a.months);
  if (!price) return null;
  const why = [t('fm.price.value', { value: f.money(price.value) }), ...price.factors.map((x) => t(`fm.price.factor.${x}`))].join(' · ');
  return (
    <span className="rounded-md bg-orange-clair px-1.5 py-0.5 text-canard" title={why}>
      {t('fm.price.ask', { ask: f.money(price.ask), floor: f.money(price.floor) })}
    </span>
  );
}

/** Texte d'une raison du conseil mercato. */
export function useReason() {
  const { t, i18n } = useTranslation();
  return (x: MercatoReason) => {
    switch (x.id) {
      case 'surplus':
        return t('fm.merc.why.surplus', { pos: POS_LABEL[x.pos], rank: x.rank, count: x.need });
      case 'starterNow':
      case 'starterProject':
      case 'backupAt':
      case 'misfit':
        return t(`fm.merc.why.${x.id}`, { pos: POS_LABEL[x.pos] });
      case 'contract':
        return x.months <= 0 ? t('fm.contracts.expired') : t('fm.merc.why.contract', { count: x.months });
      case 'unwanted':
        return t('fm.merc.why.unwanted', { status: x.status });
      case 'potential':
        // Étoiles du staff ramenées sur 20 (5 étoiles = 18, comme le potentiel du plan).
        return typeof x.stars === 'number'
          ? t('fm.merc.why.potential', { value: (8 + 2 * x.stars).toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 1 }) })
          : t('fm.merc.why.lowPotential');
      case 'potentialPa':
        return t('fm.merc.why.potentialPa', { pa: x.pa, ca: x.ca });
      case 'overtakes':
        return t('fm.merc.why.overtakes', { count: x.years, starter: x.starter });
      case 'decline':
        return t('fm.merc.why.decline', { age: x.age });
      case 'underperforms': {
        const n = (v: number) => v.toLocaleString(i18n.resolvedLanguage, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return t('fm.merc.why.underperforms', { rating: n(x.rating), team: n(x.team), count: x.apps });
      }
      default:
        return t(`fm.merc.why.${x.id}`);
    }
  };
}

/** Une ligne joueur : nom, poste, âge, compatibilité, raisons ; étoiles, niveau projeté et valeur à droite. */
function AdviceLine({ a, tag, extra, after }: { a: MercatoAdvice; tag?: ReactNode; extra?: ReactNode; after?: ReactNode }) {
  const { t } = useTranslation();
  const f = useFormat();
  const reason = useReason();
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-canard/5 py-2 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <PlayerLink player={a.player} /> <Pos player={a.player} />
          <span className="text-xs text-brun">{t('fm.contracts.age', { count: a.player.age ?? 0 })}</span>
          {a.player.team && <Tag>{a.player.team}</Tag>}
          <CompatTag c={a.compat} />
          <EngineTag v={engineValue(a.player)} />
          {tag}
        </div>
        <p className="mt-0.5 text-xs text-brun">{a.reasons.map(reason).join(' · ')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-brun">
        {extra}
        {/* Niveau actuel → potentiel atteignable, sur 20 (plus d'étoiles : elles sont relatives à l'effectif). */}
        <span className="flex items-center gap-1" title={t('fm.merc.levelHint')}>
          <Level value={a.player.level} />→<Level value={roleCeiling(a.player.level, a.player)} />
          <span>/20</span>
        </span>
        <span className="tabular-nums">{f.money(a.player.value)}</span>
      </div>
      {after && <div className="w-full">{after}</div>}
    </div>
  );
}

/** Adéquation moyenne des titulaires du onze cible. */
const xiFit = (pr: { slots: { fit: number | null }[] }) => {
  const xs = pr.slots.flatMap((s) => (s.fit == null ? [] : [s.fit]));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

const CALL_TONE: Record<ContractCall, Tone> = { extend: 'good', extendShort: 'info', sellNow: 'warn', letGo: 'bad' };

/**
 * Contrats à décider : les fins de contrat à six mois ou moins (celles que FM27 envoie en message), avec pour
 * chacun la décision à prendre dans le jeu et pourquoi. Rien n'est affiché s'il n'y en a pas.
 */
export function ContractsToDecide({ r, go, gameDate, onMarked }: { r: MercatoReport; go?: (view: string) => void; gameDate: string; onMarked?: (id: string) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const list = useMemo(() => contractDecisions(r), [r]);
  if (!list.length) return null;
  const count = (c: ContractCall) => list.filter((d) => d.call === c).length;
  return (
    <Panel
      title={t('fm.decide.title', { count: list.length })}
      action={
        go && (
          <button type="button" className="text-sm font-bold text-orange-fonce hover:underline" onClick={() => go('mercato')}>
            {t('fm.views.mercato')} →
          </button>
        )
      }
    >
      <More>{t('fm.decide.help')}</More>
      <p className="mb-2 flex flex-wrap gap-1.5 text-sm">
        {CONTRACT_CALLS.filter(count).map((c) => (
          <Tag key={c} tone={CALL_TONE[c]}>
            {t(`fm.decide.call.${c}`)} · {count(c)}
          </Tag>
        ))}
      </p>
      {list.map(({ advice: a, call, years }) => (
        <AdviceLine
          key={a.player.id}
          a={a}
          tag={
            <Tag tone={CALL_TONE[call]}>
              {t(`fm.decide.call.${call}`)}
              {years ? ` · ${t('fm.decide.years', { count: years })}` : ''}
            </Tag>
          }
          extra={
            <>
              <LeaveButton player={a.player} gameDate={gameDate} onMarked={onMarked} />
              {call === 'sellNow' && <PriceTag a={a} />}
              <span className="tabular-nums">{t('fm.decide.wage', { wage: f.money(a.player.wage) })}</span>
            </>
          }
        />
      ))}
      <More>{t('fm.decide.legend')}</More>
    </Panel>
  );
}

/**
 * Départs et jeunes : qui faire partir (vente, fin de contrat, prêt), qui prolonger, et quels jeunes valent le coup.
 * Calculé sur l'effectif importé ; aucune lecture supplémentaire dans le jeu.
 */
export function FmMercato({ saveId, snap, players, folder, gameDate, history }: { saveId: string; snap?: FmSnapshot; players: FmPlayer[]; folder: string; gameDate: string; history: SquadAt[] }) {
  const { t } = useTranslation();
  const f = useFormat();
  const names = useNames();
  const { engine } = useTacticEngine(folder, players);
  const [coach] = useCoach();
  // Partants signalés : le mercato planifie sans eux ; un signalement lance la recherche de son remplaçant.
  const { ids: leavingIds, loanIds, marks } = useLeaving();
  const [justMarked, setJustMarked] = useState<string | null>(null);
  const r = useMemo(() => mercatoAdvice(engine, players, gameDate, coach, history, leavingIds, loanIds), [engine, players, gameDate, coach, history, leavingIds, loanIds]);
  // Onze cible, comme pour les cibles du mercato : sert au remplaçant d'un partant et au niveau de la division.
  const own = useMemo(() => players.filter((p) => !p.injury && Object.keys(p.attributes).length), [players]);
  const pr = useMemo(() => buildProject(engine, own, coach), [engine, own, coach]);
  // Liste de courses : partants sans remplaçant, trous du projet, titulaires à remplacer, successions, banc.
  const needs = useMemo(() => recruitmentNeeds(engine, players, gameDate, coach, history, leavingIds, loanIds), [engine, players, gameDate, coach, history, leavingIds, loanIds]);
  const [replacing, setReplacing] = useState<string | null>(null);
  // Cibles suivies (liste du jeu et ajouts de l'appli) : le vivier du plan pour atteindre la note visée.
  const { data: targetRows } = useQuery({ queryKey: ['fm', saveId, 'targets', gameDate], queryFn: () => fmData.targets(saveId) });
  const reg = useMemo(() => (snap ? registrationContext(snap) : null), [snap]);
  const pool = useMemo(() => storedTargets(targetRows ?? [], players).filter((x) => !x.dismissed), [targetRows, players]);
  // Finances serrées : le mercato commence par les départs ; les recrues se cherchent libres ou en prêt.
  const fin = useMemo(() => (snap ? clubFinances(snap, players) : null), [snap, players]);
  const tight = useMemo(() => {
    if (!fin) return null;
    const st = financeState(fin);
    return st.tight ? { fin, signals: st.signals } : null;
  }, [fin]);
  if (!r) return <Empty>{t('fm.tac.noAttributes')}</Empty>;
  const style = engine.ref.styles.find((s) => s.id === r.projectStyle);

  const n = (v: MercatoVerdict) => r.byVerdict[v].length;
  const prospects = r.youth.filter((a) => a.prospect);
  // Chaque joueur n'apparaît qu'une fois : les jeunes sont dans leur cadre (avec leur étiquette), pas aussi dans les groupes.
  const youthIds = new Set(r.youth.map((a) => a.player.id));
  const rest = (v: MercatoVerdict) => r.byVerdict[v].filter((a) => !youthIds.has(a.player.id));

  return (
    <div className="space-y-4">
      <MercatoPlan r={r} pr={pr} engine={engine} pool={pool} needs={needs?.needs ?? []} fin={fin} gameDate={gameDate} onMarked={setJustMarked} reg={reg} snapshots={history.length} />
      {/* Le reste (jeunes, recherche de remplaçants, niveau de la division…) replié : l'écran tient sur une page. */}
      <details className="group">
        <summary className="cursor-pointer text-sm font-bold text-orange-fonce hover:underline">
          <span className="group-open:hidden">{t('fm.merc.board.detailOpen')}</span>
          <span className="hidden group-open:inline">{t('fm.merc.board.detailClose')}</span>
        </summary>
        <div className="mt-4 space-y-4">
      {/* Finances serrées : l'adjoint le dit déjà en tête ; le détail reste à portée, replié. */}
      {tight && (
        <details className="card group p-5">
          <summary className="cursor-pointer list-none font-bold [&::-webkit-details-marker]:hidden">
            {t('fm.tight.title')} <span className="text-sm font-normal text-orange-fonce group-open:hidden">· {t('fm.tight.more')}</span>
          </summary>
          <p className="text-sm">
            {t('fm.tight.signals', {
              list: tight.signals.map((sg) => t(`fm.tight.signal.${sg}`, { amount: f.money(Math.abs((sg === 'wageOver' ? tight.fin.wageRoom : sg === 'debt' ? tight.fin.balance : 0) ?? 0)) })).join(', '),
            })}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            <li>{t('fm.tight.sellFirst', { count: n('sell') + n('release') + n('loan'), income: f.money(r.income), wages: f.money(r.wagesFreed) })}</li>
            <li>{t('fm.tight.freeOrLoan')}</li>
            <li>{t('fm.tight.youth', { count: prospects.length })}</li>
            {tight.signals.includes('wageOver') && <li>{t('fm.tight.noRaise')}</li>}
          </ul>
        </details>
      )}
      {pr && r.leaving.length > 0 && (
        <Panel title={t('fm.leave.title', { count: r.leaving.length })}>
          <More>{t('fm.leave.help')}</More>
          {r.leaving.map((p) => (
            <div key={p.id} className="border-b border-canard/5 py-2 last:border-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <PlayerLink player={p} /> <Pos player={p} />
                <span className="text-xs text-brun">{t('fm.contracts.age', { count: p.age ?? 0 })}</span>
                <LeaveButton player={p} gameDate={gameDate} />
                {marks[p.id] && <span className="text-xs text-brun">{t('fm.leave.since', { date: f.date(marks[p.id]!.since) })}</span>}
              </div>
              <ReplacementFinder
                saveId={saveId}
                gameDate={gameDate}
                engine={engine}
                project={pr}
                leaving={p}
                squad={own.filter((x) => !leavingIds.has(x.id))}
                autoSearch={justMarked === p.id}
                finances={fin}
              />
            </div>
          ))}
        </Panel>
      )}
      <ContractsToDecide r={r} gameDate={gameDate} onMarked={setJustMarked} />
      {/* Compteurs : seuls ceux qui ne sont pas à zéro, un zéro n'appelle aucune décision. */}
      {(() => {
        const off = r.advice.filter((a) => a.compat?.compat === 'no').length;
        const tiles = [
          r.income > 0 && <Kpi key="income" label={t('fm.merc.kpi.income')} value={f.money(r.income)} sub={t('fm.merc.kpi.incomeSub', { wages: f.money(r.wagesFreed) })} />,
          prospects.length > 0 && <Kpi key="prospects" label={t('fm.merc.kpi.prospects')} value={prospects.length} sub={n('loan') > 0 ? t('fm.merc.kpi.prospectsSub', { loan: n('loan') }) : undefined} />,
          off > 0 && <Kpi key="off" label={t('fm.merc.kpi.off')} value={off} sub={t('fm.merc.kpi.offSub')} />,
        ].filter(Boolean);
        return tiles.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{tiles}</div> : null;
      })()}
      <More>{t('fm.merc.help', { form: r.nowForm ?? '–', style: names.style(style), projectForm: r.projectForm ?? '–' })}</More>

      {needs && <div id="merc-needs" className="scroll-mt-28"><NeedsPanel needs={needs.needs} saveId={saveId} gameDate={gameDate} engine={engine} project={pr} squad={own.filter((x) => !leavingIds.has(x.id))} finances={fin} /></div>}

      <Panel title={t('fm.merc.youth', { count: r.youth.length })}>
        {r.youth.length ? r.youth.map((a) => <AdviceLine key={a.player.id} a={a} tag={<Tag tone={TONE[a.verdict]}>{t(`fm.merc.verdict.${a.verdict}`)}</Tag>} />) : <Empty>{t('fm.merc.noYouth')}</Empty>}
        <More>{t('fm.merc.youthHelp')}</More>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {ACTION.filter((v) => rest(v).length).map((v) => (
          <Panel key={v} title={t(`fm.merc.group.${v}`, { count: rest(v).length })}>
            <p className="help">{t(`fm.merc.groupHelp.${v}`)}</p>
            {rest(v).map((a) =>
              pr && REPLACE.includes(v) ? (
                <AdviceLine
                  key={a.player.id}
                  a={a}
                  tag={
                    replacing !== a.player.id && (
                      <button type="button" className="text-xs font-bold text-orange-fonce hover:underline" onClick={() => setReplacing(a.player.id)}>
                        {t('fm.repl.open')}
                      </button>
                    )
                  }
                  extra={
                    <>
                      {v === 'sell' && <PriceTag a={a} />}
                      <LeaveButton player={a.player} gameDate={gameDate} onMarked={setJustMarked} />
                    </>
                  }
                  after={
                    replacing === a.player.id && (
                      <ReplacementFinder saveId={saveId} gameDate={gameDate} engine={engine} project={pr} leaving={a.player} squad={own} onClose={() => setReplacing(null)} finances={fin} />
                    )
                  }
                />
              ) : (
                <AdviceLine key={a.player.id} a={a} />
              ),
            )}
          </Panel>
        ))}
      </div>

      {pr && <DivisionLevelPanel engine={engine} project={pr} ownXiFit={xiFit(pr)} />}

      <Panel title={t('fm.merc.stay')}>
        <p className="help">{t('fm.merc.stayNoYouth')}</p>
        {MERCATO_ORDER.filter((v) => !ACTION.includes(v) && rest(v).length).map((v) => (
          <div key={v} className="mb-2 last:mb-0">
            <p className="mb-1 text-sm">
              <Tag tone={TONE[v]}>{t(`fm.merc.verdict.${v}`)}</Tag> <span className="text-brun">{t(`fm.merc.groupHelp.${v}`)}</span>
            </p>
            <p className="text-sm">{rest(v).map((a) => a.player.name).join(', ')}</p>
          </div>
        ))}
      </Panel>
        </div>
      </details>
    </div>
  );
}
