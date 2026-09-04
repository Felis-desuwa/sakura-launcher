// Extension spelled out: `scripts/update-test.mts` loads this file straight into node.
import { ASSET_ORDER, ASSET_SUFFIX, GITHUB_OWNER, GITHUB_REPO } from '../shared/types.ts'
import type {
  UpdateAsset,
  UpdateAssetKind,
  UpdateChannel,
  UpdateFailure,
  UpdateRelease,
  UpdateSeen,
  UpdateVerdict
} from '../shared/types.ts'

/**
 * Whether a newer release exists, and which file of it to offer.
 *
 * Split from `update.ts` for the reason every pure module here is split: reaching GitHub
 * needs a socket and deciding what came back does not. Everything below is arithmetic
 * over a body somebody else fetched, so the whole judgement can be tested offline.
 *
 * **A false "up to date" is the worst outcome this module can produce**, worse than an
 * error and worse than a false alarm: an error sends somebody to look, and a false alarm
 * costs them a click, but a confident "you are current" ends the conversation. So every
 * path that could quietly answer "nothing newer" is closed by construction rather than by
 * care — `readReleases` has no `releases` field to read on its failure arm, an unreadable
 * tag is carried out in `unreadableTags` instead of being dropped, and `compareVersions`
 * answers `null` rather than `0` when it cannot read a side.
 *
 * Nothing here reaches the network: this module builds the request and reads the answer,
 * so the shape of both can be tested without a socket. Nothing here imports electron.
 */

/** api.github.com is the only host asked, and only when a button is pressed. */
export const API_HOST = 'api.github.com'

/** Where a release asset is allowed to live. Exact equality, never `endsWith`. */
export const RELEASE_HOST = 'github.com'

/**
 * How many releases to ask for.
 *
 * Both channels read the same list endpoint. `/releases/latest` is not used even for
 * `stable`, because it is a second response shape to parse for one channel and it orders
 * by date — see R15 in the comment on `pickRelease`.
 */
export const RELEASES_PER_PAGE = 30

/** A version, parsed. `text` is what it was read from, for showing back to the user. */
export interface Version {
  major: number
  minor: number
  patch: number
  /** Empty for a release. Numeric identifiers are numbers; the rest are strings. */
  prerelease: (string | number)[]
  /** Everything after a `+`. Recorded, never compared. */
  build: string
  text: string
}

/** One release, read far enough to be ordered against the others. */
export interface ReleaseCandidate {
  tag: string
  version: Version
  prerelease: boolean
  publishedAt: string | null
  publishedMs: number | null
  notesUrl: string
  assets: UpdateAsset[]
  /** Names this module refused. Carried so a release cannot look like it shipped nothing. */
  rejectedAssets: string[]
}

/**
 * What a `/releases` body turned out to be.
 *
 * The failure arm carries no `releases` field **on purpose**. `Array.isArray(x) ? x : []`
 * is the single line in this whole feature that could lie quietly — GitHub answers a rate
 * limit with `{"message": …}` and a captive portal answers with HTML, and both would come
 * back from that line as an empty list, which reads as "nothing newer". Making the field
 * absent on failure means no caller can write that line by accident.
 */
export type ReleaseRead =
  | { ok: true; releases: ReleaseCandidate[]; unreadableTags: string[]; drafts: number }
  | { ok: false }

/** Everything `decideUpdate` needs. `releases` is `unknown` because it came off a socket. */
export interface UpdateInput {
  /** `app.getVersion()`. Parsed before the response is looked at. */
  running: string
  channel: UpdateChannel
  releases: unknown
}

/* -------------------------------------------------------------------------- */
/* Versions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read a version or a tag.
 *
 * Tolerant where tolerance is safe and strict where it is not. A missing minor or patch
 * is zero, and a leading zero is read numerically, because the failure mode of this
 * module is "we could not tell you an update exists" and refusing a whole release over a
 * typed zero is the silent one. What it will not do is guess: four parts, a non-numeric
 * part, an empty identifier or a second `v` all come back null, and `readReleases` then
 * carries the tag out where somebody can see it.
 *
 * **Build metadata is split off before the prerelease, and the order is load-bearing.**
 * In `1.0.0+build-9` the `-9` is inside the metadata and is not a prerelease, so that
 * version equals `1.0.0`. Split on `-` first and it parses as prerelease `9` of version
 * `1.0.0+build`, which then sorts *below* `1.0.0` — a released build reporting as older
 * than itself.
 */
export function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null

  // R1: at most one leading `v`, so `vv1.0.0` does not parse.
  let rest = text[0] === 'v' || text[0] === 'V' ? text.slice(1) : text

  // R2: build metadata first.
  let build = ''
  const plus = rest.indexOf('+')
  if (plus >= 0) {
    build = rest.slice(plus + 1)
    rest = rest.slice(0, plus)
  }

  // R3: then the prerelease.
  let pre: string | null = null
  const dash = rest.indexOf('-')
  if (dash >= 0) {
    pre = rest.slice(dash + 1)
    rest = rest.slice(0, dash)
  }

  // R4: one to three runs of digits.
  const parts = rest.split('.')
  if (parts.length > 3) return null
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    nums.push(Number(part))
  }

  const prerelease: (string | number)[] = []
  if (pre !== null) {
    if (pre === '') return null
    for (const id of pre.split('.')) {
      if (id === '') return null
      prerelease.push(/^\d+$/.test(id) ? Number(id) : id)
    }
  }

  return {
    major: nums[0],
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    prerelease,
    build,
    text
  }
}

/**
 * Order two parsed versions. Total: once both sides have parsed there is no failure case.
 *
 * Separate from `compareVersions` precisely because that one can answer null, and a
 * comparator that can answer null must never be handed to a sort — `pickRelease` sorts.
 *
 * String identifiers compare as **case-sensitive ASCII**, never `localeCompare`, which
 * would answer differently on some machines and identically on others: the worst kind of
 * failure available here. It also settles the labels this project actually uses, since
 * `B` is 0x42 and `b` is 0x62: `beta` < `demo` < `rc` < a release.
 */
export function precedence(a: Version, b: Version): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1

  const ap = a.prerelease
  const bp = b.prerelease
  if (ap.length === 0 && bp.length === 0) return 0
  // A version carrying a prerelease is below the same core without one.
  if (ap.length === 0) return 1
  if (bp.length === 0) return -1

  const shared = Math.min(ap.length, bp.length)
  for (let i = 0; i < shared; i++) {
    const x = ap[i]
    const y = bp[i]
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    if (xNum && yNum) {
      if (x !== y) return (x as number) < (y as number) ? -1 : 1
      continue
    }
    // A numeric identifier is always below an alphanumeric one, whatever their values.
    if (xNum !== yNum) return xNum ? -1 : 1
    if (x !== y) return (x as string) < (y as string) ? -1 : 1
  }
  if (ap.length === bp.length) return 0
  // Every shared identifier equal: more identifiers is higher.
  return ap.length < bp.length ? -1 : 1
}

/**
 * Order two version strings, or null when either cannot be read.
 *
 * **Null, never zero.** Calling an unreadable version equal is how a build nobody could
 * identify comes out as "up to date".
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return null
  return precedence(va, vb)
}

/* -------------------------------------------------------------------------- */
/* Assets                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which of the two files this is, by its name.
 *
 * **Matched by suffix alone, and deliberately not by the name electron-builder wrote.**
 * `electron-builder.yml` produces `Sakura Launcher-<version>-portable.exe`, with a space,
 * and GitHub stores it back as `Sakura.Launcher-<version>-portable.exe` — the uploader
 * sends the raw name in a query string and the space is normalised to a dot on the way in.
 * A check anchored on the product name therefore matches nothing that is actually on a
 * release, and the failure is silent: the version panel reports an update and offers no
 * file. Verified against the real v0.10.0 assets, not inferred.
 *
 * The suffix is still structural rather than a blacklist, so every present and future
 * sidecar file fails it for free: `…-setup.exe.blockmap` does not end in `-setup.exe`, and
 * neither do `latest.yml` or a `.sig`. An `includes('-setup.exe')` would hand somebody
 * forty kilobytes that is not a program and report success.
 */
export function assetKindOf(name: unknown): UpdateAssetKind | null {
  if (typeof name !== 'string' || name === '') return null
  // The name is joined to the folder the user picked. Refused rather than sanitised, so
  // the name shown and the name written are always the same string.
  if (/[/\\:]/.test(name) || name.includes('..')) return null

  const lower = name.toLowerCase()
  for (const kind of ASSET_ORDER) {
    if (lower.endsWith(ASSET_SUFFIX[kind])) return kind
  }
  return null
}

/**
 * Whether a download address is one of ours.
 *
 * Hostname by exact equality — `github.com.evil.example` passes an `endsWith` check — and
 * the path must be this repository's own release-download prefix. The host check alone is
 * not enough: `github.com/someone-else/payload/releases/download/v1/x-setup.exe` clears it
 * under a name this module would happily label `setup`.
 */
export function assetUrlOk(url: unknown): boolean {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.hostname !== RELEASE_HOST) return false
  return parsed.pathname.startsWith(`/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`)
}

/**
 * The files of one release worth offering, and the names that were refused.
 *
 * At most one per kind and always in `ASSET_ORDER`, so two labelled buttons do not swap
 * places because somebody uploaded the files in a different order. **Refusals are carried
 * out rather than dropped**, for the same reason unreadable tags are: a release whose
 * assets were all rejected would otherwise be indistinguishable from one that published
 * nothing, and that is the shape a naming change upstream would take.
 */
export function readAssets(raw: unknown): { assets: UpdateAsset[]; rejected: string[] } {
  const found = new Map<UpdateAssetKind, UpdateAsset>()
  const rejected: string[] = []
  if (!Array.isArray(raw)) return { assets: [], rejected }

  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const entry = row as { name?: unknown; browser_download_url?: unknown; size?: unknown; state?: unknown }
    const name = typeof entry.name === 'string' ? entry.name : ''
    const kind = assetKindOf(entry.name)
    if (!kind) {
      // Only worth reporting if it looked like a program at all; a .blockmap beside every
      // installer is expected and saying so every time would train the eye to skip it.
      if (name && name.toLowerCase().endsWith('.exe')) rejected.push(name)
      continue
    }
    if (!assetUrlOk(entry.browser_download_url)) {
      rejected.push(name)
      continue
    }
    // GitHub publishes the asset record before the bytes have landed. An absent `state`
    // is not a claim; a present one that is not `uploaded` is.
    if (entry.state !== undefined && entry.state !== 'uploaded') {
      rejected.push(name)
      continue
    }
    if (found.has(kind)) continue
    found.set(kind, {
      kind,
      name,
      url: entry.browser_download_url as string,
      size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0
    })
  }

  const assets: UpdateAsset[] = []
  for (const kind of ASSET_ORDER) {
    const got = found.get(kind)
    if (got) assets.push(got)
  }
  return { assets, rejected }
}

/* -------------------------------------------------------------------------- */
/* Releases                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read a `/releases` body.
 *
 * Anything that is not an array is a failure and not an empty library: that is the whole
 * point of the `ok: false` arm. Drafts are counted and dropped — only `=== true` is a
 * draft, since a missing field is not a statement — and a tag that will not parse is
 * carried out by name.
 */
export function readReleases(raw: unknown): ReleaseRead {
  if (!Array.isArray(raw)) return { ok: false }

  const releases: ReleaseCandidate[] = []
  const unreadableTags: string[] = []
  let drafts = 0

  for (const row of raw) {
    if (typeof row !== 'object' || row === null) {
      unreadableTags.push('?')
      continue
    }
    const entry = row as {
      tag_name?: unknown
      draft?: unknown
      prerelease?: unknown
      published_at?: unknown
      html_url?: unknown
      assets?: unknown
    }
    if (entry.draft === true) {
      drafts++
      continue
    }
    const tag = typeof entry.tag_name === 'string' ? entry.tag_name : ''
    const version = parseVersion(tag)
    if (!version) {
      unreadableTags.push(tag || '?')
      continue
    }
    const publishedAt = typeof entry.published_at === 'string' ? entry.published_at : null
    const ms = publishedAt ? Date.parse(publishedAt) : NaN
    const { assets, rejected } = readAssets(entry.assets)

    releases.push({
      tag,
      version,
      // Two independent signals, ORed: GitHub's own flag, and the tag carrying a
      // prerelease identifier. Each alone has an ordinary way of being wrong.
      prerelease: entry.prerelease === true || version.prerelease.length > 0,
      publishedAt,
      publishedMs: Number.isFinite(ms) ? ms : null,
      notesUrl: typeof entry.html_url === 'string' ? entry.html_url : releasesPageUrl(),
      assets,
      rejectedAssets: rejected
    })
  }

  return { ok: true, releases, unreadableTags, drafts }
}

/**
 * Which of two releases is the one to offer.
 *
 * "Newest" means highest by version, **never latest `published_at` and never first in
 * GitHub's array**: `/releases` is ordered newest-first by creation, so a v0.9.4 hotfix
 * cut after v0.10.0 sits at the top of it.
 *
 * Ties on an exact version are broken by a total order that does not depend on input
 * position — a release before a prerelease, then the later publication, then the greater
 * tag. Reading the array's order as a promise is how two checks a minute apart come back
 * with different answers.
 */
function betterThan(a: ReleaseCandidate, b: ReleaseCandidate): boolean {
  const order = precedence(a.version, b.version)
  if (order !== 0) return order > 0
  if (a.prerelease !== b.prerelease) return !a.prerelease
  const am = a.publishedMs ?? Number.NEGATIVE_INFINITY
  const bm = b.publishedMs ?? Number.NEGATIVE_INFINITY
  if (am !== bm) return am > bm
  return a.tag > b.tag
}

/** The highest release in the list, or null for an empty one. */
export function pickRelease(releases: ReleaseCandidate[]): ReleaseCandidate | null {
  let best: ReleaseCandidate | null = null
  for (const release of releases) {
    if (!best || betterThan(release, best)) best = release
  }
  return best
}

/** Whether a release belongs to a channel. `beta` widens the field; it does not pin it. */
export function inChannel(release: ReleaseCandidate, channel: UpdateChannel): boolean {
  return channel === 'beta' || !release.prerelease
}

/** Strip a candidate down to what crosses the IPC boundary. */
function toRelease(candidate: ReleaseCandidate): UpdateRelease {
  return {
    tag: candidate.tag,
    version: candidate.version.text.replace(/^[vV]/, ''),
    prerelease: candidate.prerelease,
    publishedAt: candidate.publishedAt,
    notesUrl: candidate.notesUrl,
    assets: candidate.assets,
    rejectedAssets: candidate.rejectedAssets
  }
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                 */
/* -------------------------------------------------------------------------- */

/** A check that did not get an answer. One shape, so no caller invents another. */
export function failedCheck(
  channel: UpdateChannel,
  running: string,
  reason: UpdateFailure,
  detail?: string,
  retryAt?: number
): UpdateVerdict {
  return { kind: 'failed', channel, running, reason, detail, retryAt }
}

/**
 * The whole judgement.
 *
 * **The running version is parsed before the response is even looked at.** With no running
 * version nothing can be said about any release, and reporting that as a bad response
 * blames the network for what is a packaging fault.
 *
 * `newerPrerelease` counts the releases the channel filter dropped that are newer than the
 * running build. It exists so a stable user is never quietly told they are current while a
 * newer test build sits one dropdown away — the same rule that makes unreadable tags and
 * rejected assets visible, applied to the one filter that is working as intended.
 */
export function decideUpdate(input: UpdateInput): UpdateVerdict {
  const { channel, running } = input

  const mine = parseVersion(running)
  if (!mine) return failedCheck(channel, running, 'unreadableVersion', running)

  const read = readReleases(input.releases)
  if (!read.ok) return failedCheck(channel, running, 'badResponse')

  let seen: UpdateSeen = { channel, running, newerPrerelease: 0, unreadableTags: read.unreadableTags }

  if (read.releases.length === 0) {
    // A page full of releases where not one tag could be read is not an empty repository.
    if (read.unreadableTags.length > 0) {
      return failedCheck(channel, running, 'unreadableReleases', read.unreadableTags.join(', '))
    }
    return { kind: 'noRelease', ...seen }
  }

  const eligible = read.releases.filter((r) => inChannel(r, channel))
  const newerPrerelease = read.releases.filter(
    (r) => !inChannel(r, channel) && precedence(r.version, mine) > 0
  ).length
  seen = { ...seen, newerPrerelease }

  const best = pickRelease(eligible)
  if (!best) return { kind: 'noRelease', ...seen }

  const order = precedence(best.version, mine)
  if (order > 0) return { kind: 'available', release: toRelease(best), ...seen }
  if (order === 0) return { kind: 'upToDate', ...seen }
  // Ahead of the channel — a hand-built copy, or a beta user who switched back to stable.
  // The release is carried anyway: it is the only route this build has to the line it is
  // ahead of, and a verdict that names a version without linking to it is a dead end.
  return { kind: 'ahead', release: toRelease(best), ...seen }
}

/* -------------------------------------------------------------------------- */
/* The request, and the download                                               */
/* -------------------------------------------------------------------------- */

/** The endpoint both channels read. */
export function releasesUrl(): string {
  return `https://${API_HOST}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=${RELEASES_PER_PAGE}`
}

/** The page a person is sent to. Also the fallback when a release carries no `html_url`. */
export function releasesPageUrl(): string {
  return `https://${RELEASE_HOST}/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
}

/**
 * Headers for the check.
 *
 * GitHub refuses a request with no `User-Agent`, and the version goes in it for the same
 * reason it does for the catalogues: somebody able to see who is calling can ask us to
 * stop rather than simply blocking us.
 */
export function requestHeaders(running: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `SakuraLauncher/${running} (local game library manager)`
  }
}

/** Case-insensitive header read. A live `Headers` lowercases; a hand-typed literal does not. */
function header(headers: Record<string, string>, name: string): string | null {
  const want = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return headers[key]
  }
  return null
}

/**
 * What a status line means, or null when it means the body is worth reading.
 *
 * Takes plain data rather than a live `Headers` so the harness can hand it an object
 * literal — every other pure module here takes data somebody else measured, for exactly
 * this reason.
 */
export function httpProblem(status: number, headers: Record<string, string> = {}): UpdateFailure | null {
  if (status >= 200 && status < 300) return null
  if (status === 403 || status === 429) {
    return header(headers, 'x-ratelimit-remaining') === '0' ? 'rateLimited' : 'refused'
  }
  if (status >= 500) return 'serverError'
  return 'refused'
}

/** When the rate limit lifts, in epoch ms, or null when that is not knowable or is past. */
export function rateLimitReset(headers: Record<string, string>, now: number): number | null {
  const raw = header(headers, 'x-ratelimit-reset')
  if (!raw || !/^\d+$/.test(raw)) return null
  const at = Number(raw) * 1000
  return at > now ? at : null
}

/**
 * A name that will not overwrite something already in the folder.
 *
 * Named `uniqueDownloadName` rather than `uniqueName` because `save-rules.ts` already
 * exports the latter with a different contract — it appends after the whole string, so a
 * `.exe` becomes `…-setup.exe-2`, which Windows will not run. Two sibling pure modules
 * exporting one name with two behaviours is how an auto-import silently saves a release
 * as something that cannot be double-clicked.
 */
export function uniqueDownloadName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = `${stem} (2)${ext}`
  for (let n = 2; n < 1000; n++) {
    candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  return candidate
}

/**
 * Whether what arrived is the size the release said it would be.
 *
 * **Nothing declared is `unknown`, never `ok`.** A release that could not say how big the
 * file is cannot vouch for what arrived, and reading "I do not know" as "no problem" is
 * the same class of mistake as reading a failed HDR query as false.
 */
export function checkSize(expected: number, got: number): 'ok' | 'short' | 'long' | 'unknown' {
  if (!Number.isFinite(expected) || expected <= 0) return 'unknown'
  if (got === expected) return 'ok'
  return got < expected ? 'short' : 'long'
}
