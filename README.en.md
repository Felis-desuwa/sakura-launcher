# 🌸 Sakura Launcher

[简体中文](README.md) · **English**

A library manager for offline single-player games that live on your own disk. It turns the
game folders scattered across your drives into one cherry-blossom-coloured desktop:
double-click to play, single-click to see what is taking up the space, right-click to manage —
and when a game refuses to start, it tells you why.

It is built for **libraries with no metadata to scrape** — folder names unrelated to
executable names, a dozen exes in one folder, no store IDs and no naming convention. So
nearly every judgement here comes from the files themselves: which exe is the game, which
engine it runs on, why it will not start, whether it needs a locale emulator. All of that is
read, not looked up.

There is exactly one thing that cannot be read off the disk — what the game is *about*. That
has to come from a catalogue, and that step is off by default.

## Before you download

- **I built this with Claude, and I don't write code myself.** A lot of the features are
  whatever I thought of on the spur of the moment, so the logic has rough edges — please bear
  with them. Issues are welcome; I'll go ask Claude about them.
- **It is aimed at people with big disks and a lot of games.** A scan walks the entire
  directory tree of every game folder to total its size, and parses the icon out of every
  executable it considers; while a game is running it checks the process list every 15
  seconds to measure playtime. The bigger the library the more this pays off — **on a
  low-spec machine, use your judgement.**
- **It craps in the game folders you add to it.** Every game folder gains a
  `sakura-launcher.md` holding its rating, playtime, tags and chosen executable — which is how
  the library survives a new disk or a reinstall of Windows. But it does write into your game
  directories, so **if that bothers you, don't use it.** (Nothing else writes there, and only
  the uninstaller ever deletes anything.)
- **The documentation, this page included, was also written by Claude.** I'll rewrite it when
  I'm in the mood.

## Download

Grab the latest build from [Releases](https://github.com/Felis-desuwa/sakura-launcher/releases).
Windows 10 / 11:

| | |
|---|---|
| **Installer** `…-setup.exe` | Per-user install, no administrator rights, pick your own directory. **Uninstalling does not delete `%APPDATA%\sakura-launcher\`** — ratings, playtime and tile arrangement all survive, so reinstalling restores everything |
| **Portable** `…-portable.exe` | A single exe, double-click and go |

There is no code-signing certificate, so Windows SmartScreen will stop you once: *More info →
Run anyway*.

## At a glance

- Scans folders and picks the main executable itself; when a dozen exes make that impossible,
  right-click to change it — every candidate says what it was judged on
- When a game won't start, it reads the PE import table and names the missing runtime;
  a Japanese error box that arrived as mojibake is restored to its original text
- Genre tags (school life / tear-jerker / NTR…) come from catalogues. **Off by default**, and
  even when on, all that leaves the machine is a title
- Playtime is measured by *whether any process is running inside the game folder*, which
  survives the very common launcher-exits-immediately case
- Backing saves up looks in `%APPDATA%`, `LocalLow` and the root of C: as well — saves are
  very often nowhere near the game — and recognises a completed save that came with the download
- Packing a game up to share lists your personal traces for review first, and **leaves the
  source folder untouched**
- Uninstalling takes three steps: confirm → copy out a flower's name by hand → hold for 2.5 s

---

## Features

### Scanning and identification

- **Automatic scanning** — point it at a few folders and it finds the games inside and picks
  their main executable. It copes with uneven nesting depth, folder names with no relation to
  the executable name, and leftover installers mixed in with the games
- **Finding the real launcher** — a dozen exes in one folder and no way to tell which is the
  game. Right-click → *Change main program…* sorts them into Recommended / Locale emulator /
  Tools · patches · uninstallers / Subdirectory, and spells out **what each verdict was based
  on** (filename traits, size, version info). Still unsure? **Test-run it** — the launcher
  watches whether a process actually comes up inside the game folder, which turns "I clicked
  and nothing happened" into a question with an answer
- **Engine detection** — KiriKiri / BGI / Siglus / Majiro / NScripter / Artemis / Ren'Py /
  RPG Maker / Wolf / Unity / Unreal / TyranoScript / NW.js. The engine determines where the
  crash log is written and whether a locale emulator is needed, so most of the diagnosis's
  accuracy comes from here
- **Real icons** — the executable's PE resources are parsed directly and the largest embedded
  icon is taken (usually 256×256), so even large tiles stay sharp. Games that only ship a
  small icon get a generated placeholder tile instead of a 48px image stretched into mush

### When it won't start

- **It reads the engine's own error message** — when a game fails to start the engine usually
  puts up a message box explaining why, and that sentence is usually unreadable: Japanese
  engines write Shift-JIS, which on a Chinese system shows up as mojibake like
  `巜掕偝傟偨僼傽僀儖`. The diagnosis reads the text straight out of the window and undoes the
  encoding damage, then shows you both. It is the one finding in the whole diagnosis that
  infers nothing — everything else is deduction, this is the engine speaking for itself
- **Launch diagnosis** — ten-odd seconds after a double-click with no process to show for it
  is no longer met with silence. It reads the main executable's PE import table, resolves each
  entry in Windows' own search order, and names the missing runtime outright (which year's
  VC++, the DirectX end-user runtimes, the Media Feature Pack that N editions of Windows
  lack); reads the embedded manifest to see whether administrator rights are required, and
  offers to relaunch elevated; says so when the selected exe is really an uninstaller or a
  config tool; judges from the engine and filename whether a locale emulator is called for;
  and when a process did come up and vanish, finds the log the game just wrote and quotes the
  tail of it. When it finds nothing wrong it lists **what it checked** rather than saying
  "everything looks fine". All local, no network, and it never writes to the game folder
- **Launch through another program** — Japanese games often need a locale emulator to display
  correctly. You can set it up as "run `game.exe` through `NTLEA.exe`", and that is what a
  double-click on the tile does from then on

### Genre tags (the only online feature, off by default)

Tags like school life, tear-jerker and NTR **are not in the game files** — they are judgements
about a story, and only a catalogue has them.

- **How it finds the game** — a folder name containing an RJ number goes to DLsite for an
  exact match; one work number means exactly one work, so that is taken as-is. Everything else
  is searched on VNDB by title. **Chinese titles work too** — VNDB stores each work's title in
  every language it has, and `示例游戏` is one of those records. When nothing is found,
  it **asks Bangumi what the game's original Japanese name is** and searches VNDB again with
  that name — a name looked up in a catalogue's records, **never guessed and never machine
  translated**. When several results look alike they are listed for you to choose from,
  because a sequel and a fan disc under nearly the same name are far too easy to confuse
- **Messy names still match** — folder names are rarely clean titles. Translation-group names
  and release markers are stripped from square, round and full-width brackets, and from
  outside the brackets too; version numbers glued onto the title (shaped like
  `样例游戏2v1.1.0` and `另一个游戏7.6.9` — the shapes are taken from real folder names,
  the titles are placeholders), underscores, language suffixes and
  `.7z` / `.part1.rar` are handled as well, **while digits belonging to the title are kept**
  (`A.B.C.5` never gets shaved down to `A.B.C.`). If the cleaned name still finds nothing, it
  falls back to searching only the opening fragment — these catalogues match on substrings, so
  one extra word returns nothing while a few characters fewer finds the game
- **Search it yourself when nothing matches** — nobody is going to guess a folder called
  `123456`. Every game in the confirmation dialog gets its own search box: a Japanese,
  Chinese or English title all work, and so does typing `v1234`, `RJ01234567` or a URL
  directly. Right-click any game → *Match manually…* opens it whenever you want
- **How tags are displayed** — DLsite's genres follow the interface language. VNDB's tags are
  English; the couple of hundred common ones have a Chinese reading in a table kept here, and
  anything not in the table is shown exactly as VNDB wrote it rather than guessed at. Every
  tag records **why it was applied**, visible on hover; strike out a wrong one with a click,
  and restore it whenever you like
- **Filtering by tag** — the tag bar sits under the top bar, with counts, and clicking filters.
  Several genres combine as AND — each extra chip narrows further — but **only one year can be
  selected at a time**, since a work is not both 2016 and 2017 and holding two could only ever
  give you an empty shelf
- **Cover art comes off the same record** — a catalogue keeps the cover and the tags on one
  work entry, so matching once gets both. **Manual only**: right-click a game for *Fetch cover
  online*, or **select several and fetch them together** (tags work the same way).
  **A cover you set yourself is never overwritten** — a batch skips it and says how many it
  skipped; only picking one game out of its own menu replaces its cover, because that is
  unambiguous about which game is meant. Image downloads have their own switch, so you can
  keep the tags without them
- **The description rides along with the cover** — fetching a cover also brings back the
  catalogue's description and puts it at the **bottom of the details panel**, saying who wrote
  it. **There is no separate "fetch description" button**: the picture and the text hang off
  the same work entry, and asking for them separately would be two trips for one answer — so
  whether it happens is decided once, in the settings. **Chinese only for now**: a Japanese
  blurb is skipped rather than translated, because this program does not put words in a
  catalogue's mouth. A work reached by its number uses DLsite's own copy, which needs no
  matching and so cannot be matched wrongly; everything else asks Bangumi once and **takes
  only the row whose name is the work's**. No match, no description — a wrong one is worse
  than none, because it reads exactly like the truth
- **Only the title ever leaves** — with the feature on, fetching tags sends exactly two kinds
  of thing: **the work number in the folder name**, or **the game's title**. The recipients are
  DLsite, VNDB and Bangumi. Paths, sizes, playtime, ratings, how big your library is — none of
  it is sent, and nothing identifies you or this machine. **Fetching a cover is one step
  further**: it asks an image host (`t.vndb.org`, `img.dlsite.jp`) for the picture file itself,
  which is exactly why that has a switch of its own. With the feature off not one byte
  goes out, and **the whole process never touches the game folder; it only reads the folder's
  name**
- **What you'd rather not see is hidden by default** — tags VNDB marks as spoilers are
  **hidden by default**, because nobody wants a story spoiled by their own shelf, and **R18
  tags are hidden by default** as well, with a switch in the settings. The tags are fetched and
  stored either way; the switch only decides what is drawn, so flipping it takes effect
  instantly with no catalogue round trip. **Adult covers are blurred under the same switch**,
  with a small R18 badge in the corner so a blurred tile does not read as a broken image.
  Which covers count is the catalogue's own word: VNDB rates each picture, DLsite rates the
  work
- Only games that have never been looked up are queried, and none are asked about twice. You
  can stop at any point, or re-query the whole library

### Keeping track

- **Playtime** — it does not watch the process it started (a great many games have a launcher
  that exits as soon as the real program is up, which would record every session as two
  seconds). It watches **whether any process is still running inside the game folder** instead,
  which survives self-restarts, opening the config tool mid-session, and multi-process engines.
  The price is one blind spot: a game frozen on an error box is also "a process in the folder".
  So after launch it takes a look at what is actually on screen — an error dialog is not billed
  as play, and it tells you what the dialog said
- **Four lists** — All / Wishlist / Playing / Played. *Playing* and *Played* can hold at once
  (a second playthrough after finishing), but *Wishlist* means not started and is exclusive
  with both. The wishlist is for planning only; you cannot launch from it
- **Rating and tier are two separate things** — the star rating is in the right-click menu and
  works on any page; the tier ranking has its own page with drag-and-drop, because a tier only
  means anything relative to the other games. Neither affects the other, and the tile shows the
  stars
- **Groups** — right-click empty space to create a group, then drag tiles in and out. Dropping
  on a tile's **left or right edge** shows an insertion line and places it between two tiles;
  only dropping on a tile's **centre** merges the two into a group. Group tiles are drawn as
  folders and **open on double-click**. Groups only affect the arrangement inside the launcher
  and **never move a single file on disk**
- **Sorting** — manual / name / size / installed·modified time / last played / playtime,
  switchable from the top bar. Under manual sorting, drag tiles wherever you want them
- **Renaming touches no files** — right-click to rename, and the new name is written into the
  `sakura-launcher.md` inside the game folder. **The folder itself is never renamed**, because
  many of these games locate their assets by path and a renamed folder stops opening. That file
  is commented Markdown: edit it directly to change the name, delete it to fall back to the
  folder name
- **The sidecar travels with the folder** — rating, playtime, tags and the chosen main
  executable are all written to `sakura-launcher.md` inside the game folder, with relative
  paths. Change disks or reinstall Windows and the library comes along with the folders. A file
  you edited by hand is read back when you press *Refresh* in the top bar (modification times
  are compared and the newer side wins); the automatic sync at startup deliberately does not do
  this, as it would cost one disk round trip per game
- **Refresh ≠ rescan** — *Refresh* in the top bar only syncs entries that already exist (name,
  size, sidecar, whether the folder is still there) and never adds anything on its own. When
  you have put new games into a folder, go to Settings and press *Rescan and add* on that
  directory: it lists what could be added and lets you tick, exactly like adding a folder
- **Removing a tile** — right-click → *Remove from library* takes non-game content that was
  scanned in by mistake back out, and **deletes nothing**. The path is remembered so a rescan
  will not add it back. Settings can restore one or all of them — and a restored entry brings
  its cover, rating, playtime and tags back with it

### Space, and sending things around

- **Size breakdown** — click a tile to slide out its details. The donut has two modes: this
  game's share of the whole library, and what the space inside the game folder is spent on,
  which can be drilled into level by level
- **Disk page** — capacity per drive, the ten largest games, and a *redundant archives* list:
  archives with a confirmed extracted copy elsewhere, tickable for a bulk move to the Recycle
  Bin
- **Downloads** — hand a link to IDM / aria2c / the system default / your own command line;
  a finished archive lands in *Pending install* automatically
- **Pending install** — archive entries in the library. Right-click → *Extract* installs it;
  a double-click reminds you it is not installed yet
- **Save backups** — right-click → *Back up saves…* copies the saves to a folder you choose
  (Documents\Sakura Launcher Saves by default); select several games to do them in one go. Each
  run writes a new timestamped folder and **never overwrites the last one**.
  **It only copies — not one byte of the game folder is written to.**
  Saves are frequently **not in the game folder**: Ren'Py keeps the authoritative copy in
  `%APPDATA%\RenPy`, Unity uses `LocalLow`, RPG Maker MV and anything else on NW.js hides a
  leveldb under `%LOCALAPPDATA%`, and some games write to the root of C:. So the search covers
  those places, looking for a folder named after the game.
  What it finds is split in two: **inside the game, or exactly where this engine writes** —
  ticked; and **merely named like the game, somewhere the engine has no business writing** —
  listed with the reason and **left unticked**, because names collide and only you can judge it.
  Anything the search missed can be pointed at by hand, and is remembered afterwards.
  There is one more trap: these downloads **routinely ship with a completed save**, identical
  to your own in name, extension and location. The only thing that separates them is time, so
  **anything untouched since before you added the game is flagged and left unticked** (entries
  that were in the library before August 2026 have no such baseline, and the dialog says so
  rather than guessing).
  **There is deliberately no restore button** — putting a save back overwrites the one you
  have, which is the only thing in this program that could lose data. Every backup carries a
  `sakura-backup.md` recording where each item came from; copying it back is yours to do
- **Sharing** — right-click → *Share…* packs a game up to send to someone. It first finds your
  personal traces (saves, logs, screenshots, and the launcher's own sidecar recording your
  playtime and rating) and **lists them for you to look over before deciding what to exclude**.
  7z or zip, optional password (7z can encrypt the filenames too), and your own output
  location. Selecting several games produces one archive each, done in sequence.
  **The source folder is left untouched** — personal data is left out of the archive, not
  deleted from disk, and not a byte of your saves is lost. Rules are bounded by name *and*
  location: `*.dat` inside a save directory is a save file, but in the game root it is the
  entire game for the BGI engine, so a blanket rule would produce an archive that does not
  run. Location decides, and everything is shown to you first
- **The uninstall ritual** — three steps: confirm what → **copy out a flower's name by hand** →
  hold for 2.5 seconds. The second step draws a flower at random (eighteen of them, with Latin
  names and flower meanings) and asks you to type its English name — *what* to delete was
  settled in step one; this step exists only to slow your hands down. In the third step, hold
  the button and the tile cracks like a mirror, the shards sliding out of alignment as they
  fall, and the petals falling with them are the flower you just copied out. Let go early and it
  stops: the shards reassemble and nothing has happened. Order of execution: the game's own
  uninstaller → Geek Uninstaller → the Recycle Bin

### Appearance

- **Themes** — Sakura (default) / Night Sakura (dark) / Miku / Matcha / Sea Salt / Lavender.
  All driven by CSS custom properties, so switching themes recolours even the generated
  placeholder tiles and the falling petals
- **Chinese and English** — the interface, launch errors, diagnosis findings and the sidecar
  written into the game folder all follow the language you pick. The sidecar is parsed in both
  languages, so a file written before you switched does not stop working
- **No system title bar** — Windows' white caption strip ignores the theme; it stays white
  above a cherry-blossom window and above a midnight one. So the frame is gone and **the top
  bar is the title bar**: drag it to move the window, double-click to maximise, edge-snapping
  works as before, and the three dots at its right end are minimise / maximise / close, each
  showing its glyph on hover, close taking a colour of its own. The cost is the Windows 11
  snap-layouts flyout, which only the real caption buttons can raise
- **Splash window** — Electron takes a second or two to get from double-click to a drawn
  shelf, and Windows shows nothing at all during that time, so people click again. Now a small
  cherry-blossom window appears immediately and hands over once the shelf is really ready

## Where your data lives

All user data sits in `%APPDATA%\sakura-launcher\`:

```
db.json              games, groups, settings, removed paths
cache/icons/         icons extracted from executables
cache/breakdown/     cached directory size breakdowns
covers/              covers you set yourself
```

Save backups are deliberately not kept here — they go to Documents\Sakura Launcher Saves by
default, and Settings can move them. A backup that gets deleted along with this directory is
not a backup.

Delete that directory to return to a clean state. Nothing is ever written into the project
directory. Each game folder also holds a `sakura-launcher.md`, a portable, hand-editable copy
of the same data.

## Optional external programs

- **7-Zip** — extracts *Pending install* archive entries and does the packing when sharing.
  Without it those two features are unavailable; everything else is unaffected
- **Geek Uninstaller** — the second link in the uninstall chain. Without it, a game with no
  uninstaller of its own goes straight to the Recycle Bin. You can also point at it manually
  in Settings
- **IDM / aria2c** — optional back ends for downloads. With neither, links go to the system
  default program
- **DLsite / VNDB / Bangumi** — the sources for genre tags. **Off by default**, and none of
  them needs an account or a key. DLsite is queried by work number for an exact match and gives
  localised genres; VNDB is searched by title (Chinese titles included) and supplies the tags;
  Bangumi is used only to turn a Chinese name into the original Japanese one — its subject
  detail endpoints require a login for adult works, so no tags come from there. Each host is
  paced separately: VNDB every 2 seconds (which respects its published 200 requests per 5
  minutes), the other two every 1 second. A library of thirty-odd games measured at about 100
  seconds

## Running from source

```bash
npm install
npm run dev
```

Packaging (everything lands in `release/`):

```bash
npm run dist:all           # installer + portable, both at once
npm run dist:setup         # installer only
npm run dist:portable      # portable only
```

## Development

```bash
npm run typecheck
npm run build
```

What can be verified without starting the whole app:

```bash
npm run sidecar-test                              # sidecar read/write and the merge when both sides changed
npm run exe-pick-test                             # executable classification and ranking
npm run downloader-test                           # downloader detection and completion
npm run diagnose-test                             # launch diagnosis: runtime mapping, mojibake, engine detection;
                                                  # the PE parser is checked against real system binaries,
                                                  # no samples are committed to the repository
npm run tag-test                                  # genre tags: which titles count as a match, which catalogue
                                                  # tags to drop; and which descriptions to refuse — not Chinese,
                                                  # or not this game. No network; shapes pinned by real samples
npm run cover-test                                # covers: which picture is usable, which counts as adult, the
                                                  # error page posing as an image, the user's own cover left alone
npm run save-test                                 # locating saves: which folders belong to this game, which merely
                                                  # share a name, and the save that came with the download
npm run share-test                                # the share exclusion rules (mostly the ones that must NOT hit)
npm run share-e2e                                 # calls a real 7-Zip; asserts the source folder is unchanged
node scripts/scan-test.mts "<library folder>"     # prints the games, archives and group candidates found
node scripts/icon-test.mts --scan "<library folder>" # prints the icon sizes extracted per executable
npm run diagnose-probe -- "<one game folder>"     # prints everything the diagnosis can see, read-only
```

The last three take the folder as an argument — no path is ever hardcoded in this repository.

Interface changes can be verified by screenshot in an isolated profile, without touching your
own library:

```bash
SAKURA_CAPTURE=<out.png> SAKURA_CAPTURE_DELAY=2000 \
SAKURA_CAPTURE_SCRIPT="<JS evaluated in the renderer first>" \
npx electron . --user-data-dir=<temp dir>
```

## Stack

Electron + React + TypeScript, built with electron-vite.
Icons are parsed with [resedit](https://github.com/jet2jet/resedit-js) (pure JS, no native
build step); the import-table parser is hand-written, because resedit rejects some valid but
unusual layouts — which happen to be exactly the engine binaries a diagnosis exists to explain.
Directory walking and size totals run on a worker thread and do not block the interface.

## License

MIT
