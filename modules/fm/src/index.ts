import type { GameModuleManifest } from '@fm-immersion/shared';

/**
 * Module Football Manager.
 * Les données viennent du plugin BepInEx (lecture seule) qui écrit un instantané JSON
 * dans le dossier du jeu ; FM Immersion l'importe, le garde en historique et l'analyse.
 */
export const manifest: GameModuleManifest = {
  id: 'fm',
  supportedVersions: ['27'],
};

export * from './snapshot';
export * from './positions';
export * from './player';
export * from './alerts';
export * from './analysis';
export * from './summary';
export * from './tactic';
export * from './tactic-defaults';
export * from './club';
export * from './progress';
export * from './project';
export * from './team-plan';
export * from './targets';
export * from './teams';
export * from './training';
export * from './training-guide';
export * from './youth';
export * from './academy';
export * from './training-yield';
export * from './fixtures';
export * from './instructions';
export * from './player-instructions-fm27';
export * from './team-instructions-fm27';
export * from './role-ratings-fm27';
export * from './game-stars';
export * from './lineup';
export * from './tactic-slots';
export * from './game-instructions';
export * from './tactic-advice';
export * from './lineup-advice';
export * from './team-advice';
export * from './tactic-gap';
export * from './tactic-builder';
export * from './opponent';
export * from './matchup';
export * from './match-plan';
export * from './mercato';
export * from './evolution';
export * from './decisions';
export * from './compat';
export * from './plan-grade';
export * from './stats';
export * from './subs';
export * from './rules';
export * from './registration';
export * from './takers';
export * from './reliability';
export * from './results';
export * from './replacement';
export * from './needs';
export * from './diagnose';
export * from './staff';
export * from './shirts';
export * from './lastmatch';
export * from './gazette';
export * from './live';
export * from './season';
export * from './game-request';
export * from './player-history';
export * from './farewell';
export * from './breaking';
export * from './coach-news';
export * from './bigmatch';
export * from './records';
export * from './offseason';
export * from './playtime';
export * from './pricing';
export * from './reach';
export * from './trading';
export * from './scouting';
export * from './briefing';
export * from './matchday';
export * from './rotation';
export * from './challenges';
export * from './glory-hunter';
export * from './cups';
export * from './club-look';
export * from './countries';
export * from './career';
export * from './coach-life';
export * from './coach-scenes';
export * from './press';
export * from './match-review';
export * from './tactic-todo';
export * from './engine-value';
export * from './formations-faced';
