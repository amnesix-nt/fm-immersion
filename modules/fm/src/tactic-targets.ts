import { engineValue, fitMetaScore } from './engine-value';
import type { FmPlayer } from './player';
import { recruitAttrs, type Project, type ProjectSlot } from './project';
import { attrOf, slotFit, type TacticEngine } from './tactic';

/**
 * Recrues pour la tactique choisie : pour un poste du onze de la tactique (rôles avec et sans ballon), les joueurs
 * qui collent à ce poste ET que le moteur de match récompense. Chaque joueur est noté « poste et méta » :
 * moyenne de son adéquation aux deux rôles du créneau (note du jeu, sur 20) et de sa note méta au poste (ce que
 * ses attributs valent dans le moteur, sur 20, voir engine-value.ts ; pour un gardien,
 * la note de l'étude Match Lab : agilité, réflexes).
 * La note est comparée à celle du titulaire et de la doublure du poste, notés de la même façon.
 */

export interface SlotNote {
  /** Adéquation aux deux rôles du créneau, sur 20. */
  fit: number | null;
  /** Note méta au poste du créneau, sur 20 (null si les attributs ne sont pas lus). */
  meta: number | null;
  /** Poste et méta : moyenne des deux (une seule connue : elle seule). */
  score: number | null;
}

/** Note « poste et méta » d'un joueur sur un créneau de la tactique. */
export function slotNote(engine: TacticEngine, p: FmPlayer, sl: ProjectSlot): SlotNote {
  const fit = slotFit(engine, p, sl);
  const meta = engineValue(p, sl.pos)?.meta ?? null;
  return { fit, meta, score: fitMetaScore(fit, meta) };
}

export type RecruitPickVerdict = 'starter' | 'backup' | 'none';

export interface RecruitPick<T extends FmPlayer = FmPlayer> extends SlotNote {
  player: T;
  score: number;
  /** Écart de note poste et méta avec le titulaire (null s'il n'y en a pas). */
  gain: number | null;
  verdict: RecruitPickVerdict;
  /** Attributs clés du poste (rôle avec ballon puis sans ballon), avec sa valeur. */
  keys: { key: string; value: number | null }[];
}

export interface TacticSlotSearch<T extends FmPlayer = FmPlayer> {
  slot: ProjectSlot;
  /** Titulaire du poste dans le onze de la tactique et sa note. */
  starter: (SlotNote & { player: FmPlayer }) | null;
  /** Meilleure doublure de l'effectif au poste (hors titulaires). */
  backup: (SlotNote & { player: FmPlayer }) | null;
  /** Attributs clés du poste, à regarder en premier. */
  keys: string[];
  /** Candidats qui jouent naturellement au poste, du meilleur au moins bon (poste et méta). */
  picks: RecruitPick<T>[];
}

/** Marge sous laquelle deux notes sont jugées égales (sur 20), comme pour les cibles. */
export const PICK_MARGIN = 0.25;

/**
 * Candidats pour un poste de la tactique, classés poste et méta. Seuls ceux qui jouent naturellement au poste
 * sont gardés (le jeu les y note), les joueurs de l'effectif sont écartés.
 */
export function tacticSlotSearch<T extends FmPlayer>(engine: TacticEngine, project: Project, slot: ProjectSlot, candidates: readonly T[], squad: readonly FmPlayer[] = []): TacticSlotSearch<T> {
  const keys = recruitAttrs(engine, slot);
  const own = new Set(squad.map((p) => p.id));
  const starters = new Set(project.slots.flatMap((sl) => (sl.player ? [sl.player.id] : [])));
  const starter = slot.player ? { player: slot.player, ...slotNote(engine, slot.player, slot) } : null;
  let backup: TacticSlotSearch['backup'] = null;
  for (const p of squad) {
    if (starters.has(p.id) || !p.positions.includes(slot.pos)) continue;
    const n = slotNote(engine, p, slot);
    if (n.score != null && (!backup || n.score > (backup.score ?? -Infinity))) backup = { player: p, ...n };
  }
  const picks: RecruitPick<T>[] = [];
  const seen = new Set<string>();
  for (const p of candidates) {
    if (seen.has(p.id) || own.has(p.id) || own.has(p.id.replace(/^t/, '')) || !p.positions.includes(slot.pos)) continue;
    seen.add(p.id);
    const n = slotNote(engine, p, slot);
    if (n.score == null) continue;
    const gain = starter?.score != null ? n.score - starter.score : null;
    const verdict: RecruitPickVerdict =
      gain == null || gain >= PICK_MARGIN ? 'starter' : backup?.score == null || n.score - backup.score >= PICK_MARGIN ? 'backup' : 'none';
    picks.push({ player: p, ...n, score: n.score, gain, verdict, keys: keys.map((key) => ({ key, value: attrOf(p, key) })) });
  }
  picks.sort((a, b) => b.score - a.score || (b.fit ?? 0) - (a.fit ?? 0));
  return { slot, starter, backup, keys, picks };
}

/**
 * Poste à renforcer en premier : le créneau sans titulaire, sinon celui dont le titulaire a la plus basse note
 * poste et méta.
 */
export function weakestSlot(engine: TacticEngine, project: Project): ProjectSlot | null {
  let best: { sl: ProjectSlot; score: number } | null = null;
  for (const sl of project.slots) {
    const score = sl.player ? (slotNote(engine, sl.player, sl).score ?? -1) : -Infinity;
    if (!best || score < best.score) best = { sl, score };
  }
  return best?.sl ?? null;
}
