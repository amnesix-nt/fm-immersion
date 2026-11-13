import { lineOf, POS_LABEL, slotFit, unavailable, type FmPlayer, type GameSlot, type PosCode } from '@fm-immersion/module-fm';
import { useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, LINE_COLOR, Pitch, POS_XY } from './FmFoot';
import { useTacticChoice } from './FmTactic';
import { PlayerSheetContext } from './FmUi';

interface Placed {
  player: FmPlayer;
  /** Note sur 20 dans les rôles du poste (comme en Tactique), ou niveau général hors schéma. */
  fit: number | null;
  starter: boolean;
}

/**
 * Effectif vu comme un tableau de vestiaire, sur le schéma de la tactique (la même qu'en Tactique : celle de FM27 d'abord) :
 * les titulaires à leur poste, puis chaque autre joueur au poste du schéma où il est le mieux noté parmi ceux qu'il sait
 * tenir. Ceux qui ne tiennent aucun poste du schéma sont listés à part. On voit d'un coup d'œil les postes bien garnis
 * et ceux où il manque du monde.
 */
export function FmSquadPitch({ players, folder, gameFormation, lineup, gameTactic }: { players: FmPlayer[]; folder: string; gameFormation: string | null; lineup: GameSlot[] | null; gameTactic: string | null }) {
  const { t, i18n } = useTranslation();
  const open = useContext(PlayerSheetContext);
  const { engine, plan, form, fromGame, built } = useTacticChoice(players, folder, gameFormation, lineup, gameTactic);
  const nf = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const { byPos, counts, outside } = useMemo(() => {
    const byPos = new Map<PosCode, Placed[]>();
    const counts = new Map<PosCode, number>();
    const outside: FmPlayer[] = [];
    if (!plan) return { byPos, counts, outside };
    const add = (pos: PosCode, x: Placed) => byPos.set(pos, [...(byPos.get(pos) ?? []), x]);
    const xi = new Set<string>();
    plan.slots.forEach((sl) => {
      counts.set(sl.pos, (counts.get(sl.pos) ?? 0) + 1);
      if (!byPos.has(sl.pos)) byPos.set(sl.pos, []);
      if (!sl.player) return;
      xi.add(sl.player.id);
      add(sl.pos, { player: sl.player, fit: slotFit(engine, sl.player, sl), starter: true });
    });
    for (const p of players) {
      if (xi.has(p.id)) continue;
      let best: { pos: PosCode; fit: number } | null = null;
      for (const sl of plan.slots) {
        if (!engine.canPlay(p, sl.pos)) continue;
        const f = slotFit(engine, p, sl);
        if (f != null && (!best || f > best.fit)) best = { pos: sl.pos, fit: f };
      }
      if (best) add(best.pos, { player: p, fit: best.fit, starter: false });
      else outside.push(p);
    }
    for (const list of byPos.values()) list.sort((a, b) => Number(b.starter) - Number(a.starter) || (b.fit ?? 0) - (a.fit ?? 0));
    outside.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
    return { byPos, counts, outside };
  }, [engine, plan, players]);

  if (!plan) return <p className="card text-brun">{t('fm.tac.noAttributes')}</p>;
  const thin = [...byPos].filter(([pos, list]) => list.filter((x) => !unavailable(x.player)).length <= (counts.get(pos) ?? 1)).map(([pos]) => pos);
  const source = built ? 'built' : fromGame ? 'game' : 'suggested';

  return (
    <div className="space-y-2">
      <Pitch horizontal className="w-full">
        {[...byPos].map(([pos, list]) => {
          const [x, y] = POS_XY[pos];
          const c = LINE_COLOR[lineOf(pos)];
          const n = counts.get(pos) ?? 1;
          return (
            <div
              key={pos}
              className="absolute w-32 -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${Math.min(91, Math.max(8, 100 - y))}%`,
                top: `${Math.min(84, Math.max(16, x))}%`,
              }}
            >
              <p className="mb-0.5 text-center">
                <span className={`rounded px-1.5 text-[0.65rem] font-bold ${c.bg} ${c.text}`}>
                  {POS_LABEL[pos]}
                  {n > 1 ? ` ×${n}` : ''} · {list.length}
                </span>
              </p>
              <ul className="space-y-0.5">
                {list.slice(0, 5).map(({ player: p, fit, starter }) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => open?.(p.id)}
                      className={`flex w-full items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-left text-xs shadow-sm ${starter ? 'bg-white ring-2 ring-orange' : 'bg-white/80 hover:bg-white'} ${p.injury || p.suspension ? 'opacity-60' : ''}`}
                      title={[p.name, starter ? t('fm.squadPitch.starter') : null, p.injury, p.suspension].filter(Boolean).join(' · ')}
                    >
                      <Avatar player={p} size="xs" />
                      <span className="min-w-0 flex-1 truncate font-bold text-canard">{p.name.split(/\s+/).at(-1)}</span>
                      {(p.injury || p.suspension) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-corail" aria-hidden />}
                      <span className="tabular-nums text-brun">{fit == null ? '–' : nf.format(fit)}</span>
                    </button>
                  </li>
                ))}
                {list.length > 5 && <li className="text-center text-[0.65rem] font-bold text-white">+{list.length - 5}</li>}
              </ul>
            </div>
          );
        })}
      </Pitch>
      <p className="text-xs text-brun">
        {t(`fm.squadPitch.from.${source}`, { form, tactic: gameTactic ?? '' })} {t('fm.squadPitch.help')}
        {thin.length > 0 && (
          <b className="text-canard">
            {' '}
            {t('fm.squadPitch.thin', { list: thin.map((p) => POS_LABEL[p]).join(', ') })}
          </b>
        )}
      </p>
      {outside.length > 0 && (
        <p className="text-xs text-brun">
          <b className="text-canard">{t('fm.squadPitch.outside')}</b>{' '}
          {outside.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <button type="button" className="underline decoration-dotted" onClick={() => open?.(p.id)}>
                {p.name}
              </button>{' '}
              {p.positionsLabel ? `(${p.positionsLabel})` : null}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
