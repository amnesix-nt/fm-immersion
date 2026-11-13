import { describe, expect, it } from 'vitest';
import { alertGroups, fmDashboardCard, fmSnapshotSchema, mergeReference, monthsBetween, normalizePlayer, parsePositions, STAFF_MAX, STAFF_WEIGHT, TacticEngine, toNumber, withStaffOpinion } from '../src';

describe('postes', () => {
  it('lit les libellés français du jeu', () => {
    expect(parsePositions('D (DGC), MD')).toEqual(['DD', 'DC', 'DG', 'MDF']);
    expect(parsePositions('DL/M (G), MO (DG), BT')).toEqual(['DLG', 'MG', 'MOD', 'MOG', 'BT']);
    expect(parsePositions(['GB'])).toEqual(['GB']);
    expect(parsePositions('')).toEqual([]);
    // FM27 en français écrit « AL » pour le piston (arrière latéral).
    expect(parsePositions('D/AL/M/MO (G)')).toEqual(['DG', 'DLG', 'MG', 'MOG']);
    expect(parsePositions('AL (G)')).toEqual(['DLG']);
  });

  it('met le meilleur poste du joueur en tête, pas le premier du texte', () => {
    const p = normalizePlayer({ id: 1, name: 'K', positionsText: 'D/AL/M/MO (G)', bestPosition: 'AL (G)', positionRatings: { 'D (G)': 18, 'DL (G)': 20, 'M (G)': 15, 'MO (G)': 16 } });
    expect(p.positions).toEqual(['DLG', 'DG', 'MOG', 'MG']);
    expect(p.familiarity?.DLG).toBe(20);
    // Sans familiarité lue : ordre du terrain, comme avant.
    expect(normalizePlayer({ id: 2, name: 'F', positionsText: 'MD, M/MO (C), BT (C)' }).positions).toEqual(['MDF', 'MC', 'MOC', 'BT']);
  });
});

describe('joueur', () => {
  it('convertit les valeurs texte du jeu', () => {
    expect(toNumber('1,2 M€')).toBe(1_200_000);
    expect(toNumber('450K €')).toBe(450_000);
    expect(toNumber('85 %')).toBe(85);
    expect(toNumber('–')).toBeNull();
  });

  it('calcule le niveau sans les attributs propres aux gardiens', () => {
    const p = normalizePlayer({
      id: 7,
      name: '<b>Erik Lind</b>',
      positions: 'MO (D), BT',
      attributes: { Passing: 12, Pace: { min: 13, max: 15 }, Handling: 1 },
      condition: '91 %',
      injury: { description: 'Entorse', returnDays: 10 },
    });
    expect(p).toMatchObject({ id: '7', name: 'Erik Lind', positions: ['MOD', 'BT'], line: 'ATT', level: 13, condition: 91, injury: 'Entorse', injuryDays: 10 });
  });
});

describe('alertes', () => {
  const snap = fmSnapshotSchema.parse({
    schema: 'archivix/1',
    game: 'FM27',
    club: 'Vänersborgs IF',
    gameDate: '2026-08-29',
    players: [
      { id: 1, name: 'A', positions: 'GB', contractEnd: '2026-12-31', condition: 95 },
      { id: 2, name: 'B', positions: 'BT', contractEnd: '2028-06-30', condition: 70 },
      { id: 3, name: 'C', positions: 'D (C)', contractEnd: '2027-06-30', injury: 'Genou' },
    ],
  });
  const players = snap.players.map(normalizePlayer);

  it('compte les mois restants', () => {
    expect(monthsBetween('2026-08-29', '2026-12-31')).toBe(4);
    expect(monthsBetween('2026-08-29', '2027-06-30')).toBe(10);
  });

  it('ne garde que ce qui demande une action', () => {
    const g = alertGroups(players, snap.gameDate);
    expect(g.expiring.map((p) => p.name)).toEqual(['A']);
    expect(g.injured.map((p) => p.name)).toEqual(['C']);
    expect(g.tired.map((p) => p.name)).toEqual(['B']);
    const card = fmDashboardCard(players, snap.gameDate, snap.club);
    expect(card.alerts.map((a) => a.level)).toEqual(['urgent', 'warning', 'warning']);
    expect(card.meta).toBe('Vänersborgs IF');
  });

  it('refuse un fichier qui n’est pas un instantané Archivix', () => {
    expect(fmSnapshotSchema.safeParse({ schema: 'autre', players: [] }).success).toBe(false);
  });
});

describe('résumé', () => {
  it('lit les blocs club et prochain match quand ils sont là', async () => {
    const { summarize } = await import('../src');
    const snap = fmSnapshotSchema.parse({
      schema: 'archivix/1',
      game: 'FM27',
      club: 'Vänersborgs IF',
      gameDate: '2026-08-29',
      clubInfo: { transferBudget: 0, remainingWageBudget: '-310 €' },
      nextMatch: { opponent: 'Grebbestads IF', location: 'Domicile', inDays: 0, threatLevel: 'Match disputé', next5: [{ x: 1 }] },
      players: [
        { id: 1, name: 'A', age: 20, wage: 1000 },
        { id: 2, name: 'B', age: 30, wage: '450 €' },
      ],
    });
    const s = summarize(snap, snap.players.map(normalizePlayer));
    expect(s).toMatchObject({ players: 2, avgAge: 25, wages: 1450, wageRoom: -310, transferBudget: 0 });
    expect(s.nextMatch).toEqual({ opponent: 'Grebbestads IF', home: true, inDays: 0, competition: null, staffView: 'Match disputé' });
  });

  it('reste vide sans les blocs du plugin récent', async () => {
    const { summarize } = await import('../src');
    const snap = fmSnapshotSchema.parse({ schema: 'archivix/1', game: 'FM27', club: 'X', gameDate: '2026-08-29', players: [] });
    expect(summarize(snap, [])).toMatchObject({ wageRoom: null, transferBudget: null, nextMatch: null });
  });
});

describe('avis du staff dans les notes', () => {
  const mk = (id: number, stars: number | null, team?: string) =>
    normalizePlayer({ id, name: `J${id}`, positions: 'D (C)', attributes: { Marking: 12, Tackling: 12, Heading: 12, Positioning: 12, Strength: 12, JumpingReach: 12, Anticipation: 12 }, ...(stars != null ? { stars: { current: stars, potential: stars } } : {}), ...(team ? { team } : {}) });
  const engine = new TacticEngine(mergeReference(undefined)).absolute();
  const cb = [...engine.roles.values()].find((r) => engine.availableAt(r, 'DC', 'ip'))!.code;

  it('monte les joueurs mieux étoilés, baisse les autres, sans toucher aux joueurs sans étoiles', () => {
    const squad = withStaffOpinion([...Array.from({ length: 8 }, (_, i) => mk(i + 1, 4)), mk(20, 4.5), mk(21, 3.5), mk(22, null), mk(23, 1, 'U19')]);
    const by = (id: number) => squad.find((p) => p.id === String(id))!;
    expect(by(1).staffAdj).toBe(0);
    expect(by(20).staffAdj).toBe(STAFF_WEIGHT);
    expect(by(21).staffAdj).toBe(-STAFF_WEIGHT);
    expect(by(22).staffAdj).toBeUndefined();
    // Un jeune très en dessous : correction bornée.
    expect(by(23).staffAdj).toBe(-STAFF_MAX);
    const fit = (id: number) => engine.roleFit(by(id), cb, 'ip', 'DC')!;
    expect(fit(20) - fit(1)).toBeCloseTo(STAFF_WEIGHT, 5);
    expect(fit(1) - fit(21)).toBeCloseTo(STAFF_WEIGHT, 5);
    expect(fit(22)).toBe(fit(1));
  });

  it('ne corrige rien avec trop peu d’avis', () => {
    const squad = withStaffOpinion([mk(1, 4), mk(2, 3)]);
    expect(squad.every((p) => p.staffAdj === undefined)).toBe(true);
  });
});
