import { AiLink } from '../components/AiSettingsCard';
import {
  bigMatchNow,
  breakingNews,
  coachExits,
  recordKey,
  recordNews,
  gazetteIssues,
  seasonReviews,
  seasonSoFar,
  visibleOn,
  type BigMatch,
  type BreakingNews,
  type CoachExit,
  type ExitReason,
  type GazetteIssue,
  type RecordNews,
  type SeasonReview,
} from '@fm-immersion/module-fm';
import { Face } from '../components/Face';
import { SeasonCard } from '../components/SeasonCard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { aiFor, getAiSettings } from '../lib/ai';
import { useGazetteWriting, writeGazette } from '../lib/ai-gazette';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useCareer } from '../lib/career';
import { clubLook, rememberClubLooks } from '../lib/club-look';
import { useHistory } from '../lib/fm-cache';
import { getWebhook, isWebhook } from '../lib/discord';
import {
  breakingFace,
  breakingPhoto,
  gazettePhoto,
  exitReason,
  loadCoachPhoto,
  markBigMatchSent,
  markBreakingSent,
  markFarewellSent,
  markGazetteSent,
  markRecordSent,
  markSeasonSent,
  sendBigMatch,
  sendBreaking,
  sendRecord,
  sendFarewell,
  sendGazette,
  sendSeason,
  setExitReason,
} from '../lib/gazette-auto';
import { drawBigMatch } from '../lib/bigmatch-page';
import { drawBreaking } from '../lib/breaking-page';
import { drawFarewell } from '../lib/farewell-page';
import { drawRecord, recordText } from '../lib/records-page';
import { fmData } from '../lib/data';
import { articleText, editorialText, headlineText, paperName, storyText, weekLabel } from '../lib/gazette-text';
import { drawPage } from '../lib/gazette-page';
import { issuesWithPress, usePressHeld } from '../lib/press';
import { recentForm } from '../lib/gazette-une';
import { getPhotoMode, photosReady } from '../lib/photo-events';
import { loadFace } from '../lib/player-face';
import { drawSeason } from '../lib/season-une';
import { freeConfirmed } from '../lib/fm';

/** Mode Gazette : un journal par semaine de jeu, rédigé à partir des instantanés de la partie. */
export function Gazette() {
  const { t, i18n } = useTranslation();
  // Carrière suivie, choisie dans la barre latérale.
  const { saveId, fmSaves } = useCareer();

  const { data: history = [], isLoading } = useHistory(saveId);
  // Couleurs et logos des clubs vus dans l'historique (bandeau, filets, logos de la une).
  const looksReady = useMemo(() => {
    rememberClubLooks(history.map((h) => h.data));
    return history.length;
  }, [history]);
  // Paroles du coach en conférence de presse, citées dans la semaine du match.
  const { data: held } = usePressHeld(saveId);
  const issues = useMemo(() => issuesWithPress(gazetteIssues(history), held), [history, held]);
  const reviews = useMemo(() => seasonReviews(history), [history]);
  const season = reviews[0] ?? null;
  // Carte de fin de saison : saisons finies, et la saison en cours en aperçu tant qu'elle n'est pas finie.
  const cards = useMemo(() => {
    const now = history.length
      ? seasonSoFar(
          history,
          history.reduce((a, e) => (e.gameDate > a ? e.gameDate : a), ''),
        )
      : null;
    return now?.ongoing && now.played > 0 ? [now, ...reviews] : reviews;
  }, [history, reviews]);
  // Départs du coach (autre club, ou sans club d'après le plugin) : hors-série « Flash spécial ».
  const { data: settings } = useQuery({ queryKey: ['fm', saveId, 'settings'], queryFn: () => fmData.settings(saveId), enabled: !!saveId });
  const freeSince = settings ? freeConfirmed(settings) : null;
  const exits = useMemo(() => coachExits(history, { freeSince }), [history, freeSince]);
  // Hors-série en tête tant que le départ est récent (45 jours de jeu), sinon en bas avec les bilans de saison.
  const lastDate = history.reduce((a, e) => (e.gameDate > a ? e.gameDate : a), '');
  const exitFresh = !!exits[0] && (Date.parse(lastDate.slice(0, 10) || exits[0].end) - Date.parse(exits[0].end.slice(0, 10))) / 86_400_000 <= 45;
  // Dépêches des 30 derniers jours de jeu (recrue, départ, blessure longue).
  const breaking = useMemo(
    () => breakingNews(history).filter((n) => (Date.parse(lastDate.slice(0, 10)) - Date.parse(n.date.slice(0, 10))) / 86_400_000 <= 30),
    [history, lastDate],
  );
  // Exploits des 30 derniers jours de jeu (triplé, série de victoires, plus large victoire, fin de disette).
  const records = useMemo(
    () => recordNews(history).filter((n) => (Date.parse(lastDate.slice(0, 10)) - Date.parse(n.date.slice(0, 10))) / 86_400_000 <= 30),
    [history, lastDate],
  );
  // Affiche du choc : le prochain match, s'il compte (coupe, choc au sommet, duel direct) et tombe dans les 5 jours.
  const big = useMemo(() => bigMatchNow(history), [history]);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [saveId]);
  const raw = issues[index];
  // Texte de l'IA du joueur (si elle est branchée), demandé en arrière-plan : la gazette s'affiche d'abord sans lui.
  const writing = useGazetteWriting(saveId, raw);
  const issue = raw && writing.data ? { ...raw, written: writing.data } : raw;
  const shown = useMemo(() => (issue ? issues.map((x, i) => (i === index ? issue : x)) : issues), [issues, issue, index]);
  const figures = useMemo(() => (issue ? seasonSoFar(history, issue.date) : null), [history, issue]);
  // Photo de situation de la une (bibliothèque du moteur), ou null : la une garde sa mise en page.
  const unePhotoKey = ['gazette', 'une-photo', saveId, issue?.number, issue?.weekStart] as const;
  const { data: unePhoto = null } = useQuery({ queryKey: unePhotoKey, queryFn: () => gazettePhoto(saveId, issue!, false), enabled: !!issue });

  // Ce qui attend un clic (images à envoyer) passe en tête quand le salon est relié ;
  // sinon une seule ligne en tête, et les images sous la gazette.
  const linked = isWebhook(getWebhook());
  const shareable = (big ? 1 : 0) + records.length + breaking.length;
  const extras = (
    <>
      {big && <BigMatchSection saveId={saveId} match={big} looks={looksReady} />}
      {records.length > 0 && <RecordSection saveId={saveId} news={records} looks={looksReady} />}
      {breaking.length > 0 && <BreakingSection saveId={saveId} news={breaking} looks={looksReady} />}
    </>
  );

  return (
    <div className="w-full">
      {!issue && <p className="max-w-3xl text-brun">{t('modes.gazette.details')}</p>}

      {!fmSaves.length && (
        <div className="card mt-6 max-w-3xl">
          <p className="text-brun">{t('gazette.noSave')}</p>
          <Link to="/parties" className="btn-primary mt-4">
            {t('layout.career.create')}
          </Link>
        </div>
      )}
      {!!fmSaves.length && !isLoading && !issues.length && (
        <div className="card mt-6 max-w-3xl">
          <p className="font-display text-xl font-semibold">{t('layout.today.noGazette')}</p>
          <p className="mt-2 text-brun">{t('gazette.emptyHow')}</p>
          <p className="mt-2 text-sm text-brun">{t('gazette.empty')}</p>
        </div>
      )}

      {exitFresh && <FarewellSection saveId={saveId} exits={exits} looks={looksReady} />}
      {linked
        ? extras
        : shareable > 0 && (
            <section className="card mt-6 flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="text-sm">{t('gazette.shareReady', { count: shareable })}</p>
              <Link to="/discord" className="btn-secondary text-sm">
                {t('gazette.setupDiscord')}
              </Link>
            </section>
          )}

      {issue && (
        <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_16rem]">
          <div className="min-w-0 space-y-6">
            <Une issue={issue} />
            <UnePreview issues={shown} index={index} figures={figures} looks={looksReady} photo={unePhoto} />
            <Paper issue={issue} />
            {/* Les commandes viennent après la lecture : réécrire avec l'IA, envoyer sur Discord. */}
            <section className="card">
              <h2 className="text-xs font-bold uppercase tracking-wide text-brun">{t('gazette.actions')}</h2>
              <div className="mt-3 flex flex-wrap items-start gap-3">
                <UnePhotoButton saveId={saveId} issue={issue} photoKey={unePhotoKey} photo={unePhoto} />
                <SendButton saveId={saveId} issues={shown} index={index} figures={figures} photo={unePhoto} />
              </div>
              <div className="mt-3">
                <AiStatus saveId={saveId} issue={raw!} state={writing} />
              </div>
            </section>
          </div>
          <aside className="flex flex-col gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wide text-brun">{t('gazette.archives')}</h2>
            <ul className="flex max-h-[60vh] flex-col gap-1 overflow-auto">
              {issues.map((x, i) => (
                <li key={x.weekStart}>
                  <button type="button" className={`chip w-full justify-between ${i === index ? 'chip-on' : ''}`} onClick={() => setIndex(i)}>
                    <span>{t('gazette.issue', { number: x.number })}</span>
                    <span className="text-xs opacity-70">
                      {new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
                        new Date(`${x.weekStart.slice(0, 10)}T00:00:00Z`),
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}

      {!linked && extras}
      {cards.length > 0 && <SeasonCard saveId={saveId} seasons={cards} />}
      {season && <SeasonSection saveId={saveId} review={season} />}
      {exits.length > 0 && !exitFresh && (
        <div className="mt-6">
          <FarewellSection saveId={saveId} exits={exits} looks={looksReady} />
        </div>
      )}
    </div>
  );
}

/** La une en tête d'écran : le journal du club, le numéro et la semaine, puis le fait marquant en gros titre. */
function Une({ issue }: { issue: GazetteIssue }) {
  const { t, i18n } = useTranslation();
  const head = headlineText(t, issue, i18n.resolvedLanguage);
  const look = clubLook(issue.club);
  const accent = look ? visibleOn(look.colors, '#FFFFFF', '#FFB547') : null;
  return (
    <header className="border-b-4 border-orange pb-4" style={accent ? { borderBottomColor: accent } : undefined}>
      <p className="text-xs font-bold uppercase tracking-wide text-brun">
        {paperName(t, issue.club)} · {t('gazette.issue', { number: issue.number })} · {weekLabel(t, i18n.resolvedLanguage, issue.weekStart, issue.weekEnd)}
      </p>
      <h1 className="mt-2 font-display text-4xl font-semibold leading-tight">{head.title}</h1>
    </header>
  );
}

/** Version texte du numéro (le récit, le billet, les brèves), sous l'image de la une. */
export function Paper({ issue }: { issue: GazetteIssue }) {
  const { t, i18n } = useTranslation();
  const head = headlineText(t, issue, i18n.resolvedLanguage);
  const article = articleText(t, issue, i18n.resolvedLanguage) ?? head.body;
  const edito = editorialText(t, issue, i18n.resolvedLanguage);
  return (
    <article className="card rounded-xl p-0">
      <section className="border-b border-canard/10 px-6 py-5">
        <div className="flex items-start gap-4">
          {(issue.headline.params.bestId ?? issue.headline.params.id) != null && (
            <Face
              id={(issue.headline.params.bestId ?? issue.headline.params.id) as string | number}
              name={String(issue.headline.params.best ?? issue.headline.params.name ?? '')}
              size={64}
              className="mt-1 ring-2 ring-orange"
            />
          )}
          {article && <p className="text-brun">{article}</p>}
        </div>
      </section>
      {edito && (
        <section className="border-b border-canard/10 bg-orange-clair/40 px-6 py-4">
          <h3 className="font-display text-lg font-semibold">{edito.title}</h3>
          <p className="mt-1 text-sm italic text-canard">{edito.body}</p>
          <p className="mt-2 text-xs text-brun">
            📣 {edito.fans} · 🏛️ {edito.board}
          </p>
        </section>
      )}
      {/* Comme la maquette : les brèves du numéro en tableau, avec leur rubrique. */}
      {issue.stories.length > 0 && (
        <section className="px-6 py-5">
          <h3 className="text-xs font-bold uppercase tracking-widest text-canard">{t('gazette.inIssue.title')}</h3>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-brun">
              <tr>
                <th className="px-3 py-2 font-bold">{t('gazette.inIssue.article')}</th>
                <th className="px-3 py-2 font-bold">{t('gazette.inIssue.section')}</th>
              </tr>
            </thead>
            <tbody>
              {issue.stories.map((s, i) => {
                const x = storyText(t, issue.club, s);
                return (
                  <tr key={i} className="border-t border-canard/5 align-top odd:bg-creme/40">
                    <td className="px-3 py-2">
                      <span className="flex gap-3">
                        {(s.params.id ?? s.params.bestId) != null && (
                          <Face id={(s.params.id ?? s.params.bestId) as string | number} name={String(s.params.name ?? s.params.best ?? '')} size={32} className="mt-0.5 shrink-0" />
                        )}
                        <span>
                          <span className="block font-bold">{x.title}</span>
                          {x.body && <span className="mt-0.5 block text-brun">{x.body}</span>}
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-brun">{t(`gazette.une.section.${s.kind}`, { defaultValue: t('gazette.une.section.default') })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </article>
  );
}

/** Où en est la rédaction par l'IA : en cours, faite (avec « Réécrire »), ou en panne (les phrases toutes faites restent). */
function AiStatus({ saveId, issue, state }: { saveId: string; issue: GazetteIssue; state: ReturnType<typeof useGazetteWriting> }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const settings = getAiSettings();
  const ai = aiFor('gazette', settings);
  const rewrite = useMutation({
    mutationFn: () => writeGazette(t, issue, i18n.resolvedLanguage, saveId, { force: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gazette', 'ia', saveId, issue.weekStart] }),
  });
  if (!ai) return <AiLink />;
  const busy = state.isFetching || rewrite.isPending;
  const failed = state.isError || rewrite.isError || (state.isSuccess && !state.data && !busy);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className={`font-bold ${failed ? 'text-corail' : busy ? 'text-brun' : 'text-eau-fonce'}`}>
        {busy ? t('ai.gazette.writing', { model: ai.model }) : failed ? t('ai.gazette.failed') : t('ai.gazette.written', { model: ai.model })}
      </span>
      {!busy && (
        <button type="button" className="btn-secondary text-xs" onClick={() => rewrite.mutate()}>
          {t('ai.gazette.rewrite')}
        </button>
      )}
      {(state.error || rewrite.error) && <span className="text-xs text-brun">{String(state.error ?? rewrite.error)}</span>}
    </div>
  );
}

/** Une en image, telle qu'elle part sur Discord. */
function UnePreview({
  issues,
  index,
  figures,
  looks,
  photo,
}: {
  issues: GazetteIssue[];
  index: number;
  figures: SeasonReview | null;
  looks: number;
  photo: CanvasImageSource | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const issue = issues[index]!;
  const { data: url } = useQuery({
    queryKey: [
      'gazette',
      'une',
      issue.club,
      issue.weekStart,
      issue.date,
      lang,
      index,
      issues.length,
      figures?.end,
      figures?.played,
      looks,
      issue.written?.title,
      issue.written?.article,
      !!photo,
    ],
    queryFn: async () =>
      (
        await drawPage(t, issue, {
          form: recentForm(issues, index),
          lang,
          face: await loadFace(issue.headline.params.bestId),
          figures,
          faceFor: loadFace,
          photo,
        })
      ).toDataURL('image/png'),
  });
  if (!url) return <div className="aspect-[8/5] w-full animate-pulse rounded-xl bg-canard/5" />;
  return <img src={url} alt={t('gazette.preview')} className="w-full rounded-xl shadow-sm ring-1 ring-canard/10" />;
}

/** « Faire la photo de situation » de la une (mode « sur mon clic ») : faite par le moteur, puis l'aperçu se redessine. */
function UnePhotoButton({
  saveId,
  issue,
  photoKey,
  photo,
}: {
  saveId: string;
  issue: GazetteIssue;
  photoKey: readonly unknown[];
  photo: CanvasImageSource | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: engineReady = false } = useQuery({ queryKey: ['photos', 'ready'], queryFn: photosReady, staleTime: 60_000 });
  const make = useMutation({ mutationFn: () => gazettePhoto(saveId, issue, true), onSuccess: (img) => qc.setQueryData(photoKey, img) });
  if (getPhotoMode() === 'off' || !engineReady || photo) return null;
  return (
    <>
      <button type="button" className="btn-secondary text-sm" disabled={make.isPending} onClick={() => make.mutate()}>
        {t(make.isPending ? 'breaking.photoMaking' : 'breaking.photoMake')}
      </button>
      {make.isSuccess && !photo && <p className="text-xs text-brun">{t('gazette.photoNone')}</p>}
      {make.isError && <p className="text-xs font-bold text-corail">{String(make.error)}</p>}
    </>
  );
}

function SendButton({
  saveId,
  issues,
  index,
  figures,
  photo,
}: {
  saveId: string;
  issues: GazetteIssue[];
  index: number;
  figures: SeasonReview | null;
  photo: CanvasImageSource | null;
}) {
  const { t, i18n } = useTranslation();
  const webhook = getWebhook();
  const send = useMutation({
    mutationFn: async () => {
      await sendGazette(t, i18n.resolvedLanguage, issues, index, figures, undefined, photo);
      // La semaine en cours (n° le plus récent) n'est pas terminée : l'envoi automatique la publiera à la fin de la semaine.
      if (index > 0) markGazetteSent(saveId, issues[index]!.weekStart);
    },
  });
  if (!isWebhook(webhook)) {
    return (
      <Link to="/discord" className="btn-secondary text-sm">
        {t('gazette.setupDiscord')}
      </Link>
    );
  }
  return (
    <>
      <button type="button" className="btn-primary text-sm" disabled={send.isPending} onClick={() => send.mutate()}>
        {t('gazette.sendDiscord')}
      </button>
      {send.isSuccess && <p className="text-xs font-bold text-eau-fonce">{t('gazette.sent')}</p>}
      {send.isError && <p className="text-xs font-bold text-corail">{String(send.error)}</p>}
    </>
  );
}

/** Numéro spécial « Bilan de la saison », dès que le dernier match de championnat est joué. */
function SeasonSection({ saveId, review }: { saveId: string; review: SeasonReview }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const { data: url } = useQuery({
    queryKey: ['gazette', 'season', saveId, review.end, review.club, lang],
    queryFn: async () => (await drawSeason(t, review, { face: await loadFace(review.topScorer?.id), lang })).toDataURL('image/png'),
  });
  const send = useMutation({
    mutationFn: async () => {
      await sendSeason(t, review, lang);
      markSeasonSent(saveId, review);
    },
  });
  return (
    <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold">{t('season.title', { season: review.label })}</h2>
        {url ? (
          <img src={url} alt={t('season.title', { season: review.label })} className="mt-3 w-full rounded-xl shadow-sm ring-1 ring-canard/10" />
        ) : (
          <div className="mt-3 aspect-video w-full animate-pulse rounded-xl bg-canard/5" />
        )}
      </div>
      <aside className="flex flex-col gap-2 xl:pt-10">
        {isWebhook(getWebhook()) ? (
          <button type="button" className="btn-primary text-sm" disabled={send.isPending} onClick={() => send.mutate()}>
            {t('season.send')}
          </button>
        ) : (
          <Link to="/discord" className="btn-secondary text-sm">
            {t('gazette.setupDiscord')}
          </Link>
        )}
        {send.isSuccess && <p className="text-xs font-bold text-eau-fonce">{t('season.sent')}</p>}
        {send.isError && <p className="text-xs font-bold text-corail">{String(send.error)}</p>}
      </aside>
    </section>
  );
}

/** Hors-série « Flash spécial » : le coach a quitté son club. Raison corrigeable (licenciement ou départ), envoi Discord. */
function FarewellSection({ saveId, exits, looks }: { saveId: string; exits: CoachExit[]; looks: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const [at, setAt] = useState(0);
  const x = exits[Math.min(at, exits.length - 1)]!;
  const [reason, setReason] = useState<ExitReason>(() => exitReason(saveId, x));
  useEffect(() => setReason(exitReason(saveId, x)), [saveId, x]);
  const { data: url } = useQuery({
    queryKey: ['gazette', 'farewell', saveId, x.club, x.end, reason, lang, looks],
    queryFn: async () => (await drawFarewell(t, x, { reason, lang, photo: await loadCoachPhoto(saveId) })).toDataURL('image/png'),
  });
  const send = useMutation({
    mutationFn: async () => {
      await sendFarewell(t, saveId, x, lang);
      markFarewellSent(saveId, x);
    },
  });
  return (
    <section className="grid gap-6 xl:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wide text-corail">
          ⚡ {t('farewell.flash')} · {t('farewell.special')}
        </p>
        {url ? (
          <img src={url} alt={t('farewell.special')} className="mt-3 w-full rounded-xl shadow-sm ring-1 ring-canard/10" />
        ) : (
          <div className="mt-3 aspect-[8/5] w-full animate-pulse rounded-xl bg-canard/5" />
        )}
      </div>
      <aside className="flex flex-col gap-2 xl:pt-7">
        {exits.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {exits.map((e, i) => (
              <button key={`${e.club}|${e.end}`} type="button" className={`chip ${i === at ? 'chip-on' : ''}`} onClick={() => setAt(i)}>
                {e.club}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs font-bold uppercase tracking-wide text-brun">{t('farewell.reasonLabel')}</p>
        <div className="flex flex-wrap gap-1">
          {(['sacked', 'left'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={`chip ${reason === r ? 'chip-on' : ''}`}
              onClick={() => {
                setExitReason(saveId, x, r);
                setReason(r);
              }}
            >
              {t(`farewell.kicker.${r}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-brun">{t('farewell.reasonHint')}</p>
        {isWebhook(getWebhook()) ? (
          <button type="button" className="btn-primary mt-2 text-sm" disabled={send.isPending} onClick={() => send.mutate()}>
            {t('farewell.send')}
          </button>
        ) : (
          <Link to="/discord" className="btn-secondary mt-2 text-sm">
            {t('gazette.setupDiscord')}
          </Link>
        )}
        {send.isSuccess && <p className="text-xs font-bold text-eau-fonce">{t('farewell.sent')}</p>}
        {send.isError && <p className="text-xs font-bold text-corail">{String(send.error)}</p>}
      </aside>
    </section>
  );
}

/** Dépêches récentes : une image par nouvelle (recrue, départ, blessure longue), à envoyer sur Discord. */
function BreakingSection({ saveId, news, looks }: { saveId: string; news: BreakingNews[]; looks: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [saveId]);
  const n = news[Math.min(at, news.length - 1)]!;
  const qc = useQueryClient();
  // Photo de situation déjà faite pour cette dépêche (bibliothèque du moteur), ou null : l'image garde le portrait.
  const photoKey = ['gazette', 'breaking-photo', saveId, n.kind, n.id, n.date] as const;
  const { data: photo = null } = useQuery({ queryKey: photoKey, queryFn: () => breakingPhoto(saveId, n, false) });
  const { data: engineReady = false } = useQuery({ queryKey: ['photos', 'ready'], queryFn: photosReady, staleTime: 60_000 });
  const photoMode = getPhotoMode();
  const { data: url } = useQuery({
    queryKey: ['gazette', 'breaking', saveId, n.kind, n.id, n.date, lang, looks, !!photo],
    queryFn: async () => (await drawBreaking(t, n, { lang, face: await breakingFace(saveId, n), photo })).toDataURL('image/png'),
  });
  const makePhoto = useMutation({
    mutationFn: () => breakingPhoto(saveId, n, true),
    onSuccess: (img) => qc.setQueryData(photoKey, img),
  });
  const send = useMutation({
    mutationFn: async () => {
      await sendBreaking(t, n, lang, saveId, undefined, photo);
      markBreakingSent(saveId, n);
    },
  });
  useEffect(() => send.reset(), [n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <h2 className="text-xs font-bold uppercase tracking-wide text-brun">{t('breaking.recent')}</h2>
        {url ? (
          <img src={url} alt={t(`breaking.tag.${n.kind}`)} className="mt-3 w-full rounded-xl shadow-sm ring-1 ring-canard/10" />
        ) : (
          <div className="mt-3 aspect-[16/9] w-full animate-pulse rounded-xl bg-canard/5" />
        )}
      </div>
      <aside className="flex flex-col gap-2 xl:pt-7">
        <p className="text-xs text-brun">{t('breaking.recentHelp')}</p>
        <ul className="flex max-h-72 flex-col gap-1 overflow-auto">
          {news.map((x, i) => (
            <li key={`${x.kind}|${x.id}|${x.date}`}>
              <button type="button" className={`chip w-full justify-between ${i === at ? 'chip-on' : ''}`} onClick={() => setAt(i)}>
                <span className="truncate">
                  {t(`breaking.tag.${x.kind}`)} · {x.other ?? (x.name || t('breaking.coach'))}
                </span>
                <span className="text-xs opacity-70">{x.date.slice(5, 10)}</span>
              </button>
            </li>
          ))}
        </ul>
        {photoMode !== 'off' && engineReady && !photo && (
          <button type="button" className="btn-secondary mt-2 text-sm" disabled={makePhoto.isPending || send.isPending} onClick={() => makePhoto.mutate()}>
            {t(makePhoto.isPending ? 'breaking.photoMaking' : 'breaking.photoMake')}
          </button>
        )}
        {makePhoto.isSuccess && !photo && <p className="text-xs text-brun">{t('breaking.photoNone')}</p>}
        {makePhoto.isError && <p className="text-xs font-bold text-corail">{String(makePhoto.error)}</p>}
        {isWebhook(getWebhook()) && (
          <button type="button" className="btn-primary mt-2 text-sm" disabled={send.isPending || makePhoto.isPending} onClick={() => send.mutate()}>
            {t('breaking.send')}
          </button>
        )}
        {send.isSuccess && <p className="text-xs font-bold text-eau-fonce">{t('breaking.sent')}</p>}
        {send.isError && <p className="text-xs font-bold text-corail">{String(send.error)}</p>}
      </aside>
    </section>
  );
}

/** Affiche du choc : le prochain grand match en image, à envoyer sur Discord. */
function BigMatchSection({ saveId, match, looks }: { saveId: string; match: BigMatch; looks: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const { data: url } = useQuery({
    queryKey: ['gazette', 'bigmatch', saveId, match.opponent, match.date, match.kind, lang, looks],
    queryFn: async () => (await drawBigMatch(t, match, { lang, face: await loadFace(match.ourScorer?.id) })).toDataURL('image/png'),
  });
  const send = useMutation({
    mutationFn: async () => {
      await sendBigMatch(t, match, lang);
      markBigMatchSent(saveId, match);
    },
  });
  return (
    <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <h2 className="text-xs font-bold uppercase tracking-wide text-orange-fonce">🔥 {t('bigmatch.section')}</h2>
        {url ? (
          <img src={url} alt={t(`bigmatch.tag.${match.kind}`)} className="mt-3 w-full rounded-xl shadow-sm ring-1 ring-canard/10" />
        ) : (
          <div className="mt-3 aspect-[16/9] w-full animate-pulse rounded-xl bg-canard/5" />
        )}
      </div>
      <aside className="flex flex-col gap-2 xl:pt-7">
        <p className="text-xs text-brun">{t('bigmatch.sectionHelp')}</p>
        {isWebhook(getWebhook()) && (
          <button type="button" className="btn-primary mt-2 text-sm" disabled={send.isPending} onClick={() => send.mutate()}>
            {t('bigmatch.send')}
          </button>
        )}
        {send.isSuccess && <p className="text-xs font-bold text-eau-fonce">{t('bigmatch.sent')}</p>}
        {send.isError && <p className="text-xs font-bold text-corail">{String(send.error)}</p>}
      </aside>
    </section>
  );
}

/** Édition record : les exploits récents en image (triplé, série, large victoire, fin de disette), à envoyer sur Discord. */
function RecordSection({ saveId, news, looks }: { saveId: string; news: RecordNews[]; looks: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [saveId]);
  const n = news[Math.min(at, news.length - 1)]!;
  const { data: url } = useQuery({
    queryKey: ['gazette', 'record', saveId, recordKey(n), lang, looks],
    queryFn: async () => (await drawRecord(t, n, { lang, face: n.kind === 'hatTrick' ? await loadFace(n.id) : null })).toDataURL('image/png'),
  });
  const send = useMutation({
    mutationFn: async () => {
      await sendRecord(t, n, lang);
      markRecordSent(saveId, n);
    },
  });
  useEffect(() => send.reset(), [n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <h2 className="text-xs font-bold uppercase tracking-wide text-orange-fonce">🏆 {t('records.section')}</h2>
        {url ? (
          <img src={url} alt={recordText(t, n, lang).title} className="mt-3 w-full rounded-xl shadow-sm ring-1 ring-canard/10" />
        ) : (
          <div className="mt-3 aspect-[16/9] w-full animate-pulse rounded-xl bg-canard/5" />
        )}
      </div>
      <aside className="flex flex-col gap-2 xl:pt-7">
        <p className="text-xs text-brun">{t('records.sectionHelp')}</p>
        {news.length > 1 && (
          <ul className="flex max-h-72 flex-col gap-1 overflow-auto">
            {news.map((x, i) => (
              <li key={recordKey(x)}>
                <button type="button" className={`chip w-full justify-between ${i === at ? 'chip-on' : ''}`} onClick={() => setAt(i)}>
                  <span className="truncate">
                    {t(`records.tag.${x.kind}`)}
                    {x.kind === 'hatTrick' ? ` · ${x.name}` : ''}
                  </span>
                  <span className="text-xs opacity-70">{x.date.slice(5, 10)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {isWebhook(getWebhook()) && (
          <button type="button" className="btn-primary mt-2 text-sm" disabled={send.isPending} onClick={() => send.mutate()}>
            {t('records.send')}
          </button>
        )}
        {send.isSuccess && <p className="text-xs font-bold text-eau-fonce">{t('records.sent')}</p>}
        {send.isError && <p className="text-xs font-bold text-corail">{String(send.error)}</p>}
      </aside>
    </section>
  );
}
