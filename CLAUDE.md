# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sakura Launcher — an Electron + React + TypeScript library manager for **offline single-player
games on Windows**, built for libraries with no scrapeable metadata (folder names unrelated to
executable names, a dozen exes in one folder, no store IDs). Every judgement it makes is derived
from the files themselves. Nothing goes over the network.

The user-facing feature list is a pair: `README.md` (Chinese, the primary) and `README.en.md`
(English), section for section. **A feature change edits both** — an English page that quietly
falls behind is worse than none, because it reads as current. Source comments are English.

## Commands

```bash
npm run dev            # electron-vite dev — main, preload and renderer all hot-reload
npm run typecheck      # both projects: tsconfig.node.json (main+preload+shared) and tsconfig.web.json
npm run build          # electron-vite build
npm run dist:all       # NSIS installer + portable exe into release/
npm run dist:setup     # installer only
npm run dist:portable  # portable only
```

There is no linter and no test runner. Tests are standalone `.mts` harnesses run straight through
node's type stripping — each is one suite, there is no filter flag, so "run a single test" means
running the one suite that covers the area:

```bash
npm run sidecar-test     # sidecar read/write and the merge when both sides changed
npm run exe-pick-test    # executable classification and ranking
npm run downloader-test  # downloader detection, command lines, completion
npm run diagnose-test    # launch diagnosis: runtime mapping, mojibake, engine detection, PE parsing
npm run tag-test         # genre-tag matching: title cleaning, which tags survive, which blurbs do
npm run cover-test       # cover art: which picture, whether it is adult, what is not an image
npm run save-test        # locating saves: name matching, engine roots, the download's own save
npm run share-test       # share exclusion rules
npm run share-e2e        # calls a real 7-Zip; asserts the source folder is unchanged afterwards
```

Three harnesses need a real folder passed in — **no path is ever hardcoded in this repository**:

```bash
node scripts/scan-test.mts "<library folder>"       # what the scanner sees
node scripts/icon-test.mts --scan "<library folder>" # icon sizes extracted per exe
npm run diagnose-probe -- "<one game folder>"        # everything the diagnosis can see, read-only
```

`diagnose-test` deliberately validates the PE parser against real `C:\Windows\System32` binaries
rather than a committed fixture. Never add binary samples to the repo.

### Screenshotting the UI without touching the real library

```bash
SAKURA_CAPTURE=<out.png> SAKURA_CAPTURE_DELAY=2000 \
SAKURA_CAPTURE_SCRIPT="<JS evaluated in the renderer first>" \
npx electron . --user-data-dir=<temp dir>
```

Always pass `--user-data-dir`; without it this writes to the user's actual
`%APPDATA%\sakura-launcher\db.json`.

## Architecture

### Process split

- `src/main/` — all filesystem, process and Win32 work. Nothing here trusts the renderer.
- `src/preload/index.ts` — **the complete IPC surface**, one `api` object exposed as `window.sakura`.
  Read this file first to learn what the app can do; every handler in `src/main/index.ts` and every
  call in the renderer is on one side of it. `SakuraApi` is derived from the object, so adding a
  feature means: handler in `index.ts` → binding here → call site.
- `src/renderer/src/` — React 19. `App.tsx` holds essentially all state and passes it down; pages
  and components are presentational plus callbacks.
- `src/shared/` — `types.ts` and `i18n.ts`, imported by all three.

### The pure-module convention

`scan-core.ts`, `share-rules.ts`, `save-rules.ts`, `download-core.ts`, `diagnose-rules.ts`,
`pe-imports.ts`, `tag-rules.ts`, `tag-bangumi.ts`, `cover-rules.ts` **must not import electron**. The `.mts` harnesses load them directly under node, which is what makes the
logic testable without a window. They also spell out `.ts` in their relative imports (`from
'./i18n.ts'`) because node has no bundler to fill the extension in — `allowImportingTsExtensions`
is on in `tsconfig.node.json` for exactly this. If you add an import to one of these files, keep
the extension and keep electron out.

### Where the data lives — two copies, on purpose

- `%APPDATA%\sakura-launcher\db.json` (`src/main/db.ts`) — the fast copy, read once at startup,
  debounced writes, `saveNow()` for things worth losing nothing over.
- `sakura-launcher.md` inside each game folder (`scan-core.ts` parse/write, `sidecar-sync.ts`
  reconcile) — the durable, hand-editable copy that travels with the folder. Paths in it are
  relative. Touched only at three moments: an explicit scan, and the start and end of a session.
  When the two disagree the more recently modified wins; the app records its own write mtime, so a
  newer sidecar can only mean a human edited it.

The sidecar is **bilingual**: written in the current UI language, parsed in both. If you add a field,
add it to `SIDECAR_FIELDS`/`STATUS_LABELS`/`SENTINELS` with both strings, and remember `header()`
is a function rather than a const precisely so it cannot freeze the wrong language at import time.

### Two folder watchers that must not be merged

- `playtime.ts` — measures how long a game ran. Watches whether **any** process has its image inside
  the game folder (games routinely launch a second binary and exit), with a 90 s grace so
  self-extractors, UAC prompts and launcher hand-offs are not read as a two-second session.
- `launch-watch.ts` — decides that a game **never appeared**. Three short samples (3 s / 8 s / 18 s),
  then gone. It exists separately because playtime's grace is far too long for this question and
  shortening it would break the measurement playtime exists for.

The known trap they share: a game frozen on a modal error box *is* a process in the folder. The
final sample enumerates windows (`window-text.ts`) and, on finding an error dialog, calls
`voidSession()` so the stall is not billed as play.

### Launch diagnosis

`diagnose.ts` orchestrates, `diagnose-rules.ts` holds the pure judgement, `pe-imports.ts` reads the
executable. Three things will cause mass false positives if broken:

1. `api-ms-win-*` / `ext-ms-win-*` are **virtual** api-set contract names resolved by the loader and
   absent from disk. `isVirtualDll()` must filter them or every modern exe is reported broken.
2. Delay-load imports (data directory 13) are a separate, weaker class — missing one may never matter.
3. DLL resolution follows the real Windows search order, and a 32-bit process resolves `System32`
   to `SysWOW64`.

`pe-imports.ts` is hand-written rather than using resedit because `NtExecutable.from()` rejects valid
layouts — including the very engine binaries a diagnosis exists to explain. Resources (the manifest)
still go through resedit in `pe-icon.ts`, where degrading to "unknown" is harmless.

The one check that does not infer anything is reading the engine's own message box and undoing the
Shift-JIS-through-GBK mojibake. It is ranked first in the results list for that reason.

A false positive is worse than silence here. `diagnose-test.mts` is mostly negative cases; keep it
that way.

### Engine detection

`detectEngine()` returns an `EngineId`; `hasEngineSignature()` is a thin `!== null` wrapper over it.
They are **deliberately not the same function**: `hasEngineSignature` feeds `rejectReason()`, which
decides what counts as a game at all, and widening it changes what gets imported. Changes to engine
detection must leave `scan-test` and `exe-pick-test` output byte-identical.

### i18n

One flat bilingual dictionary in `src/shared/i18n.ts` — both translations on the same line, so a
phrase reworded in one language and forgotten in the other is visible. `MessageKey` is derived from
the dictionary, so an unknown key is a compile error. **Every user-facing string goes through it**,
including strings the main process produces (launch errors, diagnosis findings, sidecar text).

- Renderer components: `useT()` from `lib/i18n.tsx`.
- Renderer non-components (`format.ts`): module-level, set by `LangProvider` **during render**, not
  in an effect — an effect would leave the first frame in the old language.
- Main process: `t()` from `main/i18n.ts`, a module variable set by `db.getSettings()`/`setSettings()`.
- The splash paints before the database is opened, so it uses `db.peekLanguage()`.
- `App.tsx` keeps a `langRef` because a translator memoised on `settings.language` is stale for work
  kicked off in the same tick as `setSettings`.

### Other pieces

- `worker-pool.ts` + `scanner.worker.ts` — directory walking and size totals on a worker thread.
  A crashed worker fails all in-flight requests and the next call spins up a fresh one.
- `splash.ts` / `splash-html.ts` — markup is a data URL built in code: no bundle, no preload, no disk
  read, because the whole point is to be on screen before anything else is ready.
- Win32 queries (process list, window enumeration) go through PowerShell, which is the only route
  that costs no native dependency. `window-text.ts` uses `-EncodedCommand` (UTF-16 base64) — the
  only form that carries a Japanese or Chinese path without quoting or codepage trouble. Note that
  PowerShell 5.1 reads a `.ps1` as ANSI without a BOM, and `Add-Type -PassThru` returns an array.
- Themes are entirely CSS custom properties in `styles/sakura.css` under `[data-theme='…']`; generated
  placeholder tiles and falling petals derive their colours from the same slots, so a theme switch
  repaints without a re-render.

## Invariants

These come from user decisions and are load-bearing. Violating one is a bug even if it typechecks.

- **Never rename a game folder.** Renaming writes the display name into `sakura-launcher.md`; many
  of these games locate assets by path and a renamed folder stops starting.
- **"Remove tile" never touches disk.** It exists to take non-game content out of the library.
  Uninstall is the only thing that deletes, and it goes through the three-step ritual.
- **Sharing never modifies the source folder.** Personal data is left out of the archive, not
  removed from disk. `share-e2e` asserts this and that assertion is the reason the harness exists.
- **The save backup copies out and never puts anything back.** There is no restore, on purpose:
  restoring overwrites a save in place, which is the only operation here that can destroy
  something unrecoverable — worse than uninstalling, which at least goes through the recycle
  bin. Adding one means adding a ritual for it. Until then the backup writes `sakura-backup.md`
  recording each item's origin, and that file is the only route back, so it gets a BOM like the
  sidecar does.
- **`Game.addedAt` is stamped only on a genuinely new entry.** It is the baseline that separates
  the user's own save from the completed one that shipped inside the download, and those are
  indistinguishable by name, extension and location. `prev?.addedAt ?? Date.now()` looks
  equivalent to what `scanner.ts` does and is a bug: it would back-date every existing entry to
  today and declare every real save to be somebody else's. An entry without a baseline keeps
  none, and the dialog says so out loud.
- **A description is only ever fetched alongside a cover**, and there is no "fetch description"
  action anywhere — the picture and the text are on one catalogue record, so a second button
  would be a second trip for one answer. The only control is `Settings.onlineSummary`.
  **Chinese only**, and nothing is translated: a blurb that reads as Japanese is dropped
  (`isChineseText`). A blurb is kept only from the record the work number named, or from the
  one Bangumi row whose name matches the work — never the next row down. The wrong plot summary
  is worse than none, because unlike a wrong tag it reads exactly like the truth.
- **Diagnosis is read-only** and does not go over the network. It names the missing runtime; it does
  not fetch it.
- **No hardcoded personal paths anywhere.** Scan roots start empty (`DEFAULT_SETTINGS.roots: []`),
  and harnesses that need a real folder take it as an argument.
- **A share rule may never be a bare extension.** `*.dat` is a save file in one engine and the entire
  game in another (BGI/Ethornell keep assets in `.dat` in the game root). Rules are bounded by
  location as well as name, and every exclusion is shown to the user before it takes effect.
- **Refresh ≠ rescan.** The top bar's refresh only syncs existing entries and never adds anything.

## Git

Remote is `Felis-desuwa/sakura-launcher` while the local commit identity differs. The mismatch is
intentional. Do not "fix" it.

Nothing in this repository names a real game from anybody's library — fixtures and examples use
placeholders (`示例游戏`, `サンプルゲーム`, `RJ01234567`, `v1234`). The shapes are taken from real
folder names; the titles are not. Keep it that way when adding a test case.
