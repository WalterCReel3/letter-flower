Self-hosted fonts for Letter Flower (index.html at the repo root).

Andika 400/700 and Baloo 2 600/800, latin subset, woff2. Both are under the SIL Open Font License 1.1;
each family's licence text is kept beside the files (OFL-Andika.txt, OFL-Baloo2.txt) and must ship with them.

STATUS: the woff2 files are NOT here yet. The build sandbox had no network; the download below was asked
of the operator (task pwa, command cmd-20261018T044637Z-40378668c5e1). Until they exist, index.html keeps
the Google Fonts link and sw.js caches what Google serves, so the installed app still has its fonts offline
after its first online launch.

To add them, from the repo root:

  curl -fSL --create-dirs -o fonts/andika-latin-400.woff2 https://cdn.jsdelivr.net/fontsource/fonts/andika@latest/latin-400-normal.woff2 -o fonts/andika-latin-700.woff2 https://cdn.jsdelivr.net/fontsource/fonts/andika@latest/latin-700-normal.woff2 -o fonts/baloo2-latin-600.woff2 https://cdn.jsdelivr.net/fontsource/fonts/baloo-2@latest/latin-600-normal.woff2 -o fonts/baloo2-latin-800.woff2 https://cdn.jsdelivr.net/fontsource/fonts/baloo-2@latest/latin-800-normal.woff2 -o fonts/OFL-Andika.txt https://raw.githubusercontent.com/google/fonts/main/ofl/andika/OFL.txt -o fonts/OFL-Baloo2.txt https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/OFL.txt

then:
  1. index.html: delete the two fonts.googleapis.com <link> lines and un-comment the @font-face <style>
     block right after them (the comment there says which).
  2. sw.js: delete precacheGoogleFonts, its call and the googleFont branch, and bump VERSION.
     (sw.js already precaches ./fonts/*.woff2 best-effort, so this step only removes dead weight.)
  3. Run: PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node tools/check.cjs --shots shots index.html
          PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node tools/serve-check.cjs
     serve-check's "fonts load from ./fonts" row turns PASS only after step 1.
