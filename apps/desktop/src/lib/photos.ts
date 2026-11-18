import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

/**
 * Photos de situation : moteur d'images téléchargé sur clic du joueur (ComfyUI portable, Qwen Image Edit 2511,
 * OWLv2 ; ~34 Go), rangé dans `%LOCALAPPDATA%\app.fmimmersion.desktop\photos`. Le manifeste (adresses épinglées,
 * tailles, SHA-256) est embarqué dans l'exe : voir `src-tauri/photos-manifest.json` et `photos_remote.rs`.
 */
export type PhotosFileState = 'ready' | 'partial' | 'missing';
export type PhotosFileStatus = {
  name: string;
  component: 'comfyui' | 'qwen' | 'owlv2';
  size: number;
  onDisk: number;
  state: PhotosFileState;
};
export type PhotosStatus = {
  dir: string;
  manifestVersion: string;
  comfyuiVersion: string;
  total: number;
  onDisk: number;
  ready: boolean;
  downloading: boolean;
  files: PhotosFileStatus[];
};
export type PhotosProgress = {
  name: string;
  component: string;
  received: number;
  size: number;
  doneBytes: number;
  totalBytes: number;
};

export const PHOTOS_STATUS_KEY = ['photos', 'status'] as const;

/** État du moteur sur ce PC (fichiers complets, partiels, manquants). */
export function usePhotosStatus() {
  return useQuery({
    queryKey: PHOTOS_STATUS_KEY,
    queryFn: () => invoke<PhotosStatus>('photos_remote_status'),
  });
}

/** Avancement du téléchargement en cours (null hors téléchargement). */
export function usePhotosProgress(active: boolean) {
  const [progress, setProgress] = useState<PhotosProgress | null>(null);
  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const off = listen<PhotosProgress>('photos-download', (e) => setProgress(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, [active]);
  return progress;
}

/** Actions : télécharger ce qui manque (reprise automatique), arrêter, tout supprimer. */
export function usePhotosActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: PHOTOS_STATUS_KEY });
  return {
    download: async () => {
      try {
        return await invoke<PhotosStatus>('photos_remote_download');
      } finally {
        await refresh();
      }
    },
    cancel: () => invoke<void>('photos_remote_cancel'),
    /** Change le dossier du moteur et y déplace ce qui est déjà téléchargé (copie si autre disque). */
    setDir: async (dir: string) => {
      try {
        return await invoke<PhotosStatus>('photos_set_dir', { dir });
      } finally {
        await refresh();
        await qc.invalidateQueries({ queryKey: ENGINE_STATUS_KEY });
      }
    },
    remove: async () => {
      try {
        return await invoke<PhotosStatus>('photos_remote_remove');
      } finally {
        await refresh();
      }
    },
  };
}

/** Vérification avant téléchargement (`photos_precheck`) : disque du dossier choisi et carte graphique. */
export type PhotosPrecheck = {
  dir: string;
  freeBytes: number | null;
  neededBytes: number;
  gpuName: string | null;
  vramMib: number | null;
};

/** Mémoire vidéo sous laquelle le moteur ne tourne pas (annoncée sur l'écran : « au moins 8 Go »). */
export const MIN_VRAM_MIB = 8 * 1024;

export type PrecheckProblem =
  | { kind: 'space'; free: number; needed: number }
  | { kind: 'noGpu' }
  | { kind: 'vram'; name: string; vramMib: number };

/** Ce qui risque d'empêcher le moteur de marcher sur ce PC ; liste vide si rien à signaler. */
export function precheckProblems(p: PhotosPrecheck): PrecheckProblem[] {
  const out: PrecheckProblem[] = [];
  if (p.freeBytes !== null && p.freeBytes < p.neededBytes) out.push({ kind: 'space', free: p.freeBytes, needed: p.neededBytes });
  if (p.vramMib === null) out.push({ kind: 'noGpu' });
  else if (p.vramMib < MIN_VRAM_MIB) out.push({ kind: 'vram', name: p.gpuName ?? '', vramMib: p.vramMib });
  return out;
}

export function precheck() {
  return invoke<PhotosPrecheck>('photos_precheck');
}

export type MoveProgress = { done: number; total: number };

/** Avancement du déplacement du dossier (null hors déplacement, ou tant que c'est un simple renommage). */
export function useMoveProgress(active: boolean) {
  const [progress, setProgress] = useState<MoveProgress | null>(null);
  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const off = listen<MoveProgress>('photos-move', (e) => setProgress(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, [active]);
  return progress;
}

/** « 33,7 Go » / « 850 Mo », selon la langue. */
export function formatBytes(bytes: number, locale: string): string {
  const go = bytes / 1e9;
  const unit = locale.startsWith('fr') ? ['Go', 'Mo'] : ['GB', 'MB'];
  if (go >= 1) return `${go.toLocaleString(locale, { maximumFractionDigits: 1 })} ${unit[0]}`;
  return `${Math.round(bytes / 1e6).toLocaleString(locale)} ${unit[1]}`;
}

// ------------------------------------------------------------------ moteur (ComfyUI en processus annexe)

export type EngineStatus = {
  installed: boolean;
  running: boolean;
  port: number | null;
  comfyuiVersion: string | null;
  log: string;
};
export type EngineProgress = {
  step: 'extract' | 'start' | 'generate' | 'done';
  received: number;
  total: number;
};

export const ENGINE_STATUS_KEY = ['photos', 'engine'] as const;

export function useEngineStatus() {
  return useQuery({
    queryKey: ENGINE_STATUS_KEY,
    queryFn: () => invoke<EngineStatus>('photos_engine_status'),
  });
}

/** Avancement de l'extraction ou de l'image de test (null au repos). */
export function useEngineProgress(active: boolean) {
  const [progress, setProgress] = useState<EngineProgress | null>(null);
  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const off = listen<EngineProgress>('photos-engine', (e) => setProgress(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, [active]);
  return progress;
}

export function useEngineActions() {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ENGINE_STATUS_KEY });
    await qc.invalidateQueries({ queryKey: PHOTOS_STATUS_KEY });
  };
  const wrap = (cmd: string) => async () => {
    try {
      return await invoke<EngineStatus>(cmd);
    } finally {
      await refresh();
    }
  };
  return {
    install: wrap('photos_engine_install'),
    start: wrap('photos_engine_start'),
    stop: wrap('photos_engine_stop'),
    /**
     * Image de test (PNG) sous forme d'adresse blob à afficher, à libérer avec URL.revokeObjectURL.
     * `face` : la photo du coach (adresse `data:` PNG) si le joueur en a une.
     */
    test: async (face: string | null): Promise<string> => {
      try {
        const bytes = await invoke<ArrayBuffer>('photos_engine_test', { face: face ? dataUrlBytes(face) : null });
        return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      } finally {
        await refresh();
      }
    },
  };
}

/** Octets d'une adresse `data:` (même forme que pour `fm_write_coach_photo`). */
function dataUrlBytes(url: string): number[] {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------ scènes et bibliothèque

export type SceneRole = 'player' | 'coach' | 'duo' | 'front';
export type SceneInfo = {
  key: string;
  role: SceneRole;
  faces: number;
  injury: boolean;
  needsCoach: boolean;
  width: number;
  height: number;
};
export type CandidateReport = {
  seed: number;
  place: string;
  light: string;
  angle: string;
  accepted: boolean | null;
  score: number | null;
  reasons: string[];
};
export type Outcome = {
  scene: string;
  file: string;
  createdAt: string;
  seed: number;
  accepted: boolean | null;
  score: number | null;
  reasons: string[];
  logosBefore: number | null;
  logosAfter: number | null;
  /** Zones prises pour des logos (parts de l'image, x0 y0 x1 y1), avant nettoyage. */
  logoBoxes?: number[][];
  cleaned: boolean;
  regenerate: boolean;
  candidates: CandidateReport[];
  warnings: string[];
  seconds: number;
};
export type PipelineProgress = {
  step: 'prepare' | 'start' | 'generate' | 'gate' | 'logos' | 'cleanup' | 'save' | 'done';
  index: number;
  total: number;
};
export type GenerateRequest = {
  scene: string;
  /** Visages en PNG (adresses `data:` ou octets) : 1, ou 2 pour un duo (coach puis joueur). */
  faces: number[][];
  kit?: number[] | null;
  candidates?: number | null;
  seed?: number | null;
};

export const SCENES_KEY = ['photos', 'scenes'] as const;
export const LIBRARY_KEY = ['photos', 'library'] as const;

export function useScenes() {
  return useQuery({ queryKey: SCENES_KEY, queryFn: () => invoke<SceneInfo[]>('photos_scenes'), staleTime: Infinity });
}

export function useLibrary() {
  return useQuery({ queryKey: LIBRARY_KEY, queryFn: () => invoke<Outcome[]>('photos_library') });
}

/** Avancement d'une génération (null au repos). */
export function usePipelineProgress(active: boolean) {
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const off = listen<PipelineProgress>('photos-pipeline', (e) => setProgress(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, [active]);
  return progress;
}

export function usePipelineActions() {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    await qc.invalidateQueries({ queryKey: ENGINE_STATUS_KEY });
  };
  return {
    generate: async (request: GenerateRequest): Promise<Outcome> => {
      try {
        return await invoke<Outcome>('photos_generate', { request });
      } finally {
        await refresh();
      }
    },
    /** Image de la bibliothèque sous forme d'adresse blob, à libérer avec URL.revokeObjectURL. */
    read: async (file: string): Promise<string> => {
      const bytes = await invoke<ArrayBuffer>('photos_library_read', { file });
      return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    },
    delete: async (file: string) => {
      try {
        await invoke('photos_library_delete', { file });
      } finally {
        await refresh();
      }
    },
  };
}

/** Octets PNG d'une adresse `data:` ; une autre image (JPEG…) est redessinée en PNG. */
export async function imageToPngBytes(source: string | File): Promise<number[]> {
  if (typeof source === 'string' && source.startsWith('data:image/png')) return dataUrlBytes(source);
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image illisible'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')?.drawImage(img, 0, 0);
    return dataUrlBytes(canvas.toDataURL('image/png'));
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}
