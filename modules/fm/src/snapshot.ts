import { z } from 'zod';

/**
 * Instantané écrit par le plugin BepInEx (format « archivix/1 ») dans
 * `<dossier FM>\archivix\archivix-snapshot.json`. Le plugin ne fait que lire le jeu ;
 * toute l'analyse se fait ici, pour que les évolutions passent par les mises à jour
 * de FM Immersion sans toucher au plugin.
 *
 * Schéma volontairement tolérant : les champs inconnus sont conservés et les
 * valeurs du jeu peuvent arriver en nombre ou en texte (« 1,2 M€ », « 85 % »).
 */
const loose = z.union([z.number(), z.string()]).nullish();
const range = z.object({ min: loose, max: loose }).passthrough();

export const fmPlayerSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    age: z.number().nullish(),
    positions: z.union([z.string(), z.array(z.string())]).nullish(),
    positionsText: z.string().nullish(),
    foot: z.string().nullish(),
    level: z.number().nullish(),
    condition: loose,
    sharpness: loose,
    morale: z.string().nullish(),
    contractEnd: z.string().nullish(),
    wage: loose,
    wageText: z.string().nullish(),
    value: loose,
    valueText: z.string().nullish(),
    squadStatus: z.string().nullish(),
    apps: z.number().nullish(),
    goals: z.number().nullish(),
    avgRating: z.number().nullish(),
    injury: z.union([z.string(), z.object({ description: z.string().nullish(), returnDays: z.number().nullish() }).passthrough()]).nullish(),
    injuryReturnDays: z.number().nullish(),
    attributes: z.record(z.union([z.number(), range])).nullish(),
  })
  .passthrough();

export const fmSnapshotSchema = z
  .object({
    schema: z.literal('archivix/1'),
    game: z.string(),
    club: z.string(),
    gameDate: z.string(),
    players: z.array(fmPlayerSchema),
    /** Tactique active lue dans le jeu (provisoire : le plugin ne donne pas encore le joueur par poste). */
    tactic: z.object({ name: z.string().nullish(), formation: z.string().nullish() }).passthrough().nullish(),
    /**
     * CA et PA réels (0-200) lus par FM Immersion dans la mémoire du jeu (lecture seule, si le joueur l'a activé), par id
     * de joueur, à la date de l'instantané. Échelle fixe, contrairement aux étoiles relatives à l'effectif.
     */
    abilities: z
      .record(
        z.object({
          ca: z.number(),
          pa: z.number(),
          /** Attributs cachés (régularité, saleté, grands matchs, fragilité, polyvalence), lus avec le CA/PA. */
          hidden: z.record(z.number()).nullish(),
          /** Octets de personnalité candidats, bruts (place de la pression à confirmer). */
          personalityRaw: z.array(z.number()).nullish(),
        }),
      )
      .nullish(),
  })
  .passthrough();

export type FmPlayerRaw = z.infer<typeof fmPlayerSchema>;
export type FmSnapshot = z.infer<typeof fmSnapshotSchema>;

/**
 * État du manager écrit par le plugin à chaque relecture (`archivix-status.json`) : le club entraîné,
 * ou `null` quand le manager est sans club (l'instantané d'effectif n'est alors pas réécrit).
 */
export const fmStatusSchema = z
  .object({
    schema: z.literal('archivix-status/1'),
    gameDate: z.string(),
    club: z.string().nullish(),
  })
  .passthrough();

export type FmStatus = z.infer<typeof fmStatusSchema>;

/** Source des joueurs prêtés dans le bloc `shortlist` (section `cibles` de chemins.json, 03/11/2026). */
export const LOAN_SOURCE = 'pretes';

/**
 * Joueurs prêtés lus par le plugin comme une liste de cibles (`Club/PlayersOutOnLoan`, source `pretes`) :
 * mêmes données que l'effectif, `club` = club où le joueur évolue.
 */
export function loanShortlist(snap: FmSnapshot): Record<string, unknown>[] {
  const list = Array.isArray(snap.shortlist) ? (snap.shortlist as unknown[]) : [];
  return list.filter((x): x is Record<string, unknown> => {
    const s = (x as Record<string, unknown> | null)?.sources;
    return Array.isArray(s) && s.includes(LOAN_SOURCE);
  });
}
