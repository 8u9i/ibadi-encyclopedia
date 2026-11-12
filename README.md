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

- **Interface**: an "ink & rubric" design drawn from the Omani manuscript tradition: warm paper, carbon-ink text, and red rubrication for headings, with paper, parchment and lamp (dark) themes. A single custom title bar holds the sections, the open books as tabs, quick open, and custom minimize, maximize and close buttons on the left edge (mirrored RTL). The native frame behaviour is kept: Windows 11 rounded corners, snapping and edge resizing. macOS keeps its traffic-light buttons.
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

The library is too large for an installer, and keeping it separate lets content updates ship on their own. It is published as the `library` release, and the app downloads it on first run: users just press «تنزيل المكتبة».

- Package a built library: `node tools/pack-library.mjs --lib <library dir> --out <dir>`. It gzips each database, cuts parts below GitHub's 2 GB limit and writes `library.json` with every part's size and SHA-256.
- Upload `library.json` and the parts to the release tagged `library` (replacing the old assets).
- The app downloads to `%LOCALAPPDATA%\Ibadi Encyclopedia\library` on Windows (or a folder the user picks). It checks free space first, resumes interrupted parts with HTTP Range requests, and verifies every part and every restored file before using them. It currently downloads about 1.2 GB, which becomes 3.4 GB on disk.
- People who already have a library folder can choose it instead («لديّ مجلّد المكتبة»), or place it next to the app as `library`.

## App updates

New versions of the app itself reach installed copies from this repository's GitHub releases (electron-updater, the one runtime dependency).

- **Windows (x64 and ARM) and Linux AppImage**: the app checks at startup and every six hours, downloads the installer for its architecture in the background, and shows «أعد التشغيل للتحديث» in the sidebar. The update also installs when the app is closed. It can be turned off in Settings → «تحديث البرنامج».
- **macOS and the .deb package**: macOS will not replace an unsigned app, so these builds only show «يتوفّر الإصدار …» with a link to the download page. Signing the Mac build (Apple Developer ID) would let it update itself too.
- **Publishing**: CI uploads `latest.yml`, `latest-linux.yml` and the `.blockmap` files next to the installers; they must be attached to every release. Installer names carry no version, so `https://github.com/8u9i/ibadi-encyclopedia/releases/latest/download/<name>` always serves the newest build.
- **Testing**: build two versions locally, serve the newer one's `dist` folder over HTTP, and start the older app with `IBADI_APP_UPDATE_URL=http://127.0.0.1:<port>/`.

## Library updates (for everyone)

New and corrected books reach every installed copy as small **update packs**, not a new 1.2 GB download.

- **In the app**: it checks `library.json` at startup and every six hours. With «تنزيل التحديثات تلقائيًا» on (the default) it downloads the new packs, checks their SHA-256 and applies them; Settings → «تحديثات المكتبة» → «تحديث الآن» does it on demand. Each pack is applied in one transaction, so a library is either fully updated or untouched. Open books reload at the same page.
- **What a pack holds**: the full content of every new or changed book (pages, headings, catalogue row, per-book metadata, cover, root-dictionary entries), the ids of removed books, and the category and author tables when they change. A one-book correction is typically 60–250 KB.
- **How changes are found**: every book has a fingerprint (SHA-256 of its text, headings and metadata). `state.json` on the release holds the fingerprints of what was last published, so a pack contains exactly the books whose fingerprint changed. Fingerprinting the whole library takes about 20 seconds.

### Publishing (maintainer)

Needs the GitHub CLI (`gh`) logged in with write access to this repository.

```bash
npm run publish-update -- --lib "D:\Ibadi\library"
```

It builds the pack, then uploads `update-NNNN.db.gz`, the new `library.json` and `state.json`, in that order, so a failure at any step is harmless (rerunning ships the same books again). `--dry-run` builds the pack without uploading. `--init` records a library as the published baseline; it was run once on the library matching the `library` release.

**Automatically, from the original app**: when `gh` can write to the repository, Settings → «تحديثات المكتبة» shows a «النشر (للمشرف)» section. Turn on «نشر التحديثات تلقائيًا» and every time this app copies new books from the original Ibadi Encyclopedia, it publishes them as a pack straight away. Other users never see this section.

To start over from a fresh full download (for example after many packs), rebuild and upload the full library with `pack-library.mjs`, set `"version"` and `"base"` in `library.json` to the current version, and run `--init`.

## Updates from the original app

When the original Ibadi Encyclopedia downloads new or updated books, this app picks them up on its own. Nothing is fetched from the internet by this app.

- **Finding the original**: the folder chosen in Settings, otherwise `X:\ibadi` on any drive, otherwise the folder of the original's `ibadi.exe` while it is running (remembered once found).
- **Detecting changes**: checks every minute whether `master.db` or the Lucene commit has changed, and waits one more check for the original to finish writing.
- **Finding what changed**: compares each book's on-disk version (`major_ondisk`/`minor_ondisk`) with a snapshot kept in `ibadi.db` (`src_book`). Books the original hides or drops are removed. Books that are listed but not downloaded (a "light" install) are kept.
- **Applying**: exports only the changed books' text with the original's own Java runtime (`app\win\64\jre`) and the bundled Lucene reader, about a second per batch. It then updates pages, headings, full-text and root indexes, metadata and covers in place. Open books reload at the same page.

The library folder must be writable. You can also start an update from Settings → «التحديث من البرنامج الأصلي».

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
src/main/        main.js (window, app:// protocol, IPC), db-worker.js (all SQLite queries), preload.cjs, settings.js,
                 library-download.js (first-run download), library-update.js + update-worker.js (update packs),
                 original-sync.js + sync-worker.js (import from the original app)
src/renderer/    index.html, styles.css, js/ (app shell, views, page renderer), fonts/ (Amiri, Amiri Quran, Noto — OFL)
src/shared/      arabic.js (normalization, query expansion, highlighting), quran.js,
                 library-pack.js (fingerprints, build and apply update packs), publish.js (upload with gh)
tools/           convert.mjs, build-library.mjs, pack-library.mjs, publish-update.mjs, lucene/LuceneExport.java, smoke-test.mjs, make-icon.mjs, cdp.mjs
```

## Not ported yet

These original modules have data or code that was not carried over in this version: the Rustami manuscripts catalog (`rustami.db`), the people/narrator network graph (`people.db`), the Al-Awtabi dictionary and fatawa indexes, online content updates from ibadi.net, and the AI search. `rustami.db` and `people.db` are plain SQLite and can be added as further views.
