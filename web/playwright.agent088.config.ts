import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({...base,use:{...base.use,baseURL:'http://127.0.0.1:4188'},webServer:{command:'npm run preview -- --port 4188 --strictPort',url:'http://127.0.0.1:4188',reuseExistingServer:false}});
