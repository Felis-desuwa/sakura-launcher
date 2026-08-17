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
npm run dev            # electron-vite dev — the renderer hot-reloads; **main and preload do not**
npm run typecheck      # both projects: tsconfig.node.json (main+preload+shared) and tsconfig.web.json
npm run build          # electron-vite build
npm run magpie:fetch   # download + SHA-256-verify Magpie into resources/magpie (gitignored)
npm run dist:all       # NSIS installer + portable exe into release/
npm run dist:setup     # installer only
npm run dist:portable  # portable only
```

**The three `dist:*` scripts run `magpie:fetch` first, which is the only build step that
touches the network.** That is separate from the runtime promise and must stay separate in
both READMEs: the program still does not go online, and the Magpie it installs has
`autoCheckForUpdates` forced off. `npm run dev` works without it — upscaling just reports
that nothing has been copied yet.

**Restart `dev` after touching `src/main/` or `src/preload/`.** Only the renderer reloads; the
main process is built once at startup and keeps running. The failure mode is quiet and costly:
the window picks up every UI change while the process behind it stays on old code, so a feature
looks half-finished — the tags arrive, the description never does — and the bug being hunted is
in a build that is no longer on disk.

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
npm run translate-test   # translating a blurb: chunking, both services' shapes, all-or-nothing
npm run save-test        # locating saves: name matching, engine roots, the download's own save
npm run magpie-test      # upscaling: the three-state switch, config merges, mode indices by name
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
`pe-imports.ts`, `tag-rules.ts`, `tag-bangumi.ts`, `cover-rules.ts`, `translate-rules.ts`,
`magpie-rules.ts`, `magpie-config.ts`
**must not import electron**. The `.mts` harnesses load them directly under node, which is what makes the
logic testable without a window. They also spell out `.ts` in their relative imports (`from
'./i18n.ts'`) because node has no bundler to fill the extension in — `allowImportingTsExtensions`
is on in `tsconfig.node.json` for exactly this. If you add an import to one of these files, keep
the extension and keep electron out.

### Where the data lives — two copies, on purpose

- `%APPDATA%\sakura-launcher\db.json` (`src/main/db.ts`) — the fast copy, read once at startup,
  debounced writes, `saveNow()` for things worth losing nothing over.
- `sakura-launcher.md` inside each game folder (`scan-core.ts` parse/write, `sidecar-sync.ts`
  reconcile) — the durable, hand-editable copy that travels with the folder. Paths in it are
  relative. Touched at an explicit scan, at the start and end of a session, and after a
  catalogue lookup settles something (`computeTags`, `applyMatch`, set/clear cover).
  When the two disagree the more recently modified wins; the app records its own write mtime, so a
  newer sidecar can only mean a human edited it.

The sidecar is **bilingual**: written in the current UI language, parsed in both. If you add a field,
add it to `SIDECAR_FIELDS`/`STATUS_LABELS`/`SENTINELS` with both strings, and remember `header()`
is a function rather than a const precisely so it cannot freeze the wrong language at import time.

`Game.renamed` is **not** the flag for "a person named this game". The sidecar is the source of
truth for a title, so the first sync after a rename clears it while keeping the name. Use
`chosenName()` in `tagger.ts` (name ≠ `displayNameFor(dir)`), or a game called 多娜多娜 in a
folder called `032601` gets looked up as `032601` and offered `032601` back in the match box.

**What a lookup found is written down too** — work id, genre tags, description, and the cover's
file name. It is nominally derivable, but only by somebody with the switch on, a connection and
the patience for a paced pass, which is no help to a folder that has just been renamed or moved
to another machine. Three rules hold it together:

- **A file name, never a path**, resolved against the folder the sidecar was found in. That is
  what survives renaming the folder to anything at all. `findCoverIn()` is the second route:
  a scan finds `sakura-cover.*` even when the line naming it was deleted.
- **Fetched covers are written into the game folder** (`COVER_BASE`), not `%APPDATA%`. The
  app-data directory is only the fallback for a folder that cannot be written to — archives,
  read-only media. `game:clearCover` deletes the file, or the next scan finds it and puts it back.
- **Adult and spoiler tags get their own lines** (`adultTags`/`spoilerTags`). Flattened into one
  list they come back stripped of the flags that hide them, which puts an explicit tag on the
  shelf and spoils an ending. Same reasoning as the cover source: an unattributed cover parses
  back as `undefined` and is *treated* as the user's — protecting it — rather than being
  relabelled as theirs in the file.

Group membership and tile order stay out: they describe this machine's desktop, not the game.

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
- **One lookup brings back everything.** Tags, cover and description are one catalogue record,
  so there is one menu entry (`menu.fetchWork`) and one pass — `tagger.computeTags`, which
  applies the tags and then calls `applyCover`/`applySummary`. There is no "fetch cover" or
  "fetch description" action anywhere; a second button would be a second trip for one answer,
  and it left libraries with the tags fetched and the covers not. The sub-switches
  (`onlineCovers`, `onlineSummary`) decide how much of the record is kept, never how many
  trips are made. `covers.ts` must not import `tagger.ts` — it takes a settled match and does
  not search, which is what keeps the two out of an import cycle.
  **A cover already on the tile is never written over — it is put to the user.**
  `coverVerdict` answers on two facts only: is there a cover, and is the new one byte for
  byte the same. `applyCover` then downloads the catalogue's picture to
  `covers/candidate-<gameId>.<ext>` under the app's own data directory and returns a
  `CoverChoice` instead of writing anything. The rule this replaced decided in silence — a
  batch skipped hand-picked covers, a single lookup replaced them — without anybody having
  seen the two pictures. **Do not narrow this back to `coverFrom === 'user'`.** That was
  tried and it is the same bug wearing a rule: in a real library nearly every cover has been
  fetched, so the dialog never fires and a lookup goes on silently doing the one thing this
  exists to stop. Where a picture came from says nothing about whether it is the one somebody
  wants to keep looking at. `coverSourceOf` still decides one thing — whether `clearWorkData`
  may delete the file — and that is the only question it answers now.
  Three things hold the rest up: the holding file is **never** written beside the
  game, because a scan finds `sakura-cover.*` there and would adopt the very picture nobody
  has agreed to; the renderer names a game id and a yes or no and **never a path**, so which
  file gets written is known only in the main process; and an offer left unanswered costs
  nothing, because closing the dialog drops it and `sweepCoverCandidates()` clears at startup
  whatever a killed session left behind.
  **Undoing a lookup keeps `taggedAt`.** `clearWorkData` drops the work record, the auto
  tags, the hidden-tag strikeouts that only applied to them, the description and a cover the
  catalogue supplied — and nothing the user put there, which is why the cover is checked
  against `coverSourceOf` first. But it leaves `taggedAt` set, because `pendingTargets`
  selects the games *without* it: clearing that too would have the next library-wide pass
  fetch the same wrong record back, and the user undoing it again every time. The route back
  is the game's own menu, which is what somebody uses when they expect a different answer.
  **Chinese only on screen.** A blurb that reads as Japanese (`isChineseText`) is
  machine-translated and **labelled as translated** — `summaryTranslated`, shown in the drawer
  and written into the sidecar. Dropping those was the original rule and it was wrong in
  practice: Bangumi carries the Japanese store copy on a great many otherwise Chinese entries,
  so it left most of a library blank. The label is the part that must not be lost — a sentence
  a machine produced and one a person wrote read alike and are not worth the same.
  A blurb is kept only from the record the work number named, or from the one Bangumi row whose
  name matches the work — **never the next row down**. Translating the right game's Japanese is
  a quality problem; showing the wrong game's Chinese is a lie, and it reads exactly like the
  truth. `translate.ts` fails whole: a half-translated blurb reads as a fault in the game's own
  description, so a failed chunk discards the attempt and the next service starts over.
- **A download that is several archives is never extracted on a guess.** A split set —
  `X.7z.001`, `X.part2.rar` — is one archive: 7-Zip is handed the first volume and picks up
  the rest, and that still happens on its own. Several *unrelated* archive sets is the other
  shape (`archiveSets` in `download-core.ts` tells them apart), and it is the ordinary way
  these releases ship: a body, a patch, a bundle of extras. Which one is the game is a
  question about the contents, and nothing here has opened them. The rule this replaced took
  the largest set and extracted it silently, which is how a library ends up half-imported
  with no record of what was skipped. Now nothing is extracted, every set is listed on a
  card in the bottom-right corner, and the card goes when its button is pressed — not on a
  timer, because it is the only record of what landed and where. `pollFolder` still narrows
  `done` to one set, so **read `verdict.sets`, never `archiveSets(verdict.done)`** — the
  latter is always one set by construction and quietly restores the old behaviour.
  Two concurrent jobs in one folder are the related trap: a baseline only records what was
  there when *that* job started, so the second job never saw the first one's archive and
  adopts it when it lands. `settle` calls `claimFiles` before anything else for that reason,
  and `freeDestFor` keeps two 7-Zips out of one destination tree even so.
- **Diagnosis is read-only** and does not go over the network. It names the missing runtime; it does
  not fetch it.
- **No hardcoded personal paths anywhere.** Scan roots start empty (`DEFAULT_SETTINGS.roots: []`),
  and harnesses that need a real folder take it as an argument.
- **A share rule may never be a bare extension.** `*.dat` is a save file in one engine and the entire
  game in another (BGI/Ethornell keep assets in `.dat` in the game root). Rules are bounded by
  location as well as name, and every exclusion is shown to the user before it takes effect.
- **Refresh ≠ rescan.** The top bar's refresh only syncs existing entries and never adds anything.
- **The user's own Magpie is never touched.** The bundled copy lives under
  `%APPDATA%\sakura-launcher\magpie\` and is kept in portable mode by the `config\config.json`
  written beside it — that file existing is the *only* thing keeping Magpie from reading and,
  on exit, rewriting `%LOCALAPPDATA%\Magpie\config\v4\config.json`. `startMagpie` refuses to
  run without it. For the same reason nothing is ever killed by process name: `mayStop()` only
  admits a path equal to our own copy's, or the user's running Magpie would be ended for them.
  And the config is **never written while Magpie runs** — it saves the whole file over from
  memory the moment any of its own settings changes, so a profile written underneath a live
  Magpie vanishes silently. That immediacy is also why ending it outright is safe: there is
  no unsaved state to lose, and `stopMagpie`'s polite WM_CLOSE is measured never to end it
  (closing Magpie's window hides it to the tray, and a `-t` copy has no window at all).
- **Magpie is started with `-t` for a game and without it for the settings button.** That
  flag is Magpie's own way of coming up in the notification area, and it is the only one
  that works. Hiding the window from outside — `windowsHide` on the spawn, which is
  `SW_HIDE` in the `STARTUPINFO` — leaves Magpie believing its main window is open, and it
  then ignores the `WM_MAGPIE_SHOWME` that a second instance broadcasts to raise it. The
  window can never be brought back for the rest of that process's life. Never pass
  `windowsHide` when spawning Magpie; it is a GUI program with no console to suppress, so
  the flag has nothing to offer and this to cost.

## Git

Remote is `Felis-desuwa/sakura-launcher` while the local commit identity differs. The mismatch is
intentional. Do not "fix" it.

Nothing in this repository names a real game from anybody's library — fixtures and examples use
placeholders (`示例游戏`, `サンプルゲーム`, `RJ01234567`, `v1234`). The shapes are taken from real
folder names; the titles are not. Keep it that way when adding a test case.
