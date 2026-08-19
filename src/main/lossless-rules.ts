// Extension spelled out: `scripts/lossless-test.mts` loads this file straight into node,
// where nothing fills the extension in.

/**
 * Finding the user's Lossless Scaling, without touching a disk.
 *
 * Lossless Scaling is paid, closed software sold on Steam. It cannot be shipped with this
 * program the way Magpie is, so there is no copy of ours to lay down and no portable mode
 * to hide behind: the only Lossless Scaling that exists is the one the user bought and
 * installed, and every part of this integration follows from that.
 *
 * The first consequence is here. Where Magpie's path is a constant under `%APPDATA%`,
 * this one has to be *worked out* — and worked out from files Steam maintains for its own
 * reasons, which is a chain with several ordinary ways to break. Everything below is the
 * parsing half of that chain; `lossless.ts` reads the files and holds the fallback that
 * matters most, which is asking the user.
 *
 * Nothing here imports electron.
 */

/** Lossless Scaling's Steam application id. Its manifest and library entry are keyed on it. */
export const LS_APP_ID = '993090'

/** The executable's name, which is also what a process listing reports. */
export const LS_EXE = 'LosslessScaling.exe'

/**
 * What every profile this program writes into the user's config is called.
 *
 * This prefix is the **only** thing that distinguishes our profiles from theirs, and so it
 * is the only thing that authorises deleting one. It has to be visibly ours in a list the
 * user reads in somebody else's program, and it has to be stable forever: change it and
 * every profile written under the old one becomes, by this rule, the user's own — never
 * cleaned up, never updated, silently scaling games with settings nobody is maintaining.
 */
export const SAKURA_PREFIX = 'Sakura · '

/** Whether a profile title is one of ours. */
export function isOurProfile(title: string): boolean {
  return title.startsWith(SAKURA_PREFIX)
}

/** What we would call the profile for a given mode. */
export function ourProfileTitle(mode: string): string {
  return SAKURA_PREFIX + mode.trim()
}

/**
 * Every Steam library folder named in `libraryfolders.vdf`.
 *
 * Steam's own text format, read with a regex rather than a parser because exactly one key
 * is wanted out of it and a full VDF reader would be more code than the thing it reads.
 * Paths in that file are JSON-ish: backslashes are doubled, so they have to be halved
 * again or every path comes back pointing at a directory that does not exist.
 *
 * Order is preserved — Steam lists the main library first, and that is where a small tool
 * like this one is most likely to be.
 */
export function steamLibraries(vdfText: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /"path"\s*"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(vdfText)) !== null) {
    const path = m[1].replace(/\\(.)/g, '$1').trim()
    if (path === '') continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/**
 * The folder name under `steamapps\common\` that an app manifest gives.
 *
 * Read rather than assumed, because it is not the app's display name and is not derivable
 * from the id. Lossless Scaling happens to install into a folder called `Lossless Scaling`
 * today; hard-coding that would be a guess that breaks silently on the day it changes, and
 * the file that knows the answer is sitting right there.
 */
export function installDirOf(acfText: string): string | null {
  const m = /"installdir"\s*"((?:[^"\\]|\\.)*)"/.exec(acfText)
  if (!m) return null
  const dir = m[1].replace(/\\(.)/g, '$1').trim()
  return dir === '' ? null : dir
}

/**
 * Whether a path the user picked is plausibly Lossless Scaling.
 *
 * Only the file name is checked, and deliberately only that: the point is to catch the
 * user having picked the game's executable, or Steam's, from a dialog that offers every
 * `.exe` on the machine — not to police where they keep it. Somebody who copied the
 * install folder out of Steam is doing something reasonable and this must not stop them.
 */
export function looksLikeLossless(exePath: string): boolean {
  const name = exePath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return name.toLowerCase() === LS_EXE.toLowerCase()
}
