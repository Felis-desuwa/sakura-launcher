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
npm run lossless-test    # the other upscaler: splicing profiles into somebody else's settings file
npm run display-test     # the machine: which screen, whether HDR is on, what a scale factor lands on
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
`upscale-rules.ts`, `magpie-rules.ts`, `magpie-config.ts`, `lossless-rules.ts`,
`lossless-config.ts`, `display-rules.ts`
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

### The two upscalers

`upscale.ts` is a switch on `Settings.upscaler` and nothing else; `launcher.ts`, the IPC
handlers and the renderer all speak of "upscaling" and never name a backend. What is
backend-neutral — which games qualify, whose setting wins, how many fit, in what order —
lives in `upscale-rules.ts` and is shared. Everything below that diverges completely, and
the divergence is about **ownership**, not quality:

- **Magpie** (`magpie.ts`, `magpie-rules.ts`, `magpie-config.ts`) is GPLv3 and travels with
  this program. A private copy under `%APPDATA%`, held in portable mode by the `config\config.json`
  beside it, is a process this program started, configured and may stop. The user's own
  Magpie is never even read.
- **Lossless Scaling** (`lossless.ts`, `lossless-rules.ts`, `lossless-config.ts`) is paid,
  closed software bought on Steam. It cannot be shipped and is not. The only copy that
  exists is theirs, so it has to be *found* rather than placed, its configuration is *theirs*
  rather than ours, and it is *not ours to stop*.

Three things will break quietly if changed:

1. `lossless-config.ts` **splices text**; it does not parse and reserialise. Only the bytes
   between `<GameProfiles>` and `</GameProfiles>` are touched. A tree round trip would
   reformat their file and drop any element a future version adds — the harness asserts the
   rest of the file is unchanged byte for byte.
2. The written order is **sorted, not ranked**. `upscaleTargets` hands games over most
   recently played first, which is right for deciding what fits under the cap and wrong for
   writing down: it changes on every launch. Since a rewrite requires Lossless Scaling to be
   closed, an unstable result would mean the config could never be updated once the first
   game of a session had started it.
3. A profile is **cloned**, not composed. Its forty-odd fields — frame generation,
   capture API, GPU and display selection — are copied verbatim from the profile the user
   picked, and only four are changed. Authoring them here would mean reimplementing that
   program's settings page and getting it wrong the day they add a field.
4. `LOSSLESS_PRESETS` (in `shared/types.ts`, beside `MAGPIE_MODES` and for the same reason:
   the renderer offers them and cannot reach into `src/main`) is the ready-made answer for
   somebody who has not built a profile. It is **the same clone with a few elements set on
   top**, never a profile authored from nothing — what it does not name it still inherits.
   What it *does* name is only what makes a preset worth having: the scaling algorithm,
   keeping a 4:3 game's proportions, frame generation off, and **`CaptureApi: WGC`**.
   That last one is not a picture preference — it is the only capture path that can carry a
   **moving cursor**, and this library is played entirely with a mouse. What DXGI hands over
   is the desktop image, which does not contain the cursor at all; Lossless Scaling can only
   draw one itself, and it draws when a frame arrives. A visual novel is a still picture, so
   the pointer freezes where it was and jumps only when something redraws. WGC has the system
   composite the cursor into the captured frame (`IsCursorCaptureEnabled`, visible in
   `Lossless.dll`) so it moves on its own. **This was arrived at the long way**: setting
   `ScaleCursor` first made a pointer appear and then froze it, which is the same bug wearing
   a different face — do not re-add it. `ClipCursor` and `AdjustCursorSpeed` stay unset too:
   they change how the mouse *moves* rather than whether it can be seen, and trapping
   somebody's cursor is not a default to hand out.
   **`GsyncSupport: false` and `QueueTarget: 0` are that same choice finishing itself**, and
   both would be wrong without it. Making the cursor visible is not the same as making it
   move: it came back stuttering and blinking, because two settings inherited from the
   clone are tuned for the opposite of this material. Variable refresh follows the frame
   rate, a still page of text has almost none, so the panel sits at its floor — and Lossless
   Scaling's own note on capture warns in as many words that a hardware cursor under WGC
   needs multi-plane overlay support before variable refresh behaves. A capture queue is
   the same shape of thing: that note offers depths 1 and 2 for "uncapped or unstable frame
   rates under GPU load" and depth 0 as "always use the last captured frame", and a queue
   that fills once a second is not a buffer, it is a delay. Neither is a picture
   preference, and neither buys a visual novel anything: there is no tearing to smooth when
   nothing moves. **Do not re-add them by reading the defaults as the user's choice** — the
   user picked an algorithm, and these arrived with the profile that got cloned. Note that
   `QueueTarget` is neither an enum nor a boolean but a plain integer; `lossless-test.mts`
   still pins it to the three depths Lossless Scaling documents, because a depth nobody has
   seen it handle is not made safe by the absence of a serialiser cliff.
   Two consequences worth knowing. WGC needs Windows 11 24H2; **older versions fall back to
   DXGI inside Lossless Scaling**, so this needs no capability check here. And the two paths
   handle colour differently — its own tooltip says DXGI needs `HdrSupport` while WGC applies
   correction itself under Windows' colour management — which is why `Settings.losslessHdr`
   keeps its manual positions: if a machine ends up corrected twice, the way out is one
   dropdown rather than a code change.
   Every value it writes is a verified member of its enum, read out of the assembly's
   metadata with `System.Reflection.Metadata` rather than guessed from the interface, where
   the label `Vsync3` belongs to a member spelled `VSYNC3`. This is not fussiness:
   `Settings.xml` is read by .NET's `XmlSerializer`, an unknown enum value throws, and what
   fails to load is the **whole file** — a misspelling costs the user every setting they
   have, not one shader. `lossless-test.mts` pins each value against the verified lists.
5. **One field is written from a measurement rather than copied or chosen: `HdrSupport`.**
   `display-info.ts` asks Windows through `QueryDisplayConfig` /
   `DisplayConfigGetDeviceInfo`, `display-rules.ts` holds the judgement, and the answer is
   applied to **preset profiles only**. It is not a picture preference — it describes the
   *screen*, which Lossless Scaling has no way to know either: on an HDR desktop everything
   it captures arrives in a high-dynamic-range format whether the game is HDR or not, and a
   preset that inherited a stale `false` from the profile it cloned presents that picture as
   though it were SDR. The colour comes out wrong, nothing reports a fault, and the value the
   user would have to correct is one they never chose — they picked an algorithm.
   Four things hold this up and each is load-bearing:
   - **Null is not false.** A query that could not answer writes nothing at all; `false` on
     an unknown is the same bug pointing the other way.
   - **A failed query keeps the last known answer** rather than reverting to null. Flapping
     between "on" and "not known" makes `changed` true on every launch, and a rewrite needs
     Lossless Scaling closed — so an unstable answer means the file can never be brought up
     to date once the first game of a session has started it.
   - **A mode naming one of the user's own profiles is still cloned and corrected in
     nothing.** A disagreement there is reported (`hdrMismatch`) and left alone. Do not
     widen this to "our profiles are ours so we may write what we like": their value is the
     one they set, and silently holding two different answers in two adjacent profiles is
     how a person loses a day.
   - **The query never runs on a poll.** `losslessStatus` is asked every five seconds by the
     settings page and reads `cachedDisplays()`; only `warmLossless`, a launch, and the
     button ask. Electron's `screen` events invalidate the cache for free, which is exactly
     when HDR being switched on stops the answer being true.
6. **A write blocked by `configLocked` must leave a standing mark** (`pendingWrite`, shown
   in the settings page). The toast that reports it lasts 4.2 seconds; the state lasts until
   the user closes Lossless Scaling. The colour bug above survived for exactly this reason —
   the user turned HDR support on in their base profile, every later launch found that
   program running and wrote nothing, and no part of the interface could say that the last
   correction had never landed.

`window-text.ts` additionally reports each window's `GetClientRect`, which is purely
additive — `launch-watch.ts` reads only the title and class. It exists so the one question
this program could never answer about scaling can be answered out loud: whole-multiple
scaling that finds no multiple presents the picture at its original size and **reports
nothing**, and a 1280×720 game in a bordered window has a client area of 1284×724, which
needs 2568×1448 to double and does not fit a 2560×1440 screen. `checkWholeMultipleFit` in
`lossless.ts` samples that **once**, for that one preset, and stores nothing anywhere — it
is not a third folder watcher and must not become one.

**Nothing about the machine goes into the sidecar.** A monitor describes this desktop, not
the game — the same reason group membership and tile order stay out.

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
- **Lossless Scaling is the user's own program, and the interface has to say so.** It is
  paid, closed software they buy and install themselves; nothing here ships it, downloads it
  or installs it. The note saying that is shown whenever the backend is selected, **found or
  not** — a note that appeared only on failure would leave everyone who happens to own it
  never told that this program does not supply it, and that it writes into its settings. The
  build is unaffected: `magpie:fetch` is still the only step that touches the network, and
  locating Lossless Scaling reads the registry and local files.
- **The route to point at it by hand is always available, and outranks the automatic search.**
  That search reads Steam's own library records and has several perfectly ordinary ways to
  miss or land on the wrong copy — Steam installed somewhere unusual, a library folder moved,
  the folder copied out whole, the registry cleaned. So it is a standing control rather than
  an error fallback, it comes with a way back to null (a path pinned once must not outlive
  the install it pointed at), and a path that is not `LosslessScaling.exe` or is not there is
  **refused rather than stored** — a bad pin would outrank the search from then on and leave
  the feature aimed at nothing while showing a path as though it worked.
- **Their `Settings.xml` is written only while Lossless Scaling is not running, and never
  before the original has been copied aside.** It saves that file over from memory when it
  quits, so anything written underneath is swallowed. Magpie has the same trap and answers it
  by stopping Magpie first; there is no such answer here, because stopping the user's own paid
  software to edit its configuration is not something this program gets to do. It waits and
  says so. The backup is taken **once** — refreshing it would replace the file-as-it-was with
  our own last output.
- **Only profiles carrying `SAKURA_PREFIX` are ever added or removed; theirs are read and
  never written.** That prefix is the sole judge of what is ours, so changing it orphans every
  profile written under the old one — and it is why a preset's title goes through
  `ourProfileTitle` rather than being spelled out in the table. A mode naming no profile of
  theirs writes **nothing** — inventing picture settings in somebody else's program, under a
  name that looks like this one endorsed them, is worse than not scaling. A preset asked for
  where there is no profile at all has nothing to clone and says so (`noBase`), which is a
  different message from `missing` on purpose: one is a name to correct, the other is a
  Lossless Scaling that has never been opened.
- **A preset id is stable and untranslated, and so is the profile title it produces.**
  `Sakura:Quality` travels in `sakura-launcher.md` to machines with another interface
  language and has to mean the same thing there; `Sakura · Quality` is read by the user
  inside *Lossless Scaling's* window, where a name that moved with this program's language
  would leave them unable to match the two — the same reasoning that keeps `MAGPIE_MODES`
  untranslated. Only the label in this program's own menus is translated.
- **Only a Lossless Scaling this program spawned, whose handle it still holds, is ever
  stopped.** It raises itself to administrator from its own `<StartAsAdmin>` — which this
  program reads and never changes — and a copy that did so is out of reach for good. Anything
  else running is theirs.
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
- **Lossless Scaling has no `-t`, and must never be given `windowsHide` instead.** The flag
  below is `SW_HIDE` in the `STARTUPINFO` and the lesson is the same one Magpie taught: the
  window is created and merely left unshown, and the program's own "show me" path then finds a
  window it believes is already open. Lossless Scaling simply has no tray-start flag, so its
  window appears — a wart, and the honest one. The game is spawned before this runs and takes
  the foreground when it finally draws.
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
