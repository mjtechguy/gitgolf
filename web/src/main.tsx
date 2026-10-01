import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ApiError } from './api';
import './styles.css';

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  queryCache: new QueryCache({
    onError(error) {
      if (error instanceof ApiError && error.status === 401) {
        client.setQueryData(['session'], null);
        client.removeQueries({ queryKey: ['repositories'] });
      }
    },
  }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={client}><App /></QueryClientProvider></StrictMode>,
);
