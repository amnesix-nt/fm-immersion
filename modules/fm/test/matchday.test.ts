import { describe, expect, it } from 'vitest';
import { matchdayPlan, mergeReference, planFromLineup, readiness, recentLoad, strainOf, TacticEngine, type GameSlot, type MatchResult, type PlayerLoad } from '../src';
import { normalizePlayer } from '../src/player';

const engine = new TacticEngine(mergeReference(undefined));
const pl = (id: number, positions: string, extra: Record<string, unknown> = {}) =>
  normalizePlayer({ id, name: `J${id}`, positions, level: 10, attributes: { Passing: 10, Tackling: 10, Positioning: 10, Finishing: 10 }, ...extra });
const base = [pl(1, 'GB'), pl(2, 'D (D)'), pl(3, 'D (C)'), pl(4, 'D (C)'), pl(5, 'D (G)'), pl(6, 'MD (C)'), pl(7, 'M (C)'), pl(8, 'M (C)'), pl(9, 'MO (D)'), pl(10, 'MO (G)')];
const lineup: GameSlot[] = [...base, pl(11, 'BT')].map((p, k) => ({ index: k, playerId: p.id, playerName: p.name, pos: null, roleIP: null, roleOOP: null, custom: false, instructions: { ip: [], oop: [] } }) as unknown as GameSlot);

const run = (striker: Record<string, unknown>, bench: Record<string, unknown>, rotate: boolean, load?: Map<string, PlayerLoad>) => {
  const players = [...base, pl(11, 'BT', striker), pl(12, 'BT', bench)];
  const plan = planFromLineup(engine, lineup, players, null);
  return matchdayPlan(engine, plan, players, { rotate, load });
};

describe('onze du prochain match', () => {
  it('repose un titulaire fatigué au profit du remplaçant frais du poste', () => {
    const r = run({ condition: 78 }, { condition: 98 }, false);
    expect(r.changes).toEqual([expect.objectContaining({ reason: 'tired' })]);
    expect(r.changes[0]!.out.id).toBe('11');
    expect(r.plan.slots[10]!.player?.id).toBe('12');
    expect(r.plan.subs[10]![0]!.id).toBe('11');
  });

  it('fait tourner dès 92 % en coupe ou calendrier chargé, pas en championnat', () => {
    expect(run({ condition: 89 }, { condition: 99 }, false).changes).toHaveLength(0);
    expect(run({ condition: 89 }, { condition: 99 }, true).changes[0]!.reason).toBe('rotation');
  });

  it('garde le titulaire si le remplaçant est lui aussi entamé', () => {
    expect(run({ condition: 80 }, { condition: 82 }, false).changes).toHaveLength(0);
  });

  it('remplace toujours un absent, même par un joueur entamé', () => {
    const r = run({ suspension: 'Carton rouge' }, { condition: 80 }, false);
    expect(r.changes[0]).toMatchObject({ reason: 'unavailable' });
    expect(r.plan.slots[10]!.player?.id).toBe('12');
  });
});

describe('physique et rotation', () => {
  const risk = (n: number) => ({ tracking: { injuryRisk: n } });
  const chained = new Map<string, PlayerLoad>([['11', { starts: 3, minutes: 270 }]]);

  it('retire des points de forme à un joueur à risque, sauf s’il manque seulement de rythme', () => {
    expect(readiness(pl(1, 'BT', risk(300)))).toBeLessThan(readiness(pl(2, 'BT')));
    expect(readiness(pl(1, 'BT', risk(100)))).toBe(readiness(pl(2, 'BT')));
    // Frais mais à court de rythme : le risque est déjà compté dans le rythme.
    expect(readiness(pl(1, 'BT', { ...risk(300), sharpness: 50, condition: 100 }))).toBe(readiness(pl(2, 'BT', { sharpness: 50, condition: 100 })));
  });

  it('ménage un titulaire au risque de blessure élevé', () => {
    const r = run(risk(300), {}, false);
    expect(r.changes).toEqual([expect.objectContaining({ reason: 'risk' })]);
    expect(r.watch[0]).toMatchObject({ slot: 10, swapped: true, strain: { level: 'rest', reason: 'risk', cause: 'fatigue' } });
  });

  it('ne le remplace pas par un joueur lui-même à risque', () => {
    const r = run(risk(300), risk(180), false);
    expect(r.changes).toHaveLength(0);
    expect(r.watch[0]).toMatchObject({ sub: null, swapped: false });
  });

  it('garde dans le onze un joueur à court de rythme, mais le signale', () => {
    const r = run({ ...risk(300), sharpness: 50, condition: 100 }, {}, false);
    expect(r.changes).toHaveLength(0);
    expect(r.watch[0]!.strain).toMatchObject({ reason: 'risk', cause: 'rhythm' });
  });

  it('fait tourner un joueur qui enchaîne trois titularisations en dix jours', () => {
    const r = run({}, {}, false, chained);
    expect(r.changes[0]).toMatchObject({ reason: 'chained' });
    expect(r.watch[0]!.load).toEqual({ starts: 3, minutes: 270 });
    // La doublure enchaîne elle aussi : personne pour le relayer.
    expect(run({}, {}, false, new Map([...chained, ['12', { starts: 3, minutes: 250 }]])).changes).toHaveLength(0);
  });

  it('avant un match lointain, ne garde que le risque élevé', () => {
    expect(strainOf(pl(1, 'BT', { condition: 80 }), { starts: 3, minutes: 270 }, true)).toBeNull();
    expect(strainOf(pl(1, 'BT', risk(300)), undefined, true)?.reason).toBe('risk');
    expect(strainOf(pl(1, 'BT', risk(180)), undefined)?.level).toBe('rotate');
  });

  it('compte les titularisations et les minutes des dix derniers jours', () => {
    const m = (date: string, started: boolean, minutes: number, matches = 1) => ({ date, since: date, matches, players: [{ id: '7', minutes, started }] }) as unknown as MatchResult;
    const load = recentLoad([m('2027-03-01', true, 90), m('2027-03-08', true, 90), m('2027-03-11', false, 25), m('2027-03-14', true, 90), m('2027-03-20', true, 90)], '2027-03-16');
    expect(load.get('7')).toEqual({ starts: 2, minutes: 205 });
    // Deux matchs entre deux instantanés : une titularisation par tranche de 60 minutes.
    expect(recentLoad([m('2027-03-14', true, 180, 2)], '2027-03-16').get('7')).toEqual({ starts: 2, minutes: 180 });
  });
});
