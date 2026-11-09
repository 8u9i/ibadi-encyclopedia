# الموسوعة الإباضية — Ibadi Encyclopedia (Electron)

A cross-platform (Windows / macOS / Linux) rebuild of the Ibadi Encyclopedia desktop library with
an RTL-first Arabic interface, fast full-text search, and low memory use.

## What the original app was (from the analysis)

| Part | Original | This rebuild |
|---|---|---|
| Installer | VB6 `setup.exe` + encrypted 7-Zip payload | electron-builder (NSIS per-user / DMG / AppImage / deb) |
| App | Python 3.13 + PySide6/QtWebEngine (PyInstaller, Cython modules), ~530 MB | Electron 44, plain ES modules, **no runtime npm dependencies** |
| Search | Lucene 10 + bundled Java runtime + AlKhalil morphology | SQLite FTS5 (built into Electron's Node), Arabic normalization, root search |
| Data | `master.db` + 2,931 per-book DBs + Lucene stored fields (page text) | One portable `ibadi.db` + `covers.db` (same files on every OS) |

## Features

- **Library**: 2,931 books in 46 categories, cover grid or list, instant filtering by title/author (diacritic-insensitive), sorting, favorites, "continue reading".
- **Reader**: single-page or continuous scrolling, nested table of contents that follows your position, breadcrumbs, printed volume/page numbers, go-to-page (printed or sequential), clickable footnotes (both directions), styled Qur'an quotations ﴿ ﴾, bookmarks with notes, reading position remembered, open tabs restored on restart, copy with citation, scanned PDF page link (online, when available).
- **Search**: whole library or a scope (categories and/or chosen books); all words / any word / exact phrase / **root** (e.g. «كتب» → كتاب، مكتوب، الكاتب…); flexible matching of proclitics (و، ف، ب، ك، ل، ال); prefix `*`; footnotes on or off; headings-only search; book order or relevance; per-book result counts; search history.
- **Qur'an**: all 114 suras in Uthmani script, verse search, and per-verse links into the three tafsir books.
- **Authors**: 1,371 authors sorted by death year, biographies, works and other contributions.
- **Quick open** (`Ctrl+K`), keyboard-first navigation (`F1` lists all shortcuts), light / sepia / dark / automatic themes, reading font, size, line spacing, column width, Arabic-Indic digits.

## Performance (measured on this machine)

- Memory: **≈ 183 MB** total for the packaged app with a book open and a search done (down from ≈ 336 MB before tuning; GPU compositing is off by default and can be turned on in Settings).
- Search across 790,021 pages: typically 1–80 ms; the worst case (the most common word, 500k matching pages) is ≈ 0.4 s. All queries run in a worker thread, so the UI never freezes.
- Installers: Windows x64 107 MB, ARM64 102 MB.

## Getting started (development)

Requires Node.js 22+.

```bash
npm install
```

```bash
npm start
```

The app looks for the library folder (the one containing `ibadi.db`) in this order: the folder chosen in the app, the `IBADI_LIBRARY` environment variable, `resources/library`, a `library` folder next to the executable (next to the `.app` on macOS), `<userData>/library`, `Documents/Ibadi/library`, and in development `../library`. If none is found, a welcome screen asks you to choose it.

## Converting the original data into a library (one time)

Needs a JDK 21+ (only for this step, to read the original Lucene indexes). Point `--src` at the original `database` folder (for example `C:\ibadi\database` after installing the original app):

```bash
npm run convert -- --src "C:\ibadi\database" --out "D:\ibadi-library" --java "C:\path\to\jdk-21"
```

It downloads the official Lucene 10.4.0 jars from Maven Central (SHA-1 verified), exports the page text, headings and verses, and then builds `ibadi.db` (≈ 3.1 GB, with full-text and root indexes) and `covers.db` (≈ 290 MB, thumbnails plus resized covers). It takes about 10 minutes.

## Building installers

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

```bash
npm run dist:linux
```

macOS and Linux packages must be built on those systems. `.github/workflows/build.yml` builds all three on GitHub Actions (run it manually, or push a `v*` tag).

### Shipping the library

The library is too large for an installer, and keeping it separate lets content updates ship on their own. Distribute it as a separate download and either:
- put it next to the installed app as a folder named `library`, or
- let users choose it on first run (the choice is remembered).

## Windows Defender and SmartScreen

- The installer and app were scanned with Microsoft Defender (`MpCmdRun`, current signatures): **no threats**. A silent install, launch and uninstall were also tested: all exit codes were 0 and nothing was left behind.
- Things that help the build avoid false positives: per-user install with no admin prompt (`asInvoker`, `allowElevation: false`), no native modules or extra DLLs, no packers or obfuscation, standard NSIS, full version metadata.
- **SmartScreen is a separate, reputation-based check.** Unsigned downloads show "Windows protected your PC → More info → Run anyway" until the publisher builds reputation. Code signing removes this. Set `CSC_LINK` (base64 `.pfx`) and `CSC_KEY_PASSWORD`, locally or as GitHub secrets, and electron-builder signs automatically. An EV certificate or Azure Trusted Signing gives immediate reputation.
- macOS: unsigned builds need right-click → Open the first time; add the Apple secrets in the workflow to sign and notarize.

## Security

Context isolation, a sandboxed renderer, no Node.js in the renderer, a strict Content-Security-Policy, and an allow-listed IPC API that checks which page is calling. Book text is always inserted as text, never as HTML. External links open in the system browser. Electron fuses: RunAsNode off, `NODE_OPTIONS` and `--inspect` ignored, ASAR integrity checking, and the app only loads from the ASAR.

## Tests

```bash
npm test -- "D:\path\to\library"
```

This runs 39 checks against a real library: metadata, paging, every search mode, scopes and facet totals, the Qur'an and tafsir, covers, user data, and that all 2,931 books open.

## Project layout

```
src/main/        main.js (window, app:// protocol, IPC), db-worker.js (all SQLite queries), preload.cjs, settings.js
src/renderer/    index.html, styles.css, js/ (app shell, views, page renderer), fonts/ (Amiri, Amiri Quran, Noto — OFL)
src/shared/      arabic.js (normalization, query expansion, highlighting), quran.js
tools/           convert.mjs, build-library.mjs, lucene/LuceneExport.java, smoke-test.mjs, make-icon.mjs, cdp.mjs
```

## Not ported yet

These original modules have data or code that was not carried over in this version: the Rustami manuscripts catalog (`rustami.db`), the people/narrator network graph (`people.db`), the Al-Awtabi dictionary and fatawa indexes, online content updates from ibadi.net, and the AI search. `rustami.db` and `people.db` are plain SQLite and can be added as further views.
