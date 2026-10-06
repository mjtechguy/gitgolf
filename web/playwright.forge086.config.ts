import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'forge086.spec.ts',workers:1,use:{baseURL:'http://127.0.0.1:4191',viewport:{width:1440,height:1000}},webServer:{command:'npm run dev -- --config vite.forge086.config.ts --port 4191 --strictPort',url:'http://127.0.0.1:4191',reuseExistingServer:false}});
