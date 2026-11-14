import {
  POS_LABEL,
  instructionKey,
  instructionState,
  piLabel,
  type FormationPlan,
  type LineupAdvice,
  type MatchReview,
  type PhysicalWatch,
  type PlayerInstruction,
  type TacticEngine,
  type TeamAdvice,
  type TodoItem,
} from '@fm-immersion/module-fm';
import { useState } from 'react';
import { readScoped, useFmSaveScope, writeScoped } from '../lib/save-store';
import { useTranslation } from 'react-i18next';
import { fitGap, fitPct, More } from './FmUi';

/*
 * Mon onze : ce que les derniers matchs disent de la tactique jouée, ce que l'adjoint dit du onze affiché (rôles à revoir, titulaires, joueurs à relancer, doublures),
 * des consignes d'équipe (adaptées à l'effectif, comparées à FM27) et des consignes individuelles réglées dans le jeu.
 */

/** L'avis de l'adjoint sur le onze affiché : des phrases courtes, chacune avec ses chiffres. */
export function LineupAdviceCard({ advice: full, plan, engine, inTodo = false }: { advice: LineupAdvice; plan: FormationPlan; engine: TacticEngine; inTodo?: boolean }) {
  // Quand « À changer dans FM27 » liste déjà les titulaires et les rôles, la carte ne garde que doublures et joueurs à relancer.
  const advice = inTodo ? { ...full, starters: [], roles: [] } : full;
  const { t, i18n } = useTranslation();
  const en = i18n.resolvedLanguage === 'en';
  const role = (code: string) => {
    const r = engine.roles.get(code);
    return (en ? r?.en : r?.fr) ?? r?.fr ?? code;
  };
  const pos = (i: number) => POS_LABEL[plan.slots[i]!.pos];
  const empty = !advice.roles.length && !advice.starters.length && !advice.rested.length && !advice.cover.length;
  if (inTodo && empty) return null;
  return (
    <section className="card">
      <h2 className="text-xl font-semibold">{t(inTodo ? 'fm.tac.advice.titleBench' : 'fm.tac.advice.title')}</h2>
      {empty ? (
        <p className="mt-2 text-sm">{t('fm.tac.advice.none')}</p>
      ) : (
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          {advice.starters.length > 0 && (
            <Group title={t('fm.tac.advice.starters')}>
              {advice.starters.map((a) => (
                <li key={a.slot}>
                  {t('fm.tac.advice.starter', { pos: pos(a.slot), better: a.better.name, betterFit: fitPct(a.betterFit), starter: a.starter.name, starterFit: fitPct(a.starterFit) })}
                </li>
              ))}
            </Group>
          )}
          {advice.roles.length > 0 && (
            <Group title={t('fm.tac.advice.roles')} note={t('fm.tac.advice.rolesNote')}>
              {advice.roles.map((a) => (
                <li key={`${a.slot}${a.phase}`}>
                  {t('fm.tac.advice.role', { player: a.player.name, phase: t(a.phase === 'ip' ? 'fm.pi.phaseIp' : 'fm.pi.phaseOop'), to: role(a.to), toFit: fitPct(a.toFit), from: role(a.from), fromFit: fitPct(a.fromFit) })}
                </li>
              ))}
            </Group>
          )}
          {advice.cover.length > 0 && (
            <Group title={t('fm.tac.advice.cover')}>
              {advice.cover.map((a) => (
                <li key={a.slot}>
                  {a.shift
                    ? t('fm.tac.advice.coverShift', { pos: pos(a.slot), starter: a.starter?.name ?? '', player: a.shift.player.name, from: POS_LABEL[a.shift.from], replacement: a.shift.replacement.name })
                    : t(a.reserve || a.makeshift ? 'fm.tac.advice.coverThin' : 'fm.tac.advice.coverNone', { pos: pos(a.slot), starter: a.starter?.name ?? '' })}
                  {a.reserve && <> {t('fm.tac.advice.coverReserve', { name: a.reserve.name, team: a.reserve.team ?? '' })}</>}
                  {a.makeshift && <> {t('fm.tac.advice.coverMakeshift', { name: a.makeshift.player.name, fam: a.makeshift.familiarity })}</>}
                </li>
              ))}
            </Group>
          )}
          {advice.rested.length > 0 && (
            <Group title={t('fm.tac.advice.rested')}>
              {advice.rested.map((a) => (
                <li key={a.slot}>
                  {t(`fm.tac.advice.restedWhy.${a.reason}`, {
                    pos: pos(a.slot),
                    better: a.better.name,
                    betterFit: fitPct(a.betterFit),
                    starter: a.starter.name,
                    starterFit: fitPct(a.starterFit),
                    value: a.value ?? '–',
                    morale: a.better.morale ?? '–',
                  })}
                </li>
              ))}
            </Group>
          )}
        </div>
      )}
      <More>{t('fm.tac.advice.help')}</More>
    </section>
  );
}

/**
 * Physique et rotation : les titulaires à ménager avant le prochain match (risque de blessure affiché par le jeu,
 * condition, matchs enchaînés), avec la doublure en bon état et ce que le changement coûte dans les rôles.
 */
export function PhysicalCard({ watch, plan, windowDays }: { watch: PhysicalWatch[]; plan: FormationPlan; windowDays: number }) {
  const { t } = useTranslation();
  const why = (w: PhysicalWatch) => {
    const vals = { pct: Math.round(w.player.condition ?? 0), sharpness: Math.round(w.player.sharpness ?? 0), starts: w.load?.starts ?? 0, minutes: Math.round(w.load?.minutes ?? 0), days: windowDays };
    const r = w.strain.reason;
    return t(r === 'risk' || r === 'riskRaised' ? `fm.tac.physical.why.${r}.${w.strain.cause}` : `fm.tac.physical.why.${r}`, vals);
  };
  const action = (w: PhysicalWatch) => {
    if (w.strain.cause === 'rhythm') return t('fm.tac.physical.do.rhythm');
    if (!w.sub) return t('fm.tac.physical.do.noSub');
    const vals = { sub: w.sub.name, subFit: fitPct(w.subFit), fit: fitPct(w.fit), gap: fitGap(Math.max(0, w.drop ?? 0)) };
    if (w.swapped) return t((w.drop ?? 0) <= 0 ? 'fm.tac.physical.do.swapEven' : 'fm.tac.physical.do.swap', vals);
    return t('fm.tac.physical.do.keep', vals);
  };
  if (watch.length === 0) return <p className="rounded-lg bg-eau/15 px-3 py-2 text-sm">{t('fm.tac.physical.none')}</p>;
  return (
    <section className="card">
      <h2 className="text-xl font-semibold">{t('fm.tac.physical.title')}</h2>
      {watch.length === 0 ? (
        <p className="mt-2 rounded-xl bg-eau/15 px-3 py-2 text-sm">{t('fm.tac.physical.none')}</p>
      ) : (
        <ul className="mt-3 space-y-1.5 text-sm">
          {watch.map((w) => (
            <li key={w.slot} className="flex items-start gap-3 rounded-xl bg-creme/50 px-3 py-2">
              <span className={`mt-0.5 shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-bold text-canard ${w.strain.level === 'rest' && w.strain.cause !== 'rhythm' ? 'bg-corail/20' : 'bg-ambre/30'}`}>{t(`fm.tac.physical.level.${w.strain.cause === 'rhythm' ? 'dose' : w.strain.level}`)}</span>
              <span>
                <b className="text-canard">
                  {w.player.name} <span className="font-normal text-brun">· {POS_LABEL[plan.slots[w.slot]!.pos]}</span>
                </b>
                <span className="block">{why(w)}</span>
                <span className="block text-xs text-brun">{action(w)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <More>{t('fm.tac.physical.help', { days: windowDays })}</More>
    </section>
  );
}

const TONE = { good: 'bg-eau', warn: 'bg-ambre', info: 'bg-canard/30' } as const;

/**
 * Ce que disent les derniers matchs : bilan et occasions (xG) de la tactique jouée, verdict (la garder et la
 * corriger, ou la remettre en cause), constats chiffrés, puis le bilan de chaque tactique essayée cette saison.
 */
export function MatchReviewCard({ review, tactic, fromGame }: { review: MatchReview; tactic: string | null; fromGame: boolean }) {
  const { t, i18n } = useTranslation();
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'always' });
  const tr = review.trend;
  const fmt = (vals: Record<string, number>) => Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, Number.isInteger(v) ? v : k === 'shots' ? nf1.format(v) : nf2.format(v)]));
  if (!review.recent.length) return null;
  return (
    <section className="card">
      <h2 className="text-xl font-semibold">{t('fm.tac.review.title')}</h2>
      {!tr ? (
        <p className="mt-2 text-sm">{t('fm.tac.review.tooFew', { count: review.recent.length })}</p>
      ) : (
        <>
          <p className="mt-2 text-sm">
            <b>{review.scoped && tactic ? t('fm.tac.review.scopeTactic', { count: tr.matches, tactic }) : t('fm.tac.review.scopeAll', { count: tr.matches })}</b>{' '}
            {t('fm.tac.review.record', { wins: tr.wins, draws: tr.draws, losses: tr.losses, gf: nf1.format(tr.goalsFor), ga: nf1.format(tr.goalsAgainst) })}
            {tr.xgFor != null && tr.xgAgainst != null && <> {t('fm.tac.review.xg', { xgFor: nf2.format(tr.xgFor), xgAgainst: nf2.format(tr.xgAgainst) })}</>}
          </p>
          {review.scoped && review.verdict !== 'open' && review.verdict !== 'early' && (
            <p className={`mt-2 rounded-xl px-3 py-2 text-sm ${review.verdict === 'keep' ? 'bg-eau/15' : 'bg-ambre/20'}`}>
              {t(`fm.tac.review.verdict.${review.verdict}${review.verdict === 'keep' && !fromGame ? 'Other' : ''}`, { tactic: tactic ?? '' })}
            </p>
          )}
          {!review.scoped && tactic && <p className="mt-2 text-xs text-brun">{t('fm.tac.review.early', { tactic, count: review.current?.matches ?? 0 })}</p>}
          {review.findings.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {review.findings.map((f) => (
                <li key={f.id} className="flex gap-2 rounded-xl bg-creme/50 px-3 py-2">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[f.tone]}`} />
                  <span>{t(`fm.tac.review.finding.${f.id}`, fmt(f.vals))}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {review.tactics.length > 1 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-bold text-orange-fonce">{t('fm.tac.review.byTactic')}</summary>
          <table className="data-table mt-1">
            <thead>
              <tr>
                <th>{t('fm.tac.review.col.tactic')}</th>
                <th>{t('fm.tac.review.col.matches')}</th>
                <th>{t('fm.tac.review.col.record')}</th>
                <th>{t('fm.tac.review.col.ppm')}</th>
                <th>{t('fm.tac.review.col.xg')}</th>
              </tr>
            </thead>
            <tbody>
              {review.tactics.map((f) => (
                <tr key={f.tactic}>
                  <td className={f === review.current ? 'font-bold text-canard' : ''}>{f.tactic}</td>
                  <td>{f.matches}</td>
                  <td>{t('fm.tac.review.wdl', { wins: f.wins, draws: f.draws, losses: f.losses })}</td>
                  <td>{nf2.format(f.ppm)}</td>
                  <td>{f.xgDiff != null ? signed.format(f.xgDiff) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-brun">{t('fm.tac.review.byTacticNote')}</p>
        </details>
      )}
      <More>{t('fm.tac.review.help')}</More>
    </section>
  );
}

/** Lignes montrées d'emblée dans « À changer dans FM27 ». */
const TODO_SHOWN = 3;
/** Lignes cochées par le joueur (« fait dans FM27 »), retenues par partie jusqu'à la prochaine lecture qui les efface d'elle-même. */
const TODO_DONE_KEY = 'fmi.tactic.todoDone.v1';
const TODO_TAG: Record<TodoItem['kind'], string> = { team: 'team', starter: 'starter', piChange: 'player', piAdd: 'player', piRemove: 'player', role: 'role' };

/**
 * « À changer dans FM27 » : la liste unique, classée par importance, de tout ce que les conseils de l'écran demandent
 * de modifier dans la tactique du jeu. Chaque ligne dit quoi faire, puis pourquoi, avec ses chiffres.
 */
export function TodoCard({ items, plan, engine, tactic }: { items: TodoItem[]; plan: FormationPlan; engine: TacticEngine; tactic: string | null }) {
  const { t, i18n } = useTranslation();
  const en = i18n.resolvedLanguage === 'en';
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 });
  const fmt = (vals: Record<string, number | string>) => Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, typeof v === 'number' ? nf1.format(v) : v]));
  // Les plus importants d'abord : la suite s'ouvre sur demande, pour ne pas allonger la page.
  const [all, setAll] = useState(false);
  const scope = useFmSaveScope();
  const [done, setDone] = useState<string[]>(() => readScoped<string[]>(TODO_DONE_KEY, scope, []));
  const toggle = (key: string) => {
    const next = done.includes(key) ? done.filter((k) => k !== key) : [...done, key];
    setDone(next);
    writeScoped(TODO_DONE_KEY, scope, next);
  };
  const role = (code: string) => {
    const r = engine.roles.get(code);
    return (en ? r?.en : r?.fr) ?? r?.fr ?? code;
  };
  const val = (r: TeamAdvice['rows'][number], o: number) => r.def.short[o] ?? r.def.options[o] ?? '';
  const line = (it: TodoItem): { what: string; why: string } => {
    switch (it.kind) {
      case 'team':
        return {
          what: t('fm.tac.todo.team', { title: it.row.def.title, to: val(it.row, it.row.option), from: val(it.row, it.row.game ?? it.row.styleOption ?? it.row.option) }),
          why: t(`fm.tac.tiAdvice.reason.${it.row.reason}`, fmt(it.row.vals)),
        };
      case 'starter':
        return {
          what: t('fm.tac.todo.starter', { pos: POS_LABEL[plan.slots[it.advice.slot]!.pos], better: it.advice.better.name, starter: it.advice.starter.name }),
          why: t('fm.tac.todo.starterWhy', { better: it.advice.better.name, betterFit: fitPct(it.advice.betterFit), starterFit: fitPct(it.advice.starterFit) }),
        };
      case 'piChange':
        return {
          what: t('fm.tac.todo.piChange', { player: it.player.name, to: t(`fm.pi.id.${it.instruction.id}`), from: piLabel(it.other, en).option }),
          why: t(`fm.pi.why.${it.instruction.why}`, fmt(it.instruction.vals)),
        };
      case 'piAdd':
        return { what: t('fm.tac.todo.piAdd', { player: it.player.name, to: t(`fm.pi.id.${it.instruction.id}`) }), why: t(`fm.pi.why.${it.instruction.why}`, fmt(it.instruction.vals)) };
      case 'piRemove':
        return {
          what: t('fm.tac.todo.piRemove', { player: it.player.name, labels: it.keys.map((k) => piLabel(k, en).option).join(', ') }),
          why: t('fm.tac.todo.piRemoveWhy', { count: it.count, budget: it.budget }),
        };
      case 'role':
        return {
          what: t('fm.tac.todo.role', { player: it.advice.player.name, phase: t(it.advice.phase === 'ip' ? 'fm.pi.phaseIp' : 'fm.pi.phaseOop'), to: role(it.advice.to), from: role(it.advice.from) }),
          why: t('fm.tac.todo.roleWhy', { toFit: fitPct(it.advice.toFit), fromFit: fitPct(it.advice.fromFit) }),
        };
    }
  };
  // Les lignes cochées descendent en bas de la liste ; le compteur ne garde que ce qui reste à faire.
  const lines = items.map((it) => ({ it, ...line(it) }));
  const isDone = (l: { what: string }) => done.includes(l.what);
  const ordered = [...lines.filter((l) => !isDone(l)), ...lines.filter(isDone)];
  const left = ordered.filter((l) => !isDone(l)).length;
  const shown = all ? ordered : ordered.slice(0, TODO_SHOWN);
  return (
    <section className="card">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-xl font-semibold">
        {t('fm.tac.todo.title')}
        {items.length > 0 && <span className="text-sm font-normal text-brun">{t('fm.tac.todo.left', { count: left })}</span>}
      </h2>
      {items.length ? (
        <ul className="mt-3 divide-y divide-canard/10 text-sm">
          {shown.map((l) => {
            const ok = isDone(l);
            return (
              <li key={l.what}>
                <label className="flex cursor-pointer items-start gap-3 py-2.5">
                  <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#8F5400]" checked={ok} onChange={() => toggle(l.what)} />
                  <span className={ok ? 'text-brun line-through' : ''}>
                    <span className="mr-2 text-xs font-bold uppercase tracking-wide text-orange-fonce">{t(`fm.tac.todo.tag.${TODO_TAG[l.it.kind]}`)}</span>
                    <b className={ok ? 'font-semibold' : 'text-canard'}>{l.what}</b>
                    {!ok && <span className="block text-xs text-brun first-letter:uppercase">{l.why}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 rounded-xl bg-eau/15 px-3 py-2 text-sm">{t('fm.tac.todo.none')}</p>
      )}
      {items.length > TODO_SHOWN && (
        <button type="button" className="mt-1 text-sm font-bold text-orange-fonce hover:underline" onClick={() => setAll(!all)}>
          {all ? t('fm.tac.todo.less') : t('fm.tac.todo.more', { count: items.length - TODO_SHOWN })}
        </button>
      )}
      <More>
        {t(tactic ? 'fm.tac.todo.intro' : 'fm.tac.todo.introNoName', { tactic: tactic ?? '' })} {t('fm.tac.todo.help')}
      </More>
    </section>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wide text-canard/60">{title}</p>
      <ul className="mt-1 space-y-1.5 text-sm [&>li]:rounded-xl [&>li]:bg-creme/50 [&>li]:px-3 [&>li]:py-2">{children}</ul>
      {note && <p className="mt-1 text-xs text-brun">{note}</p>}
    </div>
  );
}

/**
 * Consignes d'équipe adaptées au onze : ce que l'effectif fait corriger, puis, si le plugin a lu la tactique,
 * les cases réglées autrement dans FM27. `base` : « game » quand on part des consignes du jeu (onze du jeu).
 */
export function TeamAdviceBlock({ advice, base, load }: { advice: TeamAdvice; base: 'style' | 'game'; load: { team: number | null; understanding: number | null } }) {
  const { t } = useTranslation();
  const changes = advice.rows.filter((r) => r.reason);
  const diffs = base === 'style' ? advice.rows.filter((r) => r.game != null && r.game !== r.option) : [];
  const val = (r: TeamAdvice['rows'][number], o: number) => r.def.short[o] ?? r.def.options[o] ?? '';
  const heavy = load.team != null && load.understanding != null && load.team >= 50 && load.understanding < 50;
  return (
    <div className="mt-4 border-t border-canard/10 pt-3 text-sm">
      <p className="text-xs font-bold uppercase tracking-wide text-canard/60">{t('fm.tac.tiAdvice.title')}</p>
      {changes.length ? (
        <ul className="mt-1 space-y-1.5">
          {changes.map((r) => (
            <li key={r.def.id} className="rounded-xl bg-creme/50 px-3 py-2">
              <span className="text-brun">{r.def.title} :</span> <b>{val(r, r.option)}</b>{' '}
              {r.styleOption != null && r.styleOption !== r.option && <span className="text-xs text-brun">{t('fm.tac.tiAdvice.insteadOf', { label: val(r, r.styleOption) })}</span>}
              <span className="block text-xs text-brun first-letter:uppercase">{t(`fm.tac.tiAdvice.reason.${r.reason}`, r.vals)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1">{t(base === 'game' ? 'fm.tac.tiAdvice.noneGame' : 'fm.tac.tiAdvice.none')}</p>
      )}
      {heavy && <p className="mt-2 rounded-xl bg-ambre/20 px-3 py-2">{t('fm.tac.tiAdvice.heavy', { count: advice.count.game ?? 0, complexity: Math.round(load.team!), understanding: Math.round(load.understanding!) })}</p>}
      {base === 'style' && advice.read && (
        <>
          <p className="mt-4 text-xs font-bold uppercase tracking-wide text-canard/60">{t('fm.tac.tiAdvice.vsGame')}</p>
          {diffs.length ? (
            <table className="data-table mt-1">
              <thead>
                <tr>
                  <th>{t('fm.tac.tiAdvice.col.card')}</th>
                  <th>{t('fm.tac.tiAdvice.col.advised')}</th>
                  <th>{t('fm.tac.tiAdvice.col.game')}</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((r) => (
                  <tr key={r.def.id}>
                    <td className="text-brun">{r.def.title}</td>
                    <td className="font-bold text-canard">{val(r, r.option)}</td>
                    <td>{val(r, r.game!)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-1">{t('fm.tac.tiAdvice.sameAsGame')}</p>
          )}
        </>
      )}
      {!advice.read && <p className="mt-2 text-xs text-brun">{t('fm.tac.tiAdvice.notRead')}</p>}
    </div>
  );
}

/** État d'une consigne conseillée dans la tactique du jeu : déjà réglée, ou réglée à l'inverse. */
export function PiState({ x, keys }: { x: PlayerInstruction; keys: readonly string[] | null }) {
  const { t, i18n } = useTranslation();
  if (!keys) return null;
  const s = instructionState(x.id, keys);
  if (s.state === 'done') return <span className="ml-1 whitespace-nowrap rounded-md bg-eau/30 px-1.5 py-0.5 text-xs font-bold text-canard">{t('fm.pi.state.done')}</span>;
  if (s.state === 'conflict') return <span className="ml-1 whitespace-nowrap rounded-md bg-corail/20 px-1.5 py-0.5 text-xs font-bold text-canard">{t('fm.pi.state.conflict', { label: piLabel(s.other!, i18n.resolvedLanguage === 'en').option })}</span>;
  return null;
}

/**
 * Consignes individuelles réglées dans FM27 pour un joueur, et celles à retirer en premier quand il y en a trop.
 * `supported` : toutes les consignes que ses attributs appuient, sans la limite par joueur.
 */
export function GamePiLine({ mine, supported, budget }: { mine: readonly string[]; supported: readonly PlayerInstruction[]; budget: number }) {
  const { t, i18n } = useTranslation();
  const en = i18n.resolvedLanguage === 'en';
  if (!mine.length) return null;
  // Consignes du jeu que les attributs du joueur n'appuient pas : les premières à enlever si la tactique est trop chargée.
  const extra = mine.filter((k) => !supported.some((x) => instructionKey(x.id) === k));
  const over = mine.length > budget;
  return (
    <p className="mb-1 text-xs text-canard">
      <b>{t('fm.pi.inGame')}</b> {mine.map((k) => piLabel(k, en).option).join(' · ')}
      {over && extra.length > 0 && <span className="mt-0.5 block text-brun">{t('fm.pi.over', { count: mine.length, budget, labels: extra.map((k) => piLabel(k, en).option).join(', ') })}</span>}
    </p>
  );
}
