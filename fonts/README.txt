Self-hosted fonts for Letter Flower (index.html at the repo root).

Andika 400/700 and Baloo 2 600/800, latin subset, woff2 (from Fontsource via jsDelivr). Both are under the
SIL Open Font License 1.1; each family's licence text is kept beside the files (OFL-Andika.txt,
OFL-Baloo2.txt) and must ship with them.

STATUS: SWITCH DONE (task fonts-switch). index.html loads these files with @font-face (relative ./fonts/
URLs, font-display:swap) and no longer links Google Fonts. sw.js precaches all four files as required
assets (install fails rather than caching without them) and has no Google Fonts code; VERSION is v2.
variants/*.html still link Google Fonts; they are reference pages and are never cached.

Changing or adding a font file: replace it here under the same name, bump VERSION in sw.js (or phones keep
the old file), then run:
  PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node tools/check.cjs --shots shots index.html
  PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node tools/serve-check.cjs

How they were fetched (operator, cmd-20261018T044637Z-40378668c5e1):
  curl -fSL --create-dirs -o fonts/andika-latin-400.woff2 https://cdn.jsdelivr.net/fontsource/fonts/andika@latest/latin-400-normal.woff2 -o fonts/andika-latin-700.woff2 https://cdn.jsdelivr.net/fontsource/fonts/andika@latest/latin-700-normal.woff2 -o fonts/baloo2-latin-600.woff2 https://cdn.jsdelivr.net/fontsource/fonts/baloo-2@latest/latin-600-normal.woff2 -o fonts/baloo2-latin-800.woff2 https://cdn.jsdelivr.net/fontsource/fonts/baloo-2@latest/latin-800-normal.woff2 -o fonts/OFL-Andika.txt https://raw.githubusercontent.com/google/fonts/main/ofl/andika/OFL.txt -o fonts/OFL-Baloo2.txt https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/OFL.txt
