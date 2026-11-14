import { inkOn, officialResults, POS_LABEL, ratingsByPlayer, type FmPlayer, type FmSnapshot, type Line } from '@fm-immersion/module-fm';
import { useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Face } from '../components/Face';
import { clubLook } from '../lib/club-look';
import { PlayerSheetContext } from './FmUi';

/*
 * Effectif professionnel (maquette du joueur, 14/11/2026) : bandeau du vestiaire (maillots du club dessinés, avec les
 * numéros des cadres), filtres par ligne, liste courte (numéro, joueur, poste, forme sur les 5 derniers matchs, dernière
 * note) et fiche du joueur choisi à droite (photo, matchs, buts, note moyenne, dernières notes). Le tableau complet reste
 * à un clic.
 */

const LINES: (Line | 'all')[] = ['all', 'GB', 'DEF', 'MIL', 'ATT'];

/** Couleur d'une note de match : très bon, bon, moyen, faible. */
const tone = (r: number) => (r >= 7.2 ? 'bg-[#8BD346]' : r >= 6.8 ? 'bg-[#5FAF3A]' : r >= 6.4 ? 'bg-ambre' : 'bg-corail');

/** Vestiaire dessiné : casiers en bois, un maillot du club suspendu dans chacun, numéro dessus. */
function Lockers({ numbers, colors }: { numbers: number[]; colors: string[] }) {
  const fill = colors[0] ?? '#B3202A';
  const trim = colors[1] ?? '#FFFFFF';
  const ink = inkOn(fill);
  return (
    <svg viewBox="0 0 640 200" preserveAspectRatio="xMaxYMid slice" className="absolute inset-y-0 right-0 h-full w-[68%]" aria-hidden>
      <defs>
        <linearGradient id="lk-wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3A2618" />
          <stop offset="1" stopColor="#1E140D" />
        </linearGradient>
        <linearGradient id="lk-fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0B1524" />
          <stop offset="0.25" stopColor="#0B1524" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#0B1524" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="lk-light" cx="0.5" cy="0" r="0.8">
          <stop offset="0" stopColor="#FFE9C2" stopOpacity="0.35" />
          <stop offset="1" stopColor="#FFE9C2" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="640" height="200" fill="#121A26" />
      {numbers.slice(0, 5).map((n, i) => {
        const x = 150 + i * 98;
        return (
          <g key={i}>
            <rect x={x} y="8" width="92" height="170" fill="url(#lk-wood)" />
            <rect x={x} y="8" width="92" height="170" fill="url(#lk-light)" />
            <rect x={x + 6} y="14" width="80" height="3" fill="#FFE9C2" opacity="0.5" />
            <path d={`M${x + 46} 30 q0 -6 6 -6`} fill="none" stroke="#9AA3AF" strokeWidth="2" />
            <path d={`M${x + 26} 38 L${x + 66} 38`} stroke="#9AA3AF" strokeWidth="2" />
            <path
              d={`M${x + 28} 40 L${x + 14} 48 L${x + 8} 66 L${x + 18} 70 L${x + 21} 62 L${x + 21} 118 L${x + 71} 118 L${x + 71} 62 L${x + 74} 70 L${x + 84} 66 L${x + 78} 48 L${x + 64} 40 Q${x + 46} 50 ${x + 28} 40 Z`}
              fill={fill}
              stroke={trim}
              strokeWidth="2"
            />
            <text x={x + 46} y="100" textAnchor="middle" fontFamily='"Barlow Condensed", "Arial Narrow", sans-serif' fontWeight="700" fontSize="34" fill={ink}>
              {n}
            </text>
            <rect x={x + 18} y="150" width="56" height="10" rx="3" fill="#E8E4DA" opacity="0.85" />
          </g>
        );
      })}
      <rect x="140" y="178" width="500" height="22" fill="#2A1C12" />
      <rect width="640" height="200" fill="url(#lk-fade)" />
    </svg>
  );
}

export function SquadBoard({ players, snap, history, club, onTable, onCompare }: { players: FmPlayer[]; snap: FmSnapshot; history: { gameDate: string; data: FmSnapshot }[]; club: string; onTable: () => void; onCompare: () => void }) {
  const { t, i18n } = useTranslation();
  const openSheet = useContext(PlayerSheetContext);
  const [line, setLine] = useState<Line | 'all'>('all');
  const numbers = useMemo(
    () =>
      new Map(
        ((Array.isArray(snap.players) ? snap.players : []) as { id?: unknown; squadNumber?: unknown }[]).flatMap((r) =>
          typeof r.squadNumber === 'number' && r.squadNumber >= 0 ? [[String(r.id), r.squadNumber] as const] : [],
        ),
      ),
    [snap],
  );
  // Notes des matchs officiels retrouvés, du plus ancien au plus récent (titularisations).
  const ratings = useMemo(() => ratingsByPlayer(officialResults(history)), [history]);
  // Ordre du jeu : gardiens, défenseurs, milieux, attaquants, puis le numéro.
  const order: Record<string, number> = { GB: 0, DEF: 1, MIL: 2, ATT: 3 };
  const list = useMemo(
    () =>
      players
        .filter((p) => line === 'all' || p.line === line)
        .sort((a, b) => (order[a.line ?? ''] ?? 9) - (order[b.line ?? ''] ?? 9) || (numbers.get(a.id) ?? 999) - (numbers.get(b.id) ?? 999)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, line, numbers],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const sel = list.find((p) => p.id === picked) ?? list[0] ?? null;
  const look = clubLook(club);
  const nf2 = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Maillots du vestiaire : les numéros des joueurs les mieux notés.
  const lockerNumbers = [...players]
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
    .flatMap((p) => (numbers.has(p.id) ? [numbers.get(p.id)!] : []))
    .slice(0, 5);
  const last = (p: FmPlayer) => (ratings.get(p.id) ?? []).slice(-5);
  const selLast = sel ? last(sel) : [];
  const money = new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
  const nf1 = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: 'short', year: 'numeric' });
  // Fiche courte : niveau vu par le staff, état physique, moral, statut, contrat et argent ; « – » quand le jeu ne le donne pas.
  const details = (p: FmPlayer): [string, string, boolean][] => [
    ['level', p.stars?.current != null ? `${nf1.format(p.stars.current)} / ${p.stars.potential != null ? nf1.format(p.stars.potential) : '–'} ★` : '–', false],
    ['condition', p.condition != null ? `${Math.round(p.condition)} %` : '–', p.condition != null && p.condition < 85],
    ['sharpness', p.sharpness != null ? `${Math.round(p.sharpness)} %` : '–', p.sharpness != null && p.sharpness < 70],
    ['morale', p.morale ?? '–', false],
    ['goalsPerMatch', p.apps ? nf2.format((p.goals ?? 0) / p.apps) : '–', false],
    ['status', p.squadStatus ?? '–', false],
    ['contract', p.contractEnd ? date.format(new Date(p.contractEnd)) : '–', false],
    ['value', p.value ? money.format(p.value) : '–', false],
    ['wage', p.wage ? money.format(p.wage) : '–', false],
    ['foot', p.foot ?? '–', false],
    ['hierarchy', p.hierarchy ?? '–', false],
    ['personality', p.personality ?? '–', false],
  ];

  return (
    <section className="overflow-hidden rounded-2xl bg-canard text-white shadow-lg">
      <div className="relative h-44 overflow-hidden border-b border-white/10">
        <Lockers numbers={lockerNumbers.length ? lockerNumbers : [1, 9, 10, 4, 7]} colors={look?.colors ?? []} />
        <div className="relative flex h-full flex-col justify-center px-8">
          <span className="mb-3 block h-1 w-8 bg-orange" aria-hidden />
          <h2 className="font-cond text-5xl font-bold normal-case leading-none tracking-normal text-white">{t('fm.squadBoard.title')}</h2>
          <p className="mt-2 font-cond text-xl text-white/80">{t('fm.squadBoard.count', { count: players.length })}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-1 border-b border-white/10 px-6">
        {LINES.map((l, i) => (
          <span key={l} className="flex items-center">
            {i > 0 && <span className="mx-2 h-5 w-px bg-white/25" aria-hidden />}
            <button
              type="button"
              onClick={() => setLine(l)}
              aria-pressed={line === l}
              className={`relative px-3 py-3 font-cond text-xl font-semibold ${line === l ? 'text-white' : 'text-white/65 hover:text-white'}`}
            >
              {t(`fm.squadBoard.line.${l}`)}
              {line === l && <span className="absolute inset-x-2 bottom-0 h-[3px] bg-orange" aria-hidden />}
            </button>
          </span>
        ))}
        <button type="button" onClick={onTable} className="ml-auto rounded-md px-3 py-1.5 text-sm font-bold text-orange hover:bg-white/10">
          {t('fm.squadBoard.table')} →
        </button>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,1fr)]">
        <div className="min-w-0 overflow-x-auto p-5 lg:border-r lg:border-white/10">
          <table className="w-full">
            <thead>
              <tr className="bg-white/[0.06] text-left font-cond text-lg font-semibold text-white/85">
                <th className="w-14 py-2 pl-3 text-center">{t('fm.squadBoard.col.num')}</th>
                <th className="py-2">{t('fm.squadBoard.col.player')}</th>
                <th className="py-2 text-center">{t('fm.squadBoard.col.pos')}</th>
                <th className="py-2 text-center">{t('fm.squadBoard.col.age')}</th>
                <th className="py-2 text-center">{t('fm.squadBoard.col.apps')}</th>
                <th className="py-2 text-center">{t('fm.squadBoard.col.goals')}</th>
                <th className="py-2 text-center">{t('fm.squadBoard.col.avg')}</th>
                <th className="py-2 text-center">{t('fm.squadBoard.col.condition')}</th>
                <th className="py-2">{t('fm.squadBoard.col.form')}</th>
                <th className="py-2 pr-3 text-right">{t('fm.squadBoard.col.last')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, i) => {
                const l5 = last(p);
                const lastRating = l5.at(-1) ?? null;
                const on = sel?.id === p.id;
                return (
                  <tr
                    key={p.id}
                    onClick={() => setPicked(p.id)}
                    className={`cursor-pointer border-l-4 ${on ? 'border-orange bg-white/[0.12]' : `border-transparent ${i % 2 ? 'bg-white/[0.03]' : ''} hover:bg-white/[0.08]`}`}
                  >
                    <td className="py-2 text-center font-cond text-2xl font-semibold tabular-nums">{numbers.get(p.id) ?? '–'}</td>
                    <td className="py-2 font-cond text-2xl font-semibold">
                      {p.name}
                      {p.injury && <span className="ml-2 align-middle text-sm font-bold text-corail" title={p.injury}>✚</span>}
                    </td>
                    <td className="py-2 text-center font-cond text-xl text-white/85">{p.positions[0] ? POS_LABEL[p.positions[0]] : '–'}</td>
                    <td className="py-2 text-center font-cond text-xl tabular-nums text-white/85">{p.age ?? '–'}</td>
                    <td className="py-2 text-center font-cond text-xl tabular-nums">{p.apps ?? '–'}</td>
                    <td className="py-2 text-center font-cond text-xl tabular-nums">{p.goals ?? '–'}</td>
                    <td className="py-2 text-center font-cond text-xl tabular-nums">{p.avgRating ? nf2.format(p.avgRating) : '–'}</td>
                    <td className={`py-2 text-center font-cond text-xl tabular-nums ${p.condition != null && p.condition < 85 ? 'font-bold text-corail' : ''}`}>{p.condition != null ? `${Math.round(p.condition)} %` : '–'}</td>
                    <td className="py-2 pr-2">
                      <span className="flex gap-1" title={l5.map((r) => nf2.format(r)).join(' · ')}>
                        {Array.from({ length: 5 }, (_, k) => {
                          const r = l5[l5.length - 5 + k];
                          return <span key={k} className={`h-4 w-5 rounded-[2px] ${r == null ? 'bg-white/15' : tone(r)}`} />;
                        })}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right font-cond text-2xl tabular-nums">{lastRating != null ? nf2.format(lastRating) : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {sel && (
          <aside className="min-w-0 p-6">
            <h3 className="border-l-4 border-orange pl-3 font-cond text-4xl font-bold normal-case leading-none tracking-normal text-white">{sel.name}</h3>
            <p className="mt-1 pl-4 font-cond text-xl text-white/80">
              {[sel.positionsLabel || (sel.positions[0] ? POS_LABEL[sel.positions[0]] : null), sel.age != null ? t('fm.squadBoard.age', { count: sel.age }) : null].filter(Boolean).join(' · ')}
            </p>
            <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-5">
              <button type="button" onClick={() => openSheet?.(sel.id)} className="overflow-hidden rounded-md bg-white/5 ring-1 ring-white/10" title={t('fm.squadBoard.sheet')}>
                <Face id={sel.id} name={sel.name} size={150} className="!rounded-none" />
              </button>
              <div className="min-w-0">
                <div className="grid grid-cols-3 divide-x divide-white/20 border-b border-white/15 pb-3 text-center">
                  {[
                    [sel.apps ?? 0, t('fm.squadBoard.apps')],
                    [sel.goals ?? 0, t('fm.squadBoard.goals')],
                    [sel.avgRating ? nf2.format(sel.avgRating) : '–', t('fm.squadBoard.avg')],
                  ].map(([v, l]) => (
                    <div key={String(l)}>
                      <p className="font-cond text-4xl font-bold leading-none">{v}</p>
                      <p className="font-cond text-lg text-white/75">{l}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 font-cond text-xl font-semibold">{t('fm.squadBoard.lastRatings')}</p>
                {selLast.length ? (
                  <div className="mt-2 flex h-28 items-end gap-2">
                    {selLast.map((r, k) => (
                      <div key={k} className="flex flex-1 flex-col items-center justify-end">
                        <span className="mb-0.5 font-cond text-sm">{nf2.format(r)}</span>
                        <span className={`w-full rounded-t-sm ${tone(r)}`} style={{ height: `${Math.max(8, ((Math.min(9, r) - 5) / 4) * 80)}px` }} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-white/60">{t('fm.squadBoard.noRatings')}</p>
                )}
              </div>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-white/10 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
              {details(sel).map(([k, v, warn]) => (
                <div key={k} className="bg-canard px-3 py-2">
                  <dt className="truncate text-xs font-bold uppercase tracking-wide text-white/60">{t(`fm.squadBoard.stat.${k}`)}</dt>
                  <dd className={`break-words font-cond text-xl font-semibold leading-tight ${warn ? 'text-corail' : 'text-white'}`} title={String(v)}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            {(sel.injury || sel.suspension) && <p className="mt-3 rounded-md bg-corail/20 px-3 py-2 text-sm font-semibold text-white">✚ {sel.injury ?? sel.suspension}</p>}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => openSheet?.(sel.id)} className="rounded-lg border-2 border-orange py-2 font-cond text-xl font-bold text-white hover:bg-orange/10">
                {t('fm.squadBoard.sheet')}
              </button>
              <button type="button" onClick={onCompare} className="flex items-center justify-center gap-2 rounded-lg border-2 border-orange py-2 font-cond text-xl font-bold text-white hover:bg-orange/10">
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-orange" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3v18M5 21h14M6 7h12M6 7l-3 7a3 3 0 006 0zM18 7l-3 7a3 3 0 006 0z" />
                </svg>
                {t('fm.squadBoard.compare')}
              </button>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
