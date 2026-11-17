import { describe, expect, it } from 'vitest';
import { attributeEffect, ENGINE_GAINS, engineGroups, engineTier, fitMetaScore, engineValue, labMeta, positionWeights } from '../src';

const all = (v: number, over: Record<string, number> = {}) => ({ positions: ['MC' as const], attributes: { ...Object.fromEntries(Object.keys(ENGINE_GAINS).map((k) => [k, v])), ...over } });

describe('indice moteur (tests d’attributs FM27)', () => {
  it('reprend les paliers du tableau et interpole entre eux', () => {
    expect(attributeEffect('Pace', 12)).toBe(0);
    expect(attributeEffect('Pace', 18)).toBeCloseTo(19.4);
    expect(attributeEffect('Pace', 6)).toBeCloseTo(-26.8);
    expect(attributeEffect('Pace', 1)).toBeCloseTo(-40);
    expect(attributeEffect('Pace', 9)).toBeCloseTo(-13.4);
    expect(attributeEffect('WorkRate', 3)).toBeCloseTo(-15.7, 1);
    // Au-delà de 18, la pente du dernier palier continue.
    expect(attributeEffect('Stamina', 20)).toBeCloseTo((14 * 8) / 6);
    expect(attributeEffect('Teamwork', 15)).toBeNull();
  });

  it('un joueur à 12 partout vaut 0, un sprinteur gagne, un joueur sans volume de jeu est signalé', () => {
    expect(engineValue(all(12))!.index).toBe(0);
    const fast = engineValue(all(12, { Pace: 18, Acceleration: 17, Stamina: 16 }))!;
    expect(fast.index).toBe(40);
    expect(fast.strengths[0]!.attr).toBe('Pace');
    expect(engineTier(fast.index)).toBe('top');
    const lazy = engineValue(all(12, { WorkRate: 4 }))!;
    expect(lazy.belowMin.map((f) => f.attr)).toEqual(['WorkRate']);
    expect(lazy.weaknesses[0]!.attr).toBe('WorkRate');
  });

  it('rien sans attributs lus', () => {
    expect(engineValue({ positions: ['DC'], attributes: { Pace: 15 } })).toBeNull();
    expect(engineValue({ positions: ['GB'], attributes: { Handling: 15, Kicking: 14 } })).toBeNull();
  });

  it('note les gardiens par Match Lab : agilité et réflexes d’abord', () => {
    const gk = (over: Record<string, number> = {}) => ({ positions: ['GB' as const], attributes: { Agility: 12, Reflexes: 12, AerialReach: 12, Acceleration: 12, Determination: 12, Handling: 12, OneOnOnes: 12, ...over } });
    const base = engineValue(gk())!;
    expect(base.keeper).toBe(true);
    expect(base.groups).toEqual(['GK']);
    expect(base.meta).toBe(12);
    expect(base.index).toBe(0);
    expect(base.agree).toBeNull();
    // Un gardien à 15 partout vaut 15.
    expect(engineValue(gk({ Agility: 15, Reflexes: 15, AerialReach: 15, Acceleration: 15, Determination: 15 }))!.meta).toBe(15);
    // Agilité et réflexes pèsent bien plus que le face-à-face ou la prise de balle (non retenus).
    const shot = engineValue(gk({ Agility: 17, Reflexes: 17 }))!;
    const other = engineValue(gk({ OneOnOnes: 20, Handling: 20 }))!;
    expect(shot.meta).toBeGreaterThan(15);
    expect(shot.strengths.map((f) => f.attr)).toEqual(['Agility', 'Reflexes']);
    expect(engineTier(shot.index)).toBe('good');
    expect(other.meta).toBe(12);
    // Le poste visé compte : un joueur de champ jugé dans les buts, ou un gardien jugé ailleurs.
    expect(engineValue({ positions: ['DC'], attributes: { ...all(12).attributes, ...gk().attributes } }, 'GB')!.keeper).toBe(true);
  });

  it('donne la note de Match Lab en deuxième source et dit si les deux concordent', () => {
    const lab = engineValue(all(14))!;
    expect(lab.lab).toBe(14);
    expect(lab.agree).toBe(true);
    // Technicien lent : la première série le pénalise, Match Lab le juge sur ses seuls attributs physiques.
    const tech = engineValue(all(12, { Technique: 20, Vision: 20, FirstTouch: 20, Passing: 20, Movement: 20, Tackling: 20, Marking: 20, Composure: 20 }))!;
    expect(tech.lab).toBe(12);
    expect(tech.agree).toBe(false);
    // Un sprinteur : les deux sources le voient au-dessus de 14.
    const fast = engineValue(all(12, { Pace: 18, Acceleration: 17, Stamina: 16 }))!;
    expect(fast.lab).toBeGreaterThan(14);
    expect(fast.agree).toBe(true);
    // Détente : un défenseur central y gagne plus qu'un milieu défensif.
    const jump = { ...all(12).attributes, JumpingReach: 18 };
    expect(labMeta(jump, ['CB'])!).toBeGreaterThan(labMeta(jump, ['DM'])!);
    // Trop peu d'attributs lus : pas de deuxième note.
    expect(labMeta({ Pace: 15, Acceleration: 15 }, ['ST'])).toBeNull();
  });

  it('pèse les attributs selon le poste (mesures de Purity), sans changer l’échelle', () => {
    // Milieu central : pas de mesure propre, poids de toute l'équipe.
    expect(Object.values(positionWeights(['MC'])).every((w) => w === 1)).toBe(true);
    // La détente compte surtout en défense centrale et en attaque, peu sur les côtés.
    expect(positionWeights(['DC']).JumpingReach).toBeGreaterThan(1.5);
    expect(positionWeights(['BT']).JumpingReach).toBeGreaterThan(1.2);
    expect(positionWeights(['DLG']).JumpingReach).toBeLessThan(0.6);
    // L'endurance compte surtout pour un latéral ou un piston, la finition pour un attaquant.
    expect(positionWeights(['DD']).Stamina).toBeGreaterThan(1.3);
    expect(positionWeights(['BT']).Finishing).toBeGreaterThan(1.4);
    // Poids moyen de 1 par poste et bornés.
    for (const pos of ['BT', 'MOC', 'DLG', 'DC', 'MDF'] as const) {
      const w = Object.values(positionWeights([pos]));
      expect(w.every((x) => x >= 0.25 && x <= 2)).toBe(true);
    }
    // Les autres attributs ne changent pas.
    expect(positionWeights(['DC']).Passing).toBeUndefined();
    const jumper = (pos: 'DC' | 'DLG') => engineValue({ positions: [pos], attributes: all(12, { JumpingReach: 18 }).attributes })!.index;
    expect(jumper('DC')).toBeGreaterThan(jumper('DLG'));
    // Plusieurs postes : moyenne des familles ; le poste visé l'emporte sur les postes du joueur.
    expect(engineGroups(['DC', 'MDF', 'MC'])).toEqual(['CB', 'DM', 'team']);
    expect(positionWeights(['DC', 'DLG']).JumpingReach).toBeCloseTo((positionWeights(['DC']).JumpingReach! + positionWeights(['DLG']).JumpingReach!) / 2);
    const p = { positions: ['DLG' as const], attributes: all(12, { JumpingReach: 18 }).attributes };
    expect(engineValue(p, 'DC')!.index).toBe(jumper('DC'));
    expect(engineValue(p, 'DC')!.groups).toEqual(['CB']);
  });

  it('donne une note méta sur 20 : un joueur à X partout vaut X', () => {
    for (const v of [6, 12, 15, 18]) expect(engineValue(all(v))!.meta).toBeCloseTo(v, 1);
    expect(engineValue({ positions: ['DC'], attributes: all(14).attributes })!.meta).toBeCloseTo(14, 1);
    // Un sprinteur à 12 ailleurs pèse comme un joueur nettement au-dessus de 12 partout.
    const fast = engineValue(all(12, { Pace: 18, Acceleration: 17, Stamina: 16 }))!;
    expect(fast.meta).toBeGreaterThan(13.5);
    expect(fast.meta).toBeLessThan(16);
    // Un technicien lent à 17 en technique pèse moins qu'un joueur à 12 partout.
    expect(engineValue(all(12, { Technique: 17, Vision: 17, Passing: 17, Pace: 7, Acceleration: 8 }))!.meta).toBeLessThan(12);
    // Bornée entre 1 et 20.
    expect(engineValue(all(20, { Pace: 20 }))!.meta).toBeLessThanOrEqual(20);
    expect(engineValue(all(1))!.meta).toBeGreaterThanOrEqual(1);
  });

  it('classe « poste et méta » par la moyenne des deux notes', () => {
    expect(fitMetaScore(14, 12)).toBe(13);
    expect(fitMetaScore(null, 12)).toBe(12);
    expect(fitMetaScore(11, undefined)).toBe(11);
    expect(fitMetaScore(null, null)).toBeNull();
  });
});

describe('attributs cachés', () => {
  it('signale cartons, fragilité et grands matchs, rien sans lecture', async () => {
    const { hiddenNotes } = await import('../src');
    expect(hiddenNotes(null)).toEqual([]);
    expect(hiddenNotes({ Dirtiness: 17, InjuryProneness: 4, ImportantMatches: 16 })).toEqual(['cards', 'bigGames']);
    expect(hiddenNotes({ Dirtiness: 8, InjuryProneness: 15 })).toEqual(['fragile']);
  });
});
