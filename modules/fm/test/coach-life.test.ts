import { describe, expect, it } from 'vitest';
import type { CareerSpell } from '../src/career';
import { ageAt, lifeEvents, lifeFinances, schoolStage, trophyCabinet } from '../src/coach-life';

const spell = (club: string, start: string, end: string, current: boolean, trophies: CareerSpell['trophies'] = []): CareerSpell =>
  ({ club, start, end, current, reason: current ? null : 'sacked', country: null, countrySource: null, seasons: [], trophies, bestFinish: null }) as unknown as CareerSpell;

const spells = [
  spell('Vänersborgs IF', '2026-08-29', '2026-10-04', false),
  spell('Malženice', '2026-10-20', '2027-10-19', true, [
    { season: '2026/27', competition: null },
    { season: '2026/27', competition: 'Coupe de Slovaquie' },
  ]),
];

describe('lifeFinances', () => {
  it('compte le brut par jour passé et applique les impôts et les dépenses', () => {
    const f = lifeFinances(spells, { wages: { Malženice: 700 }, taxRate: 20, monthlyCosts: 1000 });
    expect(f.spells[0]).toMatchObject({ club: 'Vänersborgs IF', weekly: null, gross: null, days: 37 });
    expect(f.spells[1]).toMatchObject({ weekly: 700, days: 365, gross: 36500 });
    expect(f.gross).toBe(36500);
    expect(f.net).toBe(29200);
    expect(f.costs).toBe(Math.round((1000 * 402) / 30.44));
    expect(f.savings).toBe(f.net - f.costs);
    expect(f.monthlyNet).toBe(Math.round(((700 * 52) / 12) * 0.8));
    expect(f.missing).toBe(1);
  });

  it('sans club actuel, pas de salaire mensuel', () => {
    const f = lifeFinances([spell('A', '2026-01-01', '2026-01-07', false)], { wages: { A: 100 } });
    expect(f.gross).toBe(100);
    expect(f.taxRate).toBe(30);
    expect(f.monthlyNet).toBeNull();
  });
});

describe('foyer', () => {
  it('âge et étape scolaire', () => {
    expect(ageAt('2020-05-10', '2027-05-09')).toBe(6);
    expect(ageAt('2020-05-10', '2027-05-10')).toBe(7);
    expect(ageAt('2020', '2027-03-01')).toBe(7);
    expect(schoolStage(1)).toBe('baby');
    expect(schoolStage(7)).toBe('primary');
    expect(schoolStage(16)).toBe('high');
    expect(schoolStage(19)).toBe('adult');
  });
});

describe('lifeEvents', () => {
  it('mêle carrière et foyer, du plus récent au plus ancien, sans rien après la date de jeu', () => {
    const ev = lifeEvents(spells, { children: [{ name: 'Léa', born: '2027-02-14' }, { name: 'Tom', born: '2028-01-01' }], partner: { name: 'Julie', since: '2019' } }, '2027-10-19');
    expect(ev.map((e) => e.kind)).toEqual(['trophy', 'trophy', 'birth', 'arrival', 'exit', 'arrival']);
    expect(ev[0]!.date).toBe('2027-06-30');
    expect(ev.find((e) => e.kind === 'birth')).toMatchObject({ name: 'Léa' });
  });
});

describe('trophyCabinet', () => {
  it('regroupe par compétition, championnat en tête à égalité', () => {
    const cab = trophyCabinet([...spells, spell('X', '2027-10-20', '2028-10-20', true, [{ season: '2027/28', competition: 'Coupe de Slovaquie' }])]);
    expect(cab[0]).toMatchObject({ competition: 'Coupe de Slovaquie' });
    expect(cab[0]!.wins).toHaveLength(2);
    expect(cab[1]).toMatchObject({ competition: null });
  });
});
