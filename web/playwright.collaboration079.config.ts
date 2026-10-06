import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',use:{baseURL:'http://127.0.0.1:4189',viewport:{width:1440,height:1000}},webServer:{command:'npm run dev -- --port 4189 --strictPort',url:'http://127.0.0.1:4189',reuseExistingServer:false}});
