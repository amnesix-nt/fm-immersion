import { describe, expect, it } from 'vitest';
import { builtPlan, GAP_WEAK, mergeReference, newBuiltTactic, roleKeys, TacticEngine, tacticGap } from '../src';
import { normalizePlayer } from '../src/player';

const engine = new TacticEngine(mergeReference(undefined));
const ATTRS = ['Pace', 'Acceleration', 'Passing', 'Tackling', 'Finishing', 'Reflexes', 'Handling', 'WorkRate', 'Stamina', 'Teamwork', 'Heading', 'JumpingReach', 'Dribbling', 'Crossing', 'Marking', 'Positioning', 'Decisions', 'FirstTouch', 'Technique', 'OffTheBall', 'Strength', 'Anticipation', 'Composure', 'Movement', 'Agility', 'Concentration', 'Vision'];
const mk = (id: number, positions: string, v = 12, attrs: Record<string, number> = {}) =>
  normalizePlayer({ id, name: `J${id}`, positions, level: v, attributes: { ...Object.fromEntries(ATTRS.map((k) => [k, v])), ...attrs } });
const XI = ['GB', 'D (G)', 'D (C)', 'D (C)', 'D (D)', 'MD (C)', 'M (C)', 'M (C)', 'MO (G)', 'BT', 'MO (D)'];
const tactic = () => newBuiltTactic(engine, '4-3-3', 'a');

describe('écart entre tactique et effectif', () => {
  it('ne signale rien de fragile dans un onze homogène, mais les postes sans doublure', () => {
    const gap = tacticGap(engine, builtPlan(engine, tactic(), XI.map((p, i) => mk(i + 1, p))));
    expect(gap.slots).toHaveLength(11);
    expect(gap.count.weak).toBe(0);
    expect(gap.count.hole).toBe(0);
    // Personne sur le banc : tous les postes sont sans doublure.
    expect(gap.count.thin).toBe(11);
    expect(gap.slots.every((s) => s.missing.length === 0)).toBe(true);
  });

  it('montre le poste fragile et les attributs clés qui manquent', () => {
    const plan = builtPlan(engine, tactic(), XI.map((p, i) => mk(i + 1, p)));
    const bt = plan.slots.findIndex((s) => s.pos === 'BT');
    const weakKeys = roleKeys(engine, plan.slots[bt]!.ip, 'ip').slice(0, 3);
    const players = XI.map((p, i) => (i === bt ? mk(i + 1, p, 12, Object.fromEntries(weakKeys.map((k) => [k, 5]))) : mk(i + 1, p)));
    const gap = tacticGap(engine, builtPlan(engine, tactic(), players));
    const row = gap.slots.find((s) => s.pos === 'BT')!;
    expect(row.verdict).toBe('weak');
    expect(row.gap!).toBeGreaterThanOrEqual(GAP_WEAK);
    expect(row.missing.length).toBeGreaterThan(0);
    expect(row.missing.length).toBeLessThanOrEqual(3);
    for (const m of row.missing) {
      expect(weakKeys).toContain(m.key);
      expect(m.value).toBe(5);
      expect(m.bar).toBeGreaterThan(m.value);
    }
  });

  it('accepte une doublure au niveau du titulaire', () => {
    const players = [...XI.map((p, i) => mk(i + 1, p)), ...XI.map((p, i) => mk(i + 20, p))];
    const gap = tacticGap(engine, builtPlan(engine, tactic(), players));
    expect(gap.count.ok).toBe(11);
    expect(gap.slots.some((s) => s.subAhead)).toBe(false);
  });

  it('signale une doublure mieux notée que le titulaire', () => {
    const plan = builtPlan(engine, tactic(), XI.map((p, i) => mk(i + 1, p)));
    const bt = plan.slots.findIndex((s) => s.pos === 'BT');
    plan.subs[bt] = [mk(40, 'BT', 15)];
    const row = tacticGap(engine, plan).slots[bt]!;
    expect(row.subAhead).toBe(true);
    expect(row.subFit! - row.starterFit!).toBeGreaterThanOrEqual(0.5);
  });
});
