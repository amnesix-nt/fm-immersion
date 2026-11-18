import { describe, expect, it } from 'vitest';
import { fixtures, matchScenario, neutralize, pairTotals, ranking, ratingOf, tacticOf, type LabScenario, type LabTeam } from '../src/tactics-lab';

const team = (name: string): LabTeam => ({
  name,
  tactic_name: 'base',
  mentality: 4,
  players: Array.from({ length: 12 }, () => ({ attributes: Array.from({ length: 69 }, () => 10), native_profile: { morale: 20 } })),
  lineup: Array.from({ length: 11 }, (_, i) => i),
  phases: [
    ['GK', 'DR', 'DC', 'DC', 'DL', 'DM', 'MC', 'MC', 'AMR', 'AML', 'ST'].map((position) => ({ position })),
    ['GK', 'DR', 'DC', 'DC', 'DL', 'DM', 'MC', 'MC', 'MR', 'ML', 'ST'].map((position) => ({ position })),
  ],
  opposition: { players: [{ press: 1 }], positions: { ST: { press: 2 } } },
  setpieces: { routines: { '0': [] } },
  native_source_plan: { signature: 'base' },
});

describe('labo de tactiques', () => {
  it('neutralise l\'effectif : attributs à 75, familiarité 20 aux postes des deux phases', () => {
    const t = team('x');
    neutralize(t);
    const gk = t.players[0]!.attributes;
    expect(gk[0]).toBe(20);
    expect(gk[1]).toBe(1);
    expect(gk.slice(15).every((v) => v === 75)).toBe(true);
    expect(t.players[8]!.attributes[11]).toBe(20); // AMR avec ballon
    expect(t.players[8]!.attributes[8]).toBe(20); // MR sans ballon
    expect(t.players[11]!.attributes[0]).toBe(1); // remplaçant : aucune familiarité ajoutée
    expect(t.players[0]!.native_profile).toMatchObject({ morale: 20, pressure: 15, age: 26 });
    expect(t.opposition).toEqual({ players: [{ press: 0, mark: 0, tackle: 0, foot: 0, personal: true }], positions: { ST: { press: 0, mark: 0, tackle: 0, foot: 0, personal: true } } });
  });

  it('monte une rencontre sans toucher au scénario de base', () => {
    const base: LabScenario = { teams: [team('A'), team('B')] };
    const imported = { ...team('A'), tactic_name: 'Pivot Gang', mentality: 5, native_source_plan: { signature: 'pg' } };
    const pg = { '0': tacticOf(imported), '1': tacticOf({ ...imported, native_source_plan: { signature: 'pg1' } }) };
    const other = { '0': tacticOf({ ...team('x'), tactic_name: 'Autre' }), '1': tacticOf({ ...team('x'), tactic_name: 'Autre', native_source_plan: { signature: 'o1' } }) };
    const sc = matchScenario(base, pg, other);
    expect(sc.teams[0]).toMatchObject({ name: 'Home', tactic_name: 'Pivot Gang', mentality: 5, native_source_plan: { signature: 'pg' } });
    expect(sc.teams[1]).toMatchObject({ name: 'Away', tactic_name: 'Autre', native_source_plan: { signature: 'o1' } });
    expect(base.teams[0]!.tactic_name).toBe('base');
    expect(base.teams[0]!.players[0]!.attributes[20]).toBe(10);
  });

  it('classe les tactiques avec domicile, extérieur et adversaires', () => {
    const run = (h: number, a: number, xh = 1, xa = 1) => ({ result: { score: [h, a] as [number, number] }, statistics: { teams: [{ xg: xh }, { xg: xa }] } });
    const pairs = [
      pairTotals('A', 'B', [run(2, 0, 2, 0.5), run(1, 1)]),
      pairTotals('B', 'A', [run(0, 1), run(0, 0)]),
    ];
    const [a, b] = ranking(pairs);
    expect(a!.name).toBe('A');
    expect(a!.n).toBe(4);
    expect(a!.ppm).toBeCloseTo((3 + 1 + 3 + 1) / 4);
    expect(a!.homePpm).toBeCloseTo(2);
    expect(a!.awayPpm).toBeCloseTo(2);
    expect(a!.vs.B).toBeCloseTo(2);
    expect(a!.xgFor).toBeCloseTo((2 + 1 + 1 + 1) / 4);
    expect(b!.ppm).toBeCloseTo(0.5);
    expect(b!.ci).toBeGreaterThan(0);
  });

  it('note sur 20 et calendrier aller-retour', () => {
    expect(ratingOf(1.35)).toBe(10);
    expect(ratingOf(1.4)).toBeCloseTo(11);
    expect(ratingOf(3)).toBe(20);
    expect(ratingOf(0)).toBe(0);
    expect(fixtures(['A', 'B', 'C'])).toHaveLength(6);
  });
});
