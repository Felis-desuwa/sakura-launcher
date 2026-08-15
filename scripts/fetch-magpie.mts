import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { MAGPIE_VERSION } from '../src/main/magpie-rules.ts'

/**
 * Fetch the Magpie release this program ships, and prove it is the one we mean.
 *
 * The binary is not in this repository. Ten megabytes of executable in git would be bad
 * enough on its own, but the deciding reason is the promise made about it: what is
 * shipped is an *unmodified* upstream release, and a checked-in copy is only as
 * trustworthy as whoever last touched it. Downloading it at build time against a hash
 * pinned here is the only version of that claim anyone can verify.
 *
 * A mismatch fails the build outright. It means either the network handed us something
 * else or upstream re-cut the tag — and both are things a person has to look at, not
 * things to package up and hand to a user.
 *
 * **This is the one part of this project that uses the network.** The program itself
 * still does not, and neither does Magpie once it is installed: `autoCheckForUpdates` is
 * forced off in the config we write. See `magpie-config.ts`.
 */

const ASSET = `Magpie-v${MAGPIE_VERSION}-x64.zip`
const URL = `https://github.com/Blinue/Magpie/releases/download/v${MAGPIE_VERSION}/${ASSET}`

/** SHA-256 of the asset above, taken from the published release. */
const SHA256 = '8bc8bc233438f546b7996b00b21d7376f4f7d3d8a4940e6a8800babd2225b2de'

/** What the archive must contain for the copy to be usable at all. */
const REQUIRED = ['Magpie.exe', 'effects']

const root = path.resolve(import.meta.dirname, '..')
const dest = path.join(root, 'resources', 'magpie')
const stampFile = path.join(dest, 'sakura-fetch.json')

const run = promisify(execFile)

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Already unpacked, at this version, with the pieces that matter. */
function upToDate(): boolean {
  try {
    const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf-8'))
    if (stamp?.version !== MAGPIE_VERSION || stamp?.sha256 !== SHA256) return false
    return REQUIRED.every((entry) => fs.existsSync(path.join(dest, entry)))
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  if (upToDate()) {
    console.log(`Magpie v${MAGPIE_VERSION} is already in resources/magpie`)
    return
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-magpie-'))
  const zip = path.join(tmp, ASSET)

  console.log(`Downloading ${URL}`)
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${ASSET}`)
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))

  const got = sha256(zip)
  if (got !== SHA256) {
    // Deliberately fatal, and deliberately loud. Shipping whatever arrived would make the
    // "unmodified upstream release" line in THIRD-PARTY-NOTICES.md a guess.
    throw new Error(`SHA-256 mismatch for ${ASSET}\n  expected ${SHA256}\n  got      ${got}`)
  }
  console.log(`SHA-256 verified: ${got}`)

  // Everything but our own stamp goes, so a version bump cannot leave last version's
  // effect files behind for the new binary to load.
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })

  // Node has no unzip of its own, and Expand-Archive is the same route the rest of this
  // program takes for anything Windows-shaped.
  await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' ` +
      `-DestinationPath '${dest.replace(/'/g, "''")}' -Force`
  ])

  const missing = REQUIRED.filter((entry) => !fs.existsSync(path.join(dest, entry)))
  if (missing.length > 0) throw new Error(`archive is missing ${missing.join(', ')}`)

  fs.writeFileSync(
    stampFile,
    JSON.stringify({ version: MAGPIE_VERSION, sha256: SHA256, asset: ASSET }, null, 2)
  )
  fs.rmSync(tmp, { recursive: true, force: true })

  const files = fs.readdirSync(dest, { recursive: true, withFileTypes: true })
  console.log(`Unpacked ${files.filter((f) => f.isFile()).length} files into resources/magpie`)
}

main().catch((err) => {
  console.error(`\nfetch-magpie failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
