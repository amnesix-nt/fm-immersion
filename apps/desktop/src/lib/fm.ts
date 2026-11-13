import { saves } from '@fm-immersion/db';
import { addBaseTarget, refreshBaseTarget, carryRoleStars, fmSnapshotSchema, fmStatusSchema, type DbPlayer, type FmStatus, type GazetteWriting, type LeavingMark, type LeavingMarks, mergeTargets, type FmSnapshot, type TargetRecord } from '@fm-immersion/module-fm';
import { fmGazetteWriting, fmPressConferences, fmSnapshots, fmTargets, type FmPressConferenceRow } from '@fm-immersion/module-fm/schema';
import { and, asc, desc, eq, lte, ne } from 'drizzle-orm';
import { challengesRepo } from './challenges';
import type { Db } from './db';

/** Réglages FM rangés dans saves.extra. */
export interface FmSaveSettings {
  fmFolder?: string;
  /** Sauvegarde FM27 liée à la partie (nom du fichier .fm dans le dossier games). */
  fmSaveFile?: string;
  /** Copies de secours automatiques de la sauvegarde liée, après chaque sauvegarde de FM27. Désactivé par défaut. */
  fmBackups?: boolean;
  /** Copies gardées (3 par défaut). */
  fmBackupKeep?: number;
  /** Date d'écriture (ms) de la sauvegarde liée lors de la dernière copie : pas de nouvelle copie tant qu'elle ne change pas. */
  fmBackupDone?: number;
  /** Club suivi par la partie : un instantané d'un autre club vient d'une autre sauvegarde. */
  fmClub?: string;
  /** Date de jeu depuis laquelle le manager est sans club (lue dans l'état écrit par le plugin). */
  fmFreeSince?: string;
  /**
   * Dernière date de jeu vue sans club. Le départ n'est confirmé (hors-série envoyé sur Discord) que lorsque le jeu a
   * avancé sans club (`freeConfirmed`) : le plugin peut écrire un état « sans club » isolé pendant un chargement.
   */
  fmFreeSeen?: string;
  /** Lire le CA/PA réels de l'effectif dans la mémoire du jeu (lecture seule) à chaque nouvelle date. Désactivé par défaut. */
  fmReadAbilities?: boolean;
  /** Joueurs signalés partants par le coach, par identifiant FM27. */
  fmLeaving?: LeavingMarks;
  /** Photo du coach choisie par le joueur : PNG carré de 256 px (gros plan du manager dans FM27), en data URL. */
  coachPhoto?: string;
  /** Image d'origine réduite (JPEG, ou PNG pour garder la transparence, en data URL) et recadrage choisi, pour pouvoir recadrer la photo plus tard. */
  coachPhotoSource?: string;
  coachPhotoCrop?: { zoom: number; x: number; y: number };
  /** Pays des clubs entraînés corrigés à la main dans « Ma carrière » (nom du club → code de `countries.ts`). */
  careerCountries?: Record<string, string>;
  /** Clubs écartés de « Ma carrière » par le joueur (jours importés d'une autre sauvegarde, test…), par nom. */
  careerHidden?: string[];
}

/**
 * Date de départ du coach sans club, seulement s'il a été vu sans club à une date de jeu plus tardive. Le 13/11/2026
 * (partie « New One »), un état « sans club » écrit par le plugin pendant le chargement de la sauvegarde a envoyé sur
 * Discord un faux hors-série de départ, alors que le coach était toujours en poste : un vrai départ dure, lui.
 */
export function freeConfirmed(s: Pick<FmSaveSettings, 'fmFreeSince' | 'fmFreeSeen'>): string | null {
  return s.fmFreeSince && s.fmFreeSeen && s.fmFreeSeen > s.fmFreeSince ? s.fmFreeSince : null;
}

/** Fichier .fm listé par Rust (métadonnées seulement). */
export interface FmSaveFile {
  name: string;
  modifiedMs: number | null;
  bytes: number;
}

/**
 * Le plugin écrit un seul instantané pour la sauvegarde chargée dans FM27 : celui d'une autre
 * sauvegarde ne doit pas se mélanger à cette partie. On la reconnaît à son club.
 */
export class FmOtherSaveError extends Error {
  constructor(
    readonly club: string,
    readonly expected: string,
    /** Autre carrière FM Immersion qui a déjà ce jour de ce club : le relevé vient de sa sauvegarde, pas de la nouvelle. */
    readonly career?: string,
  ) {
    super(career ? `instantané de ${club}, déjà dans la carrière ${career}` : `instantané de ${club}, la partie suit ${expected}`);
    this.name = 'FmOtherSaveError';
  }
}

/** File des écritures des réglages (voir `updateSettings`). */
let settingsQueue: Promise<unknown> = Promise.resolve();

/**
 * Instantanés Football Manager d'une partie. Un seul instantané par date de jeu :
 * réimporter le même jour remplace le précédent, une nouvelle date l'ajoute à l'historique.
 */
export function fmRepo(db: Db) {
  return {
    async latest(saveId: string) {
      const [row] = await db
        .select()
        .from(fmSnapshots)
        .where(eq(fmSnapshots.saveId, saveId))
        .orderBy(desc(fmSnapshots.gameDate))
        .limit(1);
      return row ?? null;
    },

    async history(saveId: string) {
      return db
        .select({ gameDate: fmSnapshots.gameDate, playerCount: fmSnapshots.playerCount })
        .from(fmSnapshots)
        .where(eq(fmSnapshots.saveId, saveId))
        .orderBy(desc(fmSnapshots.gameDate));
    },

    /**
     * Nom de l'autre carrière qui a déjà ce club à cette date (le même relevé du plugin), ou null. Les fichiers du plugin
     * sont communs à toutes les sauvegardes : c'est ainsi qu'on reconnaît ceux d'une autre partie.
     */
    async ownerElsewhere(saveId: string, club: string, gameDate: string): Promise<string | null> {
      const [row] = await db
        .select({ name: saves.name })
        .from(fmSnapshots)
        .innerJoin(saves, eq(saves.id, fmSnapshots.saveId))
        .where(and(ne(fmSnapshots.saveId, saveId), eq(fmSnapshots.club, club), eq(fmSnapshots.gameDate, gameDate)))
        .limit(1);
      return row ? row.name : null;
    },

    /** Jours (AAAA-MM-JJ) de ce club déjà enregistrés dans une autre carrière : ils ne sont pas rattrapés ici. */
    async datesElsewhere(saveId: string, club: string): Promise<Set<string>> {
      const rows = await db
        .select({ gameDate: fmSnapshots.gameDate })
        .from(fmSnapshots)
        .where(and(ne(fmSnapshots.saveId, saveId), eq(fmSnapshots.club, club)));
      return new Set(rows.map((r) => r.gameDate.slice(0, 10)));
    },

    /** Tous les instantanés de la partie, du plus ancien au plus récent, pour les courbes et projections. */
    async all(saveId: string) {
      return db
        .select({ gameDate: fmSnapshots.gameDate, data: fmSnapshots.data })
        .from(fmSnapshots)
        .where(eq(fmSnapshots.saveId, saveId))
        .orderBy(asc(fmSnapshots.gameDate));
    },

    /**
     * Valide le JSON du plugin puis l'enregistre. Lève une erreur zod si le fichier n'est pas reconnu,
     * et `FmOtherSaveError` s'il vient d'un autre club que celui de la partie (sauf `force`, après un
     * changement de club dans la même carrière : le nouveau club devient celui de la partie).
     */
    async importSnapshot(saveId: string, raw: unknown, opts: { force?: boolean } = {}): Promise<FmSnapshot> {
      const parsed = fmSnapshotSchema.parse(raw);
      const settings = await this.settings(saveId);
      // Les étoiles des rôles sont lues un poste à la fois : on garde les tables lues avant.
      const prev = await this.latest(saveId);
      const expected = settings.fmClub ?? prev?.club;
      // Après une période sans club dans cette carrière, le nouveau club est accepté sans confirmation.
      const newJob = !!settings.fmFreeSince && parsed.gameDate >= settings.fmFreeSince;
      if (expected && parsed.club !== expected && !opts.force && !newJob) throw new FmOtherSaveError(parsed.club, expected);
      // Carrière toute neuve (11/11/2026, partie « New One ») : tant que FM27 n'a rien écrit pour la nouvelle sauvegarde,
      // le fichier du plugin est encore celui de l'ancienne. Un jour de club déjà enregistré dans une autre carrière
      // vient de cette autre sauvegarde : il n'est pas pris sans confirmation.
      if (!prev && !opts.force) {
        const owner = await this.ownerElsewhere(saveId, parsed.club, parsed.gameDate);
        if (owner !== null) throw new FmOtherSaveError(parsed.club, '', owner);
      }
      // Un ancien instantané (d'avant le départ) ne met pas fin à la période sans club, et un jour plus ancien que le
      // dernier (ancien club importé depuis « Ma carrière ») ne change pas le club suivi par la partie.
      const older = !!prev && parsed.gameDate < prev.gameDate;
      if ((settings.fmClub !== parsed.club && !older) || newJob)
        await this.updateSettings(saveId, { fmClub: parsed.club, ...(newJob ? { fmFreeSince: undefined, fmFreeSeen: undefined } : {}) });
      let snap = carryRoleStars(parsed, prev?.club === parsed.club ? prev?.data : undefined);
      // CA/PA lus en mémoire pour cette date : le plugin réécrit l'instantané, on les garde.
      if (!snap.abilities && prev?.gameDate === snap.gameDate && prev.club === snap.club && prev.data.abilities) snap = { ...snap, abilities: prev.data.abilities };
      // Défis en cours : un retour à une date déjà vue (sauvegarde rechargée) est noté avant d'écraser ce jour.
      await challengesRepo(db).noteImport(saveId, snap.gameDate);
      const values = { saveId, gameDate: snap.gameDate, club: snap.club, playerCount: snap.players.length, data: snap };
      // Remplacement du jour en une seule transaction : jamais de jour perdu (appli fermée entre les deux) ni doublé.
      await db.batch([
        db.delete(fmSnapshots).where(and(eq(fmSnapshots.saveId, saveId), eq(fmSnapshots.gameDate, snap.gameDate))),
        db.insert(fmSnapshots).values(values),
      ]);
      await this.saveTargets(saveId, snap);
      await db.update(saves).set({ updatedAt: new Date().toISOString() }).where(eq(saves.id, saveId));
      return snap;
    },

    /**
     * Joint à l'instantané de cette date le CA/PA réels lus dans la mémoire du jeu (rien si l'instantané manque).
     */
    async attachAbilities(saveId: string, gameDate: string, players: { id: number | string; ca: number; pa: number }[]) {
      const [row] = await db
        .select()
        .from(fmSnapshots)
        .where(and(eq(fmSnapshots.saveId, saveId), eq(fmSnapshots.gameDate, gameDate)));
      if (!row) return false;
      const abilities = Object.fromEntries(players.map((p) => [String(p.id), { ca: p.ca, pa: p.pa }]));
      await db
        .update(fmSnapshots)
        .set({ data: { ...row.data, abilities } })
        .where(eq(fmSnapshots.id, row.id));
      return true;
    },

    /** Cibles du mercato gardées pour la partie (y compris celles que le jeu ne liste plus). */
    async targets(saveId: string): Promise<TargetRecord[]> {
      const rows = await db.select().from(fmTargets).where(eq(fmTargets.saveId, saveId)).orderBy(desc(fmTargets.lastSeen));
      return rows.map(({ saveId: _s, updatedAt: _u, ...r }) => r);
    },

    /** Ajoute ou met à jour les cibles lues dans l'instantané (rien si le plugin ne les a pas lues). */
    async saveTargets(saveId: string, snap: FmSnapshot) {
      const changes = mergeTargets(await this.targets(saveId), snap);
      if (!changes?.length) return;
      const now = new Date().toISOString();
      for (const c of changes) {
        const row = { ...c, saveId, updatedAt: now };
        await db
          .insert(fmTargets)
          .values(row)
          .onConflictDoUpdate({
            target: [fmTargets.saveId, fmTargets.playerId],
            set: { name: row.name, club: row.club, firstSeen: row.firstSeen, lastSeen: row.lastSeen, inList: row.inList, data: row.data, updatedAt: now },
          });
      }
    },

    /** Ajoute aux cibles un joueur trouvé dans la base du jeu (recherche en lecture directe). */
    async addBaseTarget(saveId: string, p: DbPlayer, gameDate: string) {
      const c = addBaseTarget(await this.targets(saveId), p, gameDate);
      const now = new Date().toISOString();
      const row = { ...c, saveId, updatedAt: now };
      await db
        .insert(fmTargets)
        .values(row)
        .onConflictDoUpdate({
          target: [fmTargets.saveId, fmTargets.playerId],
          set: { name: row.name, club: row.club, firstSeen: row.firstSeen, lastSeen: row.lastSeen, inList: true, dismissed: false, data: row.data, updatedAt: now },
        });
    },

    /** Relecture des joueurs suivis dans la base du jeu : prix, CA et contrat ajoutés à leur suivi. */
    async refreshBaseTargets(saveId: string, found: DbPlayer[], gameDate: string) {
      const known = new Map((await this.targets(saveId)).map((r) => [r.playerId, r]));
      const now = new Date().toISOString();
      let n = 0;
      for (const p of found) {
        const prev = known.get(String(p.id));
        if (!prev) continue;
        const c = refreshBaseTarget(prev, p, gameDate);
        await db
          .update(fmTargets)
          .set({ name: c.name, club: c.club, lastSeen: c.lastSeen, data: c.data, updatedAt: now })
          .where(and(eq(fmTargets.saveId, saveId), eq(fmTargets.playerId, c.playerId)));
        n++;
      }
      return n;
    },

    /** Gazette déjà rédigée par l'IA pour cette semaine, si les faits n'ont pas changé depuis. */
    async writing(saveId: string, weekStart: string, facts: string): Promise<GazetteWriting | null> {
      const [row] = await db
        .select()
        .from(fmGazetteWriting)
        .where(and(eq(fmGazetteWriting.saveId, saveId), eq(fmGazetteWriting.weekStart, weekStart)));
      return row && row.facts === facts ? row.content : null;
    },

    /** Garde la gazette rédigée par l'IA (remplace celle de la même semaine). */
    async saveWriting(saveId: string, weekStart: string, facts: string, content: GazetteWriting, model: string) {
      const writtenAt = new Date().toISOString();
      await db
        .insert(fmGazetteWriting)
        .values({ saveId, weekStart, facts, content, model, writtenAt })
        .onConflictDoUpdate({ target: [fmGazetteWriting.saveId, fmGazetteWriting.weekStart], set: { facts, content, model, writtenAt } });
    },

    /** Conférences de presse tenues ou refusées par le coach, de la plus récente à la plus ancienne. */
    async pressConferences(saveId: string): Promise<FmPressConferenceRow[]> {
      return db.select().from(fmPressConferences).where(eq(fmPressConferences.saveId, saveId)).orderBy(desc(fmPressConferences.matchDate));
    },

    /** Garde une conférence de presse (réponses vides = refusée). Une seule par match et par moment. */
    async savePressConference(row: Omit<FmPressConferenceRow, 'answeredAt'>) {
      const answeredAt = new Date().toISOString();
      await db
        .insert(fmPressConferences)
        .values({ ...row, answeredAt })
        .onConflictDoUpdate({ target: [fmPressConferences.saveId, fmPressConferences.key], set: { questions: row.questions, answers: row.answers, answeredAt } });
    },

    /** Écarte une cible (ou la remet) dans FM Immersion, sans rien changer dans le jeu. */
    async dismissTarget(saveId: string, playerId: string, dismissed: boolean) {
      await db
        .update(fmTargets)
        .set({ dismissed, updatedAt: new Date().toISOString() })
        .where(and(eq(fmTargets.saveId, saveId), eq(fmTargets.playerId, playerId)));
    },

    async settings(saveId: string): Promise<FmSaveSettings> {
      const [row] = await db.select({ extra: saves.extra }).from(saves).where(eq(saves.id, saveId));
      return (row?.extra ?? {}) as FmSaveSettings;
    },

    /**
     * Note l'état du manager écrit par le plugin. Sans club : la partie le retient (date de départ),
     * seulement si cet état est postérieur au dernier instantané (sinon il vient d'une autre sauvegarde).
     */
    async noteStatus(saveId: string, raw: unknown): Promise<FmStatus> {
      const status = fmStatusSchema.parse(raw);
      if (status.club) return status;
      const [settings, prev] = await Promise.all([this.settings(saveId), this.latest(saveId)]);
      if (!settings.fmFreeSince && (!prev || status.gameDate >= prev.gameDate)) await this.updateSettings(saveId, { fmFreeSince: status.gameDate, fmFreeSeen: status.gameDate });
      else if (settings.fmFreeSince && status.gameDate > (settings.fmFreeSeen ?? settings.fmFreeSince)) await this.updateSettings(saveId, { fmFreeSeen: status.gameDate });
      return status;
    },

    /**
     * Modifie les réglages sans écraser une autre modification faite au même moment : les écritures passent une à
     * une (lecture puis écriture), et `patch` peut se calculer à partir des réglages relus juste avant.
     */
    updateSettings(saveId: string, patch: Partial<FmSaveSettings> | ((prev: FmSaveSettings) => Partial<FmSaveSettings>)) {
      const run = settingsQueue.then(async () => {
        const prev = await this.settings(saveId);
        const next: Record<string, unknown> = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
        await db.update(saves).set({ extra: next }).where(eq(saves.id, saveId));
      });
      settingsQueue = run.catch(() => undefined);
      return run;
    },

    setFolder(saveId: string, fmFolder: string) {
      return this.updateSettings(saveId, { fmFolder });
    },

    /** Signale un joueur partant (ou annule le signalement avec `null`). */
    async setLeaving(saveId: string, playerId: string, mark: LeavingMark | null) {
      return this.updateSettings(saveId, (prev) => {
        const next: LeavingMarks = { ...(prev.fmLeaving ?? {}) };
        if (mark) next[playerId] = mark;
        else delete next[playerId];
        return { fmLeaving: Object.keys(next).length ? next : undefined };
      });
    },

    /**
     * Lie la partie à une sauvegarde FM27 (ou défait le lien avec `null`). Un fichier .fm ne suit qu'une partie :
     * une autre partie liée au même fichier perd son lien.
     */
    async linkSave(saveId: string, fmSaveFile: string | null) {
      if (fmSaveFile) {
        const rows = await db.select({ id: saves.id, extra: saves.extra }).from(saves).where(eq(saves.gameId, 'fm'));
        for (const r of rows)
          if (r.id !== saveId && (r.extra as FmSaveSettings | null)?.fmSaveFile === fmSaveFile) await this.updateSettings(r.id, { fmSaveFile: undefined });
      }
      return this.updateSettings(saveId, { fmSaveFile: fmSaveFile ?? undefined });
    },

    /**
     * Date de jeu au moment où la sauvegarde a été écrite : celle du dernier instantané importé avant `at` (ISO).
     * Le plugin réécrit l'instantané du jour toutes les 5 minutes, donc le résultat peut avoir un jour de retard :
     * jamais d'avance, l'alerte « pas sauvegardé » ne se déclenche pas à tort.
     */
    async gameDateAt(saveId: string, at: string): Promise<string | null> {
      const [row] = await db
        .select({ gameDate: fmSnapshots.gameDate })
        .from(fmSnapshots)
        .where(and(eq(fmSnapshots.saveId, saveId), lte(fmSnapshots.importedAt, at)))
        .orderBy(desc(fmSnapshots.gameDate))
        .limit(1);
      return row?.gameDate ?? null;
    },
  };
}
