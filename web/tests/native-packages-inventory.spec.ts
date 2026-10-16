import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { writeHarness } from './harness-file';

// The Cloudflare-managed package inventory as the Worker reports it: named tags only, truncated only when more exist.
const host = resolve(import.meta.dirname, '../.tmp/native-packages-inventory.html');
test.beforeAll(async () => { await writeHarness(host, `<!doctype html><html><body><main id="root" class="app-main"></main><script type="module">
import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{createRootRoute,createRouter,RouterProvider}from'@tanstack/react-router';import{NativePackages}from'/src/NativePackages.tsx';import'/src/styles.css';
const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});cache.setQueryData(['session'],{id:'1'});
function Host(){return React.createElement(NativePackages,{userId:'1',repositoryId:'1',repository:{owner:'alice',name:'project'}});}
const route=createRootRoute({component:Host}),router=createRouter({routeTree:route});createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:cache},React.createElement(RouterProvider,{router})));
</script></body></html>`); });

const artifact = (n: number) => ({ tag: `v${n}`, digest: 'sha256:' + n.toString(16).padStart(64, '0'), mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 512, platforms: [], publishedAt: '', scanStatus: 'not_configured' });
async function packages(page: Page, count: number, truncated: boolean) {
  await page.route('**/native/repository-packages', route => route.fulfill({ json: { repositoryId: '1', enabled: true, canManage: true, canPush: true, provider: 'cloudflare', registry: 'https://registry.cloudflare.com',
    name: 'alice/project', imageRepository: 'a'.repeat(32) + '/golf-demo-r1', artifacts: Array.from({ length: count }, (_, i) => artifact(i + 1)), truncated } }));
  await page.goto('/.tmp/native-packages-inventory.html');
  await expect(page.getByRole('table', { name: 'artifacts' })).toBeVisible();
}

test('a full inventory of named tags is not called truncated', async ({ page }) => {
  await packages(page, 20, false);
  await expect(page.locator('.package-count')).toHaveText('20');
  await expect(page.getByText('more entries follow')).toHaveCount(0);
});

test('a truncated inventory says how many named tags it shows and that the list continues', async ({ page }) => {
  await packages(page, 3, true);
  await expect(page.locator('.package-count')).toHaveText('3+');
  await expect(page.getByText('Showing 3 named tags from the start of the registry’s tag list; more entries follow it. Search and sorting cover only these.')).toBeVisible();
});
