import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router-dom';
import logoMaillot from '../assets/logo-maillot.svg';
import { shownGameDate, useCareer, useCareerStore } from '../lib/career';
import { pageOf } from '../lib/club-nav';
import { fmData } from '../lib/data';
import { useUi } from '../lib/ui-store';
import { Crest } from './Crest';
import { CareerCard } from './Sidebar';

/*
 * Menu du haut (maquettes du joueur, 14/11/2026), à la place de la barre latérale :
 * rangée 1 = les cinq espaces (Bureau, Club, Compétitions, Médias, Carrière) et, à droite, la recherche, le jeu et le coach ;
 * rangée 2 = le club suivi et la date de jeu, les écrans de l'espace ouvert, et les actions de lecture de la partie
 * (posées là par l'écran de la carrière, voir `TOPBAR_ACTIONS`).
 */

/** Emplacement, dans la rangée 2, des actions de la carrière (état du jeu, dernière lecture, « Actualiser »). */
export const TOPBAR_ACTIONS = 'fmi-topbar-actions';

type Section = 'office' | 'club' | 'competitions' | 'media' | 'career' | 'game';
interface Sub {
  to: string;
  label: string;
}

/** Espace ouvert d'après l'adresse. */
function sectionOf(pathname: string): Section {
  if (pathname.startsWith('/club/')) return pageOf(pathname.slice('/club/'.length)) === 'results' ? 'competitions' : 'club';
  if (/^\/(gazette|presse|discord|photos)/.test(pathname)) return 'media';
  if (/^\/(carriere|defis|monde)/.test(pathname)) return 'career';
  if (/^\/(visages|sauvegardes|reglages|parties|nouveautes)/.test(pathname)) return 'game';
  return 'office';
}

export function TopBar() {
  const { t, i18n } = useTranslation();
  const { pathname } = useLocation();
  const { saveId } = useCareer();
  const todo = useCareerStore((s) => s.todo);
  const now = useCareerStore((s) => s.sync.now);
  const setSearch = useUi((s) => s.setSearchOpen);
  const { data: snapshot } = useQuery({ queryKey: ['fm', saveId, 'latest'], queryFn: () => fmData.latest(saveId), enabled: !!saveId });
  const { data: settings } = useQuery({ queryKey: ['fm', saveId, 'settings'], queryFn: () => fmData.settings(saveId), enabled: !!saveId });
  const section = sectionOf(pathname);
  const todoViews = saveId && todo.at.startsWith(`${saveId}|`) ? todo.views : [];
  const clubCount = todoViews.filter((v) => pageOf(v) !== 'home' && pageOf(v) !== 'results').length;

  const SECTIONS: { id: Section; to: string; label: string; badge?: number }[] = [
    { id: 'office', to: '/', label: t('topbar.office'), badge: todoViews.length },
    { id: 'club', to: '/club/tactic', label: t('topbar.club'), badge: clubCount },
    { id: 'competitions', to: '/club/results', label: t('topbar.competitions') },
    { id: 'media', to: '/gazette', label: t('topbar.media') },
    { id: 'career', to: '/carriere', label: t('topbar.career') },
  ];
  const SUBS: Partial<Record<Section, Sub[]>> = {
    club: [
      { to: '/club/tactic', label: t('layout.navShort.tactic') },
      { to: '/club/squad', label: t('layout.navShort.squad') },
      { to: '/club/mercato', label: t('layout.navShort.mercato') },
    ],
    media: [
      { to: '/gazette', label: t('layout.navShort.gazette') },
      { to: '/presse', label: t('layout.navShort.press') },
      { to: '/discord', label: t('layout.navShort.discord') },
      { to: '/photos', label: t('layout.nav.photos') },
    ],
    career: [
      { to: '/carriere', label: t('careerPage.title') },
      { to: '/defis', label: t('modes.challenges.title') },
      { to: '/monde', label: t('modes.world.title') },
    ],
    game: [
      { to: '/visages', label: t('layout.nav.faces') },
      { to: '/sauvegardes', label: t('layout.nav.saves') },
      { to: '/reglages', label: t('layout.nav.settings') },
      { to: '/nouveautes', label: t('whatsNew.pageTitle') },
    ],
  };
  const subs = SUBS[section] ?? [];
  // Sous-écran actif : l'adresse commence par son lien (les parties d'un écran du club restent sur leur écran).
  const subActive = (to: string) => {
    if (to.startsWith('/club/')) return pathname.startsWith('/club/') && pageOf(pathname.slice(6)) === pageOf(to.slice(6));
    return pathname === to || pathname.startsWith(`${to}/`);
  };
  const gameDate = shownGameDate(snapshot, now);
  const dateFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <header className="sticky top-0 z-50 text-white">
      {/* Rangée 1 : logo, espaces, outils */}
      <div className="flex h-14 items-center gap-2 border-b border-white/10 bg-[#08111E] px-4 xl:px-8">
        <Link to="/" className="mr-3 flex shrink-0 items-center gap-2" aria-label="FM Immersion">
          <img src={logoMaillot} alt="" className="h-8 w-8" />
          <span className="font-cond text-2xl font-bold italic tracking-wide">
            FM <span className="text-orange">IMMERSION</span>
          </span>
        </Link>
        <span className="mr-2 h-6 w-px bg-white/20" aria-hidden />
        <nav className="flex min-w-0 flex-1 items-stretch gap-1 self-stretch overflow-x-auto" aria-label={t('nav.modes')}>
          {SECTIONS.map((s) => (
            <Link
              key={s.id}
              to={s.to}
              className={`relative flex items-center gap-1.5 whitespace-nowrap px-4 font-cond text-xl font-semibold transition ${section === s.id ? 'text-white' : 'text-white/70 hover:text-white'}`}
              aria-current={section === s.id ? 'page' : undefined}
            >
              {s.label}
              {!!s.badge && <span className="rounded-full bg-orange px-1.5 font-sans text-[0.7rem] font-extrabold leading-4 text-canard">{s.badge}</span>}
              {section === s.id && <span className="absolute inset-x-3 bottom-0 h-[3px] rounded-t bg-orange" aria-hidden />}
            </Link>
          ))}
        </nav>
        <button type="button" onClick={() => setSearch(true)} className="hidden items-center gap-2 rounded-md bg-white/[0.07] px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 hover:text-white md:flex">
          {t('search.button')} <kbd className="rounded bg-white/10 px-1.5 font-sans text-xs">Ctrl K</kbd>
        </button>
        <Link
          to="/reglages"
          className={`flex h-9 w-9 items-center justify-center rounded-md ${section === 'game' ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
          title={t('layout.groups.game')}
          aria-label={t('layout.groups.game')}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
          </svg>
        </Link>
        <CoachMenu photo={settings?.coachPhoto ?? null} />
      </div>

      {/* Rangée 2 : club et date, écrans de l'espace, actions de lecture */}
      <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 bg-[#0D1828] px-4 py-1 xl:px-8">
        {snapshot ? (
          <span className="flex items-center gap-2">
            <Crest club={snapshot.club} size={24} />
            <span className="font-cond text-lg font-semibold">{snapshot.club}</span>
          </span>
        ) : (
          <span className="text-sm text-white/60">{t('layout.career.noData')}</span>
        )}
        {gameDate && (
          <>
            <span className="h-5 w-px bg-white/20" aria-hidden />
            <span className="font-cond text-lg text-white/85 first-letter:uppercase">{dateFmt.format(new Date(gameDate))}</span>
          </>
        )}
        {subs.length > 0 && (
          <nav className="ml-4 flex items-center gap-1" aria-label={t('topbar.screens')}>
            {subs.map((s) => (
              <NavLink
                key={s.to}
                to={s.to}
                className={() => `rounded px-3 py-1 text-sm font-bold ${subActive(s.to) ? 'bg-orange text-canard' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}
              >
                {s.label}
              </NavLink>
            ))}
          </nav>
        )}
        <div id={TOPBAR_ACTIONS} className="ml-auto flex items-center gap-3" />
      </div>
    </header>
  );
}

/** Le coach en haut à droite : sa photo ; au clic, la carte de la carrière (photo, club, choix de la partie), la langue et la version. */
function CoachMenu({ photo }: { photo: string | null }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const otherLang = i18n.resolvedLanguage === 'fr' ? 'en' : 'fr';
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} title={t('topbar.coach')} className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-white/10 ring-2 ring-orange/70">
        {photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : <span className="text-xs font-extrabold">{t('topbar.coachShort')}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl bg-canard p-2 pb-3 shadow-2xl ring-1 ring-white/15">
          <CareerCard />
          <div className="mt-2 flex items-center justify-between px-3 text-xs font-bold text-white/60">
            <button type="button" className="hover:text-white" onClick={() => i18n.changeLanguage(otherLang)}>
              {t('nav.language')}
            </button>
            <Link to="/nouveautes" className="hover:text-white" onClick={() => setOpen(false)}>
              {t('nav.version', { version: __APP_VERSION__ })}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
