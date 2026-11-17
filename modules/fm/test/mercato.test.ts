import { describe, expect, it } from 'vitest';
import { buildProject, contractDecisions, decisions, mercatoAdvice, mergeReference, projectCompat, TacticEngine } from '../src';
import { normalizePlayer } from '../src/player';

const ATTRS = ['Passing', 'FirstTouch', 'Technique', 'Composure', 'Vision', 'Decisions', 'Teamwork', 'WorkRate', 'Stamina', 'Strength', 'Pace', 'Acceleration', 'Tackling', 'Marking', 'Positioning', 'Anticipation', 'Heading', 'JumpingReach', 'Finishing', 'Movement', 'Crossing', 'Dribbling', 'Flair', 'Concentration', 'Agility', 'Aggression', 'Reflexes', 'Handling', 'OneOnOnes', 'AerialReach', 'CommandOfArea', 'Kicking', 'RushingOut'];
const p = (id: number, positions: string, base: number, extra: Record<string, unknown> = {}) =>
  normalizePlayer({ id, name: `J${id}`, positions, age: 26, contractEnd: '2029-06-30', value: 100_000, wage: 1000, attributes: Object.fromEntries(ATTRS.map((k) => [k, base])), ...extra });

const engine = new TacticEngine(mergeReference(undefined));
const eleven = [
  p(1, 'GB', 12),
  p(2, 'D (D)', 12),
  p(3, 'D (C)', 13),
  p(4, 'D (C)', 13),
  p(5, 'D (G)', 12),
  p(6, 'MD (C)', 13),
  p(7, 'M (C)', 13),
  p(8, 'M (C)', 13),
  p(9, 'MO (D)', 13),
  p(10, 'MO (G)', 13),
  p(11, 'BT', 13),
];
const DATE = '2026-11-24';

describe('mercato : départs et jeunes', () => {
  it('un prêté chez nous compte dans le onze et les plans, sans vente ni prolongation', () => {
    // Le 3 (titulaire DC) est prêté chez nous ; le 12 est un DC en trop et le 15, un prêté chez nous en trop.
    const squad = [...eleven, p(12, 'D (C)', 11), p(15, 'D (C)', 6, { age: 29, contractEnd: '2027-06-30' })];
    const r = mercatoAdvice(engine, squad, DATE, { style: 'possession' }, [], new Set(), new Set(['3', '15']))!;
    const v = (id: number) => r.advice.find((a) => a.player.id === String(id))!;
    expect(v(3).now.tier).toBe(0);
    expect(v(3).verdict).toBe('core');
    expect(v(3).reasons.some((x) => x.id === 'loanIn')).toBe(true);
    // Un prêté en trop n'est ni à vendre ni à libérer, et son contrat (celui du club prêteur) n'est pas à décider.
    expect(v(15).verdict).toBe('backup');
    expect(v(15).months).toBeNull();
    expect(contractDecisions(r).some((c) => c.advice.player.id === '15')).toBe(false);
    expect(r.leaving).toEqual([]);
    // Signalé partant, lui, il sort des plans.
    expect(mercatoAdvice(engine, squad, DATE, { style: 'possession' }, [], new Set(['3']))!.leaving.map((x) => x.id)).toEqual(['3']);
  });

  it('garde les titulaires et les doublures, fait partir les joueurs en trop', () => {
    const squad = [...eleven, p(12, 'D (C)', 11), p(13, 'D (C)', 10.5), p(14, 'D (C)', 10), p(15, 'D (C)', 6, { age: 29 }), p(16, 'GB', 10), p(17, 'GB', 9)];
    const r = mercatoAdvice(engine, squad, DATE, { style: 'possession' })!;
    const v = (id: number) => r.advice.find((a) => a.player.id === String(id))!;
    expect(v(3).now.tier).toBe(0);
    expect(['core', 'replace']).toContain(v(3).verdict);
    // Deux DC dans le schéma : deux doublures, le cinquième est en trop.
    expect(v(12).verdict).toBe('backup');
    expect(v(15).verdict).toBe('sell');
    expect(v(15).reasons.some((x) => x.id === 'surplus')).toBe(true);
    // Deux doublures au but.
    expect(v(16).verdict).toBe('backup');
    expect(v(17).verdict).toBe('backup');
    expect(r.income).toBe(r.byVerdict.sell.reduce((s, a) => s + (a.player.value ?? 0), 0));
  });

  it('laisse partir sans valeur marchande, vend sinon, même en fin de contrat', () => {
    const squad = [...eleven, p(12, 'D (C)', 11), p(13, 'D (C)', 10.5), p(14, 'D (C)', 6, { contractEnd: '2027-03-31', value: 0 }), p(15, 'D (C)', 5, { contractEnd: '2027-03-31' })];
    const r = mercatoAdvice(engine, squad, DATE, { style: 'possession' })!;
    expect(r.advice.find((a) => a.player.id === '14')!.verdict).toBe('release');
    expect(r.advice.find((a) => a.player.id === '15')!.verdict).toBe('sell');
  });

  it('décide de chaque contrat qui finit dans six mois', () => {
    const end = '2027-05-31';
    const squad = [
      ...eleven.map((x) => (x.id === '3' ? { ...x, contractEnd: end } : x.id === '11' ? { ...x, age: 33, contractEnd: end } : x)),
      p(12, 'D (C)', 11, { contractEnd: end }),
      p(13, 'D (C)', 10.5),
      p(14, 'D (C)', 6, { contractEnd: end }),
      p(15, 'D (C)', 5, { contractEnd: end, value: 0 }),
      p(20, 'M (C)', 9, { age: 19, contractEnd: end, stars: { current: 1, potential: 4 } }),
      p(21, 'M (C)', 9, { contractEnd: '2027-12-31' }),
    ];
    const r = mercatoAdvice(engine, squad, DATE, { style: 'possession' })!;
    const d = contractDecisions(r);
    const call = (id: number) => d.find((x) => x.advice.player.id === String(id));
    // Seuls les contrats à six mois ou moins.
    expect(call(21)).toBeUndefined();
    expect(call(13)).toBeUndefined();
    // Titulaire de 26 ans : prolonger longtemps ; titulaire de 33 ans : un an.
    expect(call(3)!.advice.compat?.compat).not.toBe('no');
    expect(call(3)!.call).toBe('extend');
    expect(call(11)!.call).toBe('extendShort');
    // Doublure de 26 ans : prolonger.
    expect(call(12)!.call).toBe('extend');
    // En trop : vendre s'il a une valeur, sinon le laisser partir.
    expect(call(14)!.call).toBe('sellNow');
    expect(call(15)!.call).toBe('letGo');
    // Jeune prometteur : prolonger au moins trois ans.
    expect(call(20)!.call).toBe('extend');
    expect(call(20)!.years).toBeGreaterThanOrEqual(3);
    // Les prolongations d'abord.
    expect(d[0]!.call).toBe('extend');
  });

  it('repère les jeunes qui valent le coup : prêt s’ils sont bloqués, prolongation si le contrat finit', () => {
    const squad = [
      ...eleven,
      p(12, 'M (C)', 12),
      p(13, 'M (C)', 11.5),
      p(14, 'M (C)', 11),
      p(20, 'M (C)', 9, { age: 20, stars: { current: 1, potential: 4 } }),
      p(21, 'M (C)', 8, { age: 17, stars: { current: 0.5, potential: 3.5 } }),
      p(22, 'M (C)', 7, { age: 20, stars: { current: 0.5, potential: 1.5 } }),
      p(23, 'BT', 9, { age: 19, contractEnd: '2027-06-30', stars: { current: 1, potential: 4.5 } }),
    ];
    const r = mercatoAdvice(engine, squad, DATE, { style: 'possession' })!;
    const v = (id: number) => r.advice.find((a) => a.player.id === String(id))!;
    expect(v(20).prospect).toBe(true);
    expect(v(20).verdict).toBe('loan');
    // À 17 ans, il progresse avec les jeunes du club.
    expect(v(21).verdict).toBe('develop');
    expect(v(21).reasons.some((x) => x.id === 'youthTeam')).toBe(true);
    expect(v(22).prospect).toBe(false);
    expect(v(22).verdict).toBe('sell');
    expect(v(23).verdict).toBe('extend');
    // Les jeunes prometteurs passent en tête de liste.
    expect(r.youth[0]!.prospect).toBe(true);
    expect(r.youth.at(-1)!.player.id).toBe('22');
  });

  it('ne conseille rien sans attributs', () => {
    expect(mercatoAdvice(engine, [normalizePlayer({ id: 1, name: 'X', positions: 'BT' })], DATE)).toBeNull();
  });
});

describe('joueurs qui ne performent pas', () => {
  const played = (x: ReturnType<typeof p>, avgRating: number, apps = 12) => ({ ...x, avgRating, apps });
  it('propose de vendre un titulaire dont la note de la saison est nettement sous celle de l’équipe', () => {
    const squad = eleven.map((x) => played(x, x.id === '11' ? 6.45 : 6.95));
    const r = mercatoAdvice(engine, [...squad, p(12, 'BT', 11)], DATE, { style: 'possession' })!;
    const bt = r.advice.find((a) => a.player.id === '11')!;
    expect(bt.now.tier).toBe(0);
    expect(bt.verdict).toBe('sell');
    expect(bt.reasons.find((x) => x.id === 'underperforms')).toMatchObject({ rating: 6.45, apps: 12 });
    // Les autres titulaires restent.
    expect(r.advice.find((a) => a.player.id === '10')!.verdict).not.toBe('sell');
  });
  it('ne juge pas sur trop peu de matchs, ni un jeune prometteur', () => {
    const few = eleven.map((x) => played(x, x.id === '11' ? 6.45 : 6.95, x.id === '11' ? 3 : 12));
    expect(mercatoAdvice(engine, few, DATE, { style: 'possession' })!.advice.find((a) => a.player.id === '11')!.verdict).not.toBe('sell');
    const young = eleven.map((x) => (x.id === '11' ? { ...played(x, 6.45), age: 19, pa: 160, ca: 100 } : played(x, 6.95)));
    const y = mercatoAdvice(engine, young, DATE, { style: 'possession' })!.advice.find((a) => a.player.id === '11')!;
    expect(y.prospect).toBe(true);
    expect(y.verdict).not.toBe('sell');
  });
  it('ne prolonge pas un joueur qui ne performe pas', () => {
    const squad = eleven.map((x) => (x.id === '11' ? { ...played(x, 6.45), contractEnd: '2027-03-31' } : played(x, 6.95)));
    const c = contractDecisions(mercatoAdvice(engine, squad, DATE, { style: 'possession' })!).find((d) => d.advice.player.id === '11')!;
    expect(c.call).toBe('sellNow');
  });
});

describe('compatibilité avec le projet de jeu', () => {
  it('juge le profil, pas le niveau : un faible fait pour le style reste compatible', () => {
    const pr = buildProject(engine, eleven, { style: 'possession' })!;
    // Milieu technique faible : profil de possession.
    const tech = p(30, 'M (C)', 8, { attributes: { ...Object.fromEntries(ATTRS.map((k) => [k, 6])), Passing: 12, FirstTouch: 12, Technique: 12, Vision: 12, Decisions: 12, Composure: 12, Teamwork: 12 } });
    // Milieu tout en impact : physique et récupération, aucune technique.
    const brute = p(31, 'M (C)', 8, { attributes: { ...Object.fromEntries(ATTRS.map((k) => [k, 4])), Tackling: 18, Aggression: 18, Strength: 18, Stamina: 18, WorkRate: 18, Marking: 18, Positioning: 16, Heading: 18, JumpingReach: 18 } });
    const a = projectCompat(engine, pr, tech);
    const b = projectCompat(engine, pr, brute);
    expect(a.gap!).toBeLessThan(b.gap!);
    expect(a.compat).not.toBe('no');
    // Pivot tout en puissance, sans technique : hors projet.
    expect(projectCompat(engine, pr, p(34, 'BT', 6, { attributes: { ...Object.fromEntries(ATTRS.map((k) => [k, 6])), Strength: 18, Heading: 18, JumpingReach: 18, Finishing: 14 } })).compat).toBe('no');
    // Aucun poste du schéma du projet (milieu gauche dans un 4-3-3) : hors projet.
    const wide = projectCompat(engine, pr, p(33, 'M (G)', 12));
    expect(wide.noPosition).toBe(true);
    expect(wide.compat).toBe('no');
    const advice = mercatoAdvice(engine, [...eleven, tech, brute], DATE, { style: 'possession' })!;
    const off = advice.advice.filter((x) => x.compat?.compat === 'no');
    for (const x of off) {
      expect(x.prospect).toBe(false);
      expect(x.verdict).not.toBe('extend');
      expect(x.reasons.some((r) => r.id === 'offProject')).toBe(true);
    }
  });

  it('juge un potentiel face aux titulaires du même effectif : une grosse recrue ne change pas le verdict', () => {
    // Les étoiles sont relatives à l'effectif : si une star signe, tout le monde perd des étoiles d'un coup.
    const at = (shift: number) => {
      const starters = eleven.map((x) => normalizePlayer({ ...x, attributes: x.attributes, stars: { current: 3 - shift, potential: 3 - shift } }));
      const young = p(30, 'M (C)', 6, { age: 20, stars: { current: 0.5, potential: 3 - shift } });
      return mercatoAdvice(engine, [...starters, young], DATE, { style: 'possession' })!.advice.find((a) => a.player.id === '30')!;
    };
    const before = at(0);
    const after = at(2);
    expect(before.prospect).toBe(true);
    expect(after.prospect).toBe(before.prospect);
    expect(after.verdict).toBe(before.verdict);
    expect(after.reasons.some((x) => x.id === 'potential')).toBe(true);
  });

  it('avec le CA/PA réels, compare le PA du jeune au CA du titulaire', () => {
    const starters = eleven.map((x) => normalizePlayer({ ...x, attributes: x.attributes, ca: 100, pa: 110, stars: { current: 3, potential: 3 } }));
    const young = (pa: number) =>
      mercatoAdvice(engine, [...starters, p(30, 'M (C)', 6, { age: 20, ca: 50, pa, stars: { current: 0.5, potential: 5 } })], DATE, { style: 'possession' })!.advice.find(
        (a) => a.player.id === '30',
      )!;
    // 5 étoiles de potentiel, mais un PA sous le CA des titulaires : pas un espoir.
    expect(young(90).prospect).toBe(false);
    expect(young(90).reasons.some((x) => x.id === 'lowPotential')).toBe(true);
    const good = young(130);
    expect(good.prospect).toBe(true);
    expect(good.reasons).toContainEqual({ id: 'potentialPa', pa: 130, ca: 100 });
  });
});

describe('joueurs signalés partants', () => {
  it('planifie sans eux : la doublure devient titulaire, leur contrat sort des décisions', () => {
    const end = '2027-05-31';
    const squad = [...eleven.map((x) => (x.id === '3' ? { ...x, contractEnd: end } : x)), p(12, 'D (C)', 11), p(13, 'D (C)', 10.5), p(14, 'D (C)', 10)];
    const before = mercatoAdvice(engine, squad, DATE, { style: 'possession' })!;
    expect(contractDecisions(before).some((d) => d.advice.player.id === '3')).toBe(true);
    const r = mercatoAdvice(engine, squad, DATE, { style: 'possession' }, [], new Set(['3']))!;
    expect(r.leaving.map((x) => x.id)).toEqual(['3']);
    expect(r.advice.some((a) => a.player.id === '3')).toBe(false);
    expect(contractDecisions(r).some((d) => d.advice.player.id === '3')).toBe(false);
    // Le meilleur DC restant prend la place de titulaire.
    expect(r.advice.find((a) => a.player.id === '12')!.project.tier).toBe(0);
  });

  it('ajoute une décision « trouver son remplaçant » quand personne ne tient le poste au niveau', () => {
    // Seule doublure en DC : bien plus faible que le partant.
    const d = decisions(engine, [...eleven, p(12, 'D (C)', 8)], DATE, { style: 'possession' }, [], null, new Set(['3']));
    const repl = d.find((x) => x.action === 'replaceLeaving');
    expect(repl?.players[0]!.id).toBe('3');
    expect(repl?.pos).toBe('DC');
    expect(repl?.why).toBe('repl_internalWeak');
  });

  it('dit qu’aucune recrue n’est nécessaire quand la doublure fait aussi bien avec un profil du projet', () => {
    const d = decisions(engine, [...eleven, p(12, 'D (C)', 13)], DATE, { style: 'possession' }, [], null, new Set(['3']));
    const c = d.find((x) => x.action === 'leavingCovered');
    expect(c?.players.map((x) => x.id)).toEqual(['3', '12']);
    expect(d.some((x) => x.action === 'replaceLeaving')).toBe(false);
  });
});
