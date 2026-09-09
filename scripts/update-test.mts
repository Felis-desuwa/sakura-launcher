import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assetKindOf,
  assetUrlOk,
  checkSize,
  compareVersions,
  decideUpdate,
  httpProblem,
  parseVersion,
  pickRelease,
  rateLimitReset,
  readAssets,
  readReleases,
  releasesPageUrl,
  releasesUrl,
  requestHeaders,
  uniqueDownloadName
} from '../src/main/update-rules.ts'
import * as updateRules from '../src/main/update-rules.ts'
import * as saveRules from '../src/main/save-rules.ts'
import { ASSET_ORDER, GITHUB_RELEASES_URL } from '../src/shared/types.ts'
import type { UpdateChannel, UpdateVerdict } from '../src/shared/types.ts'

/**
 * The manual update check: which release counts, whether it is newer, which file to offer.
 *
 * Weighted towards the one outcome that must never happen — a confident "up to date" over
 * a body nobody could read. Most of the negative cases below exist to pin that, not to
 * pin an error message.
 */

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, got: T, want: T): void {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

function deepEq(name: string, got: unknown, want: unknown): void {
  check(
    name,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
  )
}

/** One release row, spelled out only where a case cares. */
function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v1.0.0',
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    html_url: 'https://github.com/Felis-desuwa/sakura-launcher/releases/tag/v1.0.0',
    assets: [],
    ...over
  }
}

/** One asset row. The URL has to be a real release-download path or it is refused. */
function asset(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    size: 1024,
    browser_download_url: `https://github.com/Felis-desuwa/sakura-launcher/releases/download/v1.0.0/${name}`,
    ...over
  }
}

function verdict(running: string, channel: UpdateChannel, releases: unknown): UpdateVerdict {
  return decideUpdate({ running, channel, releases })
}

/* -------------------------------------------------------------------------- */
console.log('\n== reading a version ==')

eq('a plain version', parseVersion('1.2.3')?.text, '1.2.3')
eq('one leading v is a tag', parseVersion('v1.2.3')?.major, 1)
eq('two leading v is not anything', parseVersion('vv1.0.0'), null)
eq('a missing patch is zero', parseVersion('1.2')?.patch, 0)
eq('...and a missing minor too', parseVersion('1')?.minor, 0)
eq('four parts is a file version, not ours', parseVersion('1.2.3.4'), null)
eq('a letter in the core', parseVersion('1.x.0'), null)
eq('a negative', parseVersion('-1.0.0'), null)
eq('nothing at all', parseVersion(''), null)
eq('not even a string', parseVersion(null), null)
eq('a dangling dash', parseVersion('1.0.0-'), null)
eq('a dangling identifier', parseVersion('1.0.0-beta.'), null)
eq('leading zeros are read, not refused', parseVersion('01.02.03')?.minor, 2)

deepEq('a prerelease splits into identifiers', parseVersion('1.0.0-beta.2')?.prerelease, ['beta', 2])
eq('the demo suffix this build carries', parseVersion('0.11.0-demo')?.prerelease.length, 1)

/* -------------------------------------------------------------------------- */
console.log('\n== build metadata comes off before the prerelease ==')

// Split the other way and '1.0.0+build-9' parses as prerelease '9' of '1.0.0+build',
// which then sorts below 1.0.0 — a released build reporting as older than itself.
eq('a dash inside build metadata is not a prerelease', parseVersion('1.0.0+build-9')?.prerelease.length, 0)
eq('...so it is the same version', compareVersions('1.0.0+build-9', '1.0.0'), 0)
eq('metadata is recorded', parseVersion('1.0.0+build-9')?.build, 'build-9')
eq('metadata never decides', compareVersions('1.0.0+a', '1.0.0+b'), 0)

/* -------------------------------------------------------------------------- */
console.log('\n== ordering ==')

/** Each pair is strictly ascending. Run backwards too, so antisymmetry is asserted. */
const ASCENDING: [string, string, string][] = [
  ['0.9.3', '0.10.0', 'ten is not nine — the string-compare bug this exists to prevent'],
  ['0.9.9', '1.0.0', 'a major bump'],
  ['1.0.0', '1.1.0', 'a minor bump'],
  ['1.0.0', '1.0.1', 'a patch bump'],
  ['1.0.0-beta', '1.0.0', 'a prerelease is below its release'],
  ['0.11.0-demo', '0.11.0', 'the demo build against the release it was cut from'],
  ['0.10.0', '0.11.0-demo', '...and against the release before it'],
  ['1.0.0-beta.9', '1.0.0-beta.10', 'numeric identifiers compare numerically'],
  ['1.0.0-1', '1.0.0-alpha', 'numeric ranks below alphanumeric'],
  ['1.0.0-alpha.1', '1.0.0-alpha.beta', '...at any depth'],
  ['1.0.0-beta', '1.0.0-beta.1', 'more identifiers is higher when the shared ones match'],
  ['1.0.0-Beta', '1.0.0-beta', 'ASCII and case-sensitive, never localeCompare'],
  ['0.11.0-beta.1', '0.11.0-demo', 'beta sorts below demo'],
  ['0.11.0-demo', '0.11.0-rc.1', '...and demo below rc']
]

for (const [lower, higher, why] of ASCENDING) {
  eq(`${lower} < ${higher} — ${why}`, compareVersions(lower, higher), -1)
  eq(`  and ${higher} > ${lower}`, compareVersions(higher, lower), 1)
}

eq('a version equals itself', compareVersions('1.2.3', '1.2.3'), 0)
eq('a tag equals the version it names', compareVersions('v1.2.3', '1.2.3'), 0)
eq('leading zeros do not make a new version', compareVersions('1.0.0-beta.01', '1.0.0-beta.1'), 0)

// Null, never zero: calling an unreadable version equal is how a build nobody could
// identify comes back as "up to date".
eq('an unreadable left side', compareVersions('nightly-2026-09-03', '1.0.0'), null)
eq('an unreadable right side', compareVersions('1.0.0', 'nightly'), null)
eq('...and it is null in both directions', compareVersions('nightly', '1.0.0'), null)

/* -------------------------------------------------------------------------- */
console.log('\n== which file to offer ==')

// The names GitHub actually stores. electron-builder writes a space; the upload
// normalises it to a dot, so a check anchored on the product name matches nothing.
eq('the portable name a release really carries', assetKindOf('Sakura.Launcher-0.10.0-portable.exe'), 'portable')
eq('the setup name a release really carries', assetKindOf('Sakura.Launcher-0.10.0-setup.exe'), 'setup')
eq('the name the build wrote, with its space', assetKindOf('Sakura Launcher-0.10.0-portable.exe'), 'portable')
eq('a future rename of the product', assetKindOf('Something.Else-9.9.9-setup.exe'), 'setup')
eq('a blockmap is not a program', assetKindOf('Sakura.Launcher-0.10.0-setup.exe.blockmap'), null)
eq('...whatever case it arrives in', assetKindOf('Sakura.Launcher-0.10.0-SETUP.EXE.BlockMap'), null)
eq('a trailing space is a different file', assetKindOf('Sakura.Launcher-0.10.0-setup.exe '), null)
eq('the updater metadata', assetKindOf('latest.yml'), null)
eq('a checksum list', assetKindOf('SHA256SUMS.txt'), null)
eq('nothing at all', assetKindOf(''), null)
eq('not a string', assetKindOf(42), null)
eq('a path separator', assetKindOf('nested/Sakura.Launcher-1.0.0-setup.exe'), null)
eq('a backslash', assetKindOf('nested\\x-setup.exe'), null)
eq('a climb out of the folder', assetKindOf('Sakura.Launcher-../../x-setup.exe'), null)
eq('a drive letter', assetKindOf('C:x-setup.exe'), null)

eq(
  'our own release download',
  assetUrlOk('https://github.com/Felis-desuwa/sakura-launcher/releases/download/v1.0.0/x-setup.exe'),
  true
)
eq(
  'somebody else repository on the same host',
  assetUrlOk('https://github.com/attacker/payload/releases/download/v1/payload-setup.exe'),
  false
)
eq('a host that merely ends in ours', assetUrlOk('https://github.com.evil.example/a/b/releases/download/v1/x-setup.exe'), false)
eq('plain http', assetUrlOk('http://github.com/Felis-desuwa/sakura-launcher/releases/download/v1/x-setup.exe'), false)
eq('not a url', assetUrlOk('x-setup.exe'), false)
eq('not a string', assetUrlOk(null), false)

/* -------------------------------------------------------------------------- */
console.log('\n== reading the assets of one release ==')

const both = readAssets([asset('Sakura.Launcher-1.0.0-setup.exe'), asset('Sakura.Launcher-1.0.0-portable.exe')])
deepEq('always in one order, whatever order they were uploaded in', both.assets.map((a) => a.kind), [...ASSET_ORDER])
eq('and nothing was refused', both.rejected.length, 0)

const withNoise = readAssets([
  asset('Sakura.Launcher-1.0.0-setup.exe'),
  asset('Sakura.Launcher-1.0.0-setup.exe.blockmap'),
  asset('latest.yml'),
  null,
  'a string',
  { name: 42 }
])
eq('one asset out of a noisy list', withNoise.assets.length, 1)
eq('and a blockmap is not reported as a refusal', withNoise.rejected.length, 0)

const wrongHost = readAssets([
  asset('Sakura.Launcher-1.0.0-setup.exe', {
    browser_download_url: 'https://github.com/attacker/payload/releases/download/v1/x.exe'
  })
])
eq('an exe from somewhere else is refused', wrongHost.assets.length, 0)
deepEq('...and said out loud', wrongHost.rejected, ['Sakura.Launcher-1.0.0-setup.exe'])

const stillUploading = readAssets([asset('Sakura.Launcher-1.0.0-setup.exe', { state: 'starter' })])
eq('an asset whose bytes have not landed', stillUploading.assets.length, 0)
eq('an absent state is not a claim', readAssets([asset('Sakura.Launcher-1.0.0-setup.exe')]).assets.length, 1)

eq('a size that is not a number becomes zero', readAssets([asset('x-setup.exe', { size: 'big' })]).assets[0]?.size, 0)
eq('assets that are not a list', readAssets(null).assets.length, 0)

/* -------------------------------------------------------------------------- */
console.log('\n== reading a release list ==')

eq('a rate-limit message is not an empty library', readReleases({ message: 'API rate limit exceeded' }).ok, false)
eq('a captive portal page is not either', readReleases('<html>sign in</html>').ok, false)
eq('null is not', readReleases(null).ok, false)
eq('an empty array is a real answer', readReleases([]).ok, true)

const mixed = readReleases([
  release({ tag_name: 'v1.1.0' }),
  release({ tag_name: 'nightly-2026-09-03' }),
  release({ tag_name: 'v1.0.0', draft: true }),
  release({ tag_name: 'v0.9.0' })
])
eq('the readable ones are kept', mixed.ok && mixed.releases.length, 2)
deepEq('the unreadable tag is carried out', mixed.ok && mixed.unreadableTags, ['nightly-2026-09-03'])
eq('the draft is counted', mixed.ok && mixed.drafts, 1)

eq('only draft === true is a draft', readReleases([release({ draft: undefined })]).ok && readReleases([release({ draft: undefined })]).releases.length, 1)

const flagged = readReleases([release({ tag_name: 'v1.0.0', prerelease: true })])
eq('GitHub flag alone makes it a prerelease', flagged.ok && flagged.releases[0].prerelease, true)
const tagged = readReleases([release({ tag_name: 'v1.0.0-beta.1', prerelease: false })])
eq('...and so does the tag alone', tagged.ok && tagged.releases[0].prerelease, true)

/* -------------------------------------------------------------------------- */
console.log('\n== which release is newest ==')

const outOfOrder = readReleases([
  // GitHub returns newest-first BY CREATION, so a hotfix cut later sits above the higher
  // version. Reading the array's order as the answer picks the wrong one.
  release({ tag_name: 'v0.9.4', published_at: '2026-03-01T00:00:00Z' }),
  release({ tag_name: 'v0.10.0', published_at: '2026-02-01T00:00:00Z' })
])
eq('highest version wins, not first in the array', outOfOrder.ok && pickRelease(outOfOrder.releases)?.tag, 'v0.10.0')

const tie = readReleases([
  release({ tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z' }),
  release({ tag_name: '1.0.0', published_at: '2026-05-01T00:00:00Z' })
])
eq('a tie is broken by publication, not by position', tie.ok && pickRelease(tie.releases)?.tag, '1.0.0')
const reversed = readReleases([
  release({ tag_name: '1.0.0', published_at: '2026-05-01T00:00:00Z' }),
  release({ tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z' })
])
eq('...and the answer does not change when the array does', reversed.ok && pickRelease(reversed.releases)?.tag, '1.0.0')
eq('nothing to pick from', pickRelease([]), null)

/* -------------------------------------------------------------------------- */
console.log('\n== the verdict ==')

const stableLine = [release({ tag_name: 'v0.12.0' }), release({ tag_name: 'v0.11.0' })]

eq('a newer release', verdict('0.11.0', 'stable', stableLine).kind, 'available')
eq('the newest release', verdict('0.12.0', 'stable', stableLine).kind, 'upToDate')
eq('a build ahead of the line', verdict('0.13.0', 'stable', stableLine).kind, 'ahead')
eq('an empty repository', verdict('0.11.0', 'stable', []).kind, 'noRelease')

// The situation this repository is in today.
eq('the demo build is offered the release it was cut from', verdict('0.11.0-demo', 'stable', [release({ tag_name: 'v0.11.0' })]).kind, 'available')
eq('...and is not offered the one before it', verdict('0.11.0-demo', 'stable', [release({ tag_name: 'v0.10.0' })]).kind, 'ahead')

const withBeta = [
  release({ tag_name: 'v0.13.0-beta.1', prerelease: true }),
  release({ tag_name: 'v0.12.0' })
]
eq('a stable user is not offered a beta', verdict('0.12.0', 'stable', withBeta).kind, 'upToDate')
const quiet = verdict('0.12.0', 'stable', withBeta)
eq('...but is told one exists', quiet.kind === 'upToDate' && quiet.newerPrerelease, 1)
eq('a beta user is offered it', verdict('0.12.0', 'beta', withBeta).kind, 'available')

const stableAhead = [
  release({ tag_name: 'v0.13.0-beta.1', prerelease: true }),
  release({ tag_name: 'v0.14.0' })
]
eq('a beta user still gets a newer stable', verdict('0.13.0-beta.1', 'beta', stableAhead).kind, 'available')
const betaBack = verdict('0.14.0', 'beta', stableAhead)
eq('...and switching to beta does not invent an update', betaBack.kind, 'upToDate')

// The false "up to date" this module exists to prevent, in its three shapes.
eq('a body that is not a list never says current', verdict('0.1.0', 'stable', { message: 'Not Found' }).kind, 'failed')
const allUnreadable = verdict('1.0.0', 'stable', [release({ tag_name: 'nightly' }), release({ tag_name: 'weekly' })])
eq('a page of tags nobody can read is not an empty repository', allUnreadable.kind, 'failed')
eq('...and it says which', allUnreadable.kind === 'failed' && allUnreadable.reason, 'unreadableReleases')
// The subtle one, and the reason `unreadableTags` rides on every answer rather than only
// on the all-unreadable case: the release that would have contradicted “up to date” is
// exactly the one that was dropped, so the verdict is only true about the part we read.
const dropped = verdict('1.0.0', 'stable', [release({ tag_name: 'nightly' }), release({ tag_name: 'v1.0.0' })])
eq('a dropped tag beside a matching one still reads as current...', dropped.kind, 'upToDate')
deepEq('...but never silently', dropped.kind === 'upToDate' && dropped.unreadableTags, ['nightly'])
deepEq('and a clean list says so', (verdict('1.0.0', 'stable', [release({ tag_name: 'v1.0.0' })]) as { unreadableTags: string[] }).unreadableTags, [])

// A packaging fault is not a network fault, and must not send anybody to their router.
const broken = verdict('not-a-version', 'stable', stableLine)
eq('an unreadable running version fails', broken.kind, 'failed')
eq('...as a packaging fault', broken.kind === 'failed' && broken.reason, 'unreadableVersion')

const offered = verdict('0.11.0', 'stable', [
  release({ tag_name: 'v0.12.0', assets: [asset('Sakura.Launcher-0.12.0-portable.exe')] })
])
eq('the release carries its file', offered.kind === 'available' && offered.release.assets.length, 1)
eq('...and the version is shown without the v', offered.kind === 'available' && offered.release.version, '0.12.0')

// A build ahead of its channel still needs somewhere to go.
const ahead = verdict('9.9.9', 'stable', stableLine)
eq('being ahead does not lose the release', ahead.kind === 'ahead' && ahead.release.tag, 'v0.12.0')

/* -------------------------------------------------------------------------- */
console.log('\n== the request, and what a status line means ==')

check('the endpoint is api.github.com', releasesUrl().startsWith('https://api.github.com/repos/Felis-desuwa/sakura-launcher/releases'))
check('...and it asks for a page rather than everything', releasesUrl().includes('per_page='))
eq('the page a person is sent to', releasesPageUrl(), GITHUB_RELEASES_URL)
check('the request identifies the program', requestHeaders('1.0.0')['User-Agent'].startsWith('SakuraLauncher/1.0.0'))

eq('a good status is not a problem', httpProblem(200), null)
eq('a spent rate limit', httpProblem(403, { 'x-ratelimit-remaining': '0' }), 'rateLimited')
eq('...however the header is cased', httpProblem(403, { 'X-RateLimit-Remaining': '0' }), 'rateLimited')
eq('a 403 that is not a rate limit', httpProblem(403, {}), 'refused')
eq('a 429', httpProblem(429, { 'x-ratelimit-remaining': '0' }), 'rateLimited')
eq('a missing repository', httpProblem(404), 'refused')
eq('their end broke', httpProblem(503), 'serverError')

eq('when the limit lifts', rateLimitReset({ 'x-ratelimit-reset': '2000' }, 1000 * 1000), 2000 * 1000)
eq('a reset already past is not a wait', rateLimitReset({ 'x-ratelimit-reset': '1' }, 1000 * 1000), null)
eq('no header at all', rateLimitReset({}, 0), null)
eq('a header that is not a number', rateLimitReset({ 'x-ratelimit-reset': 'soon' }, 0), null)

/* -------------------------------------------------------------------------- */
console.log('\n== saving it without overwriting anything ==')

const taken = new Set(['Sakura.Launcher-1.0.0-setup.exe', 'Sakura.Launcher-1.0.0-setup (2).exe'])
eq('a free name is used as it is', uniqueDownloadName('x-setup.exe', () => false), 'x-setup.exe')
eq(
  'the suffix goes before the extension, not after the name',
  uniqueDownloadName('Sakura.Launcher-1.0.0-setup.exe', (n) => n === 'Sakura.Launcher-1.0.0-setup.exe'),
  'Sakura.Launcher-1.0.0-setup (2).exe'
)
eq(
  '...and keeps counting',
  uniqueDownloadName('Sakura.Launcher-1.0.0-setup.exe', (n) => taken.has(n)),
  'Sakura.Launcher-1.0.0-setup (3).exe'
)
eq('a name with no extension', uniqueDownloadName('README', (n) => n === 'README'), 'README (2)')

eq('the size the release promised', checkSize(100, 100), 'ok')
eq('short', checkSize(100, 99), 'short')
eq('long', checkSize(100, 101), 'long')
eq('a release that declared no size cannot vouch for what arrived', checkSize(0, 500), 'unknown')
eq('...nor can a nonsense one', checkSize(Number.NaN, 500), 'unknown')

/* -------------------------------------------------------------------------- */
console.log('\n== against the repository itself ==')

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8')) as {
  version: string
  scripts: Record<string, string>
}

// The one input to decideUpdate no fixture can pin: whatever this build was cut from.
check(`this build's own version parses (${pkg.version})`, parseVersion(pkg.version) !== null)
eq('...and it is newer than the last published release', compareVersions(pkg.version, '0.10.0'), 1)
check('the harness is registered in package.json', pkg.scripts['update-test'] === 'node scripts/update-test.mts')

const source = fs.readFileSync(path.join(here, '..', 'src', 'main', 'update-rules.ts'), 'utf-8')
// A `import type { … } from 'electron'` is erased by node's type stripping, so importing
// the module proves nothing about it. The text does.
check('the module reaches no electron', !/from ['"]electron/.test(source))
const specifiers = [...source.matchAll(/from ['"](\.[^'"]*)['"]/g)].map((m) => m[1])
check(`every relative import names its extension (${specifiers.length} of them)`, specifiers.every((s) => s.endsWith('.ts')))

// One exported name, one contract. `save-rules.ts` exports `uniqueName` with a different
// one — it appends after the whole string, so a `.exe` becomes `…-setup.exe-2`, which
// Windows will not run. An auto-import of the wrong one is silent.
const clash = Object.keys(updateRules).filter((k) => k in saveRules)
deepEq('no export name collides with another pure module', clash, [])

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
