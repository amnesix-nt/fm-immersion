/**
 * Écrans du club (ex-FM Coach), listés à plat dans la barre latérale sous « Mon club ».
 * Chaque écran montre ses parties en sous-onglets, une à la fois (la première par défaut).
 * Les anciens noms d'écran restent valides : `/club/contracts` ouvre Mercato et finances sur Contrats.
 */
export const CLUB_PAGES = ['tactic', 'squad', 'results', 'mercato'] as const;
export type ClubPage = (typeof CLUB_PAGES)[number];

export const PARTS: Record<ClubPage, readonly string[]> = {
  tactic: ['tactic', 'instructions', 'builder', 'opponent', 'depth', 'calendar', 'style', 'effectiveness', 'project', 'training', 'staff'],
  squad: ['squad', 'playtime', 'dressing', 'progression', 'roles', 'compare', 'numbers', 'loans', 'academy'],
  results: ['results', 'diagnosis', 'stats', 'analysis'],
  mercato: ['mercato', 'scouting', 'targets', 'finances', 'wages', 'contracts'],
};

/**
 * Onglets de chaque écran, sur une seule rangée de pastilles (maquette du 11/11/2026) : une partie par onglet.
 * L'ordre suit la maquette.
 */
export const TABS: Record<ClubPage, readonly (readonly string[])[]> = {
  tactic: ['tactic', 'instructions', 'builder', 'opponent', 'calendar', 'training', 'depth', 'style', 'effectiveness', 'project', 'staff'].map((v) => [v]),
  squad: ['squad', 'academy', 'loans', 'numbers', 'playtime', 'dressing', 'progression', 'roles', 'compare'].map((v) => [v]),
  results: [['results'], ['diagnosis'], ['stats'], ['analysis']],
  mercato: [['mercato'], ['scouting'], ['targets'], ['finances'], ['wages'], ['contracts']],
};

/**
 * Refonte « l'essentiel d'abord » (14/11/2026) : au plus trois onglets visibles par écran, les plus utiles ;
 * les autres parties passent dans le menu « Plus » (toujours accessibles, liens et recherche inchangés).
 */
export const MAIN_TABS: Record<ClubPage, readonly string[]> = {
  tactic: ['tactic', 'opponent', 'training'],
  squad: ['squad', 'progression', 'academy'],
  results: ['results', 'diagnosis', 'stats', 'analysis'],
  mercato: ['mercato', 'targets', 'finances'],
};

/** Parties d'un écran rangées dans « Plus » (dans l'ordre des onglets). */
export const moreTabs = (page: ClubPage): string[] => TABS[page].flat().filter((v) => !MAIN_TABS[page].includes(v));

/** Sous-onglet qui contient une partie (le premier de l'écran à défaut). */
export function tabOf(page: ClubPage, part: string): readonly string[] {
  return TABS[page].find((t) => t.includes(part)) ?? TABS[page][0]!;
}

/** Écran qui contient une partie (lui-même, ou l'écran où elle a été regroupée) ; `home` pour l'accueil. */
export function pageOf(v: string): ClubPage | 'home' {
  if ((CLUB_PAGES as readonly string[]).includes(v)) return v as ClubPage;
  return CLUB_PAGES.find((k) => PARTS[k].includes(v)) ?? 'home';
}

/** Lien d'une partie : l'accueil est la page « Aujourd'hui ». */
export const clubPath = (v: string) => (v === 'home' ? '/' : `/club/${v}`);
