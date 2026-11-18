import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GAME_DIR_KEY, useGameStatus, type BridgeStatus } from '../lib/game';

/** BepInEx dans le dossier du jeu, vu par `src-tauri/src/bepinex.rs`. */
type BepinexStatus = {
  gameFound: boolean;
  present: boolean;
  ours: boolean;
  version: string | null;
  firstLaunch: boolean;
  pinned: string;
};
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* stockage indisponible : le dossier sera redemandé */
  }
};

/** Compare « X.Y.Z » numériquement. */
const isNewer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
};

/** Installation et mise à jour du plugin FM27 depuis GitHub Releases (sur demande, jeu fermé). */
export function FmBridge({ dataFolder, onHealth }: { dataFolder: string; onHealth?: (ok: boolean) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [gameDir, setGameDir] = useState(read(GAME_DIR_KEY) ?? '');
  const [open, setOpen] = useState(false);

  const { data: defaultDir } = useQuery({ queryKey: ['fm', 'bridge', 'default-dir'], queryFn: () => invoke<string | null>('fm_bridge_default_game_dir') });
  useEffect(() => {
    if (!gameDir && defaultDir) setGameDir(defaultDir);
  }, [defaultDir, gameDir]);

  const { data: status } = useQuery({
    queryKey: ['fm', 'bridge', 'status', gameDir],
    queryFn: () => invoke<BridgeStatus>('fm_bridge_status', { gameDir }),
    enabled: !!gameDir,
    refetchInterval: 5000,
  });
  // Mémorise le dossier dès qu'il est reconnu (fm.exe trouvé), pour ne pas le redemander au prochain démarrage.
  useEffect(() => {
    if (status?.gameFound && gameDir) write(GAME_DIR_KEY, gameDir);
  }, [status?.gameFound, gameDir]);
  const latest = useQuery({ queryKey: ['fm', 'bridge', 'latest'], queryFn: () => invoke<string>('fm_bridge_latest'), retry: false, staleTime: 10 * 60_000 });

  const bepinex = useQuery({
    queryKey: ['fm', 'bepinex', gameDir],
    queryFn: () => invoke<BepinexStatus>('bepinex_status', { gameDir }),
    enabled: !!gameDir,
    refetchInterval: 15_000,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['fm', 'bridge', 'status'] });
    qc.invalidateQueries({ queryKey: ['fm', 'bepinex'] });
  };
  // Un seul clic : BepInEx d'abord s'il manque (version épinglée, vérifiée), puis le plugin.
  const install = useMutation({
    mutationFn: async () => {
      if (!status?.bepinex) await invoke<BepinexStatus>('bepinex_install', { gameDir });
      return invoke<BridgeStatus>('fm_bridge_install', { gameDir, dataDir: dataFolder });
    },
    onSuccess: () => write(GAME_DIR_KEY, gameDir),
    onSettled: refresh,
  });
  const uninstallBepinex = useMutation({
    mutationFn: () => invoke<BepinexStatus>('bepinex_uninstall', { gameDir }),
    onSettled: refresh,
  });

  const installed = status?.installedVersion ?? null;
  const upToDate = !!installed && !!latest.data && !isNewer(latest.data, installed);
  const canInstall = !!status?.gameFound && !status.running && !!dataFolder && !!latest.data && !upToDate;
  const withBepinex = !!status?.gameFound && !status.bepinex;
  const dot = (ok: boolean | undefined, warn = false) => (
    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${ok ? 'bg-eau' : warn ? 'bg-ambre' : 'bg-corail'}`} aria-hidden />
  );

  // Tout va bien : une seule ligne discrète. La carte complète reste affichée dès qu'il y a quelque chose à faire.
  const healthy = !!status?.gameFound && status.bepinex && !!installed && (upToDate || latest.isError);
  // Signale à l'en-tête si le plugin demande une action (réglages ouverts d'office, pastille sur le bouton).
  const known = !gameDir || !!status;
  useEffect(() => {
    if (known) onHealth?.(healthy);
  }, [known, healthy, onHealth]);
  if (gameDir && !status) return null;
  if (healthy && !open)
    return (
      <p className="mt-1 flex items-center gap-2 text-xs text-brun">
        <span className="h-2 w-2 rounded-full bg-eau" aria-hidden />
        {t('fm.bridge.compact', { version: installed })}
        <button type="button" className="font-bold text-orange-fonce hover:underline" onClick={() => setOpen(true)}>
          {t('fm.bridge.details')}
        </button>
      </p>
    );

  return (
    <section className="rounded-xl bg-creme/60 p-4 ring-1 ring-canard/10">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">{t('fm.bridge.title')}</h2>
        {healthy && (
          <button type="button" className="text-sm font-bold text-orange-fonce hover:underline" onClick={() => setOpen(false)}>
            {t('fm.bridge.hide')}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-brun">{t('fm.bridge.intro')}</p>

      <label className="mt-4 block text-sm font-bold">
        {t('fm.bridge.gameDir')}
        <input className="input mt-1 font-normal" value={gameDir} onChange={(e) => setGameDir(e.target.value)} />
      </label>

      {status && (
        <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <li className="flex gap-2">
            {dot(status.gameFound)}
            {status.gameFound ? t('fm.bridge.gameFound') : t('fm.bridge.gameMissing')}
          </li>
          <li className="flex gap-2">
            {dot(status.bepinex)}
            <span>
              {status.bepinex
                ? bepinex.data?.version
                  ? t('fm.bridge.bepinexVersion', { version: bepinex.data.version })
                  : t('fm.bridge.bepinex')
                : t('fm.bridge.bepinexMissing')}
              {bepinex.data?.ours && !status.running && (
                <button
                  type="button"
                  className="ml-2 text-xs font-bold text-orange-fonce hover:underline"
                  disabled={uninstallBepinex.isPending}
                  onClick={() => {
                    if (window.confirm(t('fm.bridge.bepinexUninstallConfirm'))) uninstallBepinex.mutate();
                  }}
                >
                  {t('fm.bridge.bepinexUninstall')}
                </button>
              )}
            </span>
          </li>
          <li className="flex gap-2">
            {dot(!!installed, true)}
            {installed ? t('fm.bridge.installed', { version: installed }) : t('fm.bridge.notInstalled')}
          </li>
          <li className="flex gap-2">
            {dot(upToDate || !latest.isError, true)}
            {latest.isError ? t('fm.bridge.offline') : upToDate ? t('fm.bridge.upToDate') : latest.data ? t('fm.bridge.latest', { version: latest.data }) : '…'}
          </li>
          {bepinex.data?.present && bepinex.data.firstLaunch && !status.running && (
            <li className="flex gap-2 sm:col-span-2">
              {dot(false, true)}
              {t('fm.bridge.bepinexFirstLaunch')}
            </li>
          )}
          {status.running && (
            <li className="flex gap-2 sm:col-span-2">
              {dot(false, true)}
              {t('fm.bridge.running')}
            </li>
          )}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!upToDate && (
          <button type="button" className="btn-primary" disabled={!canInstall || install.isPending} onClick={() => install.mutate()}>
            {install.isPending && withBepinex
              ? t('fm.bridge.bepinexInstalling')
              : withBepinex
                ? t('fm.bridge.installWithBepinex')
                : installed && latest.data
                  ? t('fm.bridge.update', { version: latest.data })
                  : t('fm.bridge.install')}
          </button>
        )}
        {withBepinex && !upToDate && <p className="w-full text-xs text-brun">{t('fm.bridge.bepinexNote', { version: bepinex.data?.pinned ?? '' })}</p>}
        {install.isSuccess && <p className="text-sm text-canard">{t('fm.bridge.done')}</p>}
        {install.isError && <p className="text-sm text-corail">{t('fm.bridge.error', { reason: String(install.error?.message ?? install.error) })}</p>}
        {uninstallBepinex.isSuccess && <p className="text-sm text-canard">{t('fm.bridge.bepinexRemoved')}</p>}
        {uninstallBepinex.isError && (
          <p className="text-sm text-corail">{t('fm.bridge.error', { reason: String(uninstallBepinex.error?.message ?? uninstallBepinex.error) })}</p>
        )}
      </div>
    </section>
  );
}

type BridgeOption = { key: string; value: boolean };

/**
 * Ce que le plugin lit dans FM27, réglé depuis l'appli : FM Immersion modifie le fichier de configuration du plugin
 * (BepInEx), plus besoin de l'ouvrir à la main. Le plugin relit ses réglages au lancement du jeu.
 */
export function FmBridgeOptions() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { gameDir, status } = useGameStatus();
  const ready = !!status?.gameFound && status.bepinex && !!status.installedVersion;
  const key = ['fm', 'bridge', 'options', gameDir];
  const options = useQuery({ queryKey: key, queryFn: () => invoke<BridgeOption[]>('fm_bridge_options', { gameDir }), enabled: ready });
  const [changed, setChanged] = useState(false);
  const set = useMutation({
    mutationFn: (o: BridgeOption) => invoke<BridgeOption[]>('fm_bridge_set_option', { gameDir, key: o.key, value: o.value }),
    onSuccess: (list) => {
      qc.setQueryData(key, list);
      setChanged(true);
    },
  });
  if (!ready || !options.data) return null;
  return (
    <section className="rounded-xl bg-white p-4 ring-1 ring-canard/10">
      <h2 className="font-display text-lg font-semibold">{t('fm.bridge.options.title')}</h2>
      <p className="mt-1 text-sm text-brun">{t('fm.bridge.options.intro')}</p>
      <ul className="mt-3 divide-y divide-canard/10">
        {options.data.map((o) => (
          <li key={o.key}>
            <label className="flex cursor-pointer items-start gap-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-orange-fonce"
                checked={o.value}
                disabled={set.isPending}
                onChange={(e) => set.mutate({ key: o.key, value: e.target.checked })}
              />
              <span>
                <span className="block font-bold">{t(`fm.bridge.options.${o.key}.label`)}</span>
                <span className="block text-sm text-brun">{t(`fm.bridge.options.${o.key}.help`)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {changed && <p className="mt-2 text-sm font-bold text-canard">{t(status?.running ? 'fm.bridge.options.restart' : 'fm.bridge.options.next')}</p>}
      {set.isError && <p className="mt-2 text-sm text-corail">{t('fm.bridge.options.error', { reason: String(set.error?.message ?? set.error) })}</p>}
    </section>
  );
}
