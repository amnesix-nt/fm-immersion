import { setPieceTakers, tacticGap, type GapVerdict, depthAlerts, depthChart, depthFromPlan, formationKey, POS_LABEL, seasonStart, type DepthEntry, type FmPlayer, type GameSlot, type SquadAt } from '@fm-immersion/module-fm';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PosBadge } from './FmFoot';
import { useTacticChoice } from './FmTactic';
import { Fit, Kpi, Level, Panel, Tag, useNames, PlayerLink } from './FmUi';

/** Titulaires et remplaçants : qui joue à chaque poste, et quelle doublure peut passer devant d'ici deux saisons. */
export function FmDepth({ players, folder, gameFormation, gameTactic = null, lineup, gameDate, history }: { players: FmPlayer[]; folder: string; gameFormation: string | null; gameTactic?: string | null; lineup: GameSlot[] | null; gameDate: string; history: SquadAt[] }) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  // Même style, même schéma et même onze que Tactique > Composition ; la formation du jeu n'est qu'une indication.
  const { engine, plan, style, fromGame } = useTacticChoice(players, folder, gameFormation, lineup, gameTactic);
  const form = plan?.form ?? formationKey(gameFormation);
  const rows = useMemo(() => (plan ? depthFromPlan(plan, players, history) : depthChart(players, form, history)), [plan, players, form, history]);
  const alerts = useMemo(() => depthAlerts(rows), [rows]);
  const thin = rows.filter((r) => !r.subs.length);
  // Écart poste par poste entre ce que la tactique demande et ce que l'effectif donne.
  const gap = useMemo(() => (plan ? tacticGap(engine, plan) : null), [engine, plan]);
  const gapRows = useMemo(() => {
    if (!gap) return [];
    const rank: Record<GapVerdict, number> = { hole: 0, weak: 1, thin: 2, ok: 3 };
    return [...gap.slots].sort((a, b) => rank[a.verdict] - rank[b.verdict] || (b.gap ?? 0) - (a.gap ?? 0));
  }, [gap]);
  const en = i18n.resolvedLanguage === 'en';
  const roleName = (code: string) => {
    const r = engine.roles.get(code);
    return (en ? r?.en : r?.fr) ?? r?.fr ?? code;
  };
  const nf0 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  // Tireurs et capitaine parmi le onze (sinon tout l'effectif disponible).
  const takers = useMemo(() => {
    const xi = plan ? plan.slots.flatMap((sl) => (sl.player ? [sl.player] : [])) : [];
    return setPieceTakers(xi.length ? xi : players.filter((p) => !p.injury));
  }, [plan, players]);
  const nf1 = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const y0 = seasonStart(gameDate);
  const season = (n: number) => `${y0 + n}/${String(y0 + n + 1).slice(2)}`;

  const line = (e: DepthEntry, extra: ReactNode) => (
    <div key={e.player.id} className="flex items-center justify-between gap-2 border-b border-canard/5 py-1.5 last:border-0">
      <span className="min-w-0 flex-1">
        <PlayerLink player={e.player} /> <span className="text-xs text-brun">{t('fm.contracts.age', { count: e.player.age ?? 0 })}</span>
        {e.player.team && (
          <>
            {' '}
            <Tag>{e.player.team}</Tag>
          </>
        )}
        {e.player.injury && (
          <>
            {' '}
            <Tag tone="bad">{t('fm.depth.injured')}</Tag>
          </>
        )}{' '}
        {extra}
      </span>
      <span className="flex items-center gap-1 text-xs text-brun">
        <Level value={e.player.level} />→<Level value={e.in1} />→<Level value={e.in2} />
      </span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label={t('fm.depth.canPass')} value={alerts.length} sub={t('fm.depth.by', { season: season(2) })} />
        <Kpi
          label={t('fm.depth.thin')}
          value={thin.length}
          tone={thin.length ? 'bad' : undefined}
          sub={thin.map((r) => POS_LABEL[r.pos]).join(', ') || t('fm.depth.none')}
        />
        <Kpi
          label={t('fm.depth.form')}
          value={form}
          sub={[style && names.style(style), gameFormation && t('fm.tac.inGame', { form: gameFormation })].filter(Boolean).join(' · ') || t('fm.depth.proposed')}
        />
      </div>

      {gap && (
        <Panel title={t('fm.gap.title')}>
          <p className="help">{t('fm.gap.help', { median: gap.median != null ? nf1(gap.median) : '–', level: gap.level != null ? nf1(gap.level) : '–' })}</p>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {(['hole', 'weak', 'thin'] as const).map((v) => (
              <Tag key={v} tone={gap.count[v] ? (v === 'thin' ? 'warn' : 'bad') : 'good'}>
                {t(`fm.gap.count.${v}`, { count: gap.count[v] })}
              </Tag>
            ))}
          </div>
          <div className="space-y-1">
            {gapRows.map((g) => (
              <div key={g.slot} className={`grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b border-canard/5 py-1.5 last:border-0 lg:grid-cols-[3rem_minmax(0,1fr)_13rem_16rem_9.5rem] ${g.verdict === 'ok' ? 'opacity-70' : ''}`}>
                <span>
                  <PosBadge pos={g.pos} />
                </span>
                <span className="min-w-0 text-sm">
                  <span className="font-bold">{roleName(g.ip)}</span>
                  {g.oop !== g.ip && <span className="text-brun"> · {roleName(g.oop)}</span>}
                </span>
                <span className="col-start-2 flex items-center justify-between gap-1.5 text-sm lg:col-start-auto">
                  {g.starter ? (
                    <>
                      <PlayerLink player={g.starter} /> <Fit value={g.starterFit} />
                    </>
                  ) : (
                    <span className="text-brun">{t('fm.depth.nobody')}</span>
                  )}
                </span>
                <span className="col-start-2 flex items-center justify-between gap-1.5 text-xs text-brun lg:col-start-auto">
                  {g.sub ? (
                    <>
                      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                        {t('fm.gap.sub')} <PlayerLink player={g.sub} />
                      </span>
                      <Fit value={g.subFit} />
                    </>
                  ) : (
                    t('fm.depth.noSub')
                  )}
                </span>
                <span className="col-start-2 flex flex-wrap gap-1 lg:col-start-auto lg:justify-end">
                  <Tag tone={g.verdict === 'ok' ? 'good' : g.verdict === 'thin' ? 'warn' : 'bad'}>{t(`fm.gap.verdict.${g.verdict}`)}</Tag>
                  {g.subAhead && <Tag tone="info">{t('fm.gap.subAhead')}</Tag>}
                </span>
                {g.missing.length > 0 && (
                  <p className="col-start-2 text-xs text-brun lg:col-span-4 lg:col-start-2">
                    {t('fm.gap.missing')}{' '}
                    {g.missing.map((m) => `${t(`fm.attr.${m.key}`, { defaultValue: m.key })} ${nf0(m.value)}`).join(', ')}
                    {' · '}
                    {t('fm.gap.bar', { bar: nf1(g.missing[0]!.bar) })}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title={t('fm.takers.title')}>
        <p className="mb-2 text-sm text-brun">{t('fm.takers.help')}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {takers.map((k) => (
            <div key={k.role} className="rounded-lg bg-canard/5 p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-canard/60">{t(`fm.takers.role.${k.role}`)}</p>
              {k.first ? (
                <>
                  <p className="mt-1 flex items-center justify-between gap-2 font-bold">
                    <PlayerLink player={k.first.player} />
                    <span className="tabular-nums">{nf1(k.first.score)}</span>
                  </p>
                  {k.second && (
                    <p className="flex items-center justify-between gap-2 text-xs text-brun">
                      <span>{t('fm.takers.then', { name: k.second.player.name })}</span>
                      <span className="tabular-nums">{nf1(k.second.score)}</span>
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-1 text-sm text-brun">{t('fm.takers.none')}</p>
              )}
            </div>
          ))}
        </div>
      </Panel>

      {alerts.length > 0 && (
        <Panel title={t('fm.depth.watch')}>
          {alerts.map(({ pos, sub, starter }) => (
            <div key={sub.player.id} className="flex items-center justify-between gap-3 border-b border-canard/5 py-1.5 last:border-0">
              <span>
                <PosBadge pos={pos} />{' '}
                {t(sub.when === 0 ? 'fm.depth.already' : 'fm.depth.may', { sub: sub.player.name, starter: starter.name })}
              </span>
              <Tag tone={sub.when === 0 ? 'good' : 'info'}>{sub.when === 0 ? t('fm.depth.now') : t('fm.depth.in', { season: season(sub.when!) })}</Tag>
            </div>
          ))}
        </Panel>
      )}

      <Panel title={t('fm.depth.byPos')}>
        <p className="help">
          {t(fromGame ? 'fm.depth.fromGame' : 'fm.depth.fromTactic')} {t('fm.depth.help', { s1: season(1), s2: season(2) })}
        </p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <div key={r.pos} className="rounded-xl bg-creme/50 px-3 py-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="pill">
                  {POS_LABEL[r.pos]}
                  {r.count > 1 ? ` ×${r.count}` : ''}
                </span>
                {!r.subs.length && <Tag tone="warn">{t('fm.depth.noSub')}</Tag>}
              </div>
              {r.starters.length ? r.starters.map((e) => line(e, <Tag tone="good">{t('fm.depth.starter')}</Tag>)) : <p className="text-xs text-brun">{t('fm.depth.nobody')}</p>}
              {r.subs.map((e) =>
                line(e, e.when === 0 ? <Tag tone="good">{t('fm.depth.level')}</Tag> : e.when ? <Tag tone="info">↑ {season(e.when)}</Tag> : null),
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
