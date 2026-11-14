import { ageAt, CURRENCIES, DEFAULT_TAX, lifeEvents, lifeFinances, schoolStage, trophyCabinet, type CareerSpell, type CoachLife as Life } from '@fm-immersion/module-fm';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { coachPhotoSource } from '../lib/coach-photo';
import { fmData } from '../lib/data';
import { trophyName } from '../lib/farewell-text';

/** Enregistre la vie du coach dans les réglages de la partie (rien n'est écrit dans FM27). */
function useSaveLife(saveId: string) {
  const qc = useQueryClient();
  return useMutation({
    // Patch appliqué sur la valeur enregistrée (pas sur celle affichée) : deux champs quittés coup sur coup ne s'écrasent pas.
    mutationFn: (patch: Partial<Life> | ((cur: Life) => Partial<Life>)) =>
      fmData.updateSettings(saveId, (prev) => {
        const cur = prev.coachLife ?? {};
        return { coachLife: { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) } };
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fm', saveId, 'settings'] }),
  });
}

const num = (v: string) => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Vitrine des trophées : un trophée par compétition gagnée, avec le nombre de titres et les saisons. */
export function TrophyCabinet({ spells }: { spells: CareerSpell[] }) {
  const { t } = useTranslation();
  const cabinet = trophyCabinet(spells);
  if (!cabinet.length) return <p className="mt-2 text-brun">{t('careerPage.noTrophy')}</p>;
  return (
    <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {cabinet.map((c) => (
        <li key={c.competition ?? ''} className="flex flex-col items-center rounded-2xl bg-gradient-to-b from-orange-clair to-white p-3 text-center ring-1 ring-orange/30">
          <Cup big={c.competition === null} />
          {c.wins.length > 1 && <span className="mt-1 rounded-full bg-canard px-2 py-0.5 text-xs font-extrabold text-white">×{c.wins.length}</span>}
          <span className="mt-1 text-sm font-bold leading-tight">{trophyName(t, { season: '', competition: c.competition })}</span>
          <span className="mt-0.5 text-xs text-brun">{c.wins.map((w) => `${w.season} · ${w.club}`).join(' — ')}</span>
        </li>
      ))}
    </ul>
  );
}

function Cup({ big }: { big: boolean }) {
  // Coupe dessinée (pas de visuel du jeu) : grande pour le championnat, plus petite pour une coupe.
  const s = big ? 52 : 42;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" aria-hidden>
      <path d="M14 6h20v10a10 10 0 0 1-20 0z" fill="#FFB547" stroke="#8F5400" strokeWidth="1.5" />
      <path d="M14 9H8a6 6 0 0 0 6 8M34 9h6a6 6 0 0 1-6 8" fill="none" stroke="#8F5400" strokeWidth="1.5" />
      <rect x="21" y="26" width="6" height="8" fill="#FFB547" stroke="#8F5400" strokeWidth="1.5" />
      <rect x="14" y="34" width="20" height="6" rx="1.5" fill="#0F1B2D" />
    </svg>
  );
}

/** « Hors terrain » : finances perso, foyer et journal de vie du coach, saisis par le joueur. */
export function CoachLifeSection({ saveId, life, spells, gameDate }: { saveId: string; life: Life | undefined; spells: CareerSpell[]; gameDate: string | null }) {
  const { t } = useTranslation();
  return (
    <section className="mt-10">
      <h2 className="text-2xl font-semibold">{t('coachLife.title')}</h2>
      <p className="help mt-1">{t('coachLife.intro')}</p>
      <div className="mt-4 grid gap-6 xl:grid-cols-2">
        <Finances saveId={saveId} life={life} spells={spells} />
        <Household saveId={saveId} life={life} gameDate={gameDate} />
      </div>
      <Journal life={life} spells={spells} gameDate={gameDate} />
    </section>
  );
}

function Finances({ saveId, life, spells }: { saveId: string; life: Life | undefined; spells: CareerSpell[] }) {
  const { t, i18n } = useTranslation();
  const save = useSaveLife(saveId);
  const currency = life?.currency ?? 'EUR';
  const money = new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency, maximumFractionDigits: 0 });
  const f = lifeFinances(spells, life);
  const set = save.mutate;
  const setWage = (club: string, v: string) => {
    const n = num(v);
    set((cur) => {
      const wages = { ...(cur.wages ?? {}) };
      if (n) wages[club] = n;
      else delete wages[club];
      return { wages };
    });
  };
  return (
    <div className="card">
      <h3 className="text-xl font-semibold">{t('coachLife.money.title')}</h3>
      <p className="mt-1 text-sm text-brun">{t('coachLife.money.help')}</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('coachLife.money.gross')} value={money.format(f.gross)} />
        <Stat label={t('coachLife.money.net', { rate: f.taxRate })} value={money.format(f.net)} />
        <Stat label={t('coachLife.money.savings')} value={money.format(f.savings)} warn={f.savings < 0} />
        <Stat label={t('coachLife.money.monthly')} value={f.monthlyNet != null ? money.format(f.monthlyNet) : '–'} />
      </div>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-bold uppercase tracking-wide text-canard/60">
            <th className="py-1">{t('coachLife.money.club')}</th>
            <th className="py-1">{t('coachLife.money.weekly')}</th>
            <th className="py-1 text-right">{t('coachLife.money.earned')}</th>
          </tr>
        </thead>
        <tbody>
          {f.spells.map((s) => (
            <tr key={s.club} className="border-t border-canard/10">
              <td className="py-1.5 font-bold">{s.club}</td>
              <td className="py-1.5">
                <input
                  key={`${s.club}-${s.weekly ?? ''}`}
                  className="input w-28 py-1 text-sm"
                  inputMode="decimal"
                  defaultValue={s.weekly ?? ''}
                  placeholder={t('coachLife.money.wagePlaceholder')}
                  aria-label={t('coachLife.money.weeklyOf', { club: s.club })}
                  onBlur={(e) => e.target.value !== String(s.weekly ?? '') && setWage(s.club, e.target.value)}
                />
              </td>
              <td className="py-1.5 text-right tabular-nums">{s.gross != null ? money.format(s.gross) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          {t('coachLife.money.currency')}
          <select className="input w-auto py-1 text-sm" value={currency} onChange={(e) => set({ currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          {t('coachLife.money.tax')}
          <input
            key={`tax-${life?.taxRate ?? ''}`}
            className="input w-20 py-1 text-sm"
            inputMode="numeric"
            defaultValue={life?.taxRate ?? DEFAULT_TAX}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0 && n <= 90 && n !== (life?.taxRate ?? DEFAULT_TAX)) set({ taxRate: n });
            }}
          />
          %
        </label>
        <label className="flex items-center gap-2">
          {t('coachLife.money.costs')}
          <input
            key={`costs-${life?.monthlyCosts ?? ''}`}
            className="input w-28 py-1 text-sm"
            inputMode="decimal"
            defaultValue={life?.monthlyCosts ?? ''}
            placeholder="0"
            onBlur={(e) => (num(e.target.value) ?? 0) !== (life?.monthlyCosts ?? 0) && set({ monthlyCosts: num(e.target.value) })}
          />
        </label>
      </div>
      {f.missing > 0 && <p className="mt-3 text-xs text-brun">{t('coachLife.money.missing', { count: f.missing })}</p>}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-xl p-3 ring-1 ${warn ? 'bg-corail/10 ring-corail/30' : 'bg-white ring-canard/5'}`}>
      <p className="font-display text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] font-bold uppercase tracking-wide text-canard/60">{label}</p>
    </div>
  );
}

function Household({ saveId, life, gameDate }: { saveId: string; life: Life | undefined; gameDate: string | null }) {
  const { t } = useTranslation();
  const save = useSaveLife(saveId);
  const file = useRef<HTMLInputElement>(null);
  const [photoError, setPhotoError] = useState(false);
  const [partner, setPartner] = useState(life?.partner?.name ?? '');
  const [since, setSince] = useState(life?.partner?.since ?? '');
  const [child, setChild] = useState({ name: '', born: '' });
  useEffect(() => {
    setPartner(life?.partner?.name ?? '');
    setSince(life?.partner?.since ?? '');
  }, [life?.partner?.name, life?.partner?.since]);
  const set = save.mutate;
  const children = life?.children ?? [];
  const savePartner = () => {
    const name = partner.trim();
    if (name === (life?.partner?.name ?? '') && since === (life?.partner?.since ?? '')) return;
    set({ partner: name ? { name, since: since || null } : null });
  };
  const validBorn = (v: string) => /^\d{4}(-\d{2}-\d{2})?$/.test(v);
  return (
    <div className="card">
      <h3 className="text-xl font-semibold">{t('coachLife.home.title')}</h3>
      <p className="mt-1 text-sm text-brun">{t('coachLife.home.help')}</p>
      <div className="mt-4 flex flex-wrap items-start gap-4">
        <button
          type="button"
          className="flex h-28 w-40 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-creme text-center text-xs font-bold text-brun ring-1 ring-canard/10 hover:ring-orange"
          onClick={() => file.current?.click()}
          title={t('coachLife.home.photoPick')}
        >
          {life?.familyPhoto ? <img src={life.familyPhoto} alt={t('coachLife.home.photoAlt')} className="h-full w-full object-cover" /> : t('coachLife.home.photoPick')}
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              setPhotoError(false);
              set({ familyPhoto: await coachPhotoSource(f) });
            } catch {
              setPhotoError(true);
            }
          }}
        />
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <label className="block">
            <span className="font-bold">{t('coachLife.home.partner')}</span>
            <input className="input mt-1 py-1 text-sm" value={partner} onChange={(e) => setPartner(e.target.value)} onBlur={savePartner} placeholder={t('coachLife.home.partnerPlaceholder')} />
          </label>
          <label className="block">
            <span className="font-bold">{t('coachLife.home.since')}</span>
            <input className="input mt-1 py-1 text-sm" type="date" value={since} onChange={(e) => setSince(e.target.value)} onBlur={savePartner} />
          </label>
          {life?.familyPhoto && (
            <button type="button" className="text-xs font-bold text-corail hover:underline" onClick={() => set({ familyPhoto: null })}>
              {t('coachLife.home.photoRemove')}
            </button>
          )}
          {photoError && <p className="text-xs text-corail">{t('coachLife.home.photoError')}</p>}
        </div>
      </div>
      <h4 className="mt-5 text-sm font-extrabold uppercase tracking-wider text-canard/60">{t('coachLife.home.children')}</h4>
      {children.length ? (
        <ul className="mt-2 space-y-1.5 text-sm">
          {children.map((c, i) => {
            const age = gameDate ? ageAt(c.born, gameDate) : null;
            const unborn = !!gameDate && (/^\d{4}$/.test(c.born) ? `${c.born}-01-01` : c.born) > gameDate.slice(0, 10);
            return (
              <li key={`${c.name}-${i}`} className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{c.name}</span>
                <span className="text-brun">
                  {unborn ? t('coachLife.home.unborn') : age != null ? `${t('coachLife.home.age', { count: age })} · ${t(`coachLife.stage.${schoolStage(age)}`)}` : c.born}
                </span>
                <button type="button" className="ml-auto text-xs font-bold text-corail hover:underline" onClick={() => set((cur) => ({ children: (cur.children ?? []).filter((_, j) => j !== i) }))}>
                  {t('coachLife.home.remove')}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-brun">{t('coachLife.home.noChild')}</p>
      )}
      <form
        className="mt-3 flex flex-wrap items-end gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!child.name.trim() || !validBorn(child.born)) return;
          const added = { name: child.name.trim(), born: child.born };
          set((cur) => ({ children: [...(cur.children ?? []), added] }));
          setChild({ name: '', born: '' });
        }}
      >
        <input className="input w-40 py-1 text-sm" value={child.name} onChange={(e) => setChild({ ...child, name: e.target.value })} placeholder={t('coachLife.home.childName')} aria-label={t('coachLife.home.childName')} />
        <input className="input w-40 py-1 text-sm" type="date" value={child.born} onChange={(e) => setChild({ ...child, born: e.target.value })} aria-label={t('coachLife.home.childBorn')} />
        <button type="submit" className="btn-secondary px-3 py-1 text-xs" disabled={!child.name.trim() || !validBorn(child.born)}>
          {t('coachLife.home.addChild')}
        </button>
      </form>
    </div>
  );
}

function Journal({ life, spells, gameDate }: { life: Life | undefined; spells: CareerSpell[]; gameDate: string | null }) {
  const { t, i18n } = useTranslation();
  const dateFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' });
  const events = lifeEvents(spells, life, gameDate);
  if (!events.length) return null;
  const icon = { arrival: '✍️', exit: '🚪', trophy: '🏆', partner: '💍', birth: '👶' } as const;
  return (
    <div className="card mt-6">
      <h3 className="text-xl font-semibold">{t('coachLife.journal.title')}</h3>
      <ol className="mt-3 space-y-2 border-l-2 border-orange/40 pl-4 text-sm">
        {events.map((e, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[1.6rem] top-0" aria-hidden>
              {icon[e.kind]}
            </span>
            <span className="text-xs font-bold text-brun">{dateFmt.format(new Date(e.date))}</span>
            <span className="ml-2">
              {e.kind === 'arrival' && t('coachLife.journal.arrival', { club: e.club })}
              {e.kind === 'exit' && t(e.reason === 'sacked' ? 'coachLife.journal.sacked' : 'coachLife.journal.left', { club: e.club })}
              {e.kind === 'trophy' && t('coachLife.journal.trophy', { trophy: trophyName(t, e), club: e.club, season: e.season })}
              {e.kind === 'partner' && t('coachLife.journal.partner', { name: e.name })}
              {e.kind === 'birth' && t('coachLife.journal.birth', { name: e.name })}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
