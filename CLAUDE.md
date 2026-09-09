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
npm run pointer-test     # putting a streamed tap back on the game: where the picture lands
npm run update-test      # the manual update check: version precedence, channels, which asset
npm run guide-test       # walkthrough search: what normalises away, what counts as a match
npm run binfix-test      # per-build byte fixes: what a fix pack may ask for, and what it may not
npm run repair-test      # what may be offered as a repair, and — mostly — what may not
npm run share-test       # share exclusion rules
npm run share-e2e        # calls a real 7-Zip; asserts the source folder is unchanged afterwards
```

Three harnesses need a real folder passed in — **no path is ever hardcoded in this repository**:

```bash
node scripts/scan-test.mts "<library folder>"       # what the scanner sees
node scripts/icon-test.mts --scan "<library folder>" # icon sizes extracted per exe
npm run diagnose-probe -- "<one game folder>"        # everything the diagnosis can see, read-only
npm run binfix-probe -- "<pack.json>" ["<game.exe>"] # run a fix pack against a real game, once
```

`binfix-probe` is the only harness here that **starts a game** — and it has to. `binfix-test`
can prove the rules refuse a bad pack, but nothing offline can prove that a signature is
anywhere in a real image, that a packed executable decrypts inside the timeout, or that
`WriteProcessMemory` is allowed to land, and those three are what decide whether the feature
works at all. It stops the game again afterwards. Given a pack and no executable it only
reads the pack. It lifts the PowerShell out of `src/main/binfix.ts` rather than carrying a
copy, because a copy would go on passing after the real one had rotted.

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
`lossless-config.ts`, `pointer-map-rules.ts`, `display-rules.ts`, `update-rules.ts`,
`guide-rules.ts`, `binfix-rules.ts`, `repair-rules.ts` **must not import electron**. The `.mts` harnesses load them directly under node, which is what makes the
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
   somebody's cursor is not a default to hand out. They are also the wrong answer to the
   problem they look like they solve — see the pointer mapper below.
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

### The pointer mapper

`pointer-map.ts` starts one long-lived process alongside Lossless Scaling when
`Settings.losslessPointerMap` is on; `pointer-map-rules.ts` holds the geometry and is the
only part a harness can reach. It answers the one thing an overlay upscaler structurally
cannot: it enlarges the picture and leaves the window where it was, so a streaming client
sending **absolute** coordinates taps a point that is on the picture and not on the game.
An ordinary mouse never notices, because the WGC capture carries the cursor — the pointer
on the enlarged picture *is* the real one. This is why `ClipCursor` is not the fix it looks
like: it stops the pointer leaving the window, which keeps a stray tap off other software
and does nothing at all about the tap being in the wrong place.

Thirteen things hold it up and each is load-bearing:

1. **Only events flagged `LLMHF_INJECTED`, and never our own.** Our re-injected events
   carry `SIG` in `dwExtraInfo`, without which every mapped event would be mapped again
   forever. **Do not read the injected filter as the safety argument** — that mistake cost
   the user the use of their mouse. A mouse plugged into this machine is unaffected, yes;
   but a streaming client injects *everything*, moves included, so in the one situation
   this feature exists for every event goes through the hook and whatever it decides is
   what the pointer does. It cannot tell that client from a macro tool either.
2. **Two outcomes, and the missing third is the lesson.** On the output window → clamp onto
   the picture and map. On another monitor → pass, because that is somebody's actual
   desktop. The first version had a third — **drop a point on the letterbox**, since there
   is nothing there but black — and it **deadlocks**: the moves that would carry the pointer
   off the letterbox are exactly the events being dropped, so the pointer can never leave
   and the mouse stops dead. It shipped and was reported within minutes. Clamping is also
   what `ClipCursor` was there to do, for free. Do not reintroduce a refusing branch for
   anything inside the output window.
3. **A tap and a drag are different inputs, and mapping is right for one and fatal for the
   other.** A combined remote client sends both down one wire: a tap names a position
   (absolute), a press-and-drag behaves like a trackpad (relative). Nothing in a mouse event
   says which it was. **Mapping is a compression, and a compression has a fixed point** — run
   relative motion through it and every step is compressed again, so the pointer converges
   there and stops. This shipped: with a 1284×724 game on a 2560×1440 screen the fixed point
   is (55, 105), and that is exactly where the user's pointer was found parked, three
   failed attempts in. What separates them is that we know where we last placed the pointer:
   a drag step is measured from there and lands near it, a tap names somewhere else. The two
   populations do not overlap in practice — measured drags reached 96px, the smallest tap
   jump was 129px, hence `TAP_DISTANCE = 110`. A drag then accumulates into a **virtual
   pointer held in screen space** (`advanceVirtual`), never in game space: mapping divides
   the step by the scale and the upscaler multiplies it back, so the pointer keeps up with
   the finger. Accumulate in game space and every drag is halved.
4. **There must always be a way out without a mouse.** Two exist and both are documented in
   the settings page: closing the game (scaling stops, the output window goes, `_active`
   goes false within 400 ms) and closing the launcher (the parent check fires within
   700 ms). Anything that lengthens either is a regression.
   **Neither is checked by the sweep, and that is why the promise can be kept.** `Refresh()`
   is tens to hundreds of milliseconds and runs every ~600 ms; a version that waited for it
   to notice took 600–900 ms to go inert while all four documents said half a second.
   `StillScaling()` is two calls against the output window handle already in `Geom` —
   microseconds — so it rides the 100 ms sleep between sweeps alongside `ParentAlive()`.
   Do not answer a latency promise here by running the sweep faster: that is what froze
   the pointer in the first place.
   **The second one failed once, and the way it failed is the lesson.** The parent check
   lived in the worker loop, which also wrote to stdout — unguarded. Kill the parent and the
   pipe breaks, the write throws, that thread dies, and the check dies with it: a process
   holding a system-wide mouse hook, with nothing left in it that would ever ask it to stop.
   The launcher had been started elevated (the user's Lossless Scaling sets `StartAsAdmin`,
   and the whole chain inherits it), so it could not be killed without a UAC prompt either.
   Two rules came out of it: **every statement in the worker loop is inside a catch**, and
   the check also runs on the **pump thread** via a thread timer, because that thread is by
   construction not doing anything that could throw. Belt and braces here is not excessive —
   the failure mode is a stranded global input hook.
   **It failed a second time anyway, and that is why there is now a watchdog thread.** A
   session outlived its launcher by half an hour: it wrote no state file, so the worker was
   gone, and it did not answer the pump's timer either. It took a UAC prompt to end, because
   the chain had inherited administrator from the user's own Lossless Scaling — and for that
   whole half hour every mouse event on the machine paid `LowLevelHooksTimeout` to step over
   a hook nobody was serving. Both existing checks were re-measured afterwards and both work
   (a killed parent had the process gone in 243 ms); what they share is the assumption that
   **some thread is still going round its loop**, and this is the one process that may not
   make it. So the third path does not loop at all: it blocks in the kernel on the parent's
   handle, is woken by the parent's death itself, and has no state that can wedge it. It ends
   with **`TerminateProcess`, not `Environment.Exit`** — measured, 27–41 ms against 2.2
   seconds, because Exit runs finalisers and the host's own shutdown. There is nothing here
   worth closing tidily and everything worth ending at once. Do not "improve" this thread by
   giving it anything else to do.
5. **A move is applied with `SetCursorPos`; only buttons go through `SendInput`.** Calling
   `SendInput` from inside the callback puts another event on a queue drained through that
   same callback, so every move costs two passes and the backlog compounds — it was reported
   as "the pointer lags by several seconds", and the pointer appearing to stop was the
   backlog, not the arithmetic. `SetCursorPos` raises no low-level hook event at all
   (verified: a probe parking the cursor with it saw nothing), so the high-frequency path
   produces no new work. Buttons still need `SendInput` — a press has to be a real input
   event and must carry the position — but they are two events per click, not two per
   millimetre. `state.txt` reports `queue lag ms`, computed from `MSLLHOOKSTRUCT.time`,
   which is the number that says whether the hook is keeping up. Related: the callback reads
   its fields with `Marshal.ReadInt32` rather than `PtrToStructure`, which would box an
   object for every mouse event on the machine.
6. **The pump thread pumps and does nothing else.** A low-level hook is dispatched by the
   system posting to the queue of the thread that installed it, so **the callback cannot run
   while that thread is doing anything else** — and every mouse event on the machine waits
   behind it, whether or not this feature would have touched that event. The first version
   ran `Refresh()` inline on a `PeekMessage`/`Sleep(4)` loop; `Refresh()` walks every
   top-level window and opens every owning process, so the pointer froze for tens to
   hundreds of milliseconds every 400ms and the report was "the mouse cannot move". Now
   measuring is a separate thread that publishes an immutable `Geom` through a volatile
   reference (a reference assignment is atomic; a struct written in place is not, and the
   callback would read half a rectangle), and the pump is a blocking `GetMessageW`. **Do not
   put work back on the pump thread, and do not go back to polling** — even the `Sleep(4)`
   was a 4ms floor under every mouse event on the machine.
7. **It is PowerShell hosting a C# delegate, and must not become a native binary.** The hook
   callback is JIT'd machine code compiled by `Add-Type`; PowerShell is only the host and
   the message pump, so nothing interpreted runs inside the callback and there is no
   timeout to be dropped for. Keeping it here is what keeps the "no native dependency" rule
   intact, and keeps the process holding a system-wide mouse hook a Microsoft-signed one.
   **No backticks anywhere inside the script**: it is a TypeScript template literal, and one
   in a C# comment silently terminates it.
8. **The script is a file, not `-EncodedCommand`.** Base64 UTF-16 is ~2.7× the source and
   Windows refuses a command line past 32767 characters — the failure is a bare
   `ENAMETOOLONG` from `spawn`. It is written UTF-8 **with a BOM** (PowerShell 5.1 reads a
   BOM-less `.ps1` as ANSI) and carries no paths: the game folder and the upscaler's path
   arrive through the environment. It also calls `SetProcessDpiAwarenessContext` before
   reading any coordinate, or every mapping is out by the display's scale factor on exactly
   the machines that scale their display.
9. **It measures for itself, and the geometry is written twice.** Finding both windows
   happens inside that same process on a timer, because doing it from here would mean
   spawning a PowerShell on a poll several times a second. That is why the arithmetic exists
   in both `pointer-map-rules.ts` and the C#: **the harness only guards the TypeScript, so
   changing one means changing the other.** The output window is identified by its rectangle
   being exactly a monitor's — not by class name, which is an implementation detail of
   somebody else's program, and not by size, since the upscaler's own settings window
   belongs to the same process.
10. **It draws its own pointer, on a third thread, and that is not decoration.** The
    cursor visible on the stream is the one WGC composited into the captured frame — a
    photograph — and **WGC produces a frame when the source window changes**. A visual
    novel is a still page, so the pointer sits where it was and moves only when a click
    advances the text. Reported as *"during a drag I only see the pointer move at the
    moment I let go"*, which is exactly that: the release redrew the game, the redraw
    produced a frame, and the frame carried the pointer to where it had been all along.
    The hook was not behind — the state file measured `queue lag ms` 0, worst 16 — and
    chasing latency in the mapper would have found nothing, twice. The same fact explains
    the two-second delay reported alongside it: a desktop that stops changing puts a
    streaming client into a low idle frame rate it takes a moment to come out of, so the
    lag is on the *reply*, not on the touch. A ring that keeps moving keeps the client
    sending. Five constraints hold it up: it owns **its own thread**, because
    `SetWindowPos` waits on the thread that owns the window and neither the pump (see
    Geom) nor the worker (which blocks inside `Refresh()`) may be that thread; **nothing
    is added to the callback**, which reads nothing and writes only `_markerOn`, so this
    cannot bring the lag back; it **moves only when the position changed**, or a parked
    ring would keep the whole desktop awake for nothing; it is **click-through and never
    activated**, or it would eat the taps it exists to aim; and it is **not excluded from
    capture** — the streaming client has to see it, and Lossless Scaling will not, because
    it captures the game's window and this is a separate top-level one.
11. **Where the picture lands is read from the file, never from what a preset says.**
    `activeScalingFit` looks up *our* profile in `Settings.xml` for the same reason
    `activeHdrSupport` does, and the preset's own fields are only the fallback for a
    profile that is not in the file at all. Answering from the preset is the bug that
    function was written to avoid, one door down: switch a game from `Sakura:Integer` to
    `Sakura:Quality` while Lossless Scaling is open, the write is refused (`pendingWrite`),
    the live profile is still whole-multiple — and the mapper is told the picture fills the
    screen. It reads `ScalingMode` as well, because **`Custom` names its own multiple** in
    `ScaleFactor` and owes the screen nothing: 2.1× of an 800×600 game is 1680×1260 at
    (440,90) where the proportional fit would give 1920×1440 at (320,0). A mode naming one
    of the user's own profiles is cloned verbatim, so a fixed factor is ordinary. A `fixed`
    with no readable factor falls back to the proportional fit rather than inventing one.
12. **A press `SendInput` refused is destroyed, not misplaced, and has to be said out loud.**
    UIPI blocks it when the foreground window belongs to a higher-integrity process — a
    game started as administrator from a launcher that was not — and by then the original
    event has already been swallowed. The event is still not passed on, because an unmapped
    click on whatever is under the finger is the harm this feature exists to prevent; it is
    counted as `blocked` instead, reported on stdout, and shown in the settings page. The
    version that ignored the return value had every counter saying "mapped" while every
    click vanished.
13. **`Round()` in the C# is `floor(v + 0.5)`, not `Math.Round`.** C# rounds a tie to the
    even number and JavaScript rounds it up, so the two copies of the geometry disagree
    whenever the remainder is odd — 1288×724 on 2560×1440 fits to 1439 high and the
    picture lands a pixel apart. One pixel is harmless; two specifications that quietly
    differ are not, because the harness only guards one of them.

**It is not touch support and must not be described as one.** Genuine touch is `WM_POINTER`,
invisible to a mouse hook; redirecting it needs `RegisterPointerInputTarget`, which requires
UIAccess — a manifest flag, an Authenticode signature and a secure directory. Magpie solves
this by shipping `TouchHelper.exe` (`uiAccess="true"`, signed `CN=Magpie` with an untrusted
root) and installing its certificate as administrator. That is not a thing this program gets
to do to somebody's certificate store, and it is already solved in the Magpie that ships
here — a client sending real touch wants that backend, not a second implementation.

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

### Touch

The interface is driven by a finger whenever the user connects from a tablet. Five things
hold this up and each is load-bearing:

1. **`(pointer: coarse)` is not enough, and `Settings.touchMode` exists because of it.**
   The case this was built for is a remote-desktop client injecting **mouse** events:
   Windows has a real cursor, Chromium reports `pointerType: 'mouse'`, `:hover` fires, and
   every automatic check confidently says "mouse" while the hand at the far end is on a
   tablet. `auto` consults the media query, `on`/`off` override it, and `App.tsx` publishes
   the answer as `data-touch` on the root — the same mechanism themes use — plus a `touch`
   prop for the handful of components that must *think* differently rather than merely
   measure differently.
2. **Unreachable is fixed for everyone; only size sits behind the mode.** A submenu that
   opened on hover alone, a folder that opened on a double-click alone, a window button
   whose glyph was invisible until hovered — none of those were better for a mouse, so
   none of them are mode-gated. Hit-target size genuinely trades against shelf density, so
   that is the one thing the mode governs.
3. **A submenu row opens on click, not only on hover** (`ContextMenu.tsx`). Its `onClick`
   used to `return` early when `hasSub`, which with no `mouseenter` left **star rating,
   upscale mode and move-to-group with no route in the program at all** — rating has no
   other control anywhere. It opens rather than toggles: a mouse has already opened it by
   hovering to get there, and a toggle would close it under the click meant to commit.
4. **Long-press belongs to the menu, and dragging needs a mode.** These compete for one
   gesture and the menu is worth far more — it is the only way to extract, rate, rename,
   tag, share, back up or uninstall. `HOLD_SLOP_PX` (12) is deliberately far above
   `DRAG_THRESHOLD_PX` (6), because six pixels is less than a finger holding still actually
   moves, and that is exactly why the drag used to win the race and the menu never opened.
   Dragging then cannot also be a plain press-and-move: **`touch-action` is read when a
   gesture begins and never again**, so no amount of holding can take the pan back once the
   browser has claimed it, and setting `touch-action: none` on tiles permanently would make
   a shelf of tiles unscrollable. Hence `.grid.rearranging`. Do not try to replace the mode
   with a cleverer heuristic; the platform does not offer the hook it would need.
   `TierPage` is the exception and shows the rule: its icons are 96px in rows with label,
   background and margin left to scroll from, so `touch-action: none` is safe there and it
   needs no mode.
5. **`pointercancel` aborts, it does not commit.** It means the gesture was taken away, and
   committing a drop nobody released is certainly wrong. It also used to be the only thing
   a finger could do, since aborting was bound to Escape.

`TierPage` was rewritten off HTML5 drag-and-drop for this — no engine fires it for touch,
and its icons carry no click and no keyboard activation, so **ranking a game was reachable
by mouse alone**. It now uses Pointer Events with the same `dragProxy` as the shelf, plus a
tier menu on long-press, which is the route that works however the drag goes.

Renderer behaviour has no harness. It is checked by driving synthetic `pointerType: 'touch'`
events through `SAKURA_CAPTURE_SCRIPT` against a seeded `--user-data-dir` — see
**Screenshotting the UI** above. Whatever is asserted there, assert the mouse path too: the
whole design rests on it being untouched.

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
- **The update check runs from one button and from nowhere else.** It is the second thing
  in this program that opens a socket, and unlike the catalogue it has no switch — because a
  switch would imply there is something to switch *off*, and there is no timer, no startup
  call and no background pass to disable. `update.ts` is reached from two IPC handlers and
  from nothing else; keep it that way, or the line on the front page of both READMEs stops
  being true. Three things hold the rest up:
  - **A false "up to date" is the worst outcome available**, worse than an error and worse
    than a false alarm: an error sends somebody to look and a false alarm costs a click, but
    "you are current" ends the conversation. So the paths that could quietly answer "nothing
    newer" are closed by construction rather than by care — `readReleases` has **no
    `releases` field on its failure arm**, so `Array.isArray(x) ? x : []` cannot be written
    by accident (GitHub answers a rate limit with `{"message": …}` and a captive portal with
    HTML, and both would come back from that line as an empty list); `compareVersions`
    answers **null, never 0**, when it cannot read a side; and `unreadableTags` rides on
    **every** answered verdict rather than only on the one where nothing could be read,
    because the release that would have contradicted "up to date" is exactly the one that
    got dropped.
  - **An asset is matched by suffix, never by the name the build wrote.**
    `electron-builder.yml` produces `Sakura Launcher-<version>-portable.exe` with a space,
    and GitHub stores it back as `Sakura.Launcher-…` — the uploader sends the raw name in a
    query string and the space is normalised on the way in. Anchoring on the product name
    matches nothing that is actually on a release, and fails silently: an update is reported
    and no file is offered. Verified against the real v0.10.0 assets. The suffix is still
    structural rather than a blacklist, so `.blockmap`, `latest.yml` and every future sidecar
    file fail it for free.
  - **The renderer names a `kind`, never an address.** The URL comes out of the verdict the
    main process worked out itself, and the destination folder is chosen there too — the same
    rule that keeps a cover candidate's path out of the renderer. The file is written to
    `<name>.part` and renamed only once the whole thing has arrived at the declared size:
    a truncated installer left under its real name is a program somebody would double-click.
- **A walkthrough is searched for from one button, and the two providers are not alike.**
  `guides.ts` is reached from one IPC handler and nothing else, the same shape as the
  update check. What differs is the two sites, and the difference is the design:
  - **誠也の部屋 publishes one static index**, four thousand entries on a single page, so it
    is fetched whole, cached under `cache/guides/`, and searched **locally**. That is what
    keeps it from learning which game was opened, keeps answers coming while the site is
    down, and makes searching often free. The page is **cp932**, not UTF-8 — decoded as
    UTF-8 every title is mojibake and every search quietly finds nothing. A failed fetch
    **keeps the copy on disk**, the same policy `display-info.ts` holds for a failed
    display query.
  - **2DFan answers a query**, so the title leaves the machine, and what comes back is an
    HTML fragment inside a JSON envelope — somebody else's markup, which will change. So
    `read2dfan` reports a shape it cannot read as a **failure, never an empty list**: the
    fragile provider going quiet must not look like a fact about the game. Same rule as
    `readReleases` in `update-rules.ts`, and for the same reason.
  - **Matching is containment, and a short query must be a prefix.** Not coverage — that
    was tried, measured well against full titles, and was wrong the first time a real
    search ran: a four-character series name found nothing on the site that indexes it.
    Position separates the two cases that proportion cannot, because a series name begins
    the title it belongs to (`ネコぱら` in `ネコぱらAfter…`) and a fragment lands in the middle
    (`air` in `pairing`). The floor lives inside `guideScore` rather than in one caller,
    because 2DFan's ranking runs through the same scorer and would otherwise have no floor
    at all.
  - **`guideKey` is deliberately not `titleKey`.** `tag-rules.ts` decides which catalogue
    row *is* this game, so widening it changes what gets tagged in every library; this one
    only decides which walkthrough to offer. The folds it adds were measured as flat-zero
    gaps against this corpus: fullwidth digits, fullwidth latin, halfwidth katakana, and
    unbracketed Japanese edition words.
- **A missing DLL is not missing until WinSxS has been looked in.** The VC80 and VC90 C
  runtimes are Fusion assemblies: bound through the executable's `RT_MANIFEST`, resolved by
  the activation context, and **absent from `System32` and `SysWOW64`**. Measured on a stock
  Windows 11, `msvcr80.dll`, `msvcp80.dll`, `msvcr90.dll` and `msvcp90.dll` are in neither,
  while `WinSxS\x86_microsoft.vc80.crt_1fc8b3b9a1e18e3b_...` holds all of them. A search that
  walks the loader's *directory* order therefore reported every Visual Studio 2005 or 2008
  build as missing its runtime — as a `blocker`, sorted to the top, one right-click away on
  any tile — which is most of a library of 2005-2012 Japanese visual novels, every one of
  them starting perfectly. `dllAvailable` in `diagnose.ts` consults the store and the
  app-local `Microsoft.VC90.CRT` folder before anything is called missing. Keep it narrow:
  the MFC and ATL rows exist so a machine that carries those assemblies is read correctly,
  and on one that does not the finding is right, because then the redistributable really is
  what is missing. **The architecture is not decoration** — an x86 game is not satisfied by
  the `amd64_` assembly, and widening the match trades a false positive for a false
  negative, which is the worse of the two because it is the one that stays quiet.
- **A repair is offered, never taken.** `repair-rules.ts` decides what may be done about a
  diagnosis and `repair.ts` does it. There is no timer, no startup pass and no "while we
  are here": every one happens because somebody read what it would change and pressed a
  button, which is the only footing this program has for editing a machine it does not own.
  Four rules:
  - **Every action records its undo before it acts, not after.** The previous registry
    value has to be read before it is overwritten and the file list built while the
    attribute is still set. A journal written afterwards records intent, and the difference
    shows up exactly when the undo is needed. The journal lives in `db.json` and **not in
    the sidecar** — a shim and a file attribute describe this machine, the same reason
    group membership and tile order stay out.
  - **A `guide` is not a lesser outcome, and there are more of them than actions on
    purpose.** Anything needing elevation, or that would move somebody's folder, or that
    belongs to another program, is worth more as an exact command than as a button that
    half works. `install-fonts` carries `Language.Fonts.Jpan~~~und-JPAN~0.0.1.0` — `Jpan`
    with a script code, not `Ja-JP`; the wrong one fails with a message about an unknown
    capability, which reads as a broken machine rather than a typo.
  - **The locale offer needs an observed silent failure, not just a finding.**
    `needs-locale` is two signals out of three, and the two that carry it — a JP-era engine,
    kana in the folder name — are both true of a Chinese fan translation that works
    perfectly, which is a large part of this library. 诊断 sits on every tile's context menu
    with no failure required, so gating on the finding alone put the offer under working
    games and recommended the one change that breaks them. `RepairFacts.trouble` is carried
    from the launch watcher through `repairOffers`, and only `earlyexit` and `noshow` unlock
    it: `dialog` means the game started and is saying something, which is worth more than
    any inference here, and a locale gate leaves no box at all.
  - **The locale offer is a guide, and nothing in this layer may rewrite `game.exe`.** It
    was a button first, rewriting `game.exe` to the emulator with the game as an argument,
    and that is one change with four consequences — because `game.exe` is not "what gets
    spawned", it is the identity everything else hangs on. `sidecar-sync.ts:111` writes it
    into the travelling `sakura-launcher.md` as a path relative to the game folder **with
    no `isUnder` guard** (the cover lines beside it have one), so an emulator outside that
    folder put `..\..\Program Files\…` — or a bare absolute path from another drive — into
    a file whose whole point is surviving a move to another machine. Where `exePinned` is
    not set, which is the common case, the next rescan reverts it silently while the
    journal still lists the repair and the dialog still offers to undo it. `repairFacts`
    keys the compatibility layer on `game.exe`, so a `RUNASADMIN` pressed afterwards lands
    on `LEProc.exe` and every program launched through Locale Emulator starts demanding
    UAC. And it is not idempotent: twice, and the emulator is aimed at itself. Doing this
    properly needs a launch chain the launcher honours without touching `game.exe` —
    scanner, sidecar and fix-pack hashing all move — so until then the offer hands over the
    exact command and says why it is not pressing it for you.
    **Both command lines were also wrong, and each is now pinned to upstream source rather
    than to the switch that reads like what we want.** `LEProc.exe -run <path>` is
    `RunWithIndependentProfile`: finding no `<path>.le.config` it **launches LEGUI.exe** to
    have one authored, so the button opened a settings window. The bare path is
    `RunWithDefaultProfile` — app profile, else first global, else a built-in ja-JP default
    — which is what is wanted and writes nothing. `LRProc.cpp` opens with
    `if (__argc < 3)` and a usage box: the form is `LRProc.exe GUID Path Args`, the GUID is
    positional and first, and there is no default to invent, so `localeCommand` returns
    **null** for it rather than sending a path alone. `LOCALE_TOOL_ORDER` puts `lr` first,
    so that was the branch most machines took.
    The other two rules still hold. A folder of Japanese names on a Chinese machine may
    want an emulator *or* may be a Chinese fan translation that a Japanese codepage would
    actively break — the patch wants the machine's own 936 — so the warning is in the
    offer's own text, not a footnote. And **Locale Emulator is 32-bit only**: pointing it
    at a 64-bit game is a silent no-op, so `localeToolFits` filters on the architecture the
    PE already gave us and an unknown architecture fits nothing.
  - **A populated VirtualStore silences every writability offer, and this one nearly
    shipped wrong.** A 32-bit game under `Program Files` whose manifest predates Vista gets
    UAC **file virtualisation**: Windows redirects its writes to
    `%LOCALAPPDATA%\VirtualStore\Program Files\…` and the game reads them straight back, so
    it has been saving happily for years. This program is Vista-aware, so virtualisation is
    *off for us*, the write probe fails, and every conclusion from there is wrong in the
    same direction. `RUNASADMIN` is the worst of them: **an elevated process is not
    virtualised either**, so the game would start writing the real `Program Files` path —
    which an administrator can write — and its entire save history would disappear from the
    load screen at once, immediately after the user pressed a button labelled "repair".
    A VirtualStore tree **with files in it** is therefore proof that writing works, and it
    replaces the offer with a note saying where the saves actually are. Emptiness is the
    whole question: the directory can exist from one failed write years ago and mean nothing.
  - **Only `RUNASADMIN` is ever written**, and only against a finding this program can
    actually establish. Every other layer token is a matter of taste, and a launcher
    applying `WIN7RTM` on a hunch is making a decision it cannot support. Note the two
    formatting traps, both of which fail silently: the value begins `~` **and a space**,
    and tokens are **space-separated** — run two together and the whole value does nothing.
    Real values in the wild are sometimes written without the leading `~`, so `layerTokens`
    reads both.
- **A per-build byte fix writes to memory and never to disk.** `binfix-rules.ts` decides
  whether a pack may run and `binfix.ts` runs it, through PowerShell hosting a C# stub —
  same reason as `pointer-map.ts`: no native dependency, and the process doing the writing
  stays a Microsoft-signed one. It exists because the diagnosis has a floor it cannot reach
  under: an engine that gates `WinMain` on `PRIMARYLANGID(GetSystemDefaultLangID()) == 0x11`
  and returns zero otherwise gives no window, no message, no log and exit code 0, and no
  amount of reasoning about redistributables gets there. Six things hold it up:
  - **Nothing on disk is written**, which is what makes undo mean "launch it again without
    this". It is also the only form that works on the packed executables this is for —
    Themida and its relatives decrypt at runtime, so on disk there is nothing to patch.
  - **Never an address, always a signature**, and a patch may only overwrite bytes the
    signature itself matched (`offset + fix.length <= sig.length`, refused at read time).
    There is no reachable way to write a byte that was not verified first.
  - **How many places matched is the safety check, not how long the signature is.** A floor
    of sixteen bytes was tried first and refused the real patches — `3D 40 EF 00 00 73` is
    six bytes and is an entire fix — which bought no safety and cost the feature. A pack
    declares `maxHits`; more matches than that and **nothing is written**, reported as
    `ambiguous` rather than folded into `notFound`, because "the pattern is absent" and
    "the pattern is not specific enough" call for different repairs.
  - **The patcher starts the game; it is never handed a running one.** This is the whole
    ordering and it was arrived at the hard way. Attaching by pid was written first and lost
    the race every single time: a gate decided inside `WinMain` is over in under a second,
    and a cold PowerShell that must compile an interop stub takes several, so the honest
    report was `exited` — true, useless, and exactly the failure being fixed. Compile first,
    start second. Related, and also measured: the game is started with
    **`UseShellExecute = $true`**, because with it false the game inherits the script's
    stdout handle and the launcher's pipe stays open for as long as the *game* runs — the
    patch lands, the report never arrives, and a run whose seven patches all applied in
    under three seconds was reported as a ninety-second timeout. For the same reason the
    launcher listens for `exit`, not `close`.
  - **A required patch that misses aborts the whole pack.** A half-patched engine is a state
    nobody has tested, and the only thing worse than a game that will not start is one that
    starts and then behaves in a way no report explains.
  - **No debugger, ever.** These executables are packed and the packers answer a debugger by
    breaking in ways that look like an unrelated crash. Suspend, read, write, resume is the
    entire repertoire.
  Packs live in `%APPDATA%\sakura-launcher\fixes\*.json` and are deliberately **not** in this
  repository: a fix is a fact about one build of one commercial game, which is somebody's
  library rather than this program's business to carry a list of, and a pack in the data
  directory can be written, corrected and thrown away without a release.
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
