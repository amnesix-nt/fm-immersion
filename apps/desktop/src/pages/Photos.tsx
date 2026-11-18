import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHero } from '../components/PageHero';
import { PageTitle } from '../components/PageTitle';
import { PhotoScenes } from '../components/PhotoScenes';
import { libraryImage } from '../lib/photo-events';
import { useCareer } from '../lib/career';
import { fmData } from '../lib/data';
import {
  formatBytes,
  precheck,
  precheckProblems,
  useEngineActions,
  useEngineProgress,
  useEngineStatus,
  useMoveProgress,
  usePhotosActions,
  usePhotosProgress,
  usePhotosStatus,
  useLibrary,
  type PhotosFileStatus,
} from '../lib/photos';

const COMPONENTS = ['comfyui', 'qwen', 'owlv2'] as const;

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-creme ring-1 ring-canard/10">
      <div className={`h-full rounded-full ${done >= total && total > 0 ? 'bg-eau-soutenu' : 'bg-orange'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Photos de situation : moteur d'images téléchargé, installé et testé depuis l'appli. Tout reste sur le PC ;
 * rien n'est téléchargé sans clic. Les scènes et l'envoi vers Discord viennent dans les étapes suivantes.
 */
export function Photos() {
  const { t, i18n } = useTranslation();
  const status = usePhotosStatus();
  const engine = useEngineStatus();
  const files = usePhotosActions();
  const actions = useEngineActions();
  // Photo du coach de la carrière suivie (adresse data:), pour l'image de test.
  const { saveId } = useCareer();
  const { data: settings } = useQuery({ queryKey: ['fm', saveId, 'settings'], queryFn: () => fmData.settings(saveId), enabled: !!saveId });
  const coachPhoto = settings?.coachPhoto ?? null;
  // Dernière photo de la bibliothèque, pour le bandeau.
  const library = useLibrary();
  const last = (library.data ?? []).filter((o) => o.accepted !== false).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0] ?? null;
  const { data: lastUrl = null } = useQuery({ queryKey: ['photos', 'hero', last?.file], queryFn: async () => (await libraryImage(last!.file))?.src ?? null, enabled: !!last });
  const [testImage, setTestImage] = useState<string | null>(null);
  useEffect(() => () => void (testImage && URL.revokeObjectURL(testImage)), [testImage]);

  const download = useMutation({ mutationFn: files.download });
  // Avant les ~34 Go : carte graphique et place sur le disque. Les problèmes sont montrés, le joueur décide.
  const startDownload = async () => {
    let problems: string[] = [];
    try {
      problems = precheckProblems(await precheck()).map((p) =>
        p.kind === 'space'
          ? t('photos.precheck.space', { free: fmt(p.free), needed: fmt(p.needed) })
          : p.kind === 'noGpu'
            ? t('photos.precheck.noGpu')
            : t('photos.precheck.vram', { name: p.name, vram: (p.vramMib / 1024).toFixed(0) }),
      );
    } catch {
      problems = [];
    }
    if (problems.length && !window.confirm(`${problems.join('\n\n')}\n\n${t('photos.precheck.confirm')}`)) return;
    download.mutate();
  };
  const remove = useMutation({ mutationFn: files.remove });
  const install = useMutation({ mutationFn: actions.install });
  const stop = useMutation({ mutationFn: actions.stop });
  const test = useMutation({
    mutationFn: () => actions.test(coachPhoto),
    onSuccess: (url) => {
      if (testImage) URL.revokeObjectURL(testImage);
      setTestImage(url);
    },
  });
  const [dirInput, setDirInput] = useState<string | null>(null);
  const move = useMutation({ mutationFn: files.setDir, onSuccess: () => setDirInput(null) });
  const moveProgress = useMoveProgress(move.isPending);
  const downloading = download.isPending || !!status.data?.downloading;
  const dlProgress = usePhotosProgress(downloading);
  const engProgress = useEngineProgress(install.isPending || test.isPending);
  const busy = downloading || install.isPending || test.isPending || remove.isPending || move.isPending;

  const s = status.data;
  const e = engine.data;
  const fmt = (n: number) => formatBytes(n, i18n.language);
  const state: 'missing' | 'partial' | 'downloaded' | 'ready' = !s
    ? 'missing'
    : e?.installed && s.ready
      ? 'ready'
      : s.ready
        ? 'downloaded'
        : s.onDisk > 0
          ? 'partial'
          : 'missing';
  const error = [download.error, install.error, test.error, remove.error, stop.error].find(Boolean);
  const byComponent = (c: (typeof COMPONENTS)[number]) => (s?.files ?? []).filter((f) => f.component === c);
  const sum = (fs: PhotosFileStatus[], k: 'size' | 'onDisk') => fs.reduce((a, f) => a + f[k], 0);

  return (
    <div className="page">
      {/* Même en-tête que les autres écrans de Médias : surtitre, titre, une phrase. */}
      <PageTitle eyebrow={t('topbar.media')} title={t('photos.title')}>
        {t('photos.intro')} {t('photos.size', { size: s ? fmt(s.total) : '…' })}
      </PageTitle>
      {/* Bandeau de la maquette : la dernière photo faite, sinon le stade dessiné. */}
      <PageHero
        eyebrow={t('photos.hero.eyebrow')}
        title={last ? t('photos.hero.last', { date: new Date(last.createdAt).toLocaleDateString(i18n.language) }) : t('photos.hero.none')}
        text={t(`photos.hero.${state}`)}
        image={lastUrl}
      />

      <section className="card mt-6 max-w-3xl">
        <h2 className="text-lg font-semibold">{t('photos.engine.title')}</h2>
        <p className="mt-1 text-sm" role="status">
          {state === 'missing' && t('photos.state.missing')}
          {state === 'partial' &&
            s &&
            t('photos.state.partial', {
              onDisk: fmt(s.onDisk),
              total: fmt(s.total),
            })}
          {state === 'downloaded' && t('photos.engine.downloaded')}
          {state === 'ready' && t('photos.engine.ready', { version: e?.comfyuiVersion ?? '' })}
        </p>

        {downloading && dlProgress && (
          <div className="mt-3">
            <p className="text-sm text-brun">
              {t('photos.progress', {
                file: dlProgress.name,
                received: fmt(dlProgress.received),
                size: fmt(dlProgress.size),
                done: fmt(dlProgress.doneBytes),
                total: fmt(dlProgress.totalBytes),
              })}
            </p>
            <div className="mt-1">
              <Bar done={dlProgress.doneBytes} total={dlProgress.totalBytes} />
            </div>
          </div>
        )}
        {install.isPending && (
          <div className="mt-3">
            <p className="text-sm text-brun">{t('photos.engine.extracting')}</p>
            <div className="mt-1">
              <Bar done={engProgress?.step === 'extract' ? engProgress.received : 0} total={engProgress?.step === 'extract' ? engProgress.total : 1} />
            </div>
          </div>
        )}
        {test.isPending && <p className="mt-3 text-sm text-brun">{t(`photos.engine.test.${engProgress?.step === 'generate' ? 'generating' : 'starting'}`)}</p>}

        <div className="mt-4 flex flex-wrap gap-3">
          {(state === 'missing' || state === 'partial') && !downloading && (
            <button type="button" className="btn-primary" onClick={() => void startDownload()} disabled={busy}>
              {t(state === 'partial' ? 'photos.resume' : 'photos.download')}
            </button>
          )}
          {downloading && (
            <button type="button" className="btn-secondary" onClick={() => files.cancel()}>
              {t('photos.cancel')}
            </button>
          )}
          {state === 'downloaded' && (
            <button type="button" className="btn-primary" onClick={() => install.mutate()} disabled={busy}>
              {t('photos.engine.install')}
            </button>
          )}
          {state === 'ready' && (
            <button type="button" className="btn-primary" onClick={() => test.mutate()} disabled={busy}>
              {t('photos.engine.test.button')}
            </button>
          )}
          {e?.running && (
            <button type="button" className="btn-secondary" onClick={() => stop.mutate()} disabled={busy}>
              {t('photos.engine.stop')}
            </button>
          )}
          {s && s.onDisk > 0 && !downloading && (
            <button
              type="button"
              className="btn bg-white text-corail ring-1 ring-corail/40 hover:bg-corail/10"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('photos.removeConfirm', { total: fmt(s.onDisk) }))) remove.mutate();
              }}
            >
              {t('photos.remove')}
            </button>
          )}
        </div>
        {error ? <p className="mt-3 text-sm text-corail">{t('photos.error', { error: String(error) })}</p> : null}
        <p className="mt-3 text-xs text-brun">{t('photos.verifying')}</p>
        <p className="text-xs text-brun">{t('photos.sources')}</p>
      </section>

      {state === 'ready' && <PhotoScenes coachPhoto={coachPhoto} disabled={busy} />}

      {testImage && (
        <section className="card mt-6 max-w-3xl">
          <h2 className="text-lg font-semibold">{t('photos.engine.test.title')}</h2>
          <img src={testImage} alt={t('photos.engine.test.alt')} className="mt-3 w-full rounded-lg" />
          <p className="mt-2 text-xs text-brun">{t('photos.engine.test.note')}</p>
        </section>
      )}

      {s && (
        <section className="card mt-6 max-w-3xl">
          <h2 className="text-lg font-semibold">{t('photos.files.title')}</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {COMPONENTS.map((c) => {
              const fs = byComponent(c);
              const size = sum(fs, 'size');
              const done = sum(fs, 'onDisk');
              return (
                <li key={c}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span>
                      {t(`photos.component.${c}`, {
                        version: s.comfyuiVersion,
                      })}
                    </span>
                    <span className="text-brun">
                      {fmt(done)} / {fmt(size)}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Bar done={done} total={size} />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-brun">{t('photos.dir', { dir: s.dir })}</p>
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const dir = (dirInput ?? s.dir).trim();
              if (dir && dir !== s.dir) move.mutate(dir);
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold">{t('photos.move.label')}</span>
              <input type="text" className="input" value={dirInput ?? s.dir} onChange={(e) => setDirInput(e.target.value)} disabled={busy} spellCheck={false} />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className="btn-secondary" disabled={busy || (dirInput ?? s.dir).trim() === s.dir}>
                {t('photos.move.button')}
              </button>
              {move.isPending && (
                <span className="text-sm text-brun" role="status">
                  {moveProgress ? t('photos.move.copying', { done: fmt(moveProgress.done), total: fmt(moveProgress.total) }) : t('photos.move.moving')}
                </span>
              )}
            </div>
            {move.isPending && moveProgress && <Bar done={moveProgress.done} total={moveProgress.total} />}
            {move.error ? <p className="text-sm text-corail">{String(move.error)}</p> : null}
            <p className="text-xs text-brun">{t('photos.move.hint', { size: fmt(s.total) })}</p>
          </form>
        </section>
      )}
    </div>
  );
}
