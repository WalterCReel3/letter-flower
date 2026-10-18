#!/usr/bin/env node
'use strict';
// Renders icons/*.svg to the PNGs the manifest names, with the repo's Playwright Chromium.
//   PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node icons/render.cjs
// Each PNG is a DPR-1 screenshot of a page holding only the SVG at the exact pixel size.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const JOBS = [
  { svg: 'icon.svg', out: 'icon-192.png', size: 192 },
  { svg: 'icon.svg', out: 'icon-512.png', size: 512 },
  { svg: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
];

(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] });
  for (const j of JOBS) {
    const page = await browser.newPage({ viewport: { width: j.size, height: j.size }, deviceScaleFactor: 1 });
    const svg = fs.readFileSync(path.join(DIR, j.svg), 'utf8')
      .replace(/width="512" height="512"/, `width="${j.size}" height="${j.size}"`);
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(DIR, j.out), omitBackground: true, clip: { x: 0, y: 0, width: j.size, height: j.size } });
    await page.close();
    console.log(`${j.out} ${j.size}x${j.size} from ${j.svg}`);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
