import { academy, buildProject, firstTeamBar, youthTeams, type AcademyAlertKind, type FmPlayer, type YouthStatus } from '@fm-immersion/module-fm';
import { useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReserveContext, useTacticEngine } from './FmTactic';
import { Chips, Empty, Fit, Kpi, Level, More, Panel, PlayerLink, Pos, Tag, useCoach, useFormat, useNames } from './FmUi';

const STATUS_TONE: Record<YouthStatus, 'good' | 'info' | 'warn' | 'bad'> = { promote: 'good', loan: 'warn', develop: 'info', low: 'bad' };
const ALERT_TONE: Record<AcademyAlertKind, 'good' | 'info' | 'warn' | 'bad'> = { promote: 'good', contract: 'warn', ageOut: 'warn', release: 'bad' };

/** Étoiles du staff (sur 5, demi-étoiles) : « ★ 3,5 ». */
function Stars({ value }: { value: number | null | undefined }) {
  const { i18n } = useTranslation();
  if (value == null) return <span className="text-canard/40">–</span>;
  return <span className="whitespace-nowrap tabular-nums">★ {value.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 1 })}</span>;
}

/**
 * Académie : réserve et équipes de jeunes du club (lues par le plugin), en un écran. Bilan par équipe, ce qui demande
 * une décision (espoir au niveau, contrat qui finit, joueur trop âgé pour sa catégorie, place à libérer), les meilleurs
 * espoirs, puis l'effectif de chaque équipe.
 */
export function FmAcademy({ players, folder, gameDate }: { players: FmPlayer[]; folder: string; gameDate: string }) {
  const { t, i18n } = useTranslation();
  const f = useFormat();
  const names = useNames();
  const [coach] = useCoach();
  const { engine } = useTacticEngine(folder, players);
  const reserve = useContext(ReserveContext);
  const list = useMemo(() => reserve.filter((p) => Object.keys(p.attributes).length > 0), [reserve]);
  const project = useMemo(() => (list.length ? buildProject(engine, list, coach) : null), [engine, list, coach]);
  // Repère : niveau des titulaires de l'équipe première dans le même projet de jeu.
  const bar = useMemo(() => {
    const first = buildProject(engine, players.filter((p) => Object.keys(p.attributes).length > 0), coach);
    return first ? firstTeamBar(first.slots) : null;
  }, [engine, players, coach]);
  const teams = useMemo(() => (project ? youthTeams(project.plans, bar ?? project.threshold) : []), [project, bar]);
  const view = useMemo(() => academy(teams, gameDate), [teams, gameDate]);
  const [picked, setPicked] = useState<string | null>(null);
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  if (!reserve.length)
    return (
      <Panel title={t('fm.academy.title')}>
        <Empty>{t('fm.academy.none')}</Empty>
      </Panel>
    );
  if (!teams.length)
    return (
      <Panel title={t('fm.academy.title')}>
        <Empty>{t('fm.academy.noAttributes', { count: reserve.length })}</Empty>
      </Panel>
    );
  const team = teams.find((x) => x.team === picked) ?? teams[0];
  const soon = (end: string | null) => {
    if (!end) return false;
    const d = (new Date(end).getTime() - new Date(gameDate).getTime()) / 86_400_000;
    return d >= 0 && d <= 183;
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {view.teams.map((s) => (
          <Kpi
            key={s.team}
            label={s.team}
            value={t('fm.academy.players', { count: s.size })}
            sub={[
              s.avgAge != null ? t('fm.academy.avgAge', { age: nf1.format(s.avgAge) }) : null,
              ...(['promote', 'loan', 'low'] as const).filter((k) => s.counts[k] > 0).map((k) => t(`fm.train.youth.count.${k}`, { count: s.counts[k] })),
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        ))}
      </div>

      <Panel title={t('fm.academy.todo', { count: view.alerts.length })}>
        {view.alerts.length ? (
          <ul className="space-y-1.5">
            {view.alerts.map((a, i) => (
              <li key={`${a.kind}-${a.player.id}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                <Tag tone={ALERT_TONE[a.kind]}>{t(`fm.academy.alert.${a.kind}`)}</Tag>
                <PlayerLink player={a.player} focus={a.kind === 'contract' || a.kind === 'release' ? 'contract' : undefined} />
                <Pos player={a.player} />
                <span className="text-brun">
                  {t(`fm.academy.alertText.${a.kind}${a.kind === 'release' && a.days != null ? 'Contract' : ''}`, {
                    team: a.team,
                    age: a.player.age,
                    limit: a.limit,
                    date: f.date(a.player.contractEnd),
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('fm.academy.noAlert')}</Empty>
        )}
      </Panel>

      {view.prospects.length > 0 && (
        <Panel title={t('fm.academy.prospects')}>
          <div className="table-scroll">
            <table className="data-table">
              <thead className="text-left text-canard/70">
                <tr>
                  <th className="px-2 py-1">{t('fm.prog.player')}</th>
                  <th className="px-2 py-1">{t('fm.academy.col.team')}</th>
                  <th className="px-2 py-1">{t('fm.train.youth.roleCol')}</th>
                  <th className="px-2 py-1 text-right">{t('fm.academy.col.now')}</th>
                  <th className="px-2 py-1 text-right">{t('fm.academy.col.ceiling')}</th>
                </tr>
              </thead>
              <tbody>
                {view.prospects.map((x) => (
                  <tr key={x.player.id} className="border-t border-canard/5">
                    <td className="px-2 py-1.5">
                      <PlayerLink player={x.player} /> <Pos player={x.player} /> {x.player.age != null && <span className="text-xs text-brun">{t('fm.train.age', { count: x.player.age })}</span>}
                    </td>
                    <td className="px-2 py-1.5">{x.team}</td>
                    <td className="px-2 py-1.5">{x.role ? names.role(x.role) : '–'}</td>
                    <td className="px-2 py-1.5 text-right">
                      <Level value={x.fit} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Level value={x.ceiling} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {team && (
        <Panel title={t('fm.academy.squad')}>
          {teams.length > 1 && (
            <div className="mb-3">
              <Chips value={team.team} options={teams.map((x) => [x.team, `${x.team} (${x.rows.length})`] as [string, string])} onChange={setPicked} />
            </div>
          )}
          <div className="table-scroll">
            <table className="data-table wide">
              <thead className="text-left text-canard/70">
                <tr>
                  <th className="px-2 py-1">{t('fm.prog.player')}</th>
                  <th className="px-2 py-1">{t('fm.academy.col.status')}</th>
                  <th className="px-2 py-1">{t('fm.train.youth.statusCol')}</th>
                  <th className="px-2 py-1">{t('fm.train.youth.roleCol')}</th>
                  <th className="px-2 py-1 text-right">{t('fm.academy.col.stars')}</th>
                  <th className="px-2 py-1 text-right">{t('fm.proj.fit')}</th>
                  <th className="px-2 py-1">{t('fm.academy.col.contract')}</th>
                </tr>
              </thead>
              <tbody>
                {team.rows.map(({ plan: x, status }) => (
                  <tr key={x.player.id} className="border-t border-canard/5">
                    <td className="px-2 py-1.5 font-bold">
                      <PlayerLink player={x.player} /> <Pos player={x.player} />{' '}
                      {x.player.age != null && <span className="text-xs font-normal text-brun">{t('fm.train.age', { count: x.player.age })}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-sm">{x.player.squadStatus ?? '–'}</td>
                    <td className="px-2 py-1.5" title={t(`fm.train.youth.statusHint.${status}`)}>
                      <Tag tone={STATUS_TONE[status]}>{t(`fm.train.youth.status.${status}`)}</Tag>
                    </td>
                    <td className="px-2 py-1.5">{x.role ? names.role(x.role) : '–'}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap" title={t('fm.academy.starsHint')}>
                      <Stars value={x.player.stars?.current} /> <span className="text-brun">→</span> <Stars value={x.player.stars?.potential} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Fit value={x.fit} />
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {f.date(x.player.contractEnd)} {soon(x.player.contractEnd) && <Tag tone="warn">{t('fm.academy.soon')}</Tag>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <More>{t('fm.academy.help')}</More>
        </Panel>
      )}
    </div>
  );
}
