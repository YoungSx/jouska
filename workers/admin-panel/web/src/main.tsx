import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App.tsx';
import { RootErrorBoundary } from '@/components/error-boundary.tsx';
import { ThemeProvider } from '@/components/theme-provider.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 兜底在 ThemeProvider 外面：这样连主题上下文自己崩了也还有一页话可说，
        而不是把面板变成一片纯黑。 */}
    <RootErrorBoundary>
      {/* 运维面板多在暗光下盯屏（index.html OWN-WORLD）：深色优先，系统偏好只作回退。 */}
      <ThemeProvider defaultTheme="dark">
        <App />
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
