import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { createQueryClient } from './queryClient';
import './styles.css';

const client = createQueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
