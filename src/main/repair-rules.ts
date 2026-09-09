import path from 'node:path'
// Extensions spelled out: `scripts/repair-test.mts` loads this straight into node.
import type { MessageKey } from '../shared/i18n.ts'
import type {
  DiagnosisCode,
  LaunchTrouble,
  LocaleTool,
  LocaleToolFound,
  RepairOffer
} from '../shared/types.ts'
import { t } from './i18n.ts'

/** Each tool's name as it is written on screen. A derived key would not typecheck. */
export const LOCALE_TOOL_LABEL: Record<LocaleTool, MessageKey> = {
  le: 'repair.locale.name.le',
  lr: 'repair.locale.name.lr',
  ntleas: 'repair.locale.name.ntleas'
}

/**
 * Deciding what can be done about a launch failure, with no machine under it.
 *
 * The diagnosis next door works out *what is wrong*; this works out *what may be done
 * about it*, and the gap between those two is where most of the care goes. A finding can
 * be perfectly correct and still not justify touching anything — a game whose folder is
 * full of Japanese names on a Chinese machine may want a locale emulator, or may be a
 * Chinese fan translation that a Japanese locale would actively break.
 *
 * Two rules run through all of it:
 *
 * 1. **Nothing is offered as an action unless it can be put back**, or unless what it
 *    changes is genuinely not worth putting back and the offer says so out loud. An
 *    action whose undo is "reinstall Windows" is a guide, not a button.
 * 2. **A guide is not a consolation prize.** Most of the repairs in this domain need
 *    administrator rights, or would move somebody's folder, or belong to another program
 *    entirely. For those, an exact command is worth more than a button that half works,
 *    and there are more guides here than actions on purpose.
 */

/* -------------------------------------------------------------------------- */
/*  locale emulators                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where each emulator registers itself, and what it can drive.
 *
 * The two CLSIDs are the shell context-menu handlers their installers register, which is
 * the only reliable record either one leaves. `ntleas` leaves nothing at all and can be
 * found by path alone — which is why the pinned path below is a standing control rather
 * than an error fallback.
 *
 * **`fits` is load-bearing.** Locale Emulator drives 32-bit processes only, and pointing
 * it at a 64-bit game is a silent no-op: no error, no locale, and a user who concludes
 * that locale emulation "does not work for them". The architecture is already in hand
 * from the PE header the diagnosis parsed, so this costs nothing.
 */
export const LOCALE_TOOLS: Record<
  LocaleTool,
  { clsid: string | null; proc: string; marker: string; fits: ('x86' | 'x64')[] }
> = {
  le: {
    clsid: '{C52B9871-E5E9-41FD-B84D-C5ACADBEC7AE}',
    proc: 'LEProc.exe',
    marker: 'LEConfig.xml',
    fits: ['x86']
  },
  lr: {
    clsid: '{D5D46CFE-9467-3646-BAD1-3534DAA31492}',
    proc: 'LRProc.exe',
    marker: 'LRConfig.xml',
    fits: ['x86', 'x64']
  },
  ntleas: { clsid: null, proc: 'ntleas.exe', marker: 'ntleas.exe', fits: ['x86', 'x64'] }
}

export const LOCALE_TOOL_ORDER: readonly LocaleTool[] = ['lr', 'le', 'ntleas']

/** Japanese: codepage 932, LCID 0x411. Spelled out because both numbers appear as text. */
export const JP_CODEPAGE = 932
export const JP_LCID = 1041

/**
 * Whether a tool can drive a game of this architecture.
 *
 * An unknown architecture is treated as unfitting rather than as fitting. A wrong guess
 * here produces the exact silence this is meant to prevent.
 */
export function localeToolFits(tool: LocaleTool, arch: string | null): boolean {
  if (arch !== 'x86' && arch !== 'x64') return false
  return LOCALE_TOOLS[tool].fits.includes(arch)
}

/**
 * The command line that starts a game through an emulator, or null when there is not one.
 *
 * Every branch here was wrong on the first attempt, in a way that reported success and
 * started nothing, so each is now pinned to the upstream source rather than to the switch
 * name that reads most like what we want:
 *
 * - **`le` takes a bare path and must not be given `-run`.** In `LEProc/Program.cs`, `-run`
 *   is `RunWithIndependentProfile`: it looks for `<path>.le.config` beside the target and,
 *   finding none, **launches `LEGUI.exe`** to have one authored. The switch-less form is
 *   `RunWithDefaultProfile` — the app profile, else the first global profile, else a
 *   built-in ja-JP default — which is exactly what is wanted and writes nothing. The
 *   original code sent `-run`, so pressing the button opened a settings window.
 * - **`lr` cannot be driven at all without a profile GUID.** `LRProc.cpp` opens with
 *   `if (__argc < 3)` and a usage message box; the documented form is
 *   `LRProc.exe GUID Path Args`, GUID first and positional. There is no default and no
 *   switch that supplies one, so a caller holding no GUID has nothing to send. Returning
 *   null is the honest answer — the original code sent the path alone, which is `argc` 2,
 *   which is the usage box.
 * - **`ntleas` is fully specified and takes `Q`** — quiet — because without it a failure is
 *   a modal message box, which the launch watcher reads as a game that started and hung.
 */
export function localeCommand(
  tool: LocaleTool,
  toolExe: string,
  gameExe: string
): { exe: string; args: string[] } | null {
  switch (tool) {
    case 'le':
      return { exe: toolExe, args: [gameExe] }
    case 'lr':
      return null
    case 'ntleas':
      return {
        exe: toolExe,
        args: [gameExe, `C${JP_CODEPAGE}`, `L${JP_LCID}`, 'Q1']
      }
  }
}

/**
 * How a command line is shown to somebody who has to run it themselves.
 *
 * Quoted the way a shell needs it, because the paths in this library are full of spaces
 * and brackets and a line that cannot be pasted is not an instruction.
 */
export function localeCommandText(command: { exe: string; args: string[] }): string {
  const quote = (s: string): string => (/[\s&()[\]{}^=;!'+,`~]/.test(s) ? `"${s}"` : s)
  return [command.exe, ...command.args].map(quote).join(' ')
}

/**
 * Whether a path a user pinned is really the tool they said it was.
 *
 * The same rule the Lossless Scaling pin follows, and for the same reason: a bad pin
 * outranks every automatic search from then on, and leaves the feature aimed at nothing
 * while displaying a path as though it worked. Refused rather than stored.
 */
export function pinnedToolOk(tool: LocaleTool, file: unknown): boolean {
  if (typeof file !== 'string' || file.trim() === '') return false
  return path.basename(file).toLowerCase() === LOCALE_TOOLS[tool].proc.toLowerCase()
}

/* -------------------------------------------------------------------------- */
/*  compatibility layers                                                      */
/* -------------------------------------------------------------------------- */

/** Where a per-user compatibility shim lives. No elevation, and one value per executable. */
export const LAYERS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'

/**
 * The layers this program will write, and nothing else.
 *
 * Deliberately tiny. Every token Windows accepts is a change to how somebody's program
 * runs, most of them are matters of taste rather than of failure, and a launcher that
 * starts applying `WINXPSP3` on a hunch is making a decision it cannot support. Only
 * `RUNASADMIN` is here, because only it answers a finding this program can actually
 * establish: a game that cannot write beside itself.
 */
export const WRITABLE_LAYERS = new Set(['RUNASADMIN'])

/**
 * Build the value Windows reads.
 *
 * Two details, both of which fail silently when got wrong: the string conventionally
 * begins `~` followed by a space, and the tokens are **space-separated** — run two
 * together and the whole value quietly does nothing.
 */
export function layerValue(tokens: string[]): string {
  const seen: string[] = []
  for (const token of tokens) {
    const clean = token.trim().toUpperCase()
    if (clean === '' || clean === '~') continue
    if (!seen.includes(clean)) seen.push(clean)
  }
  return seen.length === 0 ? '' : `~ ${seen.join(' ')}`
}

/** Read a layer value back into its tokens, dropping the leading `~`. */
export function layerTokens(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\s+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '' && s !== '~')
}

/**
 * Add a token to whatever was already there, or `null` when it changes nothing.
 *
 * Returning null rather than an identical string is what lets the caller avoid writing at
 * all — and a repair that writes a value identical to the one already present, then
 * reports success, is a repair that will be blamed for the next thing that goes wrong.
 */
export function layerWith(previous: unknown, token: string): string | null {
  const tokens = layerTokens(previous)
  const wanted = token.trim().toUpperCase()
  if (tokens.includes(wanted)) return null
  return layerValue([...tokens, wanted])
}

/* -------------------------------------------------------------------------- */
/*  what to offer                                                             */
/* -------------------------------------------------------------------------- */

/** Everything the impure half measured, so the decision itself stays testable. */
export interface RepairFacts {
  /** Findings the diagnosis produced, by code. */
  codes: DiagnosisCode[]
  /**
   * Why the launch watcher spoke up, when this dialog was opened by a failure rather than
   * by curiosity.
   *
   * The locale offer needs this and nothing else would do. `needs-locale` fires on two
   * signals out of three — a JP-era engine plus kana in the folder name — and both of
   * those are true of a **working** Chinese fan translation, which is a large part of this
   * library. 诊断 sits on every tile's context menu, so without this the offer appears
   * under a game that has never failed at anything, recommending the one change that would
   * break it. An observed silent exit is the fact that separates "this looks Japanese" from
   * "this did not start".
   */
  trouble: LaunchTrouble | null
  /** The game's architecture, from the PE header. */
  arch: string | null
  /** The executable itself, so a command can be written out for somebody to run. */
  gameExe: string | null
  /** Executables in the game folder still carrying a mark of the web. */
  blocked: string[]
  /** Files carrying the read-only attribute, and how many were looked at. */
  readOnly: number
  fileCount: number
  /** Whether a throwaway file could be created in the game folder. */
  folderWritable: boolean
  /**
   * A UAC VirtualStore tree for this game folder that already has files in it.
   *
   * This is the single most dangerous false positive in the whole repair layer, and it is
   * not hypothetical. A 32-bit game under `Program Files` whose manifest predates Vista
   * gets **file virtualisation**: Windows silently redirects its writes to
   * `%LOCALAPPDATA%\\VirtualStore\\Program Files\\…`, and it has been saving there happily
   * for years. This program is Vista-aware, so virtualisation is *off for us* — the write
   * probe fails, and everything above would conclude the game cannot save.
   *
   * Every answer from there is wrong in the same direction. `RUNASADMIN` is the worst:
   * **an elevated process is not virtualised either**, so the game starts writing to the
   * real `Program Files` path, which an administrator can write — and the entire save
   * history disappears from its load screen at once. The user sees saves vanish
   * immediately after pressing a button labelled "repair", and their next move is likely
   * to be a reinstall.
   *
   * So a populated VirtualStore is proof that writing *works*, and it silences every
   * writability-driven offer rather than adjusting one.
   */
  virtualStore: string | null
  /** Emulators found on this machine. */
  localeTools: LocaleToolFound[]
  /** Japanese fonts Windows does not ship: absent means the optional feature is off. */
  missingFonts: string[]
  /** The compatibility layers already set for this executable, if any. */
  layers: string[]
}

/**
 * The share of a folder that has to be read-only before it means anything.
 *
 * A handful of read-only files is ordinary — installers mark their own — and firing on
 * those would put a repair button under every game in the library. A folder copied off
 * read-only media has the attribute on essentially everything, including data files no
 * installer would ever mark, so the threshold is set where only that shape reaches it.
 */
export const READONLY_SHARE = 0.6

/** Below this many files the share means nothing; three of four is not a pattern. */
export const READONLY_MIN_FILES = 8

export function repairsFor(facts: RepairFacts): RepairOffer[] {
  const offers: RepairOffer[] = []

  /* ---- mark of the web ---- */

  if (facts.blocked.length > 0) {
    offers.push({
      id: 'unblock',
      kind: 'act',
      title: t('repair.unblock.title'),
      detail: t('repair.unblock.detail'),
      reasons: [t('repair.unblock.reason', { names: facts.blocked.slice(0, 3).map((f) => path.basename(f)).join('、'), n: String(facts.blocked.length) })],
      changes: [t('repair.unblock.change', { n: String(facts.blocked.length) })],
      // Honest rather than reassuring: the mark records that a file arrived from the
      // internet, putting it back would be inventing a provenance, and nothing needs it.
      undoable: false,
      needsAdmin: false
    })
  }

  /* ---- read-only attributes ---- */

  if (
    facts.fileCount >= READONLY_MIN_FILES &&
    facts.readOnly / facts.fileCount >= READONLY_SHARE
  ) {
    offers.push({
      id: 'clear-readonly',
      kind: 'act',
      title: t('repair.readonly.title'),
      detail: t('repair.readonly.detail'),
      reasons: [
        t('repair.readonly.reason', {
          n: String(facts.readOnly),
          total: String(facts.fileCount)
        })
      ],
      changes: [t('repair.readonly.change', { n: String(facts.readOnly) })],
      undoable: true,
      needsAdmin: false
    })
  }

  /* ---- cannot write beside itself ---- */

  if (!facts.folderWritable) {
    if (facts.virtualStore) {
      // Windows has been redirecting this game's writes for years and it never noticed.
      // Nothing is offered, because everything that could be offered here would move the
      // game off the saves it has been using — `RUNASADMIN` most of all, since an elevated
      // process is not virtualised and would start writing to the real path.
      offers.push({
        id: 'not-writable',
        kind: 'guide',
        title: t('repair.virtualStore.title'),
        detail: t('repair.virtualStore.detail'),
        reasons: [t('repair.virtualStore.reason', { path: facts.virtualStore })],
        changes: [],
        undoable: false,
        needsAdmin: false
      })
    } else {
      const already = facts.layers.includes('RUNASADMIN')
      offers.push({
        id: 'not-writable',
        kind: already ? 'guide' : 'act',
        title: t('repair.notWritable.title'),
        detail: already ? t('repair.notWritable.already') : t('repair.notWritable.detail'),
        reasons: [t('repair.notWritable.reason')],
        changes: already ? [] : [t('repair.notWritable.change', { key: LAYERS_KEY })],
        undoable: !already,
        needsAdmin: false
      })
    }
  }

  /* ---- a locale emulator ---- */

  /*
   * A locale emulator is only ever mentioned about a game that actually failed, silently.
   *
   * `needs-locale` is two signals out of three, and the two that carry it — a JP-era engine
   * and kana in the folder name — are both true of a Chinese fan translation that works
   * perfectly. 诊断 is on every tile's context menu with no failure required, so gating on
   * the finding alone put this offer under working games and recommended the one change
   * that would break them: the patch's script is GBK and wants the machine's own 936.
   *
   * `dialog` is deliberately not here. A game sitting on an error box did start, and the
   * box says more than any inference could — a locale gate leaves nothing at all.
   */
  const failedSilently = facts.trouble === 'earlyexit' || facts.trouble === 'noshow'

  if (facts.codes.includes('needs-locale') && failedSilently) {
    const usable = facts.localeTools.filter((f) => localeToolFits(f.tool, facts.arch))
    if (usable.length > 0) {
      /*
       * A guide, not a button, and the demotion is the point.
       *
       * The first version rewrote `game.exe` to the emulator and kept the game as an
       * argument. That is one action with four consequences, because `game.exe` is not
       * merely "what gets spawned" — it is the identity this program hangs everything
       * else on:
       *
       * - `sidecar-sync.ts` writes it into `sakura-launcher.md` as a path relative to the
       *   game folder, with no `isUnder` guard (the cover line beside it has one). An
       *   emulator lives outside that folder, so the travelling file ends up carrying
       *   `..\..\Program Files\…`, or a bare absolute path from another drive — against
       *   the rule that nothing about the machine goes into the sidecar.
       * - When `exePinned` is not set — the common case — the next rescan of a changed
       *   folder puts `exe` back, silently undoing the repair while the journal still
       *   lists it and the dialog still offers to undo it.
       * - `repairFacts` keys the compatibility layer on `game.exe`, so `RUNASADMIN`
       *   pressed afterwards lands on `LEProc.exe` and every program the user launches
       *   through Locale Emulator starts demanding UAC.
       * - It is not idempotent: pressed twice it aims the emulator at itself.
       *
       * None of that is fixable by adjusting this offer, because the fault is in rewriting
       * the identity at all. Doing it properly means a launch chain the launcher honours
       * without touching `game.exe`, which is a change to the scanner, the sidecar and the
       * fix-pack hashing — worth doing, not worth doing blind. Until then this hands over
       * the exact command, which `diag.needsLocale.detail` already tells people to set up
       * by hand under 「更换主程序…」.
       */
      const chosen = usable[0]
      const command = localeCommand(chosen.tool, chosen.exe, facts.gameExe ?? '')
      offers.push({
        id: 'locale-chain',
        kind: 'guide',
        title: t('repair.locale.title', { tool: t(LOCALE_TOOL_LABEL[chosen.tool]) }),
        // The caveat is in the detail rather than in a footnote: a Chinese fan translation
        // wants the machine's own Chinese codepage, and forcing 932 on it makes it worse.
        detail: command ? t('repair.locale.detail') : t('repair.locale.needsProfile'),
        reasons: [t('repair.locale.reason', { path: chosen.exe })],
        changes: [],
        undoable: false,
        needsAdmin: false,
        ...(command ? { command: localeCommandText(command) } : {})
      })
    } else {
      offers.push({
        id: 'locale-chain',
        kind: 'guide',
        title: t('repair.locale.noneTitle'),
        detail:
          facts.localeTools.length > 0 && (facts.arch === 'x86' || facts.arch === 'x64')
            ? t('repair.locale.wrongArch', { arch: facts.arch })
            : t('repair.locale.noneDetail'),
        reasons: [],
        changes: [],
        undoable: false,
        needsAdmin: false
      })
    }
  }

  /* ---- Japanese fonts ---- */

  if (facts.missingFonts.length > 0 && facts.codes.includes('needs-locale')) {
    offers.push({
      id: 'install-fonts',
      kind: 'guide',
      title: t('repair.fonts.title'),
      detail: t('repair.fonts.detail'),
      reasons: [t('repair.fonts.reason', { names: facts.missingFonts.join('、') })],
      changes: [],
      undoable: true,
      needsAdmin: true,
      // The capability name is `Jpan` with a script code, not `Ja-JP`. The wrong one
      // fails with a message about an unknown capability, which reads like a broken
      // machine rather than a typo.
      command:
        'DISM /Online /Add-Capability /CapabilityName:Language.Fonts.Jpan~~~und-JPAN~0.0.1.0'
    })
  }

  /* ---- a shim somebody else applied ---- */

  const foreign = facts.layers.filter((l) => !WRITABLE_LAYERS.has(l))
  if (foreign.length > 0) {
    offers.push({
      id: 'compat-layer',
      kind: 'act',
      title: t('repair.layers.title'),
      detail: t('repair.layers.detail'),
      reasons: [t('repair.layers.reason', { tokens: facts.layers.join(' ') })],
      changes: [t('repair.layers.change', { key: LAYERS_KEY })],
      undoable: true,
      needsAdmin: false
    })
  }

  return offers
}
