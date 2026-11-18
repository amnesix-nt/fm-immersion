import { ranking, type LabRow } from '@fm-immersion/module-fm';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFacesDirs } from '../lib/faces';
import { cancelTournament, errorText, isBusy, runTournament, useLabStore, type LabStatus } from '../lib/tactics-lab';
import { Empty, More, Panel } from './FmUi';

const MATCH_CHOICES = [10, 20, 50] as const;

/** Couleur d'une case selon les points par match (1,35 = moyen). */
const tone = (ppm: number) =>
  ppm >= 1.8 ? 'bg-eau-soutenu' : ppm >= 1.5 ? 'bg-eau/45' : ppm >= 1.2 ? 'bg-canard/5' : ppm >= 0.9 ? 'bg-ambre/30' : 'bg-corail/30';

const f2 = (n: number | null) => (n == null ? '–' : n.toFixed(2).replace('.', ','));

/** Labo de tactiques : FM Tactics Lab fait jouer tes tactiques entre elles avec le moteur de FM27. */
export function FmLab({ folder }: { folder: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { gameDir } = useFacesDirs();
  const lab = useLabStore();
  const busy = isBusy(lab.phase);

  const status = useQuery({ queryKey: ['lab', 'status'], queryFn: () => invoke<LabStatus>('lab_status'), refetchInterval: busy ? false : 10_000 });
  const files = useQuery({
    queryKey: ['fm', 'tactic-files', folder],
    queryFn: () => invoke<{ name: string }[]>('fm_list_tactic_files', { folder }),
    enabled: !!folder,
  });

  const [progress, setProgress] = useState<{ step: string; received: number; total: number } | null>(null);
  useEffect(() => {
    const un = listen<{ step: string; received: number; total: number }>('tactics-lab', (e) => setProgress(e.payload));
    return () => void un.then((f) => f());
  }, []);

  const refresh = (s: LabStatus) => qc.setQueryData(['lab', 'status'], s);
  const install = useMutation({
    mutationFn: () => invoke<LabStatus>('lab_install', { gameDir }),
    onSuccess: refresh,
    onSettled: () => setProgress(null),
  });
  const start = useMutation({ mutationFn: () => invoke<LabStatus>('lab_start', { gameDir }), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => invoke<LabStatus>('lab_stop'), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => invoke<LabStatus>('lab_remove'), onSuccess: refresh });
  const workers = useQuery({
    queryKey: ['lab', 'workers', status.data?.port],
    queryFn: () => invoke<{ batch?: { recommended?: number } }>('lab_call', { method: 'GET', path: '/api/status', body: null }),
    enabled: !!status.data?.running,
  });

  const [picked, setPicked] = useState<string[]>([]);
  const [matches, setMatches] = useState<number>(20);
  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));

  const s = status.data;
  const ready = !!s?.downloaded && !!s.extracted && !!s.selfTest?.compatible && !!s.selfTest?.canSimulate;
  const rows = useMemo(() => (lab.results ? ranking(lab.results.pairs) : []), [lab.results]);
  const pairsCount = picked.length * (picked.length - 1);
  const err = install.error ?? start.error ?? stop.error ?? remove.error;

  const launch = async () => {
    try {
      if (!s?.running) refresh(await start.mutateAsync());
    } catch {
      return;
    }
    const w = workers.data?.batch?.recommended ?? 4;
    void runTournament(folder, picked, matches, w);
  };

  return (
    <div className="space-y-5">
      <Panel title={t('fm.lab.engine.title')}>
        <p className="text-sm text-brun">{t('fm.lab.engine.intro')}</p>
        <More>
          <p className="text-sm text-brun">{t('fm.lab.engine.help', { build: s?.gameBuild ?? '' })}</p>
        </More>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {!s ? null : !s.downloaded || !s.extracted || !s.selfTest ? (
            <button type="button" className="btn-primary px-3 py-1.5" disabled={install.isPending || !gameDir} onClick={() => install.mutate()}>
              {install.isPending
                ? progress?.step === 'download'
                  ? t('fm.lab.engine.downloading', { pct: Math.round((100 * progress.received) / Math.max(1, progress.total)) })
                  : t('fm.lab.engine.checking')
                : t('fm.lab.engine.install', { version: s.version, mb: Math.round(s.size / 1e6) })}
            </button>
          ) : ready ? (
            <>
              <span className="pill bg-eau-soutenu text-canard">{t('fm.lab.engine.ready', { version: s.version })}</span>
              {s.running ? (
                <button type="button" className="btn-secondary px-3 py-1.5" disabled={busy || stop.isPending} onClick={() => stop.mutate()}>
                  {t('fm.lab.engine.stop')}
                </button>
              ) : null}
            </>
          ) : (
            <>
              <span className="pill bg-ambre/40 text-canard">{t('fm.lab.engine.incompatible', { build: s.gameBuild })}</span>
              {s.selfTest?.reason ? <span className="text-brun">{s.selfTest.reason}</span> : null}
              <button type="button" className="btn-secondary px-3 py-1.5" disabled={install.isPending} onClick={() => install.mutate()}>
                {install.isPending ? t('fm.lab.engine.checking') : t('fm.lab.engine.recheck')}
              </button>
            </>
          )}
          {s?.downloaded && !busy ? (
            <button type="button" className="text-corail hover:underline" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t('fm.lab.engine.remove')}
            </button>
          ) : null}
        </div>
        {!gameDir ? <p className="mt-2 text-sm text-corail">{t('fm.lab.engine.noGame')}</p> : null}
        {err ? <p className="mt-2 whitespace-pre-wrap text-sm text-corail">{errorText(err)}</p> : null}
      </Panel>

      <Panel title={t('fm.lab.run.title')}>
        <p className="text-sm text-brun">{t('fm.lab.run.intro')}</p>
        {!files.data?.length ? (
          <Empty>{t('fm.lab.run.none')}</Empty>
        ) : (
          <div className="mt-3 grid gap-1 sm:grid-cols-2">
            {files.data.map((f) => (
              <label key={f.name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={picked.includes(f.name)} disabled={busy} onChange={() => toggle(f.name)} />
                {f.name.replace(/\.fmf$/i, '')}
              </label>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            {t('fm.lab.run.matches')}
            <select className="input py-1" value={matches} disabled={busy} onChange={(e) => setMatches(Number(e.target.value))}>
              {MATCH_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {busy ? (
            <button type="button" className="btn-secondary px-3 py-1.5" onClick={() => void cancelTournament()}>
              {t('fm.lab.run.cancel')}
            </button>
          ) : (
            <button type="button" className="btn-primary px-3 py-1.5" disabled={!ready || picked.length < 2 || start.isPending} onClick={() => void launch()}>
              {t('fm.lab.run.go', { count: pairsCount * matches })}
            </button>
          )}
          {!busy && picked.length >= 2 ? <span className="text-brun">{t('fm.lab.run.pairs', { count: pairsCount })}</span> : null}
        </div>
        {busy ? (
          <div className="mt-3 text-sm">
            <div className="h-2 overflow-hidden rounded bg-canard/10">
              <div className="h-full bg-orange" style={{ width: `${(100 * lab.doneMatches) / Math.max(1, lab.totalMatches)}%` }} />
            </div>
            <p className="mt-1 text-brun">
              {lab.phase === 'import' ? t('fm.lab.run.importing', { name: lab.current ?? '' }) : t('fm.lab.run.playing', { pair: lab.current ?? '', done: lab.doneMatches, total: lab.totalMatches })}
              {lab.eta != null ? ` · ${t('fm.lab.run.eta', { min: Math.max(1, Math.round(lab.eta / 60)) })}` : ''}
            </p>
          </div>
        ) : null}
        {lab.phase === 'error' && lab.error ? <p className="mt-2 whitespace-pre-wrap text-sm text-corail">{t('fm.lab.run.failed', { error: lab.error })}</p> : null}
        {lab.phase === 'cancelled' ? <p className="mt-2 text-sm text-brun">{t('fm.lab.run.cancelled')}</p> : null}
      </Panel>

      <LabResults rows={rows} />
    </div>
  );
}

function LabResults({ rows }: { rows: LabRow[] }) {
  const { t } = useTranslation();
  const results = useLabStore((s) => s.results);
  if (!rows.length) return null;
  const names = rows.map((r) => r.name);
  const partial = !results?.finishedAt;
  return (
    <Panel title={t('fm.lab.results.title')}>
      <p className="text-sm text-brun">{t(partial ? 'fm.lab.results.partial' : 'fm.lab.results.intro', { matches: results?.matches ?? 0 })}</p>
      <More>
        <p className="text-sm text-brun">{t('fm.lab.results.help')}</p>
      </More>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-brun">
              <th className="py-1 pr-3">#</th>
              <th className="py-1 pr-3">{t('fm.lab.results.tactic')}</th>
              <th className="py-1 pr-3 text-right">{t('fm.lab.results.rating')}</th>
              <th className="py-1 pr-3 text-right">{t('fm.lab.results.ppm')}</th>
              <th className="py-1 pr-3 text-right">{t('fm.lab.results.home')}</th>
              <th className="py-1 pr-3 text-right">{t('fm.lab.results.away')}</th>
              <th className="py-1 pr-3 text-right">{t('fm.lab.results.goals')}</th>
              <th className="py-1 pr-3 text-right">{t('fm.lab.results.xg')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name} className="border-t border-canard/10">
                <td className="py-1.5 pr-3 tabular-nums">{i + 1}</td>
                <td className="py-1.5 pr-3 font-bold">{r.name}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  <span className={`pill ${tone(r.ppm)} text-canard`}>{r.rating.toFixed(1).replace('.', ',')}</span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {f2(r.ppm)} <span className="text-xs text-brun">±{f2(r.ci)}</span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{f2(r.homePpm)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{f2(r.awayPpm)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {f2(r.goalsFor)} – {f2(r.goalsAgainst)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {f2(r.xgFor)} – {f2(r.xgAgainst)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-5 text-sm font-bold">{t('fm.lab.results.matrix')}</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th />
              {names.map((n) => (
                <th key={n} className="max-w-24 px-1 py-1 text-left font-normal text-brun" title={n}>
                  <span className="block truncate">{n}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <th className="max-w-40 truncate py-1 pr-2 text-left font-bold" title={r.name}>
                  {r.name}
                </th>
                {names.map((n) => {
                  const v = r.vs[n];
                  return (
                    <td key={n} className={`px-1 py-1 text-center tabular-nums ${v == null ? '' : tone(v)}`}>
                      {v == null ? '' : f2(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
