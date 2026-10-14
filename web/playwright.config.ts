import { defineConfig } from '@playwright/test';

// The suite exercises the standard arrangement, where every control is on the page and row commits load on request.
// layout-presets.spec.ts clears this and selects each layout itself; GOLF_LAYOUT=appearance/layout runs the suite in another.
const [appearance, layout] = (process.env.GOLF_LAYOUT || '/refined').split('/');
const origin = 'http://127.0.0.1:4179';
const saved = [...(appearance ? [{ name: 'golf.appearance', value: appearance }] : []), { name: `golf.layout.${appearance || 'golf'}`, value: layout! }, { name: 'golf.source.latestChanges', value: 'hide' }];

export default defineConfig({
  testDir: './tests',
  use: { baseURL: origin, viewport: { width: 1440, height: 1000 }, storageState: { cookies: [], origins: [{ origin, localStorage: saved }] } },
  webServer: { command: 'npm run dev -- --port 4179 --strictPort', url: origin, reuseExistingServer: false },
});
