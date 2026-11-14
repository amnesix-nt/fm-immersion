import { inkOn, type FormationPlan, type Phase, type SnapshotFixture, type TacticEngine, type TodoItem } from '@fm-immersion/module-fm';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Crest } from '../components/Crest';
import { Stadium } from '../components/PageHero';
import { clubLook } from '../lib/club-look';
import { useTodoDone, useTodoLines } from './FmTacticAdvice';

/*
 * Préparation du match (maquette du joueur, 14/11/2026) : un écran de « bureau » sombre en tête de Tactique.
 * Bandeau du match (écussons du pack de logos du joueur, stade dessiné), terrain avec les maillots aux couleurs du
 * club et leurs numéros, brief de l'adjoint (ce qu'il faut régler dans FM27, à cocher), puis les prochains matchs.
 */

export interface PrepNext {
  opponent: string;
  home: boolean | null;
  inDays: number | null;
  competition: string | null;
}

/** Nombre de points du brief montrés d'emblée. */
const BRIEF_SHOWN = 3;

/** Titre de bloc : barre ambre et police condensée, comme la maquette. */
function BlockTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="border-l-4 border-orange pl-3 font-cond text-3xl font-bold normal-case leading-none tracking-normal text-white">{children}</h2>
      {aside}
    </div>
  );
}

/** Maillot vu de face, aux couleurs du club, numéro dessus. */
function Shirt({ fill, trim, num }: { fill: string; trim: string; num: number | null }) {
  return (
    <svg viewBox="0 0 64 56" className="h-11 w-12 drop-shadow-[0_3px_3px_rgba(0,0,0,0.45)]" aria-hidden>
      <path d="M20 3 L8 8 L1 22 L11 27 L14 21 L14 53 L50 53 L50 21 L53 27 L63 22 L56 8 L44 3 Q32 12 20 3 Z" fill={fill} stroke={trim} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M20 3 Q32 12 44 3" fill="none" stroke={trim} strokeWidth="3" />
      {num != null && (
        <text x="32" y="42" textAnchor="middle" fontFamily='"Barlow Condensed", "Arial Narrow", sans-serif' fontWeight="700" fontSize="24" fill={inkOn(fill)}>
          {num}
        </text>
      )}
    </svg>
  );
}

/** Icône d'un point du brief selon ce qu'il demande de changer. */
function KindIcon({ kind }: { kind: TodoItem['kind'] }) {
  const common = { fill: 'none', stroke: '#FFB547', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9 shrink-0" aria-hidden>
      {kind === 'starter' && (
        <g {...common}>
          <path d="M6 11 H22 M18 7 L22 11 L18 15" />
          <path d="M26 21 H10 M14 17 L10 21 L14 25" />
        </g>
      )}
      {kind === 'role' && (
        <g {...common}>
          <circle cx="16" cy="9" r="4" />
          <path d="M8 27 Q8 17 16 17 Q24 17 24 27" />
          <path d="M23 6 L27 2 M27 6 L23 2" />
        </g>
      )}
      {kind === 'team' && (
        <g {...common}>
          <rect x="5" y="5" width="22" height="22" rx="2" />
          <path d="M16 5 V27 M5 16 H27" />
          <path d="M20 8 L26 14 M20 14 L26 8" strokeWidth="1.5" />
        </g>
      )}
      {(kind === 'piChange' || kind === 'piAdd' || kind === 'piRemove') && (
        <g {...common}>
          <circle cx="18" cy="6" r="3" />
          <path d="M8 16 L14 11 L20 13 L24 18 M14 11 L12 20 L17 24 L15 30 M12 20 L6 26" />
          <path d="M25 24 H30 M28 22 L30 24 L28 26" />
        </g>
      )}
    </svg>
  );
}

/** Le terrain en perspective : plus étroit vers le but adverse, les joueurs restent droits. */
function PrepPitch({ plan, positions, numbers, swapAt, colors }: { plan: FormationPlan; positions: [number, number][]; numbers: Map<string, number>; swapAt: Map<number, string>; colors: string[] }) {
  const { t } = useTranslation();
  // Largeur relative du terrain à la hauteur y (0 = but adverse, 100 = notre but).
  const w = (y: number) => 0.8 + 0.2 * (y / 100);
  const X = (x: number, y: number) => 50 + (x - 50) * w(y);
  const field = colors[0] ?? '#C8102E';
  const trim = colors[1] ?? '#FFFFFF';
  const keeper = colors[2] && colors[2] !== field ? colors[2] : '#1F6FD1';
  const short = (name: string) => {
    const parts = name.trim().split(/\s+/);
    return (parts.length > 1 ? parts.slice(1).join(' ') : parts[0] ?? '').toLocaleUpperCase();
  };
  return (
    <div className="relative mx-auto aspect-[3/2] w-full max-w-3xl">
      <svg viewBox="0 0 100 66.7" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <pattern id="prep-stripes" width="100" height="13.3" patternUnits="userSpaceOnUse">
            <rect width="100" height="6.65" fill="#2E7D3A" />
            <rect y="6.65" width="100" height="6.65" fill="#286F33" />
          </pattern>
        </defs>
        <path d="M10 1 L90 1 L100 65.7 L0 65.7 Z" fill="url(#prep-stripes)" />
        <g fill="none" stroke="#FFFFFF" strokeOpacity="0.75" strokeWidth="0.35">
          <path d="M10 1 L90 1 L100 65.7 L0 65.7 Z" />
          <path d="M5 33.35 L95 33.35" />
          <ellipse cx="50" cy="33.35" rx="9" ry="5" />
          <path d="M33 1 L33.5 10 L66.5 10 L67 1" />
          <path d="M41 1 L41.2 4 L58.8 4 L59 1" />
          <path d="M28 65.7 L28.7 54 L71.3 54 L72 65.7" />
          <path d="M39 65.7 L39.3 60.5 L60.7 60.5 L61 65.7" />
        </g>
      </svg>
      {plan.slots.map((sl, i) => {
        const [x, y] = positions[i] ?? [sl.x, sl.y];
        const p = sl.player;
        const swap = swapAt.get(i);
        const gk = sl.pos === 'GB';
        return (
          <div key={i} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center" style={{ left: `${X(x, y)}%`, top: `${y}%` }} title={p?.name}>
            <Shirt fill={gk ? keeper : field} trim={gk ? '#FFFFFF' : trim} num={p ? (numbers.get(p.id) ?? null) : null} />
            <span className="-mt-1 max-w-[8rem] truncate rounded-sm bg-canard/90 px-2 py-0.5 font-cond text-sm font-semibold tracking-wide text-white">
              {p ? short(p.name) : t('fm.tac.nobody')}
            </span>
            {swap && <span className="mt-0.5 rounded-sm bg-orange px-1.5 font-cond text-xs font-bold text-canard">→ {short(swap)}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function MatchPrep({
  club,
  next,
  fixtures,
  form,
  plan,
  positions,
  numbers,
  swapAt,
  items,
  engine,
  phase,
  onPhase,
  shape,
  team,
  onTeam,
  side,
  xi,
  bench,
}: {
  club: string;
  next: PrepNext | null;
  fixtures: SnapshotFixture[];
  form: string;
  plan: FormationPlan;
  positions: [number, number][];
  numbers: Map<string, number>;
  swapAt: Map<number, string>;
  /** Points du brief (onze lu dans FM27) ; `null` : le brief est remplacé par `side`. */
  items: TodoItem[] | null;
  engine: TacticEngine;
  phase: Phase;
  onPhase: (p: Phase) => void;
  shape: (p: Phase) => string;
  team: 'A' | 'B';
  onTeam: (t: 'A' | 'B') => void;
  side?: ReactNode;
  /** Le onze poste par poste (rôles et notes) et les remplaçants, intégrés au tableau sombre. */
  xi?: ReactNode;
  bench?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [all, setAll] = useState(false);
  const [done, toggle] = useTodoDone();
  const written = useTodoLines(items ?? [], plan, engine);
  const lines = items ? written : null;
  const look = clubLook(club);
  const home = next?.home !== false;
  const [a, b] = next ? (home ? [club, next.opponent] : [next.opponent, club]) : [club, ''];
  const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(i18n.resolvedLanguage, { weekday: 'short', day: 'numeric', month: 'short' });
  const open = (lines ?? []).filter((l) => !done.includes(l.what));
  const ordered = [...open, ...(lines ?? []).filter((l) => done.includes(l.what))];
  const shown = all ? ordered : ordered.slice(0, BRIEF_SHOWN);
  return (
    <section className="overflow-hidden rounded-2xl bg-canard text-white shadow-lg">
      {/* Bandeau du match */}
      <div className="relative min-h-[9.5rem] overflow-hidden border-b border-white/10">
        <Stadium className="absolute inset-y-0 right-0 h-full w-[70%]" />
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6">
          {next ? (
            <>
              <Crest club={a} size={56} />
              <div className="min-w-0">
                <span className="mb-2 block h-1 w-8 bg-orange" aria-hidden />
                <p className="font-cond text-5xl font-bold leading-none">
                  {a} <span className="text-orange">–</span> {b}
                </p>
                <p className="mt-1 font-cond text-xl text-white/85">
                  {[next.competition, next.inDays != null ? t('fm.prep.inDays', { count: next.inDays }) : null].filter(Boolean).join(' · ')}
                </p>
              </div>
              <Crest club={b} size={56} />
            </>
          ) : (
            <p className="font-cond text-4xl font-bold">{t('fm.prep.noMatch')}</p>
          )}
        </div>
      </div>

      {/* Terrain et brief */}
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.65fr)_minmax(18rem,1fr)]">
        <div className="min-w-0 border-white/10 p-6 lg:border-r">
          <BlockTitle aside={<span className="font-cond text-2xl font-bold text-orange">{form}</span>}>{t('fm.prep.title')}</BlockTitle>
          <div className="mb-3 mt-4 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md bg-white/10 p-0.5" role="tablist" aria-label={t('fm.tac.xi.phaseLabel')}>
              {(['ip', 'oop'] as const).map((ph) => (
                <button
                  key={ph}
                  type="button"
                  role="tab"
                  aria-selected={phase === ph}
                  title={t(`fm.tac.xi.phaseHelp.${ph}`)}
                  onClick={() => onPhase(ph)}
                  className={`rounded px-3 py-1 text-sm font-bold ${phase === ph ? 'bg-orange text-canard' : 'text-white/80 hover:text-white'}`}
                >
                  {t(`fm.tac.phase.${ph}`)} <span className="font-normal opacity-75">{shape(ph)}</span>
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-md bg-white/10 p-0.5" role="tablist" aria-label={t('fm.tac.team.label')}>
              {(['A', 'B'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={team === k} onClick={() => onTeam(k)} className={`rounded px-3 py-1 text-sm font-bold ${team === k ? 'bg-orange text-canard' : 'text-white/80 hover:text-white'}`}>
                  {t(`fm.tac.team.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <PrepPitch plan={plan} positions={positions} numbers={numbers} swapAt={swapAt} colors={look?.colors ?? []} />
        </div>

        <div className="min-w-0 p-6">
          <BlockTitle>{t('fm.prep.brief')}</BlockTitle>
          {lines ? (
            lines.length ? (
              <ul className="mt-3 divide-y divide-white/15">
                {shown.map((l) => {
                  const ok = done.includes(l.what);
                  return (
                    <li key={l.what}>
                      <label className={`flex cursor-pointer items-start gap-3 py-4 ${ok ? 'opacity-50' : ''}`}>
                        <KindIcon kind={l.it.kind} />
                        <span className="min-w-0 flex-1">
                          <span className={`block font-cond text-xl font-semibold leading-tight ${ok ? 'line-through' : ''}`}>{l.what}</span>
                          {!ok && <span className="mt-1 block text-sm text-white/75 first-letter:uppercase">{l.why}</span>}
                        </span>
                        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#FFB547]" checked={ok} onChange={() => toggle(l.what)} aria-label={t('fm.prep.done')} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-4 text-white/80">{t('fm.tac.todo.none')}</p>
            )
          ) : (
            <div className="mt-4 text-sm text-white/80">{side}</div>
          )}
          {lines && lines.length > BRIEF_SHOWN && (
            <button type="button" className="mt-1 text-sm font-bold text-orange hover:underline" onClick={() => setAll(!all)}>
              {all ? t('fm.tac.todo.less') : t('fm.tac.todo.more', { count: lines.length - BRIEF_SHOWN })}
            </button>
          )}
        </div>
      </div>

      {/* Le onze à recopier dans FM27 et les remplaçants, sous le terrain. */}
      {(xi || bench) && (
        <div className="grid border-t border-white/10 lg:grid-cols-[minmax(0,1.65fr)_minmax(18rem,1fr)]">
          <div className="min-w-0 border-white/10 p-6 lg:border-r">
            <BlockTitle>{t('fm.prep.xi')}</BlockTitle>
            <div className="mt-3 overflow-x-auto">{xi}</div>
          </div>
          <div className="min-w-0 p-6">
            <BlockTitle>{t('fm.prep.bench')}</BlockTitle>
            <div className="mt-3">{bench}</div>
          </div>
        </div>
      )}

      {/* Calendrier : l'adversaire, domicile ou extérieur, la compétition et la date. */}
      {fixtures.length > 0 && (
        <div className="grid items-center gap-x-6 gap-y-3 border-t border-white/10 bg-black/15 px-6 py-4 md:grid-cols-[auto_repeat(3,minmax(0,1fr))]">
          <BlockTitle>{t('fm.prep.calendar')}</BlockTitle>
          {fixtures.map((f, i) => {
            const opp = f.opponent ?? '?';
            return (
              <div key={`${f.date}${i}`} className="flex min-w-0 items-center gap-3 md:border-l md:border-white/15 md:pl-5">
                <Crest club={opp} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-white/60">
                    {[f.competition, f.home == null ? null : t(f.home ? 'fm.prep.home' : 'fm.prep.away')].filter(Boolean).join(' · ')}
                  </p>
                  <p className="truncate font-cond text-xl font-semibold" title={opp}>
                    {opp}
                  </p>
                </div>
                <p className="shrink-0 font-cond text-lg font-bold text-orange">{day(f.date)}</p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
