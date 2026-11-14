import '@fontsource-variable/fraunces';
import '@fontsource-variable/nunito';
import '@fontsource-variable/fraunces/wght-italic.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './index.css';
import './theme-nuit.generated.css';
import './theme-nuit.css';
import './i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// Thème sombre bleu nuit pour toute l'appli (maquettes du joueur, 14/11/2026).
document.documentElement.classList.add('theme-nuit');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
