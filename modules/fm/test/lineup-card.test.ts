import { describe, expect, it } from 'vitest';
import { formationDigits, lineupCard, matchToday } from '../src';

const POS = ['GB', 'D (D)', 'D (C)', 'D (C)', 'D (G)', 'MD (C)', 'M (C)', 'M (C)', 'MO (D)', 'MO (G)', 'BT (C)'];
const names = ['Paul Gardien', 'Luc Droit', 'Marc Martin', 'Hugo Martin', 'Léo Gauche', 'Tom Six', 'Noé Huit', 'Eli Dix', 'Max Ailier', 'Ugo Ailier', 'Rémi Neuf'];

const snap = (over: Record<string, unknown> = {}) => ({
  club: 'Toulouse',
  gameDate: '2028-02-09',
  nextMatch: { opponent: 'Lens', inDays: "Aujourd'hui", location: 'Domicile', competition: 'Ligue 1', threatLevel: 'Il ne sera pas évident de battre Lens.' },
  tactic: { formation: '4-1-2-2-1 MD Jeu large', mentality: 'Offensive' },
  players: names.map((name, i) => ({ id: i + 1, name, squadNumber: i + 1 })),
  lineup: POS.map((position, i) => ({ index: i, position, playerId: i + 1, playerName: names[i] })),
  custom: {
    partie: { coachNom: 'Jean Coach' },
    equipe: { advClassement: '3e', advEntraineur: 'Pierre Adverse', advFormationPref: '4-3-3 MD Jeu large', advMentalite: 'Équilibré', advEff0Nom: 'A', advEff1Nom: 'B', advEff2Nom: 'C', advEff3Nom: 'D' },
  },
  ...over,
});

describe('carte compo d’avant-match', () => {
  it('place le onze sur le terrain avec le rapport sur l’adversaire', () => {
    const c = lineupCard([snap()])!;
    expect(c.key).toBe('2028-02-09|Toulouse|Lens');
    expect([c.formation, c.mentality, c.coach, c.home, c.competition]).toEqual(['4-1-2-2-1', 'Offensive', 'Jean Coach', true, 'Ligue 1']);
    expect(c.players).toHaveLength(11);
    expect(c.players[0]).toMatchObject({ id: '1', short: 'Gardien', number: 1, pos: 'GB' });
    // Gardien en bas, avant-centre en haut ; les deux D (C) côte à côte, pas l'un sur l'autre.
    expect(c.players[0]!.y).toBeGreaterThan(80);
    expect(c.players[10]!.y).toBeLessThan(15);
    expect(c.players[2]!.y).toBe(c.players[3]!.y);
    expect(c.players[2]!.x).toBeLessThan(c.players[3]!.x);
    // Même nom de famille : initiale ajoutée.
    expect([c.players[2]!.short, c.players[3]!.short]).toEqual(['M. Martin', 'H. Martin']);
    expect(c.opp).toEqual({ position: '3e', manager: 'Pierre Adverse', formation: '4-3-3', mentality: 'Équilibré' });
    expect(c.watch).toEqual(['A', 'B', 'C']);
    expect(c.threat).toMatch(/Lens/);
  });

  it('reprend la compo et le rapport d’un instantané précédent du même match', () => {
    const c = lineupCard([snap(), snap({ lineup: [], custom: null })])!;
    expect(c.players).toHaveLength(11);
    expect(c.opp?.manager).toBe('Pierre Adverse');
    expect(c.coach).toBe('Jean Coach');
  });

  it('rien sans compo complète, ni avec la compo d’un autre match', () => {
    expect(lineupCard([snap({ lineup: [] })])).toBeNull();
    expect(lineupCard([snap(), snap({ nextMatch: { opponent: 'Brest', inDays: 'Dans 4 jours' }, lineup: [] })])).toBeNull();
    expect(lineupCard([])).toBeNull();
  });

  it('match du jour et schéma', () => {
    expect(matchToday(snap())).toBe(true);
    expect(matchToday(snap({ nextMatch: { opponent: 'Lens', inDays: 'Dans 2 jours' } }))).toBe(false);
    expect(formationDigits('4-2-3-1 MD MO Jeu large')).toBe('4-2-3-1');
    expect(formationDigits('Jeu large')).toBeNull();
  });
});
