import { describe, expect, it } from 'vitest';
import { precheckProblems, type PhotosPrecheck } from '../src/lib/photos';

const base: PhotosPrecheck = { dir: 'D:\\photos', freeBytes: 100e9, neededBytes: 40e9, gpuName: 'NVIDIA GeForce RTX 5070 Ti', vramMib: 16303 };

describe('vérification avant le téléchargement du moteur photo', () => {
  it('rien à signaler sur un PC qui convient', () => {
    expect(precheckProblems(base)).toEqual([]);
  });

  it('place insuffisante', () => {
    expect(precheckProblems({ ...base, freeBytes: 20e9 })).toEqual([{ kind: 'space', free: 20e9, needed: 40e9 }]);
  });

  it('place illisible : rien affirmé', () => {
    expect(precheckProblems({ ...base, freeBytes: null })).toEqual([]);
  });

  it('pas de carte NVIDIA', () => {
    expect(precheckProblems({ ...base, gpuName: null, vramMib: null })).toEqual([{ kind: 'noGpu' }]);
  });

  it('carte sous 8 Go', () => {
    expect(precheckProblems({ ...base, gpuName: 'NVIDIA GeForce GTX 1060 6GB', vramMib: 6144 })).toEqual([
      { kind: 'vram', name: 'NVIDIA GeForce GTX 1060 6GB', vramMib: 6144 },
    ]);
  });

  it('8 Go tout juste : accepté', () => {
    expect(precheckProblems({ ...base, vramMib: 8192 })).toEqual([]);
  });
});
