import '@fontsource-variable/inter/wght.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/tokens.css';
import './mobile.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
