import path from 'node:path'
// Extension spelled out: the harnesses in scripts/ import this file straight into node,
// where nothing fills the extension in for them.
import type { MessageKey } from '../shared/i18n.ts'
import { ENGINE_LABEL, type EngineId } from '../shared/types.ts'
import { t } from './i18n.ts'

/**
 * The judgement half of the launch diagnosis, with no disk access in it.
 *
 * Everything here is a decision about text: is this DLL name real, which redistributable
 * ships it, does this filename look like Japanese read through the wrong codepage. Keeping
 * it pure is what lets `scripts/diagnose-test.mts` drive the hard cases — a missing
 * `MSVCP140.dll`, a name full of mojibake — without a broken game to point it at.
 *
 * The standard this code is held to: **a false positive is worse than silence.** A player
 * whose game runs fine being told it is missing a runtime learns to distrust the whole
 * feature, and there is no second chance at that. Every rule below is written to stay
 * quiet when unsure.
 */

/**
 * API set contract names. These are not files — the loader resolves them through the
 * apiset schema in the kernel to whatever DLL actually provides the functions.
 *
 * This is the single most important rule here. Every modern executable imports a dozen
 * or more of them, none exist on disk, and reporting them as missing would mean flagging
 * essentially every game in the library.
 */
export function isVirtualDll(name: string): boolean {
  return /^(api|ext)-ms-win-/i.test(name)
}

export interface RuntimePackage {
  key: string
  /**
   * What to go and install. The name and the note are dictionary keys rather than text —
   * `runtime.<key>` and `runtime.<key>.note` — because this table is data the diagnosis
   * renders, and the diagnosis has to speak whichever language the user set.
   */
  labelKey: MessageKey
  noteKey: MessageKey
  test: RegExp
}

/**
 * DLL name to the thing that ships it.
 *
 * Only entries that are genuinely diagnostic. A missing `d3d11.dll` means a broken
 * Windows install, not a missing download, so there is nothing useful to say about it and
 * it is left off.
 */
export const RUNTIME_PACKAGES: RuntimePackage[] = [
  {
    key: 'vc2015',
    labelKey: 'runtime.vc2015',
    noteKey: 'runtime.vc2015.note',
    // msvcp140_1, msvcp140_atomic_wait and vcruntime140_1 all ship in the same package.
    test: /^(msvcp140|vcruntime140|concrt140|mfc140u?|vcomp140)(_[a-z0-9_]+)?\.dll$/i
  },
  {
    key: 'vc2013',
    labelKey: 'runtime.vc2013',
    noteKey: 'runtime.vc2013.note',
    test: /^(msvcp120|msvcr120|mfc120u?|vcomp120)\.dll$/i
  },
  {
    key: 'vc2012',
    labelKey: 'runtime.vc2012',
    noteKey: 'runtime.vc2012.note',
    test: /^(msvcp110|msvcr110|mfc110u?)\.dll$/i
  },
  {
    key: 'vc2010',
    labelKey: 'runtime.vc2010',
    noteKey: 'runtime.vc2010.note',
    test: /^(msvcp100|msvcr100|mfc100u?)\.dll$/i
  },
  {
    key: 'vc2008',
    labelKey: 'runtime.vc2008',
    noteKey: 'runtime.vc2008.note',
    test: /^(msvcp90|msvcr90|mfc90u?)\.dll$/i
  },
  {
    key: 'vc2005',
    labelKey: 'runtime.vc2005',
    noteKey: 'runtime.vc2005.note',
    test: /^(msvcp80|msvcr80|mfc80u?)\.dll$/i
  },
  {
    key: 'directx',
    labelKey: 'runtime.directx',
    noteKey: 'runtime.directx.note',
    test: /^(d3dx9_\d+|d3dx10_\d+|d3dx11_\d+|d3dcompiler_\d+|xinput1_[123]|x3daudio1_\d+|xactengine\d+_\d+|xaudio2_\d+|dsetup)\.dll$/i
  },
  {
    key: 'dotnet',
    labelKey: 'runtime.dotnet',
    noteKey: 'runtime.dotnet.note',
    test: /^(mscoree|mscorlib|netstandard)\.dll$/i
  },
  {
    key: 'mediafeature',
    labelKey: 'runtime.mediafeature',
    noteKey: 'runtime.mediafeature.note',
    test: /^(mfplat|mfreadwrite|mfcore|evr)\.dll$/i
  },
  {
    key: 'openal',
    labelKey: 'runtime.openal',
    noteKey: 'runtime.openal.note',
    test: /^(openal32|wrap_oal)\.dll$/i
  },
  {
    key: 'physx',
    labelKey: 'runtime.physx',
    noteKey: 'runtime.physx.note',
    test: /^(physxloader|physx3?_?[a-z0-9]*|nvtoolsext\d*)\.dll$/i
  }
]

/** Which redistributable a missing DLL points at, or null if it is not a known one. */
export function runtimeFor(dll: string): RuntimePackage | null {
  const name = path.basename(dll).toLowerCase()
  return RUNTIME_PACKAGES.find((p) => p.test.test(name)) ?? null
}

export interface RuntimeGroup {
  pkg: RuntimePackage
  dlls: string[]
}

/**
 * Fold a list of missing DLLs into the packages that would fix them, plus the leftovers.
 *
 * Grouping matters for how this reads: "缺 Visual C++ 2010 运行库" is an instruction,
 * while "缺 msvcp100.dll、msvcr100.dll" is a riddle.
 */
export function groupMissing(dlls: string[]): {
  groups: RuntimeGroup[]
  unknown: string[]
} {
  const groups = new Map<string, RuntimeGroup>()
  const unknown: string[] = []
  for (const dll of dlls) {
    const pkg = runtimeFor(dll)
    if (!pkg) {
      unknown.push(dll)
      continue
    }
    const existing = groups.get(pkg.key)
    if (existing) existing.dlls.push(dll)
    else groups.set(pkg.key, { pkg, dlls: [dll] })
  }
  return { groups: [...groups.values()], unknown }
}

/**
 * Characters produced by reading Shift-JIS bytes as Windows-1252.
 *
 * Restricted to the ones that essentially never occur in a filename anybody typed on
 * purpose. The common punctuation the same mapping produces — the curly quotes, the
 * en dash, the ellipsis — is deliberately left out: plenty of legitimately named
 * releases use those, and including them would flag files that are perfectly fine.
 */
const MOJIBAKE_CHARS = new Set([
  'ƒ',
  '‚',
  '„',
  '†',
  '‡',
  'ˆ',
  '‰',
  'Š',
  '‹',
  'Œ',
  'Ž',
  'š',
  '›',
  'œ',
  'ž',
  'Ÿ',
  '¡',
  '¢',
  '£',
  '¤',
  '¥',
  '¦',
  '§'
])

/**
 * Whether a name looks like Japanese text decoded with the wrong codepage.
 *
 * Two independent grounds, because mojibake comes in dense runs rather than isolated
 * characters: three or more suspicious characters anywhere, or two of them side by side.
 * A single stray `ƒ` is not enough — that is how a legitimate name gets accused.
 */
export function looksLikeMojibake(text: string): boolean {
  // U+FFFD means a decoder already gave up on these bytes; nothing else to weigh.
  if (text.includes('�')) return true

  let count = 0
  let adjacent = false
  for (let i = 0; i < text.length; i++) {
    if (!MOJIBAKE_CHARS.has(text[i])) continue
    count++
    if (i > 0 && MOJIBAKE_CHARS.has(text[i - 1])) adjacent = true
  }
  return count >= 3 || (count >= 2 && adjacent)
}

/** Kana — the marker that separates Japanese from Chinese, which share their han. */
export function hasKana(text: string): boolean {
  return /[぀-ゟ゠-ヿｦ-ﾝ]/.test(text)
}

/**
 * Reverse map from character to the GBK bytes that produce it.
 *
 * Built once, on first use. Node can decode GBK but not encode it, and the whole
 * business below is a matter of getting back to the original bytes.
 */
let gbkBytes: Map<string, [number, number]> | null = null

function reverseGbk(): Map<string, [number, number]> {
  if (gbkBytes) return gbkBytes
  const map = new Map<string, [number, number]>()
  const dec = new TextDecoder('gbk', { fatal: false })
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue
      const ch = dec.decode(Uint8Array.from([lead, trail]))
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [lead, trail])
    }
  }
  gbkBytes = map
  return map
}

/**
 * Recover Japanese text that Windows rendered through a Chinese codepage.
 *
 * An engine that writes its messages in Shift-JIS gets converted to Unicode with
 * whatever the system's ANSI codepage is. On a Chinese machine that produces strings of
 * rare han — `巜掕偝傟偨僼傽僀儖` — which are unreadable to everyone, in the one place
 * where the text is the entire point: the error message saying why the game will not run.
 *
 * The conversion is lossless in principle, so this walks it back: characters to GBK
 * bytes, bytes to Shift-JIS.
 *
 * Returns null rather than a guess whenever the result is not convincingly Japanese.
 * Mangling a message that was already fine would be worse than leaving it alone, so the
 * output has to contain kana and decode cleanly before it is offered.
 */
export function unmojibake(text: string): string | null {
  // Already readable Japanese — there is nothing to undo.
  if (!text || hasKana(text)) return null

  const map = reverseGbk()
  const bytes: number[] = []
  let converted = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const pair = map.get(ch)
    // A character with no GBK representation means this was never GBK-rendered text.
    if (!pair) return null
    bytes.push(pair[0], pair[1])
    converted++
  }
  if (converted === 0) return null

  const out = new TextDecoder('shift_jis', { fatal: false }).decode(Uint8Array.from(bytes))
  if (out.includes('�') || out === text) return null
  // Two kana is the threshold: one could be a coincidence of byte values, a pair in
  // running text is not.
  const kana = out.match(/[぀-ゟ゠-ヿ]/g)?.length ?? 0
  return kana >= 2 ? out : null
}

/**
 * Window classes that mean "a message box is sitting on the screen".
 *
 * `#32770` is the class Windows gives every standard dialog, which is what `MessageBox`
 * puts up. Engines that roll their own tend to say so in the name.
 */
export const DIALOG_CLASS_RE = /^(#32770|.*(errormessagebox|msgbox|errordialog).*)$/i

export interface ForeignWindow {
  className: string
  title: string
  /** Text of every child control, which is where a message box keeps its message. */
  controls: string[]
}

export interface DialogFinding {
  title: string
  /** The message as the engine wrote it, unmangled when that was possible. */
  message: string
  /** What was on screen before decoding, kept when the two differ. */
  raw?: string
}

/**
 * Pick the message a stuck game is showing, if it is showing one.
 *
 * Buttons are dropped — "确定" is not the message — and the longest remaining control
 * text wins, because that is invariably the sentence and not the caption.
 */
export function pickErrorDialog(windows: ForeignWindow[]): DialogFinding | null {
  const dialogs = windows.filter((w) => DIALOG_CLASS_RE.test(w.className))
  for (const dialog of dialogs) {
    const body = dialog.controls
      .filter((t) => t.trim().length > 0)
      // Button captions: short, and never the thing worth reading.
      .filter((t) => !/^(确定|确認|確定|取消|OK|Cancel|はい|いいえ|是|否)$/i.test(t.trim()))
      .sort((a, b) => b.length - a.length)[0]
    const text = (body ?? dialog.title ?? '').trim()
    if (!text) continue
    const decoded = unmojibake(text)
    return {
      title: dialog.title.trim(),
      message: decoded ?? text,
      raw: decoded ? text : undefined
    }
  }
  return null
}

/**
 * Engines from the era that assumed the system's non-Unicode codepage was Japanese.
 *
 * These call the ANSI Win32 APIs and convert paths and script text through whatever
 * codepage the machine is set to. On a Chinese or Western system that conversion mangles
 * everything, which is what a locale emulator exists to fix. The modern engines are
 * absent from this list because they are all Unicode and a locale emulator does nothing
 * for them but add a failure mode.
 */
export const JP_ERA_ENGINES = new Set<EngineId>([
  'kirikiri',
  'bgi',
  'siglus',
  'majiro',
  'nscripter',
  'artemis',
  'wolf'
])

/** The Japanese ANSI codepage. A system set to this needs no locale emulator. */
export const JAPANESE_ACP = 932

export interface LocaleSignals {
  /** The machine's ANSI codepage, or null when it could not be read. */
  acp: number | null
  engine: EngineId | null
  /** Names taken from the game folder — the executable, the folder itself, its contents. */
  names: string[]
}

export interface LocaleVerdict {
  needed: boolean
  reasons: string[]
}

/**
 * Whether this game probably wants a locale emulator.
 *
 * Three independent signals, and two of them have to agree. Any one alone is too weak:
 * plenty of Japanese games are Unicode-clean, plenty of folders have Japanese names and
 * run fine, and an engine being old does not prove the machine cannot cope. Requiring
 * two keeps this from firing on every Japanese title in the library.
 *
 * A machine already set to Japanese is excluded outright, whatever else is true —
 * there is nothing left for an emulator to do.
 */
export function localeVerdict({ acp, engine, names }: LocaleSignals): LocaleVerdict {
  if (acp === JAPANESE_ACP) return { needed: false, reasons: [] }

  const reasons: string[] = []
  const mojibake = names.filter(looksLikeMojibake)
  if (mojibake.length > 0) {
    reasons.push(t('diag.locale.mojibakeReason', { names: mojibake.slice(0, 3).join('、') }))
  }
  if (engine && JP_ERA_ENGINES.has(engine)) {
    reasons.push(t('diag.locale.engineReason', { engine: ENGINE_LABEL[engine] }))
  }
  if (names.some(hasKana)) {
    reasons.push(t('diag.locale.kanaReason'))
  }
  if (acp !== null && acp !== JAPANESE_ACP) {
    reasons.push(t('diag.locale.acpReason', { acp: String(acp) }))
  }

  // The codepage on its own is true of most machines in this part of the world and
  // proves nothing, so it does not get to be one of the two.
  const substantive = reasons.length - (acp !== null && acp !== JAPANESE_ACP ? 1 : 0)
  return { needed: substantive >= 2, reasons }
}

/** Where an engine leaves a record of why it died. */
export interface LogHints {
  /** Filenames to look for inside the game folder, matched case-insensitively. */
  inGameDir: RegExp[]
  /**
   * Unity writes outside the game folder entirely, under
   * `%USERPROFILE%\AppData\LocalLow\<company>\<product>\Player.log`.
   */
  localLow: boolean
}

const GENERIC_LOGS = [/^error\.(log|txt)$/i, /^crash\.(log|txt|dmp)$/i, /^debug\.log$/i]

export function logHintsFor(engine: EngineId | null): LogHints {
  switch (engine) {
    case 'unity':
      return { inGameDir: [/^output_log\.txt$/i, ...GENERIC_LOGS], localLow: true }
    case 'renpy':
      return {
        inGameDir: [/^log\.txt$/i, /^errors\.txt$/i, /^traceback\.txt$/i, ...GENERIC_LOGS],
        localLow: false
      }
    case 'kirikiri':
      return { inGameDir: [/\.console\.log$/i, /^krkr.*\.log$/i, ...GENERIC_LOGS], localLow: false }
    case 'unreal':
      return { inGameDir: [/\.log$/i, ...GENERIC_LOGS], localLow: false }
    default:
      return { inGameDir: GENERIC_LOGS, localLow: false }
  }
}

/**
 * The directories Windows searches for a DLL, in order.
 *
 * Pure so the search can be tested without a filesystem. `SysWOW64` holds the 32-bit
 * system DLLs, and a 32-bit process asking for `System32` is redirected there — so
 * checking the wrong one would report every system DLL as missing for half the library,
 * which is the entire population of older Japanese games.
 */
export function searchDirsFor(
  exeDir: string,
  arch: string,
  windir: string,
  pathEntries: string[]
): string[] {
  const system = arch === 'x86' ? path.join(windir, 'SysWOW64') : path.join(windir, 'System32')
  return [exeDir, system, path.join(windir, 'System32'), windir, ...pathEntries]
}

/** Severity order for presentation: the answer first, the footnotes last. */
export const SEVERITY_RANK: Record<string, number> = { blocker: 0, likely: 1, note: 2 }
