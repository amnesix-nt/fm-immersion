import type { InstructionGroup } from './instructions';
import { PLAYER_INSTRUCTIONS_FM27, piKey } from './player-instructions-fm27';
import { TEAM_INSTRUCTIONS_FM27 } from './team-instructions-fm27';

/*
 * Consignes de la tactique jouée, lues par le plugin (section `tactique` de chemins.json, validée en jeu le 09/11/2026) :
 *
 * - consignes d'équipe : `ce_<id>_<Code>` = SelectedTeamInstructionOption{TeamInstructionID=id}, une valeur de
 *   l'énumération TacticTeamInstructionOptions du jeu (des nombres sans ordre apparent, d'où la table ci-dessous) ;
 * - consignes individuelles : `ci_<i>_<g>` = SelectedPlayerInstruction{PlayerInstructionGroupID=g, TeamSelectionIndex=i,
 *   InPossession}, une valeur de l'énumération PlayerInstruction (0 = aucune), et `ciModif_<i>_<g>` =
 *   PlayerInstructionGroupIsTweaked : « True » quand c'est le joueur qui l'a choisie, « False » quand le rôle l'impose.
 *
 * Énumérations relevées dans les fichiers d'interface générés par BepInEx (FM.UI) ; rien n'est écrit dans le jeu.
 */

/** Valeur du jeu de chaque option, par consigne d'équipe, dans l'ordre des options de TEAM_INSTRUCTIONS_FM27. */
const TI_OPTION_VALUES: Record<number, number[]> = {
  1: [1985571685, 1146434657, 1483944022, 2019653698, 1867543624],
  3: [1450726497, 846284410, 1734436950],
  4: [1716541542, 1111652208, 1951095402, 1244744824, 1347573861],
  5: [1752052821, 1934574368, 1297429358],
  6: [1869829494, 896626297],
  // Perdre du temps : le jeu a trois valeurs (moins souvent, standard, plus souvent) ; seules les deux dernières ont leur option à l'écran.
  // Perdre du temps : le jeu a trois valeurs (moins souvent, standard, plus souvent), l'écran deux options.
  7: [1329030726, 1733973351],
  8: [927550517, 1196979288, 2033537859],
  9: [2003456321, 807423041, 894978671, 1329018200, 1735747406],
  10: [1500664391, 1985168495, 1313689463, 2000905329, 1450268022],
  11: [2001753209, 1396068403, 928473934],
  12: [896480825, 1297249398, 1498428227],
  15: [825575765, 1397124971, 1466132292],
  16: [1398290509, 1097811032, 1732531317, 2001361485, 543316536, 1362654530, 1664119088],
  17: [1936095309, 842232368, 1380137303],
  18: [844190326, 1364668513, 1196903216],
  19: [946684999, 1480870768, 1313559094],
  20: [1817268034, 1196126273, 1987666283],
  21: [1498756423, 1311996258, 1496610426, 1345339954, 543778113],
  22: [1684615797, 1097682775, 1280010857],
  23: [1667524405, 1748587383],
  24: [1365857100, 1732331848, 1702379875],
  25: [1870092139, 844782149, 1381658469],
  26: [1817334343, 1649964405, 1850439286, 542589235],
  27: [2021157752, 1951290700, 1799907952],
  28: [1128871265, 1246451814, 894725200, 1848850767],
  29: [1730167140, 1248478788, 1749839698],
  30: [1800754547, 1465200750, 2001548153, 1299723626, 1849981002],
  31: [1700947790, 1496789296, 1484157235, 809924212],
};

/** Groupes de consignes individuelles du jeu (PlayerInstructionGrouping), par numéro. */
const PI_GROUPS: InstructionGroup[] = [
  'AttackingWidth', 'DribblingDirection', 'DribblingFrequency', 'ForwardRuns', 'FreedomOfMovement', 'HoldUpBall', 'Shooting',
  'PassingStrategy', 'PassingRisk', 'CrossingStrategy', 'CrossFrom', 'TriggerPress', 'Marking', 'Tackling', 'MarkingTarget',
  'AttackBoxSide', 'AttackBoxDepth',
];

/** Groupes sans ballon (lus avec InPossession=false). */
export const PI_GROUPS_OOP = new Set([11, 12, 13, 14]);

/** Option du jeu (PlayerInstruction) → option affichée à l'écran (libellé FR de PLAYER_INSTRUCTIONS_FM27). */
const PI_OPTION: Record<number, string> = {
  1: 'Plus courtes', 2: 'Plus directes', 3: 'Prenez plus de risques', 4: 'Prenez moins de risques',
  7: 'Centrez en profondeur', 8: 'Ligne de but', 9: 'Premier poteau', 10: 'Second poteau', 11: 'Centre', 12: 'Attaquant pivot',
  13: 'Dribblez plus', 14: 'Dribblez moins', 15: 'Prenez les couloirs', 16: "Repiquez dans l'axe", 17: 'Oui',
  18: 'Tirer plus souvent', 19: 'Tirer moins souvent', 22: 'Effectuez plus de courses', 23: 'Effectuez moins de courses',
  24: 'Décrochez plus souvent', 25: 'Restez excentrés', 26: "Restez plus dans l'axe", 27: 'Prenez les espaces',
  29: 'Plus souvent', 30: 'Moins souvent', 31: 'Taclez plus durement', 32: 'Taclez moins durement', 33: 'Marquez de plus près',
  34: 'Marquage individuel', 35: 'Marquage de zone',
  36: 'Centre', 37: 'Gauche', 38: 'Droite', 39: 'Premier poteau', 40: 'Second poteau',
  41: 'Attaquer la ligne défensive', 42: 'Arriver en retard dans la surface',
};

export interface GameInstructions {
  /** Consignes d'équipe : identifiant du jeu → index de l'option (comme `BuiltTactic.ti`). */
  ti: Record<string, number>;
  /** Par index de sélection (0-10) : consignes individuelles choisies par le joueur (« Groupe:Option »). */
  pi: string[][];
  /** Par index de sélection : consignes que le rôle impose (même format), pour information. */
  imposed: string[][];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Consignes de la tactique jouée d'après le bloc `custom.tactique` de l'instantané, ou null si le plugin ne les a pas
 * lues (chemins.json sans ces clés, écran Tactique ouvert…).
 */
export function gameInstructions(snap: unknown): GameInstructions | null {
  const t = (snap as { custom?: { tactique?: Record<string, unknown> } } | null | undefined)?.custom?.tactique;
  if (!t || typeof t !== 'object') return null;
  const ti: Record<string, number> = {};
  let seen = 0;
  for (const def of TEAM_INSTRUCTIONS_FM27) {
    const key = Object.keys(t).find((k) => k.startsWith(`ce_${def.id}_`));
    const v = key ? num(t[key]) : null;
    if (v == null) continue;
    seen++;
    const o = TI_OPTION_VALUES[def.id]?.indexOf(v) ?? -1;
    if (o >= 0) ti[def.id] = o;
  }
  const pi: string[][] = [];
  const imposed: string[][] = [];
  for (let i = 0; i < 11; i++) {
    const mine: string[] = [];
    const role: string[] = [];
    PI_GROUPS.forEach((group, g) => {
      const v = num(t[`ci_${i}_${g}`]);
      if (v == null) return;
      seen++;
      const option = PI_OPTION[v];
      if (!option) return;
      const tweaked = String(t[`ciModif_${i}_${g}`] ?? '').toLowerCase() === 'true';
      (tweaked ? mine : role).push(piKey(group, option));
    });
    pi.push(mine);
    imposed.push(role);
  }
  return seen ? { ti, pi, imposed } : null;
}

/**
 * Consignes individuelles réglées dans FM27, par joueur : celles qu'il a choisies (`mine`) et celles que son rôle
 * impose (`imposed`). Le rang de sélection relie la tactique à la compo (`lineup[].index` → `playerId`).
 * Vide si le plugin n'a lu ni les consignes ni la compo.
 */
export function gamePlayerInstructions(snap: unknown): Map<string, { mine: string[]; imposed: string[] }> {
  const out = new Map<string, { mine: string[]; imposed: string[] }>();
  const gi = gameInstructions(snap);
  const raw = (snap as { lineup?: unknown } | null | undefined)?.lineup;
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { slots?: unknown } | null)?.slots) ? ((raw as { slots: unknown[] }).slots) : null;
  if (!gi || !rows) return out;
  rows.forEach((r, k) => {
    if (!r || typeof r !== 'object') return;
    const o = r as Record<string, unknown>;
    const id = o.playerId ?? o.player_id ?? o.id;
    const index = typeof o.index === 'number' ? o.index : k;
    if (id == null || index < 0 || index > 10) return;
    out.set(String(id), { mine: gi.pi[index] ?? [], imposed: gi.imposed[index] ?? [] });
  });
  return out;
}

/**
 * Clé « Groupe:Option » d'une consigne individuelle d'après sa valeur dans l'énumération PlayerInstruction du jeu,
 * ou null si elle n'a pas d'option à l'écran. Les options « Centre », « Premier poteau » et « Second poteau »
 * existent dans deux groupes : à partir de 36, ce sont celles d'« Attaquer la surface ».
 */
export function piKeyOfGameValue(v: number): string | null {
  const option = PI_OPTION[v];
  if (!option) return null;
  const box = v >= 36;
  const def = PLAYER_INSTRUCTIONS_FM27.find((g) => g.group.startsWith('AttackBox') === box && g.options.some((o) => o.fr === option));
  return def ? piKey(def.group, option) : null;
}
