import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist');
const swPath = path.join(distDir, 'sw.js');
const assetsDir = path.join(distDir, 'assets');

const urls = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

if (fs.existsSync(assetsDir)) {
  for (const file of fs.readdirSync(assetsDir)) {
    if (!file.endsWith('.map')) {
      urls.push(`/assets/${file}`);
    }
  }
}

const rawSw = fs.readFileSync(swPath, 'utf8');
const updatedSw = `self.__PRECACHE_ASSETS = ${JSON.stringify(urls, null, 2)};\n` + rawSw;
fs.writeFileSync(swPath, updatedSw, 'utf8');
console.log('[inject-sw] Precache manifest written to dist/sw.js:', urls);
