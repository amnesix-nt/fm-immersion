import { describe, expect, it } from 'vitest';
import type { CareerSpell } from '../src/career';
import { careerScenes, sceneState } from '../src/coach-scenes';

const spell = (club: string, start: string, end: string, current: boolean, extra: Partial<CareerSpell> = {}): CareerSpell =>
  ({ club, start, end, current, reason: current ? null : 'sacked', country: 'SE', countrySource: null, seasons: [], trophies: [], bestFinish: null, ...extra }) as unknown as CareerSpell;

const spells = [
  spell('Vänersborgs IF', '2026-08-29', '2026-10-04', false),
  spell('Malženice', '2026-10-20', '2027-10-19', true, {
    country: 'SK',
    seasons: [{ label: '2026/27', ended: true } as CareerSpell['seasons'][number], { label: '2027/28', ended: false } as CareerSpell['seasons'][number]],
    trophies: [{ season: '2026/27', competition: 'Coupe de Slovaquie' }],
  }),
];

describe('careerScenes', () => {
  it('tire les scènes des moments de la carrière, jamais après la date de jeu', () => {
    const sc = careerScenes(spells, { partner: { name: 'Julie' }, children: [{ name: 'Léa', born: '2026-12-02' }, { name: 'Tom', born: '2028-01-01' }] }, '2027-10-19');
    expect(sc.map((s) => s.kind)).toEqual(['arrival', 'car', 'sacked', 'arrival', 'move', 'car', 'birth', 'summer', 'trophy']);
    expect(sc.find((s) => s.kind === 'summer')!.date).toBe('2027-06-30');
  });

  it('pas de scène de déménagement sans conjoint, pas de nouvelle voiture dans le même pays', () => {
    const same = [spell('A', '2026-01-01', '2026-03-01', false, { reason: 'left' }), spell('B', '2026-03-10', '2026-06-01', true)];
    expect(careerScenes(same, undefined, '2026-06-01').map((s) => s.kind)).toEqual(['arrival', 'car', 'left', 'arrival']);
  });
});

describe('sceneState', () => {
  it('applique les choix : jauges, logement, voiture, dépenses', () => {
    const life = {
      answers: {
        'arrival|Malženice|2026-10-20': { choice: 'house', date: '2026-10-21' },
        'car|Malženice|2026-10-20': { choice: 'sports', date: '2026-10-21' },
        'sacked|Vänersborgs IF|2026-10-04': { choice: 'holiday', date: '2026-10-05' },
      },
    };
    const st = sceneState(spells, life, '2027-10-19');
    expect(st.harmony).toBe(60 + 5 - 3 + 10);
    expect(st.morale).toBe(60 + 5 + 10);
    expect(st.housing).toBe('house');
    expect(st.car).toBe('sports');
    expect(st.monthly).toBe(2200 + 1500);
    expect(st.spending.oneOff).toBe(4000);
    expect(st.spending.housing).toBe(Math.round((2200 * 365) / 30.44));
    expect(st.spending.car).toBe(Math.round((1500 * 364) / 30.44));
    // Les scènes plus vieilles que 120 jours sans réponse sont passées ; les autres attendent, la plus récente d'abord.
    expect(st.pending.map((s) => s.kind)).toEqual(['trophy', 'summer']);
  });

  it('diplômes : un à la fois, le choix « passer un diplôme » en lance un', () => {
    const life = { answers: { 'sacked|Vänersborgs IF|2026-10-04': { choice: 'badge', date: '2026-10-05' } }, badges: [{ level: 'b', start: '2027-01-01' }] };
    const st = sceneState(spells, life, '2027-10-19');
    expect(st.badges.map((b) => [b.level, b.start, b.end, b.done])).toEqual([
      ['c', '2026-10-04', '2027-04-04', true],
      ['b', '2027-04-04', '2028-01-04', false],
    ]);
    expect(st.spending.badges).toBe(5500);
    expect(st.nextBadge).toBeNull();
    expect(sceneState(spells, { badges: [{ level: 'c', start: '2026-09-01' }] }, '2027-10-19').nextBadge?.level).toBe('b');
  });
});
