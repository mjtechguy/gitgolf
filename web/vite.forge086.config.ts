import {mergeConfig} from 'vite';
import {realpathSync} from 'node:fs';
import base from './vite.config.ts';
export default mergeConfig(base,{server:{fs:{allow:[process.cwd(),realpathSync('node_modules')]}}});
