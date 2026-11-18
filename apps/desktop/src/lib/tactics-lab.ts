/**
 * Labo de tactiques : pilote FM Tactics Lab (serveur local lancé par `src-tauri/src/tactics_lab.rs`) pour faire
 * jouer un tournoi entre des tactiques du dossier `tactics`, puis garde le bilan de chaque rencontre.
 *
 * Le tournoi tourne dans ce module (et non dans l'écran) : on peut changer d'écran pendant les calculs.
 * Une seule série de matchs à la fois côté outil ; les rencontres passent l'une après l'autre.
 */
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { fixtures, matchScenario, pairTotals, tacticOf, type LabRun, type LabScenario, type LabTactic, type PairTotals } from '@fm-immersion/module-fm';

export interface SelfTest {
  compatible: boolean;
  canSimulate: boolean;
  reason: string | null;
}

export interface LabStatus {
  version: string;
  gameBuild: string;
  size: number;
  downloaded: boolean;
  extracted: boolean;
  selfTest: SelfTest | null;
  running: boolean;
  port: number | null;
  log: string;
}

export interface LabResults {
  names: string[];
  matches: number;
  pairs: PairTotals[];
  finishedAt: string | null;
}

type Phase = 'idle' | 'import' | 'run' | 'done' | 'error' | 'cancelled';

interface LabState {
  phase: Phase;
  error: string | null;
  /** Rencontre en cours (« A contre B ») et avancement. */
  current: string | null;
  doneMatches: number;
  totalMatches: number;
  eta: number | null;
  results: LabResults | null;
}

const STORE_KEY = 'fmi.lab.v1';

function loadResults(): LabResults | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as LabResults | null;
    return v && Array.isArray(v.pairs) ? v : null;
  } catch {
    return null;
  }
}

function saveResults(r: LabResults) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(r));
  } catch {
    /* stockage plein : le bilan reste affiché jusqu'à la fermeture */
  }
}

export const useLabStore = create<LabState>(() => ({
  phase: 'idle',
  error: null,
  current: null,
  doneMatches: 0,
  totalMatches: 0,
  eta: null,
  results: loadResults(),
}));

const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => invoke<T>('lab_call', { method, path, body: body ?? null });

let cancelled = false;
let currentJob: string | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bytesToBase64 = (bytes: number[]) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(s);
};

export const errorText = (e: unknown) => {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
};

/** Tactique d'un fichier du dossier, lue par le jeu lui-même (via l'outil), pour chaque côté du terrain. */
async function importTactic(folder: string, file: string, base: LabScenario): Promise<Record<string, LabTactic>> {
  const raw = await invoke<number[]>('fm_read_tactic_raw', { folder, name: file });
  const file_base64 = bytesToBase64(raw);
  const out: Record<string, LabTactic> = {};
  for (const side of [0, 1]) {
    const r = await call<{ scenario: LabScenario }>('POST', '/api/import-fmf', { side, scenario: base, file_base64 });
    out[String(side)] = tacticOf(r.scenario.teams[side]!);
  }
  return out;
}

interface Job {
  id: string;
  status: string;
  completed: number;
  total: number;
  eta_seconds?: number | null;
  error?: string;
  runs?: LabRun[];
}

/**
 * Tournoi entre les fichiers choisis : chaque tactique reçoit chacune des autres, `matches` matchs par rencontre.
 * Les noms affichés sont ceux des fichiers, sans l'extension.
 */
export async function runTournament(folder: string, files: string[], matches: number, workers: number) {
  const set = useLabStore.setState;
  cancelled = false;
  const names = files.map((f) => f.replace(/\.fmf$/i, ''));
  const pairs = fixtures(names);
  const results: LabResults = { names, matches, pairs: [], finishedAt: null };
  set({ phase: 'import', error: null, current: null, doneMatches: 0, totalMatches: pairs.length * matches, eta: null, results });
  try {
    const base = await call<LabScenario>('GET', '/api/defaults');
    const tactics: Record<string, Record<string, LabTactic>> = {};
    for (const [i, f] of files.entries()) {
      if (cancelled) throw new Error('cancelled');
      set({ current: names[i]! });
      try {
        tactics[names[i]!] = await importTactic(folder, f, base);
      } catch (e) {
        throw new Error(`${f} : ${errorText(e)}`);
      }
    }
    set({ phase: 'run' });
    const seeds = Array.from({ length: matches }, (_, i) => i + 1);
    for (const [k, [h, a]] of pairs.entries()) {
      if (cancelled) throw new Error('cancelled');
      set({ current: `${h} – ${a}` });
      const scenario = matchScenario(base, tactics[h]!, tactics[a]!);
      const { id } = await call<{ id: string }>('POST', '/api/run', { scenario, seeds, workers, event_details: false, name: `${h} vs ${a}` });
      currentJob = id;
      let job: Job;
      for (;;) {
        await sleep(2000);
        job = await call<Job>('GET', `/api/jobs/${id}`);
        const left = (pairs.length - k - 1) * matches + (job.total - job.completed);
        const perMatch = job.eta_seconds && job.total > job.completed ? job.eta_seconds / (job.total - job.completed) : null;
        set({ doneMatches: k * matches + job.completed, eta: perMatch ? Math.round(perMatch * left) : null });
        if (!['queued', 'running'].includes(job.status)) break;
      }
      currentJob = null;
      if (cancelled) throw new Error('cancelled');
      if (job.status !== 'complete') throw new Error(job.error || job.status);
      results.pairs = [...results.pairs, pairTotals(h, a, job.runs ?? [])];
      set({ results: { ...results } });
      saveResults(results);
    }
    results.finishedAt = new Date().toISOString();
    saveResults(results);
    set({ phase: 'done', current: null, eta: null, results: { ...results } });
  } catch (e) {
    currentJob = null;
    if (cancelled) set({ phase: 'cancelled', current: null, eta: null });
    else set({ phase: 'error', error: errorText(e), current: null, eta: null });
  }
}

export async function cancelTournament() {
  cancelled = true;
  if (currentJob) await call('POST', '/api/cancel', { id: currentJob }).catch(() => undefined);
}

export const isBusy = (p: Phase) => p === 'import' || p === 'run';
