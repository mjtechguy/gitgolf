import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { createQueryClient } from './queryClient';
import { installFocusPolicy } from './focusPolicy';
import './styles.css';
import { reloadOnceForBuild } from './staleBuild';

window.addEventListener('vite:preloadError', event => {
  const build = document.querySelector<HTMLScriptElement>('script[type=module][src]')?.src || '';
  if (reloadOnceForBuild(sessionStorage, build, () => location.reload())) event.preventDefault();
});

const client = createQueryClient();
installFocusPolicy();

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
