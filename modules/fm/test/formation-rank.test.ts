import { describe, expect, it } from 'vitest';
import { ENGINE_GAINS, FORMATIONS, lineFits, mergeReference, rankFormations, rankTactics, TacticEngine, trainingGains, weakestOfPlan } from '../src';
import { normalizePlayer } from '../src/player';

const ATTRS = ['Passing', 'FirstTouch', 'Technique', 'Composure', 'Vision', 'Decisions', 'Teamwork', 'WorkRate', 'Stamina', 'Strength', 'Pace', 'Acceleration', 'Tackling', 'Marking', 'Positioning', 'Anticipation', 'Heading', 'JumpingReach', 'Finishing', 'Movement', 'Crossing', 'Dribbling', 'Flair', 'Concentration', 'Agility', 'Aggression', 'Reflexes', 'Handling', 'OneOnOnes', 'AerialReach', 'CommandOfArea', 'Kicking', 'RushingOut', 'Balance', 'NaturalFitness', 'Determination', 'Bravery', 'LongShots'];
const p = (id: number, positions: string, base: number) => normalizePlayer({ id, name: `J${id}`, positions, age: 26, attributes: Object.fromEntries(ATTRS.map((k) => [k, base])) });

const engine = new TacticEngine(mergeReference(undefined));
// Trois défenseurs centraux solides, pas de latéral : les schémas à trois derrière doivent passer devant.
const squad = [
  p(1, 'GB', 13),
  p(2, 'D (C)', 15),
  p(3, 'D (C)', 15),
  p(4, 'D (C)', 15),
  p(5, 'DL (G)', 13),
  p(6, 'DL (D)', 13),
  p(7, 'MD (C)', 13),
  p(8, 'M (C)', 13),
  p(9, 'M (C)', 13),
  p(10, 'BT', 14),
  p(11, 'BT', 14),
  p(12, 'M (C)', 8),
];

describe('classement des schémas selon l’effectif', () => {
  const rows = rankFormations(rankTactics(engine, squad));

  it('un schéma par ligne, tous les schémas, du meilleur au moins bon', () => {
    expect(rows.map((r) => r.form).sort()).toEqual(Object.keys(FORMATIONS).sort());
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.score).toBeGreaterThanOrEqual(rows[i]!.score);
  });

  it('garde le meilleur style de chaque schéma, comme le classement des tactiques', () => {
    const ranked = rankTactics(engine, squad);
    const row = rows.find((r) => r.form === '3-5-2')!;
    const best = Math.max(...ranked.flatMap((r) => r.plans.filter((pl) => pl.form === '3-5-2').map((pl) => pl.score - r.complexity)));
    expect(row.score).toBeCloseTo(best);
    expect(row.plan.form).toBe('3-5-2');
  });

  it('trois centraux et deux pistons : un schéma à trois derrière bat le 4-2-3-1', () => {
    const idx = (f: string) => rows.findIndex((r) => r.form === f);
    expect(idx('3-5-2')).toBeLessThan(idx('4-2-3-1'));
  });

  it('notes de ligne et poste le plus faible', () => {
    const row = rows.find((r) => r.form === '3-5-2')!;
    const lines = lineFits(row.plan);
    expect(lines.def).not.toBeNull();
    expect(lines.att).not.toBeNull();
    const weak = weakestOfPlan(row.plan)!;
    const fits = row.plan.slots.map((s) => (s.player ? (s.fit ?? 0) : -1));
    expect(fits[weak.slot]).toBe(Math.min(...fits));
  });

  it('un créneau vide est le poste le plus faible et compte 0 dans sa ligne', () => {
    const plan = { form: 'x', slots: [{ pos: 'DC', x: 0, y: 0, ip: '', oop: '', player: squad[1]!, fit: 14 }, { pos: 'DC', x: 0, y: 0, ip: '', oop: '', player: null, fit: null }], subs: [], score: 7, fit: 7, penalty: 0, holes: 1 } as never;
    expect(weakestOfPlan(plan)!.slot).toBe(1);
    expect(lineFits(plan).def).toBe(7);
    expect(lineFits(plan).mid).toBeNull();
  });
});

describe('quoi entraîner en premier', () => {
  const all = (v: number, over: Record<string, number> = {}) => ({ positions: ['MC' as const], attributes: { ...Object.fromEntries(Object.keys(ENGINE_GAINS).map((k) => [k, v])), ...over } });

  it('à 9 partout, vitesse et accélération rapportent le plus', () => {
    const g = trainingGains(all(9))!;
    expect(g.length).toBeGreaterThan(0);
    expect(g.length).toBeLessThanOrEqual(5);
    expect(['Pace', 'Acceleration']).toContain(g[0]!.attr);
    for (let i = 1; i < g.length; i++) expect(g[i - 1]!.gain).toBeGreaterThanOrEqual(g[i]!.gain);
  });

  it('le volume de jeu ne rapporte plus rien au-dessus de 12, beaucoup en dessous', () => {
    const high = trainingGains(all(12, { WorkRate: 14 }), undefined, 99)!;
    expect(high.find((x) => x.attr === 'WorkRate')).toBeUndefined();
    const low = trainingGains(all(12, { WorkRate: 4 }), undefined, 99)!;
    expect(low.find((x) => x.attr === 'WorkRate')!.gain).toBeGreaterThan(0.1);
  });

  it('un attribut à 20 ne se travaille plus, un gardien suit Match Lab', () => {
    expect(trainingGains(all(12, { Pace: 20 }), undefined, 99)!.find((x) => x.attr === 'Pace')).toBeUndefined();
    const gk = trainingGains({ positions: ['GB'], attributes: { Agility: 12, Reflexes: 12, AerialReach: 12, Acceleration: 12, Determination: 12 } })!;
    expect(gk[0]!.attr).toBe('Agility');
    expect(gk[0]!.gain).toBeCloseTo(0.58 / (0.58 + 0.5 + 0.16 + 0.16 + 0.12));
  });

  it('rien sans attributs lus', () => {
    expect(trainingGains({ positions: ['MC'], attributes: {} })).toBeNull();
  });
});
