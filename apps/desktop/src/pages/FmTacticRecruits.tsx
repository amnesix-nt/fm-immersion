import {
  baseTarget,
  clubFinances,
  clubReach,
  reachCaps,
  reachOf,
  tacticSlotSearch,
  weakestSlot,
  type DbPlayer,
  type FmPlayer,
  type FmSnapshot,
  type OwnAbility,
  type Project,
  type ProjectSlot,
  type Reach,
  type ReachLevel,
  type TacticEngine,
  type RecruitPickVerdict,
  type Target,
} from '@fm-immersion/module-fm';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PosBadge } from './FmFoot';
import { fmData } from '../lib/data';
import { Fit, More, Tag, fitGap, fitPct, useNames, type Tone } from './FmUi';

const VERDICT_TONE: Record<RecruitPickVerdict, Tone> = { starter: 'good', backup: 'info', none: 'warn' };
const REACH_TONE: Record<ReachLevel, Tone> = { easy: 'good', possible: 'info', hard: 'warn', out: 'bad' };
/** Candidats montrés d'abord, puis tous sur demande. */
const SHOWN = 12;
/** On cherche à partir d'un peu sous le CA du titulaire : un profil méta vaut parfois mieux que son CA. */
const CA_BELOW = 15;

const cls = (v: number | null | undefined) =>
  v == null ? 'text-canard/40' : v >= 15 ? 'font-bold text-eau-fonce' : v >= 12 ? 'text-canard' : v >= 10 ? 'text-brun' : 'text-corail';

/**
 * Recrues pour ma tactique : un poste de la tactique choisie, et les joueurs de la base du jeu (lecture seule, sur
 * clic) et des cibles suivies qui y collent le mieux, notés poste et méta (adéquation aux rôles + note méta au poste).
 * Seuls les joueurs que le club peut attirer et payer sont gardés, sauf demande.
 */
export function FmTacticRecruits({
  saveId,
  gameDate,
  snap,
  engine,
  project,
  players,
  followedTargets,
}: {
  saveId: string;
  gameDate: string;
  snap: FmSnapshot;
  engine: TacticEngine;
  project: Project;
  players: FmPlayer[];
  /** Cibles déjà suivies (avec attributs), candidates elles aussi. */
  followedTargets: Target[];
}) {
  const { t } = useTranslation();
  const names = useNames();
  const qc = useQueryClient();
  const weakest = useMemo(() => weakestSlot(engine, project), [engine, project]);
  const [idx, setIdx] = useState<number | null>(null);
  const slot: ProjectSlot | null = (idx != null ? project.slots[idx] : null) ?? weakest;
  const [maxAge, setMaxAge] = useState('');
  const [wide, setWide] = useState(false);
  const [all, setAll] = useState(false);
  const fin = useMemo(() => clubFinances(snap, players), [snap, players]);
  const attr = (k: string) => t(`fm.attr.${k}`, { defaultValue: k });

  const search = useMutation({
    mutationFn: async ({ sl, age }: { sl: ProjectSlot; age: string }) => {
      const own = await invoke<{ players: (OwnAbility & { id: number; ca: number })[] }>('fm_memory_abilities');
      const club = clubReach(own.players, players, fin);
      const starterCa = sl.player ? (own.players.find((x) => String(x.id) === sl.player!.id)?.ca ?? null) : null;
      const n = Number(age);
      const found = await invoke<DbPlayer[]>('fm_memory_search', {
        filter: {
          positions: [sl.pos],
          minCa: starterCa == null ? undefined : Math.max(0, starterCa - CA_BELOW),
          maxAge: age.trim() && Number.isFinite(n) ? n : undefined,
          excludeInjured: true,
          excludeOwn: true,
          limit: 300,
          ...reachCaps(club),
        },
      });
      return { slot: sl, found, club };
    },
  });
  const add = useMutation({
    mutationFn: (p: DbPlayer) => fmData.addBaseTarget(saveId, p, gameDate),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fm', saveId, 'targets'] }),
  });

  const followedIds = useMemo(() => new Set(followedTargets.map((x) => x.id)), [followedTargets]);
  const data = search.data && slot && search.data.slot.pos === slot.pos && search.data.slot.ip === slot.ip ? search.data : null;
  const raw = useMemo(() => new Map((data?.found ?? []).map((p) => [`t${p.id}`, p])), [data]);
  const reach = useMemo(() => new Map<string, Reach>(data ? data.found.map((p) => [`t${p.id}`, reachOf(p, data.club, gameDate)]) : []), [data, gameDate]);
  const result = useMemo(() => {
    if (!slot) return null;
    const fromBase = (data?.found ?? []).flatMap((p) => baseTarget(p) ?? []).filter((x) => wide || reach.get(x.id)?.level !== 'out');
    const pool = new Map<string, Target>([...fromBase, ...followedTargets].map((x) => [x.id, x]));
    return tacticSlotSearch(engine, project, slot, [...pool.values()], players);
  }, [slot, data, wide, reach, followedTargets, engine, project, players]);
  const hidden = wide ? 0 : [...reach.values()].filter((x) => x.level === 'out').length;

  if (!slot || !result) return null;
  const picks = all ? result.picks : result.picks.slice(0, SHOWN);
  const note = (n: { fit: number | null; meta: number | null; score: number | null }) =>
    t('fm.tacRecruit.note', { fit: fitPct(n.fit), meta: fitPct(n.meta), score: fitPct(n.score) });

  return (
    <section className="card mb-6 p-5" aria-labelledby="tac-recruit">
      <h2 id="tac-recruit" className="font-display text-xl font-semibold">
        {t('fm.tacRecruit.title', { style: names.style(project.style), form: project.form })}
      </h2>
      <More>{t('fm.tacRecruit.help')}</More>

      <div className="mt-3 flex flex-wrap gap-1">
        {project.slots.map((sl, i) => (
          <button
            key={`${sl.pos}-${i}`}
            type="button"
            onClick={() => {
              setIdx(i);
              setAll(false);
            }}
            className={`chip ${sl === slot ? 'chip-on' : ''}`}
            title={sl.player?.name ?? t('fm.tacRecruit.empty')}
          >
            <PosBadge pos={sl.pos} /> {names.role(engine.roles.get(sl.ip))}
            {sl === weakest && <span className="ml-1 text-[11px] font-bold text-corail">{t('fm.tacRecruit.weakest')}</span>}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-xl bg-creme/60 px-3 py-2 text-sm">
        <p>
          <PosBadge pos={slot.pos} /> <b>{names.role(engine.roles.get(slot.ip))}</b>
          {slot.oop !== slot.ip && <span className="text-brun"> · {t('fm.tacRecruit.oop', { role: names.role(engine.roles.get(slot.oop)) })}</span>}
        </p>
        <p className="mt-1 text-xs text-brun">
          {result.starter ? t('fm.tacRecruit.starter', { name: result.starter.player.name, note: note(result.starter) }) : t('fm.tacRecruit.empty')}
          {result.backup && <> · {t('fm.tacRecruit.backup', { name: result.backup.player.name, note: note(result.backup) })}</>}
        </p>
        <p className="mt-1 text-xs text-brun">{t('fm.tacRecruit.keys', { list: result.keys.map(attr).join(', ') })}</p>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="block text-xs font-bold text-canard">
          {t('fm.dbSearch.f.maxAge')}
          <input className="input mt-1 w-24 font-normal" inputMode="numeric" value={maxAge} onChange={(e) => setMaxAge(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-canard">
          <input type="checkbox" checked={wide} onChange={(e) => setWide(e.target.checked)} />
          {t('fm.reach.wide')}
        </label>
        <button type="button" className="btn-primary" disabled={search.isPending} onClick={() => search.mutate({ sl: slot, age: maxAge })}>
          {search.isPending ? t('fm.memory.reading') : t('fm.tacRecruit.run')}
        </button>
      </div>
      {search.isError && <p className="mt-2 text-sm text-corail">{t('fm.memory.error', { reason: String((search.error as Error)?.message ?? search.error) })}</p>}
      {data && (
        <p className="mt-2 text-xs text-brun">
          {t('fm.tacRecruit.count', { shown: result.picks.length, read: data.found.length })}
          {hidden > 0 && <> · {t('fm.reach.hidden', { count: hidden })}</>}
        </p>
      )}
      {!data && <p className="mt-2 text-xs text-brun">{t(followedTargets.length ? 'fm.tacRecruit.followedOnly' : 'fm.tacRecruit.hint')}</p>}

      {picks.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="data-table">
            <thead className="text-left text-canard/70">
              <tr>
                {['player', 'age', 'reach', 'caPa', 'fit', 'meta', 'score', 'gain', 'keys', ''].map((k) => (
                  <th key={k} className="px-2 py-1" title={k === 'score' ? t('fm.tacRecruit.scoreHelp') : undefined}>
                    {k && t(`fm.tacRecruit.col.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {picks.map((c) => {
                const d = raw.get(c.player.id);
                const rc = reach.get(c.player.id);
                const isFollowed = followedIds.has(c.player.id);
                return (
                  <tr key={c.player.id} className={`border-t border-canard/5 hover:bg-creme/60 ${c.verdict === 'none' ? 'text-canard/60' : ''}`}>
                    <td className="px-2 py-1.5 font-bold">
                      {c.player.name}
                      {isFollowed && <> <Tag tone="good">{t('fm.dbSearch.followed')}</Tag></>}
                      <div className="text-xs font-normal text-brun">
                        {d ? (d.club ?? (d.loanClub ? '–' : t('fm.dbSearch.free'))) : (c.player.club ?? '–')}
                        {d?.division && <> · {d.division}</>}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{c.player.age ?? '–'}</td>
                    <td className="px-2 py-1.5">
                      {rc ? (
                        <span title={rc.why.map((w) => t(`fm.reach.why.${w}`)).join(', ') || undefined}>
                          <Tag tone={REACH_TONE[rc.level]}>{t(`fm.reach.level.${rc.level}`)}</Tag>
                        </span>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{d ? `${d.ca} / ${d.pa < 0 ? '?' : d.pa}` : '–'}</td>
                    <td className="px-2 py-1.5"><Fit value={c.fit} /></td>
                    <td className="px-2 py-1.5"><Fit value={c.meta} /></td>
                    <td className="px-2 py-1.5"><Fit value={c.score} /></td>
                    <td className="px-2 py-1.5">
                      <Tag tone={VERDICT_TONE[c.verdict]}>{t(`fm.targets.verdict.${c.verdict}`)}</Tag>
                      {c.gain != null && (
                        <span className={`ml-1 text-xs font-bold tabular-nums ${c.gain >= 0 ? 'text-eau-fonce' : 'text-corail'}`}>
                          {c.gain >= 0 ? '+' : '−'}
                          {fitGap(Math.abs(c.gain))}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs">
                      {c.keys.slice(0, 4).map((k, i) => (
                        <span key={k.key}>
                          {i > 0 && ', '}
                          {attr(k.key)} <span className={`tabular-nums ${cls(k.value)}`}>{k.value == null ? '?' : Math.round(k.value)}</span>
                        </span>
                      ))}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {d && !isFollowed && (
                        <button type="button" className="text-xs font-bold text-orange-fonce hover:underline" disabled={add.isPending} onClick={() => add.mutate(d)}>
                          {t('fm.dbSearch.add')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {result.picks.length > SHOWN && (
            <button type="button" className="mt-2 text-sm font-bold text-orange-fonce hover:underline" onClick={() => setAll((v) => !v)}>
              {all ? t('fm.tacRecruit.less') : t('fm.tacRecruit.more', { count: result.picks.length - SHOWN })}
            </button>
          )}
        </div>
      ) : (
        data && <p className="mt-3 text-sm text-brun">{t('fm.tacRecruit.none')}</p>
      )}
    </section>
  );
}
