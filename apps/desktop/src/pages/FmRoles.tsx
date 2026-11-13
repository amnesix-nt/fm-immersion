import { POS_LABEL, POS_ORDER, roleMatrix, type FmPlayer, type Line, type Phase } from '@fm-immersion/module-fm';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PosBadge } from './FmFoot';
import { useTacticEngine } from './FmTactic';
import { Chips, Empty, Fit, fitPct, More, Panel, PlayerLink, Tag, useNames } from './FmUi';

const OPTS_KEY = 'fmi.matrix';
interface Opts {
  phase: Phase;
  line: Line | 'all';
  nat: boolean;
}
const readOpts = (): Opts => {
  try {
    return { phase: 'ip', line: 'all', nat: false, ...(JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') as Partial<Opts>) };
  } catch {
    return { phase: 'ip', line: 'all', nat: false };
  }
};

/** Postes et rôles : adéquation de chaque joueur au meilleur rôle de chaque poste. */
export function FmRoles({ players, folder }: { players: FmPlayer[]; folder: string }) {
  const { t } = useTranslation();
  const names = useNames();
  const { engine } = useTacticEngine(folder, players);
  const [opts, setOpts] = useState<Opts>(readOpts);
  const update = (p: Partial<Opts>) => {
    const next = { ...opts, ...p };
    setOpts(next);
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(next));
    } catch {
      /* stockage indisponible : les choix ne sont pas retenus */
    }
  };
  const list = useMemo(
    () =>
      players
        .filter((p) => Object.keys(p.attributes).length && (opts.line === 'all' || p.line === opts.line))
        .sort((a, b) => POS_ORDER.indexOf(a.positions[0] ?? 'BT') - POS_ORDER.indexOf(b.positions[0] ?? 'BT') || (b.level ?? 0) - (a.level ?? 0)),
    [players, opts.line],
  );
  const { rows, colBest } = useMemo(() => roleMatrix(engine, list, opts.phase), [engine, list, opts.phase]);
  if (!players.some((p) => Object.keys(p.attributes).length)) return <Empty>{t('fm.tac.noAttributes')}</Empty>;

  return (
    <div className="space-y-4">
      <Panel title={t('fm.roles.gridTitle')}>
        <More>{t('fm.roles.help', { phase: t(`fm.tac.phase.${opts.phase}`).toLowerCase() })}</More>
        <div className="mb-3 flex flex-wrap items-center gap-4">
          <Chips
            value={opts.phase}
            options={[
              ['ip', t('fm.tac.phase.ip')],
              ['oop', t('fm.tac.phase.oop')],
            ]}
            onChange={(phase) => update({ phase })}
          />
          <Chips
            value={opts.line}
            options={(['all', 'GB', 'DEF', 'MIL', 'ATT'] as const).map((l) => [l, t(`fm.line.${l}`)])}
            onChange={(line) => update({ line })}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={opts.nat} onChange={(e) => update({ nat: e.target.checked })} /> {t('fm.roles.natOnly')}
          </label>
        </div>
        <div className="table-scroll">
          <table className="data-table wide text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white px-2 py-1 text-left text-sm">{t('fm.prog.player')}</th>
                {POS_ORDER.map((pos) => (
                  <th key={pos} className="px-1 py-1">
                    <PosBadge pos={pos} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ player: p, cells }) => {
                const gk = p.positions.includes('GB');
                return (
                  <tr key={p.id} className="border-t border-canard/5">
                    <td className="sticky left-0 whitespace-nowrap bg-white px-2 py-1 text-sm font-bold">
                      <PlayerLink player={p} /> <span className="text-xs font-normal text-brun">{p.age}</span>
                    </td>
                    {cells.map((c, i) => {
                      // Poste que le joueur ne sait pas jouer du tout : un point, pas « 0,0 ★ ».
                      const none = !!c && !c.natural && Number.parseFloat(fitPct(c.fit).replace(',', '.')) === 0;
                      if (!c || none || (!c.natural && (opts.nat || gk !== (c.pos === 'GB'))))
                        return (
                          <td key={i} className="px-1 py-1 text-center text-canard/25">
                            ·
                          </td>
                        );
                      const tip = `${POS_LABEL[c.pos]} · ${names.role(c.role)}${c.natural ? '' : ` (${t('fm.roles.off')})`}${c.tryIt ? ` · ${t('fm.roles.try')}` : ''}`;
                      return (
                        <td key={i} className="px-1 py-1 text-center" title={tip}>
                          {c.natural ? (
                            <Fit value={c.fit} />
                          ) : (
                            <span className={`tabular-nums ${c.tryIt ? 'rounded-full px-1.5 py-0.5 font-bold text-canard ring-1 ring-dashed ring-eau-fonce' : 'text-canard/50'}`}>{fitPct(c.fit)}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-canard/10">
                <td className="sticky left-0 bg-white px-2 py-1 text-brun">{t('fm.roles.bestNat')}</td>
                {colBest.map((m, i) => (
                  <td key={i} className="px-1 py-1 text-center">
                    {m ? <span className="font-bold">{m.player.name.split(' ').at(-1)}</span> : <Tag tone="bad">{t('fm.roles.nobody')}</Tag>}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>

      <Panel title={t('fm.roles.howTitle')}>
        <ul className="space-y-1 text-sm">
          {(['keys', 'base', 'engine', 'foot', 'staff'] as const).map((k) => (
            <li key={k}>{t(`fm.roles.how.${k}`)}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
