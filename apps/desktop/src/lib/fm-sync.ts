import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef } from 'react';
import { baseTargetIds, type DbPlayer } from '@fm-immersion/module-fm';
import { useCareer, useCareerStore } from './career';
import { fmData } from './data';
import { rememberClubLooks } from './club-look';
import { importMissingHistory } from './fm-history';
import { FmOtherSaveError } from './fm';
import { noteImported } from './fm-cache';

/** Relecture des fichiers du plugin (instantané, état du manager). */
const LIVE_POLL_MS = 10_000;

/** Dossier du plugin de la carrière suivie : celui enregistré, sinon celui trouvé sur le PC. */
export function useFmFolder(saveId: string) {
  const { data: settings } = useQuery({ queryKey: ['fm', saveId, 'settings'], queryFn: () => fmData.settings(saveId), enabled: !!saveId });
  const { data: defaultFolder } = useQuery({ queryKey: ['fm', 'default-folder'], queryFn: () => invoke<string | null>('fm_default_folder') });
  return settings?.fmFolder ?? defaultFolder ?? '';
}

/**
 * Monté une fois pour toute l'appli : suit la carrière choisie presque en direct, quel que soit l'écran ouvert.
 * Le plugin réécrit son instantané à chaque nouveau jour de jeu (et toutes les 5 minutes) ; on relit le fichier
 * toutes les 10 secondes (lecture locale, rien dans le jeu) et on l'enregistre dès qu'il a changé.
 */
export function useFmSync() {
  const qc = useQueryClient();
  const { saveId } = useCareer();
  const folder = useFmFolder(saveId);
  const setSync = useCareerStore((s) => s.setSync);
  const lastText = useRef<string | null>(null);
  /** Repère (taille, date) de l'instantané déjà traité : tant qu'il ne change pas, le fichier n'est pas relu. */
  const lastStamp = useRef<string | null>(null);
  const abilitiesDate = useRef<string | null>(null);
  const abilitiesTry = useRef(0);
  const historyTry = useRef(0);
  useCoachPhotoFile(saveId, folder);

  useEffect(() => {
    if (!folder || !saveId) return;
    const key = ['fm', saveId] as const;
    lastText.current = null;
    lastStamp.current = null;
    let stop = false;
    const tick = async () => {
      // État du manager (club entraîné ou sans club), écrit par le plugin depuis la version qui le gère.
      try {
        const st = await invoke<string | null>('fm_read_status', { folder });
        if (!stop && st) {
          const status = await fmData.noteStatus(saveId, JSON.parse(st));
          const free = status.club ? null : status.gameDate;
          const prev = useCareerStore.getState().sync;
          // Réglages relus seulement quand l'état change (ils contiennent la photo du coach : pas toutes les 10 s).
          if (prev.free !== free || prev.now?.club !== (status.club ?? null)) qc.invalidateQueries({ queryKey: [...key, 'settings'] });
          setSync({ free, now: { gameDate: status.gameDate, club: status.club ?? null } });
        }
      } catch {
        /* fichier absent ou en cours d'écriture */
      }
      try {
        // Lu seulement s'il a changé (taille ou date du fichier) : plus de relecture de plusieurs centaines de Ko
        // toutes les 10 s quand le plugin n'a rien réécrit.
        const read = await invoke<{ stamp: string | null; text: string | null }>('fm_read_snapshot_since', { folder, since: lastStamp.current });
        const text = read.text;
        if (!stop && text != null && text === lastText.current) lastStamp.current = read.stamp;
        else if (!stop && text != null) {
          const snap = JSON.parse(text);
          rememberClubLooks([snap]);
          try {
            const imported = await fmData.importSnapshot(saveId, snap);
            // Retenu seulement une fois importé : un import raté est retenté au passage suivant.
            lastText.current = text;
            lastStamp.current = read.stamp;
            setSync({ other: null });
            noteImported(qc, saveId, imported);
            qc.invalidateQueries({ queryKey: ['saves'] });
          } catch (e) {
            // Autre sauvegarde chargée : signalée, et ce même fichier n'est plus relu tant que le plugin ne l'a pas réécrit.
            if (e instanceof FmOtherSaveError) lastStamp.current = read.stamp;
            throw e;
          }
        }
      } catch (e) {
        // Autre sauvegarde chargée : on le signale ; sinon fichier absent, en cours d'écriture ou import raté, nouvel
        // essai au prochain passage.
        if (e instanceof FmOtherSaveError && !stop) setSync({ other: e });
      }
      // Historique : les jours de jeu passés pendant que l'appli était fermée sont rattrapés depuis les fichiers
      // datés du plugin, une fois par minute, par lots.
      try {
        if (!stop && Date.now() - historyTry.current >= 60_000) {
          historyTry.current = Date.now();
          // Le dernier instantané (plusieurs centaines de Ko) n'est relu que si le club n'est pas déjà dans les réglages.
          const club = (await fmData.settings(saveId)).fmClub ?? (await fmData.latest(saveId))?.club ?? null;
          const n = await importMissingHistory(saveId, folder, club);
          if (n && !stop) {
            qc.invalidateQueries({ queryKey: key });
            qc.invalidateQueries({ queryKey: ['saves'] });
          }
        }
      } catch {
        /* dossier illisible : nouvel essai au prochain passage */
      }
      // CA/PA réels (option du joueur) : lus une fois par date de jeu dans la mémoire de FM27, en lecture seule,
      // au plus une tentative par minute.
      try {
        if (Date.now() - abilitiesTry.current < 60_000) return;
        if (stop || !(await fmData.settings(saveId)).fmReadAbilities) return;
        abilitiesTry.current = Date.now();
        const latest = await fmData.latest(saveId);
        if (!latest || latest.data.abilities || latest.gameDate === abilitiesDate.current) return;
        const r = await invoke<{ gameDate: string | null; players: { id: number; ca: number; pa: number }[] }>('fm_memory_abilities');
        // La mémoire peut être en avance sur l'instantané (écrit toutes les 5 minutes) : on attend la même date.
        if (stop || r.gameDate?.slice(0, 10) !== latest.gameDate.slice(0, 10) || !r.players.length) return;
        if (await fmData.attachAbilities(saveId, latest.gameDate, r.players)) {
          abilitiesDate.current = latest.gameDate;
          // Même lecture pour les joueurs suivis : prix, CA et contrat, pour les alertes du Repérage.
          try {
            const ids = baseTargetIds(await fmData.targets(saveId));
            if (ids.length) {
              const found = await invoke<DbPlayer[]>('fm_memory_search', { filter: { ids, limit: 300 } });
              if (!stop && (await fmData.refreshBaseTargets(saveId, found, latest.gameDate))) qc.invalidateQueries({ queryKey: ['fm', saveId, 'targets'] });
            }
          } catch {
            /* relu à la prochaine date de jeu */
          }
          const updated = await fmData.latest(saveId);
          if (updated && !stop) noteImported(qc, saveId, updated.data);
        }
      } catch {
        /* FM27 fermé ou version inconnue : nouvel essai dans une minute */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), LIVE_POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [folder, saveId]);
}

/** Octets d'une image en data URL (`data:image/png;base64,…`). */
function dataUrlBytes(url: string): number[] {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Photo du coach recopiée dans le dossier du plugin (`photo-coach.png`) : le plugin CoachPhoto l'affiche dans FM27
 * à la place du portrait 3D du manager. Réécrite quand elle change, retirée quand le joueur la retire.
 */
function useCoachPhotoFile(saveId: string, folder: string) {
  const { data: settings } = useQuery({ queryKey: ['fm', saveId, 'settings'], queryFn: () => fmData.settings(saveId), enabled: !!saveId });
  const photo = settings ? (settings.coachPhoto ?? '') : null;
  const written = useRef<string | null>(null);
  useEffect(() => {
    if (!folder || photo === null) return;
    const key = `${folder}|${photo}`;
    if (written.current === key) return;
    written.current = key;
    invoke('fm_write_coach_photo', { folder, png: photo ? dataUrlBytes(photo) : null }).catch(() => {
      written.current = null; // dossier absent : nouvel essai au prochain changement
    });
  }, [folder, photo]);
}
