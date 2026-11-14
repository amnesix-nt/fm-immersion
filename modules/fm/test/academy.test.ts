import { describe, expect, it } from 'vitest';
import { academy, ageLimitOf, type YouthTeam } from '../src';
import { normalizePlayer } from '../src/player';

const pl = (id: number, age: number, potential: number | null, contractEnd: string | null) => ({
  ...normalizePlayer({ id, name: `J${id}`, positions: 'M (C)', age, contractEnd, attributes: { Passing: 10 } }),
  stars: { current: 2, potential },
});
const row = (p: ReturnType<typeof pl>, status: YouthTeam['rows'][number]['status'], fit = 10) => ({
  plan: { player: p, role: null, phase: 'ip' as const, fit, weak: [], slot: null },
  status,
  focus: null,
});
const team = (name: string, rows: YouthTeam['rows']): YouthTeam => {
  const counts = { promote: 0, loan: 0, develop: 0, low: 0 };
  for (const r of rows) counts[r.status]++;
  return { team: name, rows, counts };
};

describe('académie', () => {
  it('lit la limite d’âge dans le nom de l’équipe', () => {
    expect(ageLimitOf('Slutsk U19')).toBe(19);
    expect(ageLimitOf('Équipe U-21')).toBe(21);
    expect(ageLimitOf('Slutsk-2')).toBeNull();
  });

  it('bilan par équipe, alertes rangées et meilleurs espoirs', () => {
    const a = academy(
      [
        team('Slutsk U19', [row(pl(1, 16, 4, '2029-12-31'), 'develop', 9), row(pl(2, 19, 3, '2027-06-30'), 'loan'), row(pl(3, 17, 5, null), 'promote', 14)]),
        team('Slutsk-2', [row(pl(4, 21, 2, '2027-05-01'), 'low'), row(pl(5, 22, 1, null), 'low')]),
      ],
      '2027-03-19',
    );
    expect(a.teams.map((t) => [t.team, t.size, t.ageLimit])).toEqual([
      ['Slutsk U19', 3, 19],
      ['Slutsk-2', 2, null],
    ]);
    expect(a.teams[0]!.avgAge).toBeCloseTo(52 / 3);
    expect(a.alerts.map((x) => [x.kind, x.player.id])).toEqual([
      ['promote', '3'],
      ['contract', '2'],
      ['ageOut', '2'],
      ['release', '4'],
      ['release', '5'],
    ]);
    expect(a.alerts.find((x) => x.kind === 'contract')!.days).toBe(103);
    expect(a.prospects[0]!.player.id).toBe('3');
  });
});
