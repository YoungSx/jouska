import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App.tsx';
import { ThemeProvider } from '@/components/theme-provider.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 运维面板多在暗光下盯屏（index.html OWN-WORLD）：深色优先，系统偏好只作回退。 */}
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
