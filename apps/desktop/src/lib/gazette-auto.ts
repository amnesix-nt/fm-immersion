import { invoke } from '@tauri-apps/api/core';
import {
  bigMatchNow,
  breakingNews,
  isCoachBreaking,
  recordKey,
  recordNews,
  coachExits,
  gazetteIssues,
  seasonReviews,
  seasonSoFar,
  type BigMatch,
  type BreakingNews,
  type CoachExit,
  type ExitReason,
  type GazetteIssue,
  type RecordNews,
  type SeasonReview,
} from '@fm-immersion/module-fm';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { withWriting } from './ai-gazette';
import { CAREER_KEY } from './career';
import { rememberClubLooks } from './club-look';
import { bigMatchPayload, drawBigMatch } from './bigmatch-page';
import { breakingPayload, drawBreaking } from './breaking-page';
import { fmData, savesData } from './data';
import { freeConfirmed } from './fm';
import { getWebhook, isWebhook, sendDiscordImage } from './discord';
import { fetchHistory } from './fm-cache';
import { drawFarewell } from './farewell-page';
import { farewellPayload } from './farewell-text';
import { drawPage } from './gazette-page';
import { issuesWithPress } from './press';
import { discordPagePayload } from './gazette-text';
import { canvasPng, recentForm } from './gazette-une';
import { autoPhotosNow, breakingTag, existingPhoto, gazetteTag, getPhotoMode, photoForEvent, sceneForBreaking, sceneForHeadline } from './photo-events';
import { loadFace } from './player-face';
import { drawRecord, recordPayload } from './records-page';
import { drawSeason, seasonPayload } from './season-une';

/** Envoie la gazette n° `index` (une en image + encart), comme le bouton « Envoyer sur Discord ». */
export async function sendGazette(
  t: TFunction,
  lang: string | undefined,
  issues: GazetteIssue[],
  index: number,
  figures: SeasonReview | null = null,
  webhook = getWebhook(),
  photo: CanvasImageSource | null = null,
) {
  const issue = issues[index]!;
  // Tout le journal sur une seule image (page complète), avec un court encart : pas de long texte dans le salon.
  const png = await canvasPng(
    await drawPage(t, issue, { form: recentForm(issues, index), lang, face: await loadFace(issue.headline.params.bestId), figures, faceFor: loadFace, photo }),
  );
  return sendDiscordImage(discordPagePayload(t, issue, lang), png, webhook);
}

/** Envoie le numéro spécial « Bilan de la saison » (une en image + encart). */
export async function sendSeason(t: TFunction, r: SeasonReview, lang?: string, webhook = getWebhook()) {
  const png = await canvasPng(await drawSeason(t, r, { face: await loadFace(r.topScorer?.id), lang }));
  return sendDiscordImage(seasonPayload(t, r, lang), png, webhook);
}

/** Photo du coach choisie dans la barre latérale (data URL), en image prête à dessiner ; null sans photo. */
export async function loadCoachPhoto(saveId: string): Promise<HTMLImageElement | null> {
  try {
    const src = (await fmData.settings(saveId)).coachPhoto;
    if (!src) return null;
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/** Raison du départ corrigée par le joueur (licenciement ou départ), sinon celle devinée. Gardée sur ce PC. */
const exitKey = (saveId: string, x: CoachExit) => `fmi.gazette.exit.${saveId}|${x.club}|${x.end}`;
export const exitReason = (saveId: string, x: CoachExit): ExitReason => {
  const v = read(exitKey(saveId, x));
  return v === 'sacked' || v === 'left' ? v : x.reason;
};
export const setExitReason = (saveId: string, x: CoachExit, r: ExitReason) => write(exitKey(saveId, x), r);

/** Hors-série « Flash spécial » du départ du coach (page en image + encart). */
export async function sendFarewell(t: TFunction, saveId: string, x: CoachExit, lang?: string, webhook = getWebhook()) {
  const reason = exitReason(saveId, x);
  const png = await canvasPng(await drawFarewell(t, x, { reason, lang, photo: await loadCoachPhoto(saveId) }));
  return sendDiscordImage(farewellPayload(t, x, reason, lang), png, webhook);
}

/** Hors-série déjà envoyés (aussi à la main), pour que l'envoi automatique ne les renvoie pas. */
const FAREWELL_SENT_KEY = 'fmi.discord.farewellSent';
const farewellId = (saveId: string, x: CoachExit) => `${saveId}|${x.club}|${x.end}`;
export const isFarewellSent = (saveId: string, x: CoachExit) => (read(FAREWELL_SENT_KEY) ?? '').split('\n').includes(farewellId(saveId, x));
export const markFarewellSent = (saveId: string, x: CoachExit) =>
  write(FAREWELL_SENT_KEY, [...(read(FAREWELL_SENT_KEY) ?? '').split('\n').filter(Boolean), farewellId(saveId, x)].slice(-20).join('\n'));

/** Le hors-série part une fois, peu après le départ (pas celui d'un club quitté il y a des mois). */
export function farewellToSend(exits: CoachExit[], lastDate: string | undefined, sent: (x: CoachExit) => boolean): CoachExit | null {
  const x = exits[0];
  if (!x || sent(x)) return null;
  const ref = lastDate && lastDate > x.end ? lastDate : x.end;
  const days = (Date.parse(ref.slice(0, 10)) - Date.parse(x.end.slice(0, 10))) / 86_400_000;
  return days <= 45 ? x : null;
}

/** Dernier bilan de saison envoyé : partie et date de fin de saison. */
const SEASON_SENT_KEY = 'fmi.discord.seasonSent';
export const seasonSentKey = (saveId: string, r: SeasonReview) => `${saveId}|${r.end}`;
export const isSeasonSent = (saveId: string, r: SeasonReview) => read(SEASON_SENT_KEY) === seasonSentKey(saveId, r);
export const markSeasonSent = (saveId: string, r: SeasonReview) => write(SEASON_SENT_KEY, seasonSentKey(saveId, r));

/** Le bilan part une fois, peu après la fin de saison (pas celui d'une saison finie depuis des mois). */
export function seasonToSend(reviews: SeasonReview[], lastDate: string | undefined, sent: (r: SeasonReview) => boolean): SeasonReview | null {
  const r = reviews[0];
  if (!r || !lastDate || sent(r)) return null;
  const days = (Date.parse(lastDate.slice(0, 10)) - Date.parse(r.end.slice(0, 10))) / 86_400_000;
  return days <= 60 ? r : null;
}

/** Visage d'une dépêche : celui du joueur, ou la photo du coach quand elle parle de son avenir. */
export const breakingFace = (saveId: string | null, n: BreakingNews) =>
  isCoachBreaking(n) ? (saveId ? loadCoachPhoto(saveId) : Promise.resolve(null)) : loadFace(n.id);

/**
 * Photo de situation d'une dépêche (faite sur le PC par le moteur d'images), selon le réglage du joueur : celle déjà
 * dans la bibliothèque, ou faite maintenant quand `generate` (envoi automatique en mode « auto », ou son clic). Null
 * sans moteur, sans visage, ou en cas d'échec : la dépêche garde alors le portrait.
 */
export async function breakingPhoto(saveId: string | null, n: BreakingNews, generate: boolean) {
  if (!saveId || getPhotoMode() === 'off') return null;
  const coachPhoto = (await fmData.settings(saveId).catch(() => null))?.coachPhoto ?? null;
  const choice = sceneForBreaking(n, !!coachPhoto);
  return photoForEvent(breakingTag(saveId, n), choice, { playerId: isCoachBreaking(n) ? null : n.id, coachPhoto }, generate);
}

/** Photo de situation de la une d'une gazette (même règle que `breakingPhoto`) ; null : la une garde sa mise en page. */
export async function gazettePhoto(saveId: string | null, issue: GazetteIssue, generate: boolean) {
  if (!saveId || getPhotoMode() === 'off') return null;
  const coachPhoto = (await fmData.settings(saveId).catch(() => null))?.coachPhoto ?? null;
  const choice = sceneForHeadline(issue.headline, issue.weekStart, !!coachPhoto);
  return photoForEvent(gazetteTag(saveId, issue), choice, { playerId: choice?.playerId, coachPhoto }, generate);
}

/** Dépêche (recrue, départ, blessure, avenir du coach) : image et court encart, avec le visage du joueur ou du coach, ou la photo de situation. */
export async function sendBreaking(
  t: TFunction,
  n: BreakingNews,
  lang?: string,
  saveId: string | null = null,
  webhook = getWebhook(),
  photo: CanvasImageSource | null = null,
) {
  const png = await canvasPng(await drawBreaking(t, n, { lang, face: await breakingFace(saveId, n), photo }));
  return sendDiscordImage(breakingPayload(t, n, lang), png, webhook);
}

/** Affiche du choc : image et court encart, avec la photo de notre meilleur buteur. */
export async function sendBigMatch(t: TFunction, m: BigMatch, lang?: string, webhook = getWebhook()) {
  const png = await canvasPng(await drawBigMatch(t, m, { lang, face: await loadFace(m.ourScorer?.id) }));
  return sendDiscordImage(bigMatchPayload(t, m, lang), png, webhook);
}

/** Édition record : image et court encart, avec le visage de l'auteur du triplé. */
export async function sendRecord(t: TFunction, n: RecordNews, lang?: string, webhook = getWebhook()) {
  const png = await canvasPng(await drawRecord(t, n, { lang, face: n.kind === 'hatTrick' ? await loadFace(n.id) : null }));
  return sendDiscordImage(recordPayload(t, n, lang), png, webhook);
}

/** Exploits déjà envoyés (aussi à la main), pour que l'envoi automatique ne les renvoie pas. */
const RECORD_SENT_KEY = 'fmi.discord.recordSent';
const recordId = (saveId: string, n: RecordNews) => `${saveId}|${recordKey(n)}`;
export const isRecordSent = (saveId: string, n: RecordNews) => (read(RECORD_SENT_KEY) ?? '').split('\n').includes(recordId(saveId, n));
export const markRecordSent = (saveId: string, n: RecordNews) =>
  write(RECORD_SENT_KEY, [...(read(RECORD_SENT_KEY) ?? '').split('\n').filter(Boolean), recordId(saveId, n)].slice(-60).join('\n'));

/**
 * Affiches déjà envoyées : partie, adversaire, compétition et date du match. La date tirée du « Dans 3 jours » du jeu
 * peut bouger d'un jour d'un relevé à l'autre : une affiche du même match à trois jours près compte comme envoyée.
 */
const BIGMATCH_SENT_KEY = 'fmi.discord.bigMatchSent';
const bigMatchId = (saveId: string, m: BigMatch) => `${saveId}|${m.opponent}|${m.competition ?? ''}`;
export const isBigMatchSent = (saveId: string, m: BigMatch) =>
  (read(BIGMATCH_SENT_KEY) ?? '').split('\n').some((line) => {
    const at = line.lastIndexOf('|');
    return line.slice(0, at) === bigMatchId(saveId, m) && Math.abs(Date.parse(line.slice(at + 1)) - Date.parse(m.date)) <= 3 * 86_400_000;
  });
export const markBigMatchSent = (saveId: string, m: BigMatch) =>
  write(BIGMATCH_SENT_KEY, [...(read(BIGMATCH_SENT_KEY) ?? '').split('\n').filter(Boolean), `${bigMatchId(saveId, m)}|${m.date}`].slice(-30).join('\n'));

/** Dépêches déjà envoyées (aussi à la main), pour que l'envoi automatique ne les renvoie pas. */
const BREAKING_SENT_KEY = 'fmi.discord.breakingSent';
const breakingId = (saveId: string, n: BreakingNews) => `${saveId}|${n.kind}|${n.id}|${n.date.slice(0, 10)}`;
export const isBreakingSent = (saveId: string, n: BreakingNews) => (read(BREAKING_SENT_KEY) ?? '').split('\n').includes(breakingId(saveId, n));
export const markBreakingSent = (saveId: string, n: BreakingNews) =>
  write(BREAKING_SENT_KEY, [...(read(BREAKING_SENT_KEY) ?? '').split('\n').filter(Boolean), breakingId(saveId, n)].slice(-60).join('\n'));

/** Envoi automatique des dépêches : par défaut comme celui de la gazette, sinon le choix du joueur (gardé sur ce PC). */
const BREAKING_AUTO_KEY = 'fmi.discord.breakingAuto';
export const getBreakingAuto = () => {
  const v = read(BREAKING_AUTO_KEY);
  return v == null ? getGazetteAuto() : v === '1';
};
export const setBreakingAuto = (on: boolean) => write(BREAKING_AUTO_KEY, on ? '1' : '0');

/**
 * Dépêches (et exploits) à envoyer : ceux pas encore partis, vues dans les trois derniers jours de jeu (pas celles d'il y a des
 * mois à l'activation), trois au plus, de la plus ancienne à la plus récente.
 */
export function breakingToSend<N extends { date: string }>(news: N[], lastDate: string | undefined, sent: (n: N) => boolean): N[] {
  if (!lastDate) return [];
  const last = Date.parse(lastDate.slice(0, 10));
  return news
    .filter((n) => !sent(n) && (last - Date.parse(n.date.slice(0, 10))) / 86_400_000 <= 3)
    .slice(0, 3)
    .reverse();
}

/** Envoi automatique de la gazette chaque semaine de jeu, activé par le joueur (gardé sur ce PC). */
const AUTO_KEY = 'fmi.discord.gazetteAuto';
/** Dernière gazette envoyée automatiquement : partie et lundi de la semaine. */
const SENT_KEY = 'fmi.discord.gazetteSent';
/** Carrière suivie par toute l'appli (choisie dans la barre latérale). */
const GAZETTE_SAVE_KEY = CAREER_KEY;

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* stockage indisponible */
  }
};

/** Note une gazette comme envoyée (aussi à la main), pour que l'envoi automatique ne la renvoie pas. */
export function markGazetteSent(saveId: string, weekStart: string) {
  const [sentSave, sentWeek] = (read(SENT_KEY) ?? '').split('|');
  if (sentSave !== saveId || !sentWeek || weekStart > sentWeek) write(SENT_KEY, `${saveId}|${weekStart}`);
}

export const getGazetteAuto = () => read(AUTO_KEY) === '1';
export const setGazetteAuto = (on: boolean) => write(AUTO_KEY, on ? '1' : null);

/**
 * Gazette à envoyer : la dernière semaine terminée (la semaine en cours, la plus récente, s'écrit encore).
 * Une seule à la fois, jamais d'anciens numéros : à l'activation, seule la dernière semaine terminée part.
 */
export function gazetteToSend(issues: GazetteIssue[], saveId: string, sent: string | null): number | null {
  const done = issues[1];
  if (!done) return null;
  const [sentSave, sentWeek] = (sent ?? '').split('|');
  if (sentSave === saveId && sentWeek && sentWeek >= done.weekStart) return null;
  return 1;
}

/** Dernière gazette partie toute seule et dernier envoi automatique raté, montrés au joueur (gardés sur ce PC). */
const AUTO_SENT_KEY = 'fmi.discord.autoLastSent';
const AUTO_ERROR_KEY = 'fmi.discord.autoLastError';
export interface AutoSent {
  number: number;
  weekStart: string;
  at: string;
}
export interface AutoError {
  what: string;
  error: string;
  at: string;
  /** L'envoi a échoué trois fois de suite : il est abandonné pour ne pas bloquer les suivants. */
  dropped: boolean;
}
const readJson = <T>(k: string): T | null => {
  try {
    return JSON.parse(read(k) ?? 'null') as T | null;
  } catch {
    return null;
  }
};
export const autoLastSent = () => readJson<AutoSent>(AUTO_SENT_KEY);
export const autoLastError = () => readJson<AutoError>(AUTO_ERROR_KEY);

/** Essais ratés par envoi (en mémoire) : au troisième, on le note comme parti pour passer aux suivants. */
export const MAX_TRIES = 3;
const failures = new Map<string, number>();

/**
 * Fait un envoi automatique sans jamais bloquer les autres : une dépêche refusée par Discord n'empêche plus la gazette
 * de partir. Un envoi raté est retenté à la minute suivante, puis abandonné après `maxTries` échecs (la gazette, elle,
 * est retentée tant qu'elle n'est pas partie).
 * Renvoie vrai si l'envoi est parti.
 */
export async function attempt(what: string, key: string, send: () => Promise<unknown>, done: () => void, maxTries = MAX_TRIES): Promise<boolean> {
  try {
    await send();
    done();
    failures.delete(key);
    return true;
  } catch (e) {
    const n = (failures.get(key) ?? 0) + 1;
    const dropped = n >= maxTries;
    if (dropped) {
      failures.delete(key);
      done();
    } else failures.set(key, n);
    console.warn(`Envoi automatique (${what}) :`, e);
    write(AUTO_ERROR_KEY, JSON.stringify({ what, error: String(e).slice(0, 300), at: new Date().toISOString(), dropped } satisfies AutoError));
    return false;
  }
}

/**
 * Dernière vérification de l'envoi automatique et ce qu'elle a conclu, montrée dans Live Discord : le joueur (et
 * nous) voyons pourquoi rien n'est parti, au lieu de deviner.
 */
const AUTO_CHECK_KEY = 'fmi.discord.autoLastCheck';
export type AutoCheckState = 'noSave' | 'noHistory' | 'waiting' | 'alreadySent' | 'sending' | 'sent' | 'failed';
export interface AutoCheck {
  at: string;
  state: AutoCheckState;
  /** Club et date de jeu du dernier jour lu. */
  club?: string | null;
  gameDate?: string | null;
  /** Lundi de la dernière semaine terminée, et celui de la dernière gazette notée comme partie. */
  week?: string | null;
  sentWeek?: string | null;
}
export const autoLastCheck = () => readJson<AutoCheck>(AUTO_CHECK_KEY);
const noteCheck = (c: Omit<AutoCheck, 'at'>) => write(AUTO_CHECK_KEY, JSON.stringify({ at: new Date().toISOString(), ...c } satisfies AutoCheck));

/** Demande une vérification tout de suite (bouton « Vérifier maintenant » de Live Discord). */
export const AUTO_CHECK_EVENT = 'fmi:gazette-auto-check';
export const checkGazetteNow = () => window.dispatchEvent(new Event(AUTO_CHECK_EVENT));

/** Une tournée bloquée (une attente qui ne revient jamais) est abandonnée au bout de ce délai. */
const STUCK_MS = 10 * 60_000;

/**
 * Attente maximale de la photo de situation avant un envoi : au-delà (moteur figé, carte graphique prise par le jeu),
 * l'envoi part avec le portrait. Une photo prend d'habitude deux à quatre minutes.
 */
export const PHOTO_WAIT_MS = 5 * 60_000;

/** `p`, ou `fallback` s'il ne répond pas avant `ms` (le travail continue en arrière-plan, son résultat est ignoré). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      () => {
        clearTimeout(id);
        resolve(fallback);
      },
    );
  });
}

/** Petite pause entre deux envois : Discord refuse les rafales sur un même webhook. */
const pause = () => new Promise((r) => window.setTimeout(r, 1500));

/**
 * Monté une fois pour toute l'appli : chaque minute, si le joueur l'a activé et relié un salon, relit l'instantané
 * du plugin (comme FM Coach) puis envoie la gazette dès qu'une semaine de jeu est terminée, le bilan de la saison
 * dès que le dernier match de championnat est joué, et le hors-série quand le coach quitte son club.
 */
/** Événements dont la photo a déjà été tentée pendant cette session (réussie ou non) : pas de nouvel essai chaque minute. */
const photoTried = new Set<string>();

export function useGazetteAuto() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  /** Début de la tournée en cours (0 = aucune). */
  const busy = useRef(0);
  /** Une photo a été faite en arrière-plan : le moteur sera arrêté quand il n'en restera plus à faire. */
  const photoMade = useRef(false);
  /** Début de la photo faite toute seule en cours (0 = aucune) : elle tourne à part des envois. */
  const photoBusy = useRef(0);
  useEffect(() => {
    const tick = async () => {
      const sending = isWebhook(getWebhook());
      const gazetteOn = sending && getGazetteAuto();
      const breakingOn = sending && getBreakingAuto();
      // Sans envoi automatique, la tournée ne sert qu'aux photos de situation faites toutes seules.
      if (!gazetteOn && !breakingOn && getPhotoMode() !== 'auto') return;
      // Une tournée bloquée depuis plus de 10 minutes ne doit pas arrêter l'envoi automatique pour de bon.
      if (busy.current && Date.now() - busy.current < STUCK_MS) return;
      if (busy.current)
        write(AUTO_ERROR_KEY, JSON.stringify({ what: 'check', error: 'stuck', at: new Date().toISOString(), dropped: false } satisfies AutoError));
      const started = Date.now();
      busy.current = started;
      try {
        const fmSaves = (await savesData.list()).filter((s) => s.gameId === 'fm');
        const saveId = fmSaves.find((s) => s.id === read(GAZETTE_SAVE_KEY))?.id ?? fmSaves[0]?.id;
        if (!saveId) {
          noteCheck({ state: 'noSave' });
          return;
        }
        // L'instantané du jour et les jours rattrapés sont importés par la lecture du plugin (`useFmSync`, active dans
        // toute l'appli) : ici, on lit seulement l'historique, dans le cache tenu à jour par celle-ci.
        const history = await fetchHistory(qc, saveId);
        rememberClubLooks(history.map((h) => h.data));
        const lastDate = history
          .map((h) => h.gameDate)
          .sort()
          .at(-1);
        const lang = i18n.resolvedLanguage;
        // Chaque envoi est isolé (`attempt`) : un envoi refusé ne bloque plus les autres, la gazette d'abord.
        if (gazetteOn) {
          const issues = issuesWithPress(gazetteIssues(history), await fmData.pressConferences(saveId).catch(() => []));
          const sentWeek = (read(SENT_KEY) ?? '').split('|')[0] === saveId ? ((read(SENT_KEY) ?? '').split('|')[1] ?? null) : null;
          const seen = { club: history.at(-1)?.data.club ?? null, gameDate: lastDate ?? null, week: issues[1]?.weekStart ?? null, sentWeek };
          const index = gazetteToSend(issues, saveId, read(SENT_KEY));
          if (!history.length) noteCheck({ state: 'noHistory' });
          else if (index == null) noteCheck({ ...seen, state: issues[1] ? 'alreadySent' : 'waiting' });
          if (index != null) {
            const week = issues[index]!;
            noteCheck({ ...seen, state: 'sending' });
            const ok = await attempt(
              'gazette',
              `gazette|${saveId}|${week.weekStart}`,
              async () => {
                // Rédigée par l'IA du joueur quand elle est branchée (sinon, ou si elle échoue, avec les phrases toutes faites).
                issues[index] = await withWriting(t, week, lang, saveId);
                // En mode « auto », la photo de situation de la une est faite avant l'envoi (deux à quatre minutes).
                // Jamais plus de cinq minutes : une photo qui traîne ne doit pas empêcher la gazette de partir.
                const photo = await withTimeout(gazettePhoto(saveId, issues[index]!, await autoPhotosNow()), PHOTO_WAIT_MS, null);
                await sendGazette(t, lang, issues, index, seasonSoFar(history, week.date), getWebhook(), photo);
              },
              () => {
                markGazetteSent(saveId, week.weekStart);
                write(AUTO_SENT_KEY, JSON.stringify({ number: week.number, weekStart: week.weekStart, at: new Date().toISOString() } satisfies AutoSent));
              },
              Infinity,
            );
            noteCheck({ ...seen, state: ok ? 'sent' : 'failed' });
            await pause();
          }
          // Fin du championnat : numéro spécial, après la gazette de la semaine.
          const season = seasonToSend(seasonReviews(history), lastDate, (r) => isSeasonSent(saveId, r));
          if (season) {
            await attempt(
              'season',
              `season|${seasonSentKey(saveId, season)}`,
              () => sendSeason(t, season, lang),
              () => markSeasonSent(saveId, season),
            );
            await pause();
          }
          // Le coach a quitté son club (autre club, ou sans club d'après le plugin) : hors-série « Flash spécial ».
          // Sans club : seulement une fois le départ confirmé (le jeu a avancé d'au moins un jour sans club).
          const freeSince = freeConfirmed(await fmData.settings(saveId));
          const exit = farewellToSend(coachExits(history, { freeSince }), lastDate, (x) => isFarewellSent(saveId, x));
          if (exit) {
            await attempt(
              'farewell',
              `farewell|${farewellId(saveId, exit)}`,
              () => sendFarewell(t, saveId, exit, lang),
              () => markFarewellSent(saveId, exit),
            );
            await pause();
          }
        }
        // Dépêches, exploits et affiche du choc : elles n'attendent pas la gazette de la semaine.
        if (breakingOn) {
          for (const n of breakingToSend(breakingNews(history), lastDate, (x) => isBreakingSent(saveId, x))) {
            // En mode « auto », la photo de situation est faite avant l'envoi (deux à quatre minutes sur la carte graphique).
            await attempt(
              'breaking',
              `breaking|${breakingId(saveId, n)}`,
              async () =>
                sendBreaking(t, n, lang, saveId, getWebhook(), await withTimeout(breakingPhoto(saveId, n, await autoPhotosNow()), PHOTO_WAIT_MS, null)),
              () => markBreakingSent(saveId, n),
            );
            await pause();
          }
          // Exploits du jour (triplé, série, large victoire, fin de disette), avec les mêmes règles que les dépêches.
          for (const n of breakingToSend(recordNews(history), lastDate, (x) => isRecordSent(saveId, x))) {
            await attempt(
              'record',
              `record|${recordId(saveId, n)}`,
              () => sendRecord(t, n, lang),
              () => markRecordSent(saveId, n),
            );
            await pause();
          }
          // Affiche du choc, quelques jours avant un match qui compte (une fois par match).
          const big = bigMatchNow(history);
          if (big && !isBigMatchSent(saveId, big)) {
            await attempt(
              'bigMatch',
              `bigMatch|${bigMatchId(saveId, big)}|${big.date}`,
              () => sendBigMatch(t, big, lang),
              () => markBigMatchSent(saveId, big),
            );
          }
        }
      } catch (e) {
        // Erreur hors des envois (lecture de l'historique…) : montrée elle aussi dans Live Discord.
        console.warn('Gazette automatique :', e);
        write(
          AUTO_ERROR_KEY,
          JSON.stringify({ what: 'check', error: String(e).slice(0, 300), at: new Date().toISOString(), dropped: false } satisfies AutoError),
        );
      } finally {
        // Une tournée abandonnée pour blocage ne libère pas la place de celle qui l'a remplacée.
        if (busy.current === started) busy.current = 0;
      }
      // Les photos faites toutes seules tournent à part : elles ne retardent plus jamais un envoi.
      void photoTick();
    };
    /**
     * Photos de situation faites toutes seules, sans attendre un envoi : la une de la dernière gazette terminée et les
     * dépêches des derniers jours. Une seule à la fois (deux à quatre minutes), chaque événement essayé une fois par
     * session ; rien tant que la carte graphique est prise par un autre logiciel.
     */
    const photoTick = async () => {
      if (getPhotoMode() !== 'auto') return;
      // Une photo figée depuis plus de dix minutes ne doit pas arrêter les suivantes pour de bon.
      if (photoBusy.current && Date.now() - photoBusy.current < STUCK_MS) return;
      const started = Date.now();
      photoBusy.current = started;
      try {
        const fmSaves = (await savesData.list()).filter((s) => s.gameId === 'fm');
        const saveId = fmSaves.find((s) => s.id === read(GAZETTE_SAVE_KEY))?.id ?? fmSaves[0]?.id;
        if (!saveId) return;
        const history = await fetchHistory(qc, saveId);
        const lastDate = history
          .map((h) => h.gameDate)
          .sort()
          .at(-1);
        const issues = issuesWithPress(gazetteIssues(history), await fmData.pressConferences(saveId).catch(() => []));
        const todo: { tag: string; make: () => Promise<unknown>; key: readonly unknown[] }[] = [];
        const une = issues[1];
        if (une) todo.push({ tag: gazetteTag(saveId, une), make: () => gazettePhoto(saveId, une, true), key: ['gazette', 'une-photo', saveId] });
        for (const n of breakingToSend(breakingNews(history), lastDate, () => false))
          todo.push({ tag: breakingTag(saveId, n), make: () => breakingPhoto(saveId, n, true), key: ['gazette', 'breaking-photo', saveId] });
        let next: (typeof todo)[number] | null = null;
        for (const x of todo) {
          if (photoTried.has(x.tag)) continue;
          if (await existingPhoto(x.tag)) photoTried.add(x.tag);
          else {
            next = x;
            break;
          }
        }
        if (next && (await autoPhotosNow())) {
          photoTried.add(next.tag);
          await next.make();
          photoMade.current = true;
          await qc.invalidateQueries({ queryKey: next.key });
        } else if (!next && photoMade.current && !busy.current) {
          // Plus rien à faire (et aucun envoi en cours) : le moteur d'images rend la carte graphique au jeu.
          photoMade.current = false;
          await invoke('photos_engine_stop').catch(() => undefined);
        }
      } catch (e) {
        console.warn('Photo de situation automatique :', e);
      } finally {
        if (photoBusy.current === started) photoBusy.current = 0;
      }
    };
    const id = window.setInterval(tick, 60_000);
    const now = () => void tick();
    window.addEventListener(AUTO_CHECK_EVENT, now);
    void tick();
    return () => {
      window.clearInterval(id);
      window.removeEventListener(AUTO_CHECK_EVENT, now);
    };
  }, [t, i18n, qc]);
}
