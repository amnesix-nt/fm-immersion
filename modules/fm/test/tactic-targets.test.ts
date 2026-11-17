import { describe, expect, it } from 'vitest';
import { buildProject, mergeReference, slotNote, tacticSlotSearch, TacticEngine, weakestSlot } from '../src';
import { normalizePlayer } from '../src/player';

const ATTRS = ['Passing', 'FirstTouch', 'Technique', 'Composure', 'Vision', 'Decisions', 'Teamwork', 'WorkRate', 'Stamina', 'Strength', 'Pace', 'Acceleration', 'Tackling', 'Marking', 'Positioning', 'Anticipation', 'Heading', 'JumpingReach', 'Finishing', 'Movement', 'Crossing', 'Dribbling', 'Flair', 'Concentration', 'Agility', 'Aggression', 'Reflexes', 'Handling', 'OneOnOnes', 'AerialReach', 'CommandOfArea', 'Kicking', 'RushingOut', 'Balance', 'NaturalFitness', 'Determination', 'Bravery', 'LongShots', 'Leadership', 'OffTheBall'];
const p = (id: number | string, positions: string, base: number, over: Record<string, number> = {}) =>
  normalizePlayer({ id, name: `J${id}`, positions, age: 25, attributes: { ...Object.fromEntries(ATTRS.map((k) => [k, base])), ...over } });

const engine = new TacticEngine(mergeReference(undefined));
const squad = [p(1, 'GB', 12), p(2, 'D (D)', 12), p(3, 'D (C)', 12), p(4, 'D (C)', 12), p(5, 'D (G)', 12), p(6, 'MD (C)', 12), p(7, 'M (C)', 12), p(8, 'M (C)', 12), p(9, 'MO (D)', 12), p(10, 'MO (G)', 12), p(11, 'BT', 9), p(12, 'BT', 11)];
const pr = buildProject(engine, squad, { style: 'possession', form: '4-3-3' })!;
const bt = pr.slots.find((s) => s.pos === 'BT')!;

describe('recrues pour la tactique', () => {
  it('note poste et méta : la moyenne de l’adéquation et de la note méta au poste', () => {
    const n = slotNote(engine, squad[10]!, bt);
    expect(n.fit).not.toBeNull();
    expect(n.meta).not.toBeNull();
    expect(n.score).toBeCloseTo((n.fit! + n.meta!) / 2, 5);
    // Gardien : note méta de l'étude Match Lab (agilité, réflexes).
    const gb = pr.slots.find((s) => s.pos === 'GB')!;
    const g = slotNote(engine, squad[0]!, gb);
    expect(g.meta).not.toBeNull();
    expect(g.score).toBeCloseTo((g.fit! + g.meta!) / 2, 5);
  });

  it('le poste le plus faible est celui de l’attaquant à 9', () => {
    expect(weakestSlot(engine, pr)?.pos).toBe('BT');
  });

  it('classe les candidats du poste en favorisant ce que le moteur récompense', () => {
    // Même niveau technique, mais l'un est rapide et puissant : la méta le place devant.
    const slow = p('t100', 'BT', 13, { Pace: 8, Acceleration: 8, Stamina: 9 });
    const fast = p('t101', 'BT', 13, { Pace: 17, Acceleration: 17, Stamina: 15 });
    const dc = p('t102', 'D (C)', 16);
    const r = tacticSlotSearch(engine, pr, bt, [slow, fast, dc, squad[11]!], squad);
    expect(r.picks.map((x) => x.player.id)).toEqual(['t101', 't100']);
    expect(r.picks[0]!.meta!).toBeGreaterThan(r.picks[1]!.meta!);
    expect(r.picks[0]!.verdict).toBe('starter');
    expect(r.picks[0]!.gain!).toBeGreaterThan(0);
    expect(r.starter?.player.id).toBe('12');
    expect(r.backup?.player.id).toBe('11');
    expect(r.keys.length).toBeGreaterThan(0);
    expect(r.picks[0]!.keys.every((k) => k.value != null)).toBe(true);
  });
});
