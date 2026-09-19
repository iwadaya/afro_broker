// Self-hosted Inter (variable) — the design system's --font-sans.
import '@fontsource-variable/inter/opsz.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { initTheme } from './utils/theme';

// Styles: Universe tokens + themes first (daylight = light, midnight = dark),
// then the base shell, then the broking module's scoped ab- stylesheet.
import './styles/tokens.css';
import './styles/themes.css';
import './styles/base.css';
import './broking/broking.css';

initTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
