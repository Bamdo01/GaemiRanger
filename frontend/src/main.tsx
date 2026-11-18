import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ServerProvider } from './api';
import './styles.css';

// GitHub Pages 는 새로고침하면 하위 주소를 못 찾으므로 HashRouter (#/market) 를 쓴다.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <ServerProvider>
        <App />
      </ServerProvider>
    </HashRouter>
  </StrictMode>,
);
