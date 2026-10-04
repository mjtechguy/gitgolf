import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { OrganizationExecutionSettings } from '../../src/OrganizationExecutionSettings';
import '../../src/styles.css';
function Host() {
  const [signingOut, setSigningOut] = useState(false);
  return <><button onClick={() => setSigningOut(true)}>Sign out fixture</button><OrganizationExecutionSettings userId="42" organization="acme" signingOut={signingOut} /></>;
}
const router = createRouter({ routeTree: createRootRoute({ component: Host }) });
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>);
