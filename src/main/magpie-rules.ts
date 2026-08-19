// Extension spelled out: `scripts/magpie-test.mts` loads this file straight into node,
// where nothing fills the extension in.

/**
 * Deciding what Magpie should be told, without touching a disk or a process.
 *
 * Magpie is a separate program — GPLv3, shipped alongside this one — that scales a
 * window up with a shader while it runs. It is here because the games in this library
 * are the ones it helps most: an engine that hard-codes 800×600 is a postage stamp on a
 * modern display, and the alternative Windows offers is an integer stretch that turns
 * line art to mush.
 *
 * The whole integration rests on one Magpie feature: a *profile* that names an
 * executable path and sets `autoScale` makes Magpie scale that window by itself, the
 * moment it appears, with no further prompting. So this program never has to hold a
 * window handle, poll for one, or synthesise a hotkey — it writes a JSON file and starts
 * a process. That is the reason a launcher with no native dependencies can carry this
 * feature at all.
 *
 * Which games get a profile, and under what name, is not decided here: that question is
 * the same for both upscalers and lives in `upscale-rules.ts`. What is left here is
 * everything that is true of Magpie and of nothing else.
 *
 * Nothing here imports electron; the harness loads it directly under node, the same
 * arrangement `save-rules.ts` and `scan-core.ts` have.
 */

/**
 * The Magpie release this program ships.
 *
 * Also the reinstall trigger: the copy under `%APPDATA%` records the version it was
 * written from, and a mismatch means the launcher was updated and the copy is stale.
 * Keep it in step with `scripts/fetch-magpie.mts`, which verifies the download's hash.
 */
export const MAGPIE_VERSION = '0.12.1'

/**
 * The Windows build Magpie needs: 10 v1903, the first with the capture API it uses.
 * Windows 11 reports 10.0 too, with a higher build, so only the build number is read.
 */
const MIN_BUILD = 18362

/**
 * Whether this machine is new enough, from `os.release()`.
 *
 * Anything unparseable is a no. Being wrong in that direction costs the user a feature
 * they can switch on again after being told why; being wrong in the other direction
 * starts a process that exits immediately and explains nothing.
 */
export function supportsMagpie(osRelease: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(osRelease.trim())
  if (!m) return false
  const major = Number(m[1])
  if (major > 10) return true
  if (major < 10) return false
  return Number(m[3]) >= MIN_BUILD
}

/**
 * What the Magpie processes currently running mean for us.
 *
 * `foreign` is the case worth all this trouble. Magpie allows one instance, so when the
 * user has their own copy open, the copy this program starts exits immediately and its
 * profiles never apply — and from here that is indistinguishable from success. Detecting
 * it is the only way the user ever finds out.
 */
export type InstanceVerdict =
  | { kind: 'none' }
  | { kind: 'ours' }
  | { kind: 'foreign'; path: string }

/**
 * Judge the running Magpie processes against the copy we manage.
 *
 * A foreign instance outranks ours: if both are somehow running, ours is the one that
 * lost the single-instance race and is doing nothing.
 */
export function instanceVerdict(runningExePaths: string[], ourExe: string): InstanceVerdict {
  const ours = ourExe.trim().toLowerCase()
  let mine = false
  for (const raw of runningExePaths) {
    const p = raw.trim()
    if (p === '') continue
    if (p.toLowerCase() === ours) mine = true
    else return { kind: 'foreign', path: p }
  }
  return mine ? { kind: 'ours' } : { kind: 'none' }
}

/**
 * Whether this program may stop the Magpie it found.
 *
 * Only ever the copy it owns, compared as a whole path. This is the guard on the one
 * genuinely destructive thing here — killing a process — and it exists because the
 * obvious implementation (match on the name `Magpie.exe`) would terminate the user's own
 * running copy, which this program has no business touching.
 */
export function mayStop(verdict: InstanceVerdict): boolean {
  return verdict.kind === 'ours'
}

/** What the copy under `%APPDATA%` records about where it came from. */
export interface MagpieStamp {
  magpieVersion: string
  appVersion: string
  copiedAt: number
}

/**
 * Whether the copy on disk has to be laid down again.
 *
 * Anything unrecognisable counts as stale: a stamp that cannot be read is a copy whose
 * provenance is unknown, and re-copying costs one file operation while trusting it could
 * leave a new launcher driving an old Magpie's effect files.
 */
export function needsReinstall(stamp: unknown, version: string): boolean {
  if (typeof stamp !== 'object' || stamp === null) return true
  const got = (stamp as { magpieVersion?: unknown }).magpieVersion
  return typeof got !== 'string' || got !== version
}
