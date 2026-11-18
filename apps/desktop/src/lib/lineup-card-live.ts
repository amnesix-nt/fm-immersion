import { lineupCard, matchToday, type LineupCard } from '@fm-immersion/module-fm';
import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useCareer } from './career';
import { useHistory } from './fm-cache';
import { useFmFolder } from './fm-sync';

/**
 * Compo d'avant-match, montrée à deux endroits :
 * - dans FM27 : le jour du match, l'appli dépose la carte dessinée (`fmimmersion-compo.png`) et sa fiche
 *   (`fmimmersion-compo.json`, format fmi-compo/1) dans le dossier du plugin ; le plugin l'affiche par-dessus le jeu
 *   quand le match commence, une fois par match. Rien n'est envoyé au jeu.
 * - sur Discord : au début du direct, juste avant le tableau de score (réglage du joueur, coché par défaut).
 */

const DISCORD_KEY = 'fmi.discord.lineup';

/** Compo d'avant-match envoyée au début du direct (cochée par défaut, gardée sur ce PC). */
export function getLineupDiscord(): boolean {
  try {
    return localStorage.getItem(DISCORD_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setLineupDiscord(on: boolean) {
  try {
    if (on) localStorage.removeItem(DISCORD_KEY);
    else localStorage.setItem(DISCORD_KEY, '0');
  } catch {
    /* sans stockage : réglage par défaut */
  }
}

/** La carte en PNG : photos des titulaires (pack de visages ou portraits photoréalistes) et photo du coach. */
export async function lineupPng(t: TFunction, card: LineupCard, opts: { lang?: string; saveId?: string } = {}): Promise<Uint8Array> {
  const { drawLineupCard } = await import('./lineup-image');
  const { canvasPng } = await import('./gazette-une');
  const { loadFace } = await import('./player-face');
  const { loadCoachPhoto } = await import('./gazette-auto');
  const faces = new Map<string, CanvasImageSource | null>();
  await Promise.all(card.players.map(async (p) => p.id && faces.set(p.id, await loadFace(p.id).catch(() => null))));
  const coach = opts.saveId ? await loadCoachPhoto(opts.saveId) : null;
  return canvasPng(await drawLineupCard(t, card, { faces, coach }, { lang: opts.lang }));
}

/** Message Discord de la compo : titre et image (jointe sous le nom `une.png`, comme la une de la gazette). */
export function lineupPayload(t: TFunction, card: LineupCard) {
  return {
    username: 'FM Immersion',
    embeds: [
      {
        title: t('live.lineupCard.discordTitle', { club: card.club, opponent: card.opponent }),
        color: 0xffb547,
        image: { url: 'attachment://une.png' },
        footer: { text: [card.competition, 'FM Immersion'].filter(Boolean).join('  ·  ') },
      },
    ],
    attachments: [{ id: 0, filename: 'une.png' }],
  };
}

/** Fiche lue par le plugin : quel match, combien de temps rester affichée, texte du bouton. */
export function inGameLineup(t: TFunction, card: LineupCard) {
  return { format: 'fmi-compo/1', key: card.key, image: 'fmimmersion-compo.png', seconds: 20, close: t('live.lineupCard.close') };
}

/** Monté une fois pour toute l'appli : dépose (ou retire) la carte du jour pour le plugin. */
export function useLineupInGame() {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const { saveId } = useCareer();
  const folder = useFmFolder(saveId);
  const { data: history } = useHistory(saveId);
  const card = useMemo(() => {
    if (!history) return undefined;
    const last = history.at(-1)?.data;
    return last && matchToday(last) ? lineupCard(history.slice(-5).map((h) => h.data)) : null;
  }, [history]);
  // Même carte (mêmes joueurs, même rapport) : rien n'est redessiné ni réécrit.
  const sig = card === undefined ? undefined : card ? JSON.stringify([card, lang]) : null;
  const written = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    written.current = undefined;
  }, [folder, saveId]);
  useEffect(() => {
    if (!folder || sig === undefined || sig === written.current) return;
    let stop = false;
    void (async () => {
      try {
        if (!card) {
          await invoke('fm_write_lineup', { folder, json: null, png: null });
        } else {
          const png = await lineupPng(t, card, { lang, saveId });
          if (stop) return;
          await invoke('fm_write_lineup', { folder, json: JSON.stringify(inGameLineup(t, card)), png: Array.from(png) });
        }
        if (!stop) written.current = sig;
      } catch (e) {
        console.warn('Compo pour FM27 :', e);
      }
    })();
    return () => {
      stop = true;
    };
  }, [folder, sig, card, t, lang, saveId]);
}
