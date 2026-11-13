import { beforeEach, describe, expect, it } from 'vitest';
import { FmOtherSaveError, fmRepo, freeConfirmed } from '../src/lib/fm';
import { savesRepo } from '../src/lib/saves';
import { memoryDb } from './memory-db';

const snap = (gameDate: string, names: string[]) => ({
  schema: 'archivix/1',
  game: 'FM27',
  club: 'Vänersborgs IF',
  gameDate,
  players: names.map((name, i) => ({ id: i + 1, name, positions: 'BT' })),
});

describe('instantanés Football Manager', () => {
  let saves: ReturnType<typeof savesRepo>;
  let fm: ReturnType<typeof fmRepo>;
  beforeEach(() => {
    const db = memoryDb() as never;
    saves = savesRepo(db);
    fm = fmRepo(db);
  });

  it('garde la gazette rédigée par l’IA tant que ses faits ne changent pas', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'Malženice' });
    const w = { title: 'T', article: 'A', editorial: 'E', fans: 'F', board: 'B' };
    expect(await fm.writing(save.id, '2027-09-27', 'abc')).toBeNull();
    await fm.saveWriting(save.id, '2027-09-27', 'abc', w, 'ollama/gemma3:12b');
    expect(await fm.writing(save.id, '2027-09-27', 'abc')).toEqual(w);
    expect(await fm.writing(save.id, '2027-09-27', 'def')).toBeNull();
    await fm.saveWriting(save.id, '2027-09-27', 'def', { ...w, title: 'T2' }, 'ollama/gemma3:12b');
    expect((await fm.writing(save.id, '2027-09-27', 'def'))?.title).toBe('T2');
  });

  it('garde une conférence de presse par match et par moment, la dernière réponse l’emporte', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'Malženice' });
    const row = {
      saveId: save.id,
      key: 'post|Malženice|Nitra|2027-09-28',
      kind: 'post' as const,
      matchDate: '2027-09-28',
      club: 'Malženice',
      opponent: 'Nitra',
      competition: '2. liga',
      questions: [{ id: 'result' as const, text: 'Victoire 2-1 contre Nitra ?' }],
      answers: [{ question: 'result' as const, tone: 'calm' as const, text: 'Une bonne victoire.' }],
    };
    await fm.savePressConference(row);
    await fm.savePressConference({ ...row, answers: [] });
    const held = await fm.pressConferences(save.id);
    expect(held).toHaveLength(1);
    expect(held[0]!.answers).toEqual([]);
    expect(held[0]!.questions[0]!.text).toBe('Victoire 2-1 contre Nitra ?');
  });

  it('joint le CA/PA lus en mémoire à l’instantané de la date et les garde quand le plugin le réécrit', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'Malženice' });
    await fm.importSnapshot(save.id, snap('2027-02-14', ['A', 'B']));
    expect(await fm.attachAbilities(save.id, '2027-02-21', [{ id: 1, ca: 90, pa: 140 }])).toBe(false);
    expect(await fm.attachAbilities(save.id, '2027-02-14', [{ id: 1, ca: 90, pa: 140 }])).toBe(true);
    await fm.importSnapshot(save.id, snap('2027-02-14', ['A', 'B']));
    expect((await fm.latest(save.id))?.data.abilities).toEqual({ '1': { ca: 90, pa: 140 } });
    // Nouvelle date : pas de CA/PA tant qu'ils n'ont pas été relus.
    await fm.importSnapshot(save.id, snap('2027-02-21', ['A', 'B']));
    expect((await fm.latest(save.id))?.data.abilities).toBeUndefined();
  });

  it('n’enregistre jamais deux fois la même date, même avec deux imports simultanés', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'Malženice' });
    await Promise.all([fm.importSnapshot(save.id, snap('2027-03-01', ['A'])), fm.importSnapshot(save.id, snap('2027-03-01', ['A', 'B']))]);
    expect((await fm.history(save.id)).map((h) => h.gameDate)).toEqual(['2027-03-01']);
  });

  it('ne perd aucune modification des réglages faite en même temps', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'Malženice' });
    await Promise.all([
      fm.setLeaving(save.id, '1', { reason: 'sell', since: '2027-01-01' } as never),
      fm.setLeaving(save.id, '2', { reason: 'sell', since: '2027-01-01' } as never),
      fm.updateSettings(save.id, { fmReadAbilities: true }),
      fm.updateSettings(save.id, { coachPhoto: 'data:image/png;base64,AA==' }),
    ]);
    const s = await fm.settings(save.id);
    expect(Object.keys(s.fmLeaving ?? {}).sort()).toEqual(['1', '2']);
    expect(s.fmReadAbilities).toBe(true);
    expect(s.coachPhoto).toBe('data:image/png;base64,AA==');
  });

  it("garde un instantané par date de jeu et renvoie le plus récent", async () => {
    const save = await saves.create({ gameId: 'fm', name: 'Vänersborg' });
    await fm.importSnapshot(save.id, snap('2026-08-29', ['A']));
    await fm.importSnapshot(save.id, snap('2026-09-05', ['A', 'B']));
    await fm.importSnapshot(save.id, snap('2026-09-05', ['A', 'B', 'C']));

    expect((await fm.history(save.id)).map((h) => [h.gameDate, h.playerCount])).toEqual([
      ['2026-09-05', 3],
      ['2026-08-29', 1],
    ]);
    const latest = await fm.latest(save.id);
    expect(latest?.data.players.map((p) => p.name)).toEqual(['A', 'B', 'C']);
    expect((await fm.all(save.id)).map((h) => [h.gameDate, h.data.players.length])).toEqual([
      ['2026-08-29', 1],
      ['2026-09-05', 3],
    ]);
  });

  it('refuse un fichier inconnu sans rien enregistrer', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'X' });
    await expect(fm.importSnapshot(save.id, { schema: 'autre' })).rejects.toThrow();
    expect(await fm.latest(save.id)).toBeNull();
  });

  it('mémorise le dossier du plugin dans la partie', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'X' });
    await fm.setFolder(save.id, 'D:\\Sports Interactive\\Football Manager 27\\archivix');
    expect(await fm.settings(save.id)).toEqual({ fmFolder: 'D:\\Sports Interactive\\Football Manager 27\\archivix' });
  });

  it('garde les cibles du mercato d\'un instantané à l\'autre', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'V' });
    const cible = (id: number, name: string, club: string) => ({ id, name, club, positions: 'M (C)', attributes: { Passing: { min: 11, max: 14 } }, scout: { knowledge: 60 }, sources: ['listeSuivi'] });
    await fm.importSnapshot(save.id, { ...snap('2026-09-01', ['A']), shortlist: [cible(10, 'Cible Un', 'IFK'), cible(11, 'Cible Deux', 'GAIS')] });
    // Instantané sans bloc de cibles (lecture désactivée) : la base ne bouge pas.
    await fm.importSnapshot(save.id, snap('2026-09-02', ['A']));
    expect((await fm.targets(save.id)).filter((t) => t.inList)).toHaveLength(2);

    await fm.importSnapshot(save.id, { ...snap('2026-09-08', ['A']), shortlist: [cible(11, 'Cible Deux', 'Örgryte')] });
    const rows = await fm.targets(save.id);
    const deux = rows.find((t) => t.playerId === '11')!;
    expect([deux.club, deux.firstSeen, deux.lastSeen, deux.inList]).toEqual(['Örgryte', '2026-09-01', '2026-09-08', true]);
    const un = rows.find((t) => t.playerId === '10')!;
    expect([un.inList, un.lastSeen]).toEqual([false, '2026-09-01']);

    await fm.dismissTarget(save.id, '10', true);
    expect((await fm.targets(save.id)).find((t) => t.playerId === '10')?.dismissed).toBe(true);
  });

  it('garde les partants signalés dans la partie et annule un signalement', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'Malženice' });
    await fm.setLeaving(save.id, '7', { reason: 'refused', since: '2026-12-01', name: 'Nicolás Gorosito' });
    await fm.setLeaving(save.id, '8', { reason: 'sold', since: '2026-12-02', name: 'Marek Fábry' });
    expect(Object.keys((await fm.settings(save.id)).fmLeaving ?? {})).toEqual(['7', '8']);
    expect((await fm.settings(save.id)).fmLeaving?.['7']?.reason).toBe('refused');
    await fm.setLeaving(save.id, '8', null);
    await fm.setLeaving(save.id, '7', null);
    expect((await fm.settings(save.id)).fmLeaving).toBeUndefined();
  });

  it("lie la partie à une sauvegarde FM27 et défait le lien", async () => {
    const save = await saves.create({ gameId: 'fm', name: 'V' });
    await fm.setFolder(save.id, 'D:\\FM\\archivix');
    await fm.linkSave(save.id, 'Vänersborgs.fm');
    expect(await fm.settings(save.id)).toEqual({ fmFolder: 'D:\\FM\\archivix', fmSaveFile: 'Vänersborgs.fm' });
    await fm.linkSave(save.id, null);
    expect(await fm.settings(save.id)).toEqual({ fmFolder: 'D:\\FM\\archivix' });
  });

  it("refuse l'instantané d'une autre sauvegarde (autre club), sauf confirmation", async () => {
    const save = await saves.create({ gameId: 'fm', name: 'V' });
    await fm.importSnapshot(save.id, snap('2026-08-29', ['A']));
    expect((await fm.settings(save.id)).fmClub).toBe('Vänersborgs IF');

    const autre = { ...snap('2031-03-01', ['Z']), club: 'IFK Göteborg' };
    const err = await fm.importSnapshot(save.id, autre).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FmOtherSaveError);
    expect([(err as FmOtherSaveError).club, (err as FmOtherSaveError).expected]).toEqual(['IFK Göteborg', 'Vänersborgs IF']);
    expect((await fm.latest(save.id))?.club).toBe('Vänersborgs IF');

    // Changement de club dans la même carrière : confirmé, le nouveau club devient celui de la partie.
    await fm.importSnapshot(save.id, autre, { force: true });
    expect((await fm.settings(save.id)).fmClub).toBe('IFK Göteborg');
    await fm.importSnapshot(save.id, { ...autre, gameDate: '2031-03-02' });
    expect((await fm.history(save.id)).length).toBe(3);
  });

  it("ne prend pas dans une carrière neuve le relevé encore laissé par la sauvegarde d'une autre carrière", async () => {
    const ancienne = await saves.create({ gameId: 'fm', name: 'test' });
    await fm.importSnapshot(ancienne.id, snap('2028-03-11', ['A']));
    const neuve = await saves.create({ gameId: 'fm', name: 'New One' });
    const err = await fm.importSnapshot(neuve.id, snap('2028-03-11', ['A'])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FmOtherSaveError);
    expect((err as FmOtherSaveError).career).toBe('test');
    expect(await fm.latest(neuve.id)).toBeNull();
    expect((await fm.settings(neuve.id)).fmClub).toBeUndefined();
    // Premier relevé de la nouvelle sauvegarde (autre date) : pris tout seul.
    await fm.importSnapshot(neuve.id, snap('2026-07-21', ['B']));
    expect((await fm.latest(neuve.id))?.gameDate).toBe('2026-07-21');
    expect([...(await fm.datesElsewhere(neuve.id, 'Vänersborgs IF'))]).toEqual(['2028-03-11']);
    // Confirmé par le joueur (deux carrières pour la même sauvegarde) : accepté.
    const copie = await saves.create({ gameId: 'fm', name: 'Copie' });
    await fm.importSnapshot(copie.id, snap('2028-03-11', ['A']), { force: true });
    expect((await fm.latest(copie.id))?.gameDate).toBe('2028-03-11');
  });

  it('reprend le club des instantanés déjà importés avant le lien', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'V' });
    await fm.importSnapshot(save.id, snap('2026-08-29', ['A']));
    await fm.updateSettings(save.id, { fmClub: undefined });
    await expect(fm.importSnapshot(save.id, { ...snap('2026-09-01', ['A']), club: 'GAIS' })).rejects.toBeInstanceOf(FmOtherSaveError);
  });

  it('reprend tout seul le nouveau club après une période sans club', async () => {
    const save = await saves.create({ gameId: 'fm', name: 'V' });
    await fm.importSnapshot(save.id, snap('2026-11-01', ['A']));
    // État d'une autre sauvegarde, plus ancien que la partie : ignoré.
    await fm.noteStatus(save.id, { schema: 'archivix-status/1', gameDate: '2025-01-01', club: null });
    expect((await fm.settings(save.id)).fmFreeSince).toBeUndefined();

    await fm.noteStatus(save.id, { schema: 'archivix-status/1', gameDate: '2026-11-20', club: null });
    expect((await fm.settings(save.id)).fmFreeSince).toBe('2026-11-20');
    // L'ancien instantané relu au démarrage ne met pas fin à la période sans club.
    await fm.importSnapshot(save.id, snap('2026-11-01', ['A']));
    expect((await fm.settings(save.id)).fmFreeSince).toBe('2026-11-20');

    // Départ confirmé seulement quand le jeu avance sans club (faux « sans club » pendant un chargement, 13/11/2026).
    expect(freeConfirmed(await fm.settings(save.id))).toBeNull();
    await fm.noteStatus(save.id, { schema: 'archivix-status/1', gameDate: '2026-11-21', club: null });
    expect(freeConfirmed(await fm.settings(save.id))).toBe('2026-11-20');

    await fm.importSnapshot(save.id, { ...snap('2026-12-05', ['N']), club: 'Örgryte IS' });
    const st = await fm.settings(save.id);
    expect([st.fmClub, st.fmFreeSince, st.fmFreeSeen]).toEqual(['Örgryte IS', undefined, undefined]);
  });
});
