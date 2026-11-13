import { describe, expect, it } from 'vitest';
import { depthFromPlan, gameLineup, matchRole, mergeReference, planFromLineup, TacticEngine, type FmSnapshot } from '../src';
import { normalizePlayer } from '../src/player';

const engine = new TacticEngine(mergeReference(undefined));
const pl = (id: number, positions: string) => normalizePlayer({ id, name: `J${id}`, positions, level: 10, attributes: { Passing: 10, Tackling: 10, Positioning: 10 } });
const players = [pl(1, 'GB'), pl(2, 'D (D)'), pl(3, 'D (C)'), pl(4, 'D (C)'), pl(5, 'D (G)'), pl(6, 'MD (C)'), pl(7, 'M (C)'), pl(8, 'M (C)'), pl(9, 'MO (D)'), pl(10, 'MO (G)'), pl(11, 'BT'), pl(12, 'MD (C)')];
const snap = {
  lineup: {
    slots: [
      { position: 'GB', playerId: 1, roleIP: 'Gardien', roleOOP: 'Gardien' },
      { position: 'D (D)', playerId: 2, roleIP: 'FB', roleOOP: 'OPHoldingFullBack' },
      { position: 'D (C)', playerId: 3 },
      { position: 'D (C)', playerId: 4 },
      { position: 'D (G)', playerId: 5 },
      { position: 'MD (C)', playerName: 'J6', roleIP: 'Meneur de jeu en retrait', roleOOP: 'OPScreeningDefensiveMidfielder', customRole: true, instructions: { ip: ['Passes plus courtes'], oop: [] } },
      { position: 'M (C)', playerId: 7 },
      { position: 'M (C)', playerId: 8 },
      { position: 'MO (D)', playerId: 9 },
      { position: 'MO (G)', playerId: 10 },
      { position: 'BT (C)', playerId: 11 },
    ],
  },
} as unknown as FmSnapshot;

describe('compo lue dans le jeu', () => {
  it('lit le bloc lineup et retrouve les rôles du jeu', () => {
    const l = gameLineup(snap)!;
    expect(l).toHaveLength(11);
    expect(l[10]!.pos).toBe('BT');
    expect(matchRole(engine, 'OPScreeningDefensiveMidfielder', 'MDF', 'oop')?.code).toBe('SCRDM');
    expect(matchRole(engine, 'Meneur de jeu en retrait', 'MDF', 'ip')?.code).toBe('DLP');
    expect(gameLineup({} as FmSnapshot)).toBeNull();
  });

  it('construit le onze du jeu, avec ses doublures', () => {
    const plan = planFromLineup(engine, gameLineup(snap)!, players, '4-1-2-2-1');
    expect(plan.slots.map((s) => s.player?.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    const dm = plan.slots[5]!;
    expect([dm.ip, dm.oop]).toEqual(['DLP', 'SCRDM']);
    expect(dm.game?.custom).toBe(true);
    expect(plan.subs[5]!.map((p) => p.id)).toEqual(['12']);
    expect(depthFromPlan(plan, players).find((r) => r.pos === 'MDF')!.subs[0]!.player.id).toBe('12');
  });

  it('accepte le format du plugin 0.3 (rang, joueur, poste brut, sans rôles)', () => {
    const raw = [
      { index: 0, playerId: 1, playerName: 'J1', position: { Name: 'GB' } },
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id, k) => ({ index: k + 1, playerId: id, playerName: `J${id}`, position: null })),
    ];
    const l = gameLineup({ lineup: raw } as unknown as FmSnapshot)!;
    expect(l).toHaveLength(11);
    expect(l[0]!.pos).toBe('GB');
    const plan = planFromLineup(engine, l, players, null);
    expect(plan.slots).toHaveLength(11);
    // Sans poste lu ni schéma connu : premier poste du joueur ; rôles = meilleur rôle à ce poste.
    expect(plan.slots[5]!.pos).toBe('MDF');
    expect(plan.slots.every((s) => s.ip && s.oop)).toBe(true);
  });

  it('lit le format du plugin 0.3.1 (postes et rôles en noms anglais, rôle personnalisé, joueurs étendus)', async () => {
    const { withExtended, starsOf } = await import('../src');
    const raw = [
      { index: 0, playerId: 1, positionIP: 'GoalKeeper', ipRole: 'IPGoalkeeper', oopRole: 'OPGoalkeeper' },
      ...[2, 3, 4, 5, 7, 8, 9, 10, 11].map((id, k) => ({ index: k + 1, playerId: id, positionIP: null })),
      { index: 10, playerId: 6, positionIP: 'DefensiveMidfielder', ipRole: 'IPDeepLyingPlaymaker', oopRole: 'OPScreeningDefensiveMidfielder', roleOverride: { Role: 'B2B' } },
    ];
    const l = gameLineup({ lineup: raw } as unknown as FmSnapshot)!;
    expect(l[0]!.pos).toBe('GB');
    expect(l[10]!.pos).toBe('MDF');
    expect(l[10]!.custom).toBe(true);
    const plan = planFromLineup(engine, l, players, null);
    expect([plan.slots[10]!.ip, plan.slots[10]!.oop]).toEqual(['DLP', 'SCRDM']);
    const snap2 = withExtended({ players: [{ id: 6, name: 'J6' }], playersExtended: { '6': { morale: 5, moraleText: 'Bon', currentStars: { MinValue: 10, MaxValue: 10, IsScoutsOpinion: 'False' }, potentialStars: { MinValue: 15, MaxValue: 18 } } } } as unknown as FmSnapshot);
    const p6 = normalizePlayer(snap2.players[0]!);
    expect(p6.morale).toBe('Bon');
    expect(p6.stars).toMatchObject({ current: 2.5, potential: 4 });
    expect(starsOf({ MinValue: 20, MaxValue: 20 })).toBe(5);
    expect(starsOf(3)).toBe(3);
  });

  it('lit les suspensions de chemins.json (instantané réel du 01/11) et les écarte', async () => {
    const { withExtended, suspensionsOf, unavailable } = await import('../src');
    const ban = { Player: 'Person#213462', BanScope: { BanScopeString: 'Championnat national' }, ActiveBanMatchesRemaining: 1, ActiveBanMatchesElapsed: 0, ActiveBanTotalMatches: 1, ActiveBanReason: '3 cartons jaunes' };
    const base = { players: [{ id: 2000533385, name: 'Pontus Edh' }, { id: 7, name: 'J7' }] };
    const custom = (count: number, list: unknown) => ({ equipe: { nbSuspensionsEnCours: count, suspensionsEnCours: list }, joueurs: { '0': { id: 2000533385, suspensions: 1 }, '1': { id: 7, suspensions: 0 } } });
    const s1 = withExtended({ ...base, custom: custom(1, JSON.stringify([ban])) } as unknown as FmSnapshot);
    const [edh, j7] = s1.players.map(normalizePlayer);
    expect(edh!.suspension).toBe('Championnat national, 1 match, 3 cartons jaunes');
    expect(unavailable(edh!)).toBe(true);
    expect(j7!.suspension).toBeNull();
    // Après le match (01/11) : liste vide, cumul resté à 1 → plus suspendu.
    expect(suspensionsOf({ ...base, custom: { equipe: { nbSuspensionsEnCours: 0, suspensionsEnCours: '[]' }, joueurs: { '0': { id: 2000533385, suspensions: 1 } } } } as unknown as FmSnapshot).size).toBe(0);
    // Deux joueurs au cumul positif, une suspension reliée par suspenduId0 : seul le bon est écarté.
    const two = { equipe: { nbSuspensionsEnCours: 1, suspensionsEnCours: [ban], suspenduId0: 7 }, joueurs: { '0': { id: 2000533385, suspensions: 1 }, '1': { id: 7, suspensions: 1 } } };
    expect([...suspensionsOf({ ...base, custom: two } as unknown as FmSnapshot).keys()]).toEqual(['7']);
    // Sans id : par prudence, les deux candidats sont écartés.
    expect(suspensionsOf({ ...base, custom: { ...two, equipe: { nbSuspensionsEnCours: 1, suspensionsEnCours: [ban] } } } as unknown as FmSnapshot).size).toBe(2);
    // Compteur du joueur resté à 1 alors que l'équipe n'a plus de suspension : cumul, pas une suspension.
    expect(suspensionsOf({ ...base, custom: custom(0, []) } as unknown as FmSnapshot).size).toBe(0);
    // Liste déjà dépliée (objet) et sans compteur d'équipe : on se fie à la liste.
    expect(suspensionsOf({ ...base, custom: { equipe: { suspensionsEnCours: [ban] }, joueurs: { '0': { id: 2000533385, suspensions: 1 } } } } as unknown as FmSnapshot).get('2000533385')).toContain('1 match');
  });
});
