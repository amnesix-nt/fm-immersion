import { careerOf, COUNTRIES, crestLetters, inkOn, type Career as CareerData, type CareerSpell } from '@fm-immersion/module-fm';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CoachLifeSection, TrophyCabinet } from '../components/CoachLife';
import { PageHero } from '../components/PageHero';
import { useCareer } from '../lib/career';
import { useFmFolder } from '../lib/fm-sync';
import { FmHistoryImport } from './FmSave';
import { clubLook, rememberClubLooks } from '../lib/club-look';
import { Crest } from '../components/Crest';
import { fmData } from '../lib/data';
import { useHistory } from '../lib/fm-cache';
import { trophyName } from '../lib/farewell-text';
import { ordinal } from '../lib/season-une';
import { MAP_HEIGHT, MAP_PINS, MAP_SHAPES, MAP_WIDTH } from '../lib/world-map';

/** Nom d'un pays dans la langue de l'appli : nom ISO du navigateur, nations britanniques traduites ici. */
export function countryName(t: TFunction, code: string, lang?: string) {
  if (code.startsWith('GB-')) return t(`careerPage.nations.${code}`);
  try {
    return new Intl.DisplayNames([lang ?? 'fr'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** « Ma carrière » : le parcours du coach dans la partie suivie (clubs, saisons, titres) et sa carte du monde. */
export function Career() {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const qc = useQueryClient();
  const { saveId, save, fmSaves } = useCareer();
  const { data: history = [], isLoading } = useHistory(saveId);
  const { data: settings } = useQuery({ queryKey: ['fm', saveId, 'settings'], queryFn: () => fmData.settings(saveId), enabled: !!saveId });
  useMemo(() => rememberClubLooks(history.map((h) => h.data)), [history]);
  const folder = useFmFolder(saveId);
  // Clubs écartés par le joueur (jours venus d'une autre sauvegarde) : leurs jours ne comptent pas dans la carrière.
  const hidden = useMemo(() => settings?.careerHidden ?? [], [settings?.careerHidden]);
  const kept = useMemo(() => history.filter((h) => !hidden.includes(h.data.club)), [history, hidden]);
  const raw = useMemo(() => careerOf(kept, { freeSince: settings?.fmFreeSince ?? null }), [kept, settings?.fmFreeSince]);
  // Pays corrigés à la main par le joueur (par nom de club), à la place du pays deviné.
  const fixed = useMemo(() => settings?.careerCountries ?? {}, [settings?.careerCountries]);
  const career: CareerData = useMemo(() => {
    const spells = raw.spells.map((s) => (fixed[s.club] ? { ...s, country: fixed[s.club]!, countrySource: null } : s));
    return { spells, totals: { ...raw.totals, countries: new Set(spells.map((s) => s.country).filter(Boolean)).size } };
  }, [raw, fixed]);
  const setCountry = useMutation({
    mutationFn: ({ club, code }: { club: string; code: string | null }) =>
      fmData.updateSettings(saveId, (prev) => {
        const next = { ...(prev.careerCountries ?? {}) };
        if (code) next[club] = code;
        else delete next[club];
        return { careerCountries: next };
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fm', saveId, 'settings'] }),
  });
  const setHidden = useMutation({
    mutationFn: ({ club, hide }: { club: string; hide: boolean }) =>
      fmData.updateSettings(saveId, (prev) => {
        const list = (prev.careerHidden ?? []).filter((c) => c !== club);
        return { careerHidden: hide ? [...list, club] : list.length ? list : undefined };
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fm', saveId, 'settings'] }),
  });

  const dateFmt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium' });
  const tt = career.totals;

  return (
    <div className="w-full px-6 py-6 xl:px-10">
      <p className="text-xs font-bold uppercase tracking-wide text-canard/50">{t('layout.groups.story')}</p>
      <h1 className="text-3xl font-semibold">{t('careerPage.title')}</h1>
      <p className="help mt-1">{t('careerPage.intro')}</p>

      {!fmSaves.length && (
        <div className="card mt-6 max-w-3xl">
          <p className="text-brun">{t('careerPage.noSave')}</p>
          <Link to="/parties" className="btn-primary mt-4">
            {t('layout.career.create')}
          </Link>
        </div>
      )}
      {!!fmSaves.length && !isLoading && !career.spells.length && !hidden.length && (
        <div className="card mt-6 max-w-3xl">
          <p className="font-display text-xl font-semibold">{t('careerPage.emptyTitle')}</p>
          <p className="mt-2 text-brun">{t('careerPage.empty')}</p>
        </div>
      )}

      {!!career.spells.length && (
        <>
          {/* Bandeau de la maquette : la saison et le club d'aujourd'hui, la photo du coach à droite. */}
          <PageHero
            eyebrow={career.spells.at(-1)!.seasons.at(-1)?.label ?? t('careerPage.title')}
            title={career.spells.at(-1)!.current ? career.spells.at(-1)!.club : t('layout.career.free')}
            text={t('careerPage.summary', {
              coach: save?.name ?? '',
              since: dateFmt.format(new Date(career.spells[0]!.start.slice(0, 10))),
              clubs: t('careerPage.nClubs', { count: tt.clubs }),
              countries: t('careerPage.nCountries', { count: tt.countries }),
            })}
            image={settings?.coachPhoto ?? null}
          />

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            <Tile value={String(tt.seasons + (tt.ongoingSeason ? 1 : 0))} label={t('careerPage.tile.seasons', { count: tt.seasons + (tt.ongoingSeason ? 1 : 0) })} />
            <Tile value={String(tt.played)} label={t('careerPage.tile.played', { count: tt.played })} />
            <Tile value={`${tt.wins}-${tt.draws}-${tt.losses}`} label={t('careerPage.tile.record')} />
            <Tile value={tt.winRate != null ? `${tt.winRate} %` : '–'} label={t('careerPage.tile.winRate')} />
            <Tile value={`${tt.goalsFor}-${tt.goalsAgainst}`} label={t('careerPage.tile.goals')} />
            <Tile value={tt.pointsPerGame != null ? new Intl.NumberFormat(lang, { minimumFractionDigits: 2 }).format(tt.pointsPerGame) : '–'} label={t('careerPage.tile.ppg')} />
            <Tile value={String(tt.trophies)} label={t('careerPage.tile.trophies', { count: tt.trophies })} accent={tt.trophies > 0} />
            <Tile value={tt.bestFinish != null ? ordinal(t, tt.bestFinish) : '–'} label={t('careerPage.tile.best')} />
          </div>

          <div className="mt-6 grid gap-6 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <WorldMap spells={career.spells} />
            <div className="card">
              <h2 className="text-xl font-semibold">{t('careerPage.honours')}</h2>
              <TrophyCabinet spells={career.spells} />
              <h3 className="mt-6 text-sm font-extrabold uppercase tracking-wider text-canard/60">{t('careerPage.records')}</h3>
              <ul className="mt-2 space-y-1.5 text-sm">
                {tt.biggestWin && (
                  <li>
                    {t('careerPage.biggestWin', {
                      score: `${tt.biggestWin.goalsFor}-${tt.biggestWin.goalsAgainst}`,
                      opponent: tt.biggestWin.opponent ?? t('careerPage.unknownOpponent'),
                      club: tt.biggestWin.club,
                    })}
                  </li>
                )}
                {tt.unbeaten > 0 && <li>{t('careerPage.unbeaten', { count: tt.unbeaten })}</li>}
                <li>{t('careerPage.cleanSheets', { count: tt.cleanSheets })}</li>
                <li>{t('careerPage.days', { count: tt.days })}</li>
              </ul>
            </div>
          </div>

          <h2 className="mt-8 text-2xl font-semibold">{t('careerPage.clubs')}</h2>
          <ol className="mt-3 space-y-4">
            {[...career.spells].reverse().map((s, i) => (
              <SpellCard
                key={`${s.club}-${s.start}`}
                n={career.spells.length - i}
                spell={s}
                auto={raw.spells.find((r) => r.start === s.start)?.country ?? null}
                manual={!!fixed[s.club]}
                onCountry={(code) => setCountry.mutate({ club: s.club, code })}
                onHide={() => setHidden.mutate({ club: s.club, hide: true })}
              />
            ))}
          </ol>
          <p className="mt-4 text-xs text-brun">{t('careerPage.source')}</p>

          <CoachLifeSection saveId={saveId} life={settings?.coachLife} spells={career.spells} gameDate={kept.at(-1)?.gameDate ?? null} />
        </>
      )}

      {!!fmSaves.length && !isLoading && (
        <div className="card mt-8 max-w-4xl">
          <h2 className="text-xl font-semibold">{t('careerPage.fixTitle')}</h2>
          <p className="mt-1 text-sm text-brun">{t('careerPage.fixHelp')}</p>
          {!!hidden.length && (
            <ul className="mt-3 space-y-1.5">
              {hidden.map((club) => (
                <li key={club} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-bold">{club}</span>
                  <span className="text-brun">{t('careerPage.hiddenLabel')}</span>
                  <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setHidden.mutate({ club, hide: false })}>
                    {t('careerPage.unhide')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!!folder && (
            <div className="mt-4">
              <FmHistoryImport saveId={saveId} folder={folder} club={career.spells.at(-1)?.club ?? null} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Tile({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 ring-1 ${accent ? 'bg-orange-clair ring-orange/30' : 'bg-white ring-canard/5'}`}>
      <p className="font-display text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs font-bold uppercase tracking-wide text-canard/60">{label}</p>
    </div>
  );
}

function SpellCard({
  n,
  spell: s,
  auto,
  manual,
  onCountry,
  onHide,
}: {
  n: number;
  spell: CareerSpell;
  auto: string | null;
  manual: boolean;
  onCountry: (code: string | null) => void;
  onHide: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const [editing, setEditing] = useState(false);
  const dateFmt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium' });
  const r = s.total;
  const pct = r.played ? Math.round((r.wins / r.played) * 100) : null;
  const options = useMemo(
    () => COUNTRIES.map((c) => ({ code: c.code, name: countryName(t, c.code, lang) })).sort((a, b) => a.name.localeCompare(b.name, lang)),
    [t, lang],
  );
  return (
    <li className="card">
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canard text-sm font-extrabold text-white">{n}</span>
        <Crest club={s.club} />
        <div className="min-w-0 flex-1">
          <p className="font-display text-xl font-semibold">{s.club}</p>
          <p className="text-sm text-brun">
            {dateFmt.format(new Date(s.start.slice(0, 10)))} – {s.current ? t('careerPage.now') : dateFmt.format(new Date(s.end.slice(0, 10)))}
            {' · '}
            {editing ? (
              <select
                className="input inline-block w-auto py-0.5 text-sm"
                value={manual ? (s.country ?? '') : ''}
                autoFocus
                onChange={(e) => {
                  onCountry(e.target.value || null);
                  setEditing(false);
                }}
                onBlur={() => setEditing(false)}
                aria-label={t('careerPage.countryPick')}
              >
                <option value="">{auto ? t('careerPage.countryAuto', { name: countryName(t, auto, lang) }) : t('careerPage.countryNone')}</option>
                {options.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : (
              <button type="button" className="font-bold text-orange-fonce hover:underline" onClick={() => setEditing(true)} title={t('careerPage.countryPick')}>
                {s.country ? countryName(t, s.country, lang) : t('careerPage.countryUnknown')}
              </button>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`pill ${s.current ? '' : s.reason === 'sacked' ? 'bg-corail text-white' : 'bg-canard/10'}`}>
            {s.current ? t('careerPage.current') : t(`careerPage.exit.${s.reason ?? 'left'}`)}
          </span>
          {!s.current && (
            <button type="button" className="text-xs font-bold text-brun hover:text-corail hover:underline" onClick={onHide} title={t('careerPage.hideHelp')}>
              {t('careerPage.hide')}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Fact label={t('careerPage.tile.played', { count: r.played })} value={String(r.played)} />
        <Fact label={t('careerPage.tile.record')} value={`${r.wins}-${r.draws}-${r.losses}`} />
        <Fact label={t('careerPage.tile.winRate')} value={pct != null ? `${pct} %` : '–'} />
        <Fact label={t('careerPage.tile.goals')} value={`${r.goalsFor}-${r.goalsAgainst}`} />
        <Fact label={t('careerPage.tile.best')} value={s.bestFinish != null ? ordinal(t, s.bestFinish) : '–'} />
        {r.topScorer && <Fact label={t('careerPage.topScorer')} value={`${r.topScorer.name} (${r.topScorer.value})`} />}
      </div>

      {s.untracked.matches > 0 && (
        <p className="mt-2 text-xs text-brun">
          {s.untracked.record
            ? t('careerPage.rebuilt', { count: s.untracked.matches, witness: s.untracked.record.witness })
            : t('careerPage.untracked', { count: s.untracked.matches, goals: s.untracked.goalsFor })}
        </p>
      )}

      {!!s.trophies.length && (
        <p className="mt-3 flex flex-wrap gap-2">
          {s.trophies.map((tr, i) => (
            <span key={i} className="pill">
              🏆 {trophyName(t, tr)} {tr.season}
            </span>
          ))}
        </p>
      )}

      {!!s.seasons.length && (
        <div className="mt-4 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('careerPage.col.season')}</th>
                <th>{t('careerPage.col.position')}</th>
                <th>{t('careerPage.col.played')}</th>
                <th>{t('careerPage.col.record')}</th>
                <th>{t('careerPage.col.goals')}</th>
                <th>{t('careerPage.col.cups')}</th>
              </tr>
            </thead>
            <tbody>
              {[...s.seasons].reverse().map((x, i) => (
                <tr key={i}>
                  <td className="font-bold">
                    {x.label}
                    {!x.ended && <span className="ml-2 text-xs font-normal text-brun">{t(s.current ? 'careerPage.ongoing' : 'careerPage.leftMidSeason')}</span>}
                  </td>
                  <td>{x.position != null ? ordinal(t, x.position) : '–'}</td>
                  <td>
                    {x.played}
                    {x.untracked.matches > 0 && !x.untracked.record && <span className="ml-1 text-xs text-brun">{t('careerPage.untrackedShort', { count: x.untracked.matches })}</span>}
                  </td>
                  <td>
                    {x.wins}-{x.draws}-{x.losses}
                  </td>
                  <td>
                    {x.goalsFor}-{x.goalsAgainst}
                  </td>
                  <td>{x.cupsWon.length ? x.cupsWon.join(', ') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="font-extrabold tabular-nums">{value}</p>
    <p className="text-xs text-brun">{label}</p>
  </div>
);

/** Position d'un passage sur la carte, décalée en cercle quand plusieurs clubs sont dans le même pays. */
function pinsOf(spells: CareerSpell[], spread: number) {
  const byCountry = new Map<string, number[]>();
  spells.forEach((s, i) => {
    if (!s.country || !MAP_PINS[s.country]) return;
    const clubs = byCountry.get(s.country) ?? [];
    // Retour dans un club déjà entraîné : même point.
    if (!clubs.some((j) => spells[j]!.club === s.club)) clubs.push(i);
    byCountry.set(s.country, clubs);
  });
  return spells.map((s, i) => {
    if (!s.country || !MAP_PINS[s.country]) return null;
    const [x, y] = MAP_PINS[s.country]!;
    const clubs = byCountry.get(s.country)!;
    const k = clubs.findIndex((j) => spells[j]!.club === s.club);
    if (clubs.length < 2) return { x, y };
    const a = (2 * Math.PI * k) / clubs.length - Math.PI / 2;
    return { x: x + Math.cos(a) * spread, y: y + Math.sin(a) * spread };
  });
}

/** Carte du monde (dessinée sur place, rien de chargé d'Internet) : pays entraînés en orange, clubs numérotés dans l'ordre. */
function WorldMap({ spells }: { spells: CareerSpell[] }) {
  const { t, i18n } = useTranslation();
  const [whole, setWhole] = useState(false);
  const visited = new Set(spells.map((s) => (s.country?.startsWith('GB-') ? 'GB' : s.country)).filter(Boolean));
  const current = spells.find((s) => s.current)?.country ?? null;
  const currentShape = current?.startsWith('GB-') ? 'GB' : current;

  // Cadre : tous les pays entraînés avec une marge, au moins un quart de la largeur du monde ; ou le monde entier.
  const base = pinsOf(spells, 0).filter((p): p is { x: number; y: number } => !!p);
  let box = { x: 0, y: 0, w: MAP_WIDTH, h: MAP_HEIGHT };
  if (!whole && base.length) {
    const xs = base.map((p) => p.x);
    const ys = base.map((p) => p.y);
    const ratio = MAP_WIDTH / MAP_HEIGHT;
    let w = Math.max(MAP_WIDTH / 4, (Math.max(...xs) - Math.min(...xs)) * 1.5);
    let h = Math.max((Math.max(...ys) - Math.min(...ys)) * 1.5, w / ratio);
    w = Math.max(w, h * ratio);
    h = w / ratio;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    box = { x: Math.min(Math.max(0, cx - w / 2), MAP_WIDTH - w), y: Math.min(Math.max(0, cy - h / 2), MAP_HEIGHT - h), w, h };
  }
  const k = box.w / MAP_WIDTH;
  const pins = pinsOf(spells, 14 * k);
  const route = pins.filter((p): p is { x: number; y: number } => !!p);
  const missing = spells.filter((s) => !s.country || !MAP_PINS[s.country]);
  const r = 11 * k;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{t('careerPage.map')}</h2>
        <div className="flex gap-1">
          <button type="button" className={`chip ${!whole ? 'chip-on' : ''}`} onClick={() => setWhole(false)}>
            {t('careerPage.mapZoom')}
          </button>
          <button type="button" className={`chip ${whole ? 'chip-on' : ''}`} onClick={() => setWhole(true)}>
            {t('careerPage.mapWorld')}
          </button>
        </div>
      </div>
      <svg
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className="mt-3 w-full rounded-xl bg-[#EAF0F2]"
        role="img"
        aria-label={t('careerPage.mapLabel', { clubs: spells.map((s) => s.club).join(', ') })}
      >
        {MAP_SHAPES.map((s, i) => (
          <path
            key={i}
            d={s.d}
            fill={s.code && s.code === currentShape ? '#FFB547' : s.code && visited.has(s.code) ? '#FFD99A' : '#D9DAD5'}
            stroke="#FFFFFF"
            strokeWidth={0.6}
            vectorEffect="non-scaling-stroke"
          >
            {s.code && visited.has(s.code) && <title>{countryName(t, s.code === 'GB' ? spells.find((x) => x.country?.startsWith('GB-'))!.country! : s.code, i18n.resolvedLanguage)}</title>}
          </path>
        ))}
        {route.length > 1 && (
          <polyline
            points={route.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="#8F5400"
            strokeWidth={2}
            strokeDasharray="6 5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {spells.map((s, i) => {
          const p = pins[i];
          // Un club entraîné plusieurs fois : un seul point, au numéro de son dernier passage.
          if (!p || spells.slice(i + 1).some((x) => x.club === s.club)) return null;
          return (
            <g key={i}>
              <title>{`${i + 1}. ${s.club}`}</title>
              <circle cx={p.x} cy={p.y} r={r} fill={s.current ? '#8F5400' : '#0F1B2D'} stroke="#FFFFFF" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <text x={p.x} y={p.y} dy="0.35em" textAnchor="middle" fontSize={r * 1.15} fontWeight={800} fill="#FFFFFF">
                {i + 1}
              </text>
              <text
                x={p.x + r * 1.5}
                y={p.y}
                dy="0.35em"
                fontSize={r * 1.25}
                fontWeight={800}
                fill="#0F1B2D"
                stroke="#FFFFFF"
                strokeWidth={3}
                paintOrder="stroke"
                vectorEffect="non-scaling-stroke"
              >
                {s.club}
              </text>
            </g>
          );
        })}
      </svg>
      {!!missing.length && <p className="mt-2 text-xs text-brun">{t('careerPage.mapMissing', { clubs: missing.map((s) => s.club).join(', ') })}</p>}
    </div>
  );
}
