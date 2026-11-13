import { describe, expect, it } from 'vitest';
import { builtPlan, GAP_WEAK, mergeReference, oopFit, newBuiltTactic, roleKeys, TacticEngine, tacticGap } from '../src';
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

describe('rôle sans ballon à un autre poste', () => {
  it('ne retire pas plus de familiarité qu’au poste avec ballon', () => {
    // Meneur à l'aise en MO (C), que la tactique fait défendre en pointe : il n'est pas avant-centre (familiarité 1).
    const p = normalizePlayer({ id: 1, name: 'Z', positions: 'M (C), MO (C)', attributes: Object.fromEntries(ATTRS.map((k) => [k, 12])), positionRatings: { 'M (C)': 20, 'MO (C)': 17, 'BT (C)': 1 } });
    const raw = engine.absolute();
    const oop = [...raw.roles.values()].find((r) => raw.availableAt(r, 'BT', 'oop'))!.code;
    const away = raw.roleFit(p, oop, 'oop', 'BT')!;
    const home = raw.roleFit(p, oop, 'oop', 'MOC')!;
    expect(away).toBeLessThan(home - 3);
    expect(oopFit(raw, p, oop, 'MOC', 'BT')).toBe(home);
    // Même poste dans les deux phases : rien ne change.
    expect(oopFit(raw, p, oop, 'BT')).toBe(away);
  });
});
