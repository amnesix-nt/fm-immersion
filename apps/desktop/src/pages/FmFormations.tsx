import { knownFormation, POS_LABEL, rankFormations, type FmPlayer, type FormationRow } from '@fm-immersion/module-fm';
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTacticChoice } from './FmTactic';
import { Empty, Fit, More, Panel, PlayerLink, Tag, useNames } from './FmUi';

/*
 * Schémas selon l'effectif : chaque schéma connu de l'appli, classé d'après le meilleur onze que l'effectif peut y
 * aligner (tous styles confondus), avec la note de chaque ligne et le poste le plus faible. Même calcul que la
 * Composition : le joueur peut ouvrir un schéma dans Composition pour le voir en détail.
 */

/** Lignes du onze dépliées, dans l'ordre du terrain. */
const ROW_ORDER = ['GB', 'DLG', 'DG', 'DC', 'DD', 'DLD', 'MDF', 'MG', 'MC', 'MD', 'MOG', 'MOC', 'MOD', 'BT'] as const;

export function FmFormations({ players, folder, gameFormation, go }: { players: FmPlayer[]; folder: string; gameFormation: string | null; go?: (v: string) => void }) {
  const { t } = useTranslation();
  const names = useNames();
  const { ranked, update, form: current, fromGame, built } = useTacticChoice(players, folder, gameFormation);
  const rows = useMemo(() => rankFormations(ranked), [ranked]);
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <Empty>{t('fm.tac.noAttributes')}</Empty>;
  const played = knownFormation(gameFormation);
  const shown = !fromGame && !built ? current : null;
  const top = rows[0]!.score;
  const playedRow = played ? rows.find((r) => r.form === played) : null;
  const playedRank = playedRow ? rows.indexOf(playedRow) + 1 : 0;
  const tryIt = (r: FormationRow) => {
    update({ source: 'simloom', style: r.style.id, form: r.form, built: undefined });
    go?.('tactic');
  };
  const weakLabel = (r: FormationRow) => {
    const w = r.weakest;
    if (!w) return '–';
    return w.player ? (
      <>
        {POS_LABEL[w.pos]} · <PlayerLink player={w.player} face={false} className="font-semibold" /> <Fit value={w.fit} />
      </>
    ) : (
      <>
        {POS_LABEL[w.pos]} · <Tag tone="bad">{t('fm.formations.nobody')}</Tag>
      </>
    );
  };

  return (
    <div className="space-y-4">
      <Panel title={t('fm.formations.title')}>
        <p className="text-sm">
          {t('fm.formations.intro', { form: rows[0]!.form, style: names.style(rows[0]!.style) })}
          {playedRow && ` ${playedRank === 1 ? t('fm.formations.playedBest', { form: played }) : t('fm.formations.played', { form: played, rank: playedRank, gap: (top - playedRow.score).toLocaleString(undefined, { maximumFractionDigits: 1 }) })}`}
        </p>
        <More>{t('fm.formations.how')}</More>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-brun">
                <th className="py-1 pr-2 font-normal">#</th>
                <th className="pr-2 font-normal">{t('fm.formations.col.form')}</th>
                <th className="pr-2 font-normal">{t('fm.formations.col.style')}</th>
                <th className="pr-2 text-right font-normal" title={t('fm.formations.col.scoreHelp')}>
                  {t('fm.formations.col.score')}
                </th>
                <th className="pr-2 text-right font-normal">{t('fm.formations.col.def')}</th>
                <th className="pr-2 text-right font-normal">{t('fm.formations.col.mid')}</th>
                <th className="pr-2 text-right font-normal">{t('fm.formations.col.att')}</th>
                <th className="pr-2 font-normal">{t('fm.formations.col.weak')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isOpen = open === r.form;
                const slots = r.plan.slots
                  .map((s, k) => ({ s, k }))
                  .sort((a, b) => ROW_ORDER.indexOf(a.s.pos) - ROW_ORDER.indexOf(b.s.pos) || a.s.x - b.s.x);
                return (
                  <Fragment key={r.form}>
                    <tr className={`border-t border-canard/10 ${i === 0 ? 'bg-orange-clair/40' : ''}`}>
                      <td className="py-1.5 pr-2 text-brun">{i + 1}</td>
                      <td className="pr-2">
                        <span className="font-bold">{r.form}</span>{' '}
                        {r.form === played && <Tag tone="info">{t('fm.formations.inGame')}</Tag>}{' '}
                        {r.form === shown && <Tag tone="good">{t('fm.formations.chosen')}</Tag>}
                      </td>
                      <td className="pr-2">{names.style(r.style)}</td>
                      <td className="pr-2 text-right">
                        <Fit value={r.score} />
                      </td>
                      <td className="pr-2 text-right">
                        <Fit value={r.lines.def} />
                      </td>
                      <td className="pr-2 text-right">
                        <Fit value={r.lines.mid} />
                      </td>
                      <td className="pr-2 text-right">
                        <Fit value={r.lines.att} />
                      </td>
                      <td className="pr-2">
                        {weakLabel(r)}
                        {r.holes > 1 && <span className="ml-1 text-xs text-corail">{t('fm.formations.holes', { count: r.holes })}</span>}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <button type="button" className="chip ml-1 text-xs" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.form)}>
                          {t(isOpen ? 'fm.formations.hideXi' : 'fm.formations.showXi')}
                        </button>
                        {go && (
                          <button type="button" className="chip ml-1 text-xs" onClick={() => tryIt(r)}>
                            {t('fm.formations.open')}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={8} className="pb-3">
                          <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                            {slots.map(({ s, k }) => (
                              <li key={k} className="flex items-center justify-between gap-2">
                                <span className="truncate">
                                  <span className="mr-1 inline-block w-14 text-xs text-brun">{POS_LABEL[s.pos]}</span>
                                  {s.player ? <PlayerLink player={s.player} /> : <span className="text-corail">{t('fm.formations.nobody')}</span>}
                                </span>
                                <Fit value={s.player ? s.fit : null} />
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
