import { describe, expect, it } from 'vitest';
import { bestOf, depthAlerts, depthChart, formationKey, growthAt, progression, projectLevel, rotation, seasonStart, upcomingFixtures } from '../src';
import { normalizePlayer } from '../src/player';
import type { FmSnapshot } from '../src/snapshot';

const p = (id: number, pos: string, level: number, extra: Record<string, unknown> = {}) => normalizePlayer({ id, name: `J${id}`, positions: pos, level, ...extra });

describe('progression sur le CA réel', () => {
  it('mesure la tendance sur le CA, plafonnée par le PA, et en tire le niveau', async () => {
    const { withAbilities } = await import('../src/player');
    const at = (gameDate: string, ca: number) => ({ gameDate, players: [p(1, 'BT', 10, { age: 19, ca, pa: 120 })] });
    // +20 de CA en un an : à ce rythme il atteindrait 140 en deux ans, mais son PA est 120.
    const history = [at('2026-02-14', 80), at('2027-02-14', 100)];
    const now = p(1, 'BT', 10, { age: 19, ca: 100, pa: 120 });
    expect(projectLevel(now, 1, history)).toBeCloseTo(12);
    expect(projectLevel(now, 2, history)).toBeCloseTo(12);
    // Le CA/PA de la mémoire du jeu est joint aux joueurs par id.
    const snap = withAbilities({ players: [{ id: 7, name: 'X' }], abilities: { '7': { ca: 55, pa: -75 } } });
    const x = normalizePlayer(snap.players[0] as never);
    expect([x.ca, x.pa]).toEqual([55, null]);
    expect(x.hidden).toBeNull();
    // Les attributs cachés lus avec le CA/PA suivent ; une valeur hors 1-20 est écartée.
    const h = withAbilities({ players: [{ id: 7, name: 'X' }], abilities: { '7': { ca: 55, pa: 90, hidden: { Consistency: 14, Dirtiness: 0 } } } });
    expect(normalizePlayer(h.players[0] as never).hidden).toEqual({ Consistency: 14 });
  });
});

describe('progression et profondeur', () => {
  it('projette selon l’âge sans historique, selon la tendance avec', () => {
    const young = p(1, 'BT', 10, { age: 18 });
    expect(projectLevel(young, 2)).toBeCloseTo(10 + growthAt(18) + growthAt(19));
    const old = p(2, 'BT', 10, { age: 33 });
    expect(projectLevel(old, 1)).toBeLessThan(10);
    // Un an d'écart, +2 points : la tendance réelle l'emporte sur la courbe d'âge.
    const history = [
      { gameDate: '2026-01-01', players: [p(2, 'BT', 8, { age: 32 })] },
      { gameDate: '2027-01-01', players: [old] },
    ];
    expect(projectLevel(old, 1, history)).toBeCloseTo(12, 0);
  });

  it('repère la saison en cours (début en juillet)', () => {
    expect(seasonStart('2026-08-29')).toBe(2026);
    expect(seasonStart('2027-03-01')).toBe(2026);
  });

  it('reconnaît le schéma du jeu', () => {
    expect(formationKey('4-4-2')).toBe('4-4-2');
    expect(formationKey('Mon plan')).toBe('4-2-3-1');
    expect(formationKey(null)).toBe('4-2-3-1');
  });

  it('place titulaires et doublures, et signale qui peut passer devant', () => {
    const players = [
      p(1, 'BT', 13, { age: 30 }),
      p(2, 'BT', 12, { age: 31 }),
      p(3, 'BT', 11, { age: 18 }),
      p(4, 'BT', 12.5, { age: 25, injury: 'Entorse' }),
      p(5, 'GB', 12),
    ];
    const rows = depthChart(players, '4-4-2');
    const bt = rows.find((r) => r.pos === 'BT')!;
    expect(bt.count).toBe(2);
    // Le blessé n'est pas titulaire tant qu'un joueur valide existe.
    expect(bt.starters.map((s) => s.player.id)).toEqual(['1', '2']);
    expect(bt.subs.map((s) => [s.player.id, s.when])).toEqual([
      ['4', 0],
      ['3', 1],
    ]);
    expect(rows.find((r) => r.pos === 'DC')!.starters).toEqual([]);
    expect(depthAlerts(rows).map((a) => a.sub.player.id)).toEqual(['4', '3']);
  });

  it('suit l’évolution entre le premier et le dernier instantané', () => {
    const rows = progression([
      { gameDate: '2026-08-01', players: [p(1, 'BT', 10), p(2, 'MC', 12)] },
      { gameDate: '2026-10-01', players: [p(1, 'BT', 11.2), p(2, 'MC', 11.5), p(3, 'DC', 9)] },
    ]);
    expect(rows.map((r) => [r.player.id, r.delta])).toEqual([
      ['1', 1.2],
      ['3', 0],
      ['2', -0.5],
    ]);
    expect(rows[0]!.series).toEqual([10, 11.2]);
  });

  it('compte les points d’attributs depuis la première apparition du joueur', () => {
    const at = (gameDate: string, pass: number, pace: number) => ({ gameDate, players: [p(1, 'MC', 10, { attributes: { Passing: pass, Pace: pace, Stamina: 12 } })] });
    const rows = progression([
      { gameDate: '2026-01-01', players: [] },
      at('2026-03-01', 10, 14),
      at('2026-08-01', 12, 13),
      at('2026-10-01', 13, 13),
    ]);
    const r = rows[0]!;
    expect(r.since).toBe('2026-03-01');
    expect(r.points).toBe(2);
    expect(r.ups).toEqual([{ key: 'Passing', diff: 3 }]);
    expect(r.downs).toEqual([{ key: 'Pace', diff: -1 }]);
    // Il y a 90 jours ou plus : l'instantané du 1er mars (celui d'août est trop récent).
    expect(r.recent).toBe(2);
  });

  it('liste les prochains matchs avec l’écart entre eux, et la rotation', () => {
    const snap = {
      gameDate: '2026-09-01',
      fixtures: [
        { date: '2026-09-06', opponent: 'B', home: false },
        { date: '2026-08-20', opponent: 'Passé' },
        { date: '2026-09-03', opponent: 'A', competition: 'Coupe', home: true },
      ],
    } as unknown as FmSnapshot;
    expect(upcomingFixtures(snap).map((f) => [f.opponent, f.gap])).toEqual([
      ['A', null],
      ['B', 3],
    ]);
    const r = rotation([p(1, 'BT', 12, { condition: 80, sharpness: 60 }), p(2, 'BT', 6, { sharpness: 50 }), p(3, 'BT', 12, { condition: 95 })]);
    expect(r.tired.map((x) => x.id)).toEqual(['1']);
    expect(r.rusty.map((x) => x.id)).toEqual(['1']);
  });

  it('repère la meilleure valeur d’une ligne', () => {
    expect(bestOf([12, null, 15])).toBe(15);
    expect(bestOf([12, null])).toBeNull();
    expect(bestOf([12, 12])).toBeNull();
  });
});
