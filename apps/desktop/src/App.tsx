import { useEffect } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { QuickSearch } from './components/QuickSearch';
import { TopBar } from './components/TopBar';
import { UpdateGate } from './components/UpdateGate';
import { WhatsNew } from './components/WhatsNew';
import { useCareer, useCareerStore } from './lib/career';
import { useFmSync } from './lib/fm-sync';
import { useGameRequests } from './lib/game-request';
import { useAutoBackups } from './lib/save-backup';
import { useGazetteAuto } from './lib/gazette-auto';
import { useLiveDiscord } from './lib/live-discord';
import { usePressInGame } from './lib/press-ingame';
import { Career } from './pages/Career';
import { Challenges } from './pages/Challenges';
import { Faces } from './pages/Faces';
import { Photos } from './pages/Photos';
import { FmSave, SettingsWithoutCareer } from './pages/FmSave';
import { Home } from './pages/Home';
import { Overview } from './pages/Overview';
import { Saves } from './pages/Saves';
import { Soon } from './pages/Soon';
import { Story } from './pages/Story';
import { WhatsNewPage } from './pages/WhatsNewPage';

export function App() {
  useLiveDiscord();
  useGazetteAuto();
  useFmSync();
  usePressInGame();
  useGameRequests();
  useAutoBackups();
  return (
    <UpdateGate>
      <div className="min-h-screen">
        <TopBar />
        <QuickSearch />
        <WhatsNew />
        <main className="min-w-0">
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/club/:view" element={<CareerOnly><FmSave /></CareerOnly>} />
            <Route path="/reglages" element={<Settings />} />
            <Route path="/parties" element={<Home />} />
            <Route path="/visages" element={<Faces />} />
            <Route path="/photos" element={<Photos />} />
            <Route path="/sauvegardes" element={<Saves />} />
            <Route path="/carriere" element={<Career />} />
            <Route path="/gazette" element={<Story tab="gazette" />} />
            <Route path="/presse" element={<Story tab="presse" />} />
            <Route path="/discord" element={<Story tab="discord" />} />
            <Route path="/defis" element={<Challenges />} />
            <Route path="/monde" element={<Soon mode="world" />} />
            <Route path="/nouveautes" element={<WhatsNewPage />} />
            {/* Anciennes adresses (avant la barre latérale unique). */}
            <Route path="/coach" element={<Navigate to="/" replace />} />
            <Route path="/fm/:saveId" element={<OpenCareer />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </UpdateGate>
  );
}

/** Accueil : « Aujourd'hui » de la carrière suivie, ou la présentation de l'appli tant qu'il n'y a pas de carrière. */
function Today() {
  const { saveId, isLoading } = useCareer();
  if (isLoading) return null;
  return saveId ? <FmSave page="home" /> : <Overview />;
}

/** Écrans qui demandent une carrière : sans carrière, retour à l'accueil (qui propose d'en créer une). */
function CareerOnly({ children }: { children: React.ReactNode }) {
  const { saveId, isLoading } = useCareer();
  if (isLoading) return null;
  return saveId ? <>{children}</> : <Navigate to="/" replace />;
}

/** Plugin et réglages : avec une carrière, ses réglages ; sans, la marche à suivre pour en créer une. */
function Settings() {
  const { saveId, isLoading } = useCareer();
  if (isLoading) return null;
  return saveId ? <FmSave page="settings" /> : <SettingsWithoutCareer />;
}

/** Ancien lien vers une partie : elle devient la carrière suivie. */
function OpenCareer() {
  const { saveId = '' } = useParams();
  const setSaveId = useCareerStore((s) => s.setSaveId);
  useEffect(() => {
    if (saveId) setSaveId(saveId);
  }, [saveId, setSaveId]);
  return <Navigate to="/" replace />;
}
