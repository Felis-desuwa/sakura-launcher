// Extension spelled out: `scripts/lossless-test.mts` loads this file straight into node.
import type { UpscaleTarget } from './upscale-rules.ts'
import { isOurProfile, ourProfileTitle } from './lossless-rules.ts'
import { losslessPresetFor } from '../shared/types.ts'

/**
 * Writing game profiles into Lossless Scaling's `Settings.xml` without taking anything
 * away from it.
 *
 * That file is **the user's own**, and there is no second copy. Magpie's integration is
 * built on a private copy under `%APPDATA%` that nobody else reads; this one has no such
 * escape, so every rule below exists to make an edit to somebody else's configuration
 * something they can live with:
 *
 *  - **No parse-and-reserialise.** Reading the whole document into a tree and writing it
 *    back would reformat it, reorder nothing helpfully, and quietly drop any element a
 *    future Lossless Scaling adds that this program has never heard of. Instead only the
 *    text between `<GameProfiles>` and `</GameProfiles>` is touched; every other byte of
 *    the file comes through unchanged, which the harness asserts.
 *  - **Only our own profiles are ever added or removed**, recognised by `SAKURA_PREFIX`
 *    and by nothing else. A profile the user made is read — cloned, even — and never
 *    written to.
 *  - **A profile is cloned, never composed.** Lossless Scaling's profile carries some forty
 *    fields: frame generation, GPU and display selection, cropping, and how the mouse
 *    behaves. Authoring those here would mean reimplementing that program's settings page
 *    inside this one and getting it wrong on the day they add a field. So the profile is
 *    copied verbatim and only four things are changed — its title, the executables it
 *    matches, and the two fields that make it fire by itself.
 *
 *    A **preset** (`LOSSLESS_PRESETS`) is the same clone with a handful of elements set on
 *    top, and it is deliberately not a second mechanism: it inherits everything it does not
 *    name, exactly as a plain clone does. What it overrides is only what makes a preset
 *    worth having — the scaling algorithm, keeping a 4:3 game's proportions, and frame
 *    generation off. Every value it writes is a verified member of the enum it belongs to;
 *    see the table in `shared/types.ts` for why that is not a detail.
 *  - **A mode that names no profile of theirs writes nothing.** Inventing a whole profile
 *    would be inventing picture settings the user never agreed to, in their program, under
 *    a name that looks like this one endorsed them. A preset asked for on an installation
 *    with no profile at all has nothing to clone either, and says so (`noBase`) rather than
 *    filling in the gap.
 *
 * Nothing here imports electron.
 */

/** Bounds on the auto-scale delay written into our profiles, in seconds. */
const MIN_DELAY = 0
const MAX_DELAY = 30

/** One `<Profile>` block, located in the text rather than parsed out of it. */
export interface LosslessProfile {
  title: string
  /** The `<Path>` filter, or null when the element is absent — which is their default profile. */
  path: string | null
  /** The whole block, `<Profile>` through `</Profile>`, exactly as it appears. */
  block: string
  /** Whitespace the block is indented by, so anything written keeps the file readable. */
  indent: string
  /** Whether this is one of ours. */
  ours: boolean
}

/** Decode the five XML entities. Nothing here produces character references. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Encode a value for an element's text.
 *
 * `&` first, or every entity written by the later replacements gets its ampersand escaped
 * a second time. Game folders with `&` in the name are ordinary enough that this is not a
 * theoretical concern.
 */
function encode(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Where `<GameProfiles>`'s contents start and end, or null when there is no such element. */
function profilesRegion(xml: string): { start: number; end: number } | null {
  const open = /<GameProfiles(\s[^>]*)?>/.exec(xml)
  if (!open) return null
  const start = open.index + open[0].length
  const end = xml.indexOf('</GameProfiles>', start)
  return end < 0 ? null : { start, end }
}

/** The text of the first `<Name>…</Name>` in a block, decoded, or null when absent. */
function elementText(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  return m ? decode(m[1]) : null
}

/**
 * Set one element's text inside a profile block, inserting it when it is not there.
 *
 * A missing `<Path>` is the normal state of the profile most people clone from — their
 * default one, which matches everything precisely because it names nothing — so inserting
 * rather than failing is the common path, not the edge case. It goes in after `<Title>`
 * so the block still reads top-down the way Lossless Scaling writes it.
 *
 * Order does not actually matter to the reader on the other side: `Settings.xml` carries
 * the `xsi`/`xsd` namespaces of .NET's `XmlSerializer`, which matches child elements by
 * name. Keeping the order tidy is for the person who opens the file, not the program.
 */
function setElement(block: string, name: string, value: string): string {
  const re = new RegExp(`(<${name}>)[\\s\\S]*?(</${name}>)`)
  if (re.test(block)) return block.replace(re, `$1${encode(value)}$2`)

  // `<Name />` is what .NET writes for an element it considers empty. No boolean or
  // enum ever comes back that way, so this was unreachable until this function began
  // writing `HdrSupport`; without it such an element would not match above and a
  // *second* one would be inserted, leaving the file with two answers to one question.
  const selfClosing = new RegExp(`<${name}\\s*/>`)
  if (selfClosing.test(block)) {
    return block.replace(selfClosing, `<${name}>${encode(value)}</${name}>`)
  }

  // The indentation and line ending the block's own children use, so an inserted element
  // does not sit at column zero in a file the user may well open.
  const child = /(\r?\n)([^\S\n]*)</.exec(block)
  const eol = child?.[1] ?? '\n'
  const indent = child?.[2] ?? '  '

  const title = new RegExp(`<Title>[\\s\\S]*?</Title>`).exec(block)
  const at = title ? title.index + title[0].length : block.indexOf('>') + 1
  return `${block.slice(0, at)}${eol}${indent}<${name}>${encode(value)}</${name}>${block.slice(at)}`
}

/**
 * Every `<Profile>` block inside `<GameProfiles>`, in the order the file lists them.
 *
 * A scanner rather than a parser: it looks for the tags and records where they are. That
 * is enough for everything done here and cannot be surprised by an element it has never
 * seen, which a schema-shaped reader would be.
 */
export function parseProfiles(xml: string): LosslessProfile[] {
  const region = profilesRegion(xml)
  if (!region) return []
  const inner = xml.slice(region.start, region.end)

  const out: LosslessProfile[] = []
  const re = /([^\S\n]*)<Profile(?:\s[^>]*)?>[\s\S]*?<\/Profile>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    const block = m[0].slice(m[1].length)
    const title = elementText(block, 'Title') ?? ''
    out.push({
      title,
      path: elementText(block, 'Path'),
      block,
      indent: m[1],
      ours: isOurProfile(title)
    })
  }
  return out
}

/**
 * The profile titles to offer as modes — the user's own, never ours.
 *
 * Ours are excluded because offering them would let a profile be cloned from a clone: the
 * name would still resolve, the settings would still be right, and the chain would survive
 * exactly until the day the original was deleted. More plainly, they are not choices the
 * user made; they are this program's own bookkeeping showing up in a menu.
 *
 * Empty means the file could not be read or holds nothing, and the caller has to say so
 * rather than substitute a list. There is no equivalent of Magpie's seven built-ins here:
 * this program does not know what is in somebody else's config until it reads it, and a
 * guess would be offered as a choice and then silently do nothing.
 */
export function listProfiles(xml: string): string[] {
  const out: string[] = []
  for (const profile of parseProfiles(xml)) {
    if (profile.ours) continue
    const title = profile.title.trim()
    if (title !== '' && !out.includes(title)) out.push(title)
  }
  return out
}

/** How many profiles in this file are ours. Shown in the settings page, nothing more. */
export function countOurProfiles(xml: string): number {
  return parseProfiles(xml).filter((p) => p.ours).length
}

/**
 * Lossless Scaling's own `<StartAsAdmin>`, read and never written.
 *
 * It decides whether the copy this program starts will raise a UAC prompt, and whether the
 * result can ever be stopped again. Both are things the user should be told before they
 * happen rather than after, and neither is this program's to change.
 */
export function startsElevated(xml: string): boolean {
  return (elementText(xml, 'StartAsAdmin') ?? '').trim().toLowerCase() === 'true'
}

/** Find one of the user's profiles by title, case- and space-insensitively. */
function findProfile(profiles: LosslessProfile[], mode: string): LosslessProfile | null {
  const want = mode.trim()
  const theirs = profiles.filter((p) => !p.ours)
  return (
    theirs.find((p) => p.title.trim() === want) ??
    theirs.find((p) => p.title.trim().toLowerCase() === want.toLowerCase()) ??
    null
  )
}

/**
 * The profile a preset is built on top of: the user's first, which is Lossless Scaling's
 * own default.
 *
 * A preset still has to be cloned from something — it overrides six elements and inherits
 * the other thirty-odd — and their default is the honest choice of base. It is the one
 * profile every installation has, and it holds whatever they settled on for the things a
 * preset deliberately does not decide: which GPU, which display, how the mouse moves.
 */
function baseProfile(profiles: LosslessProfile[]): LosslessProfile | null {
  return profiles.find((p) => !p.ours) ?? null
}

/**
 * What the profile currently driving `mode` says about HDR, or null when no such profile
 * exists yet or it does not say.
 *
 * Read from **our** profile rather than from the one it was cloned from, because ours is
 * what Lossless Scaling will actually use and the two drift apart: a correction made to
 * the base profile does not reach ours until the file can be rewritten, and that cannot
 * happen while Lossless Scaling is running. Reading the base would report the fix as
 * though it had landed, which is precisely how the original colour bug survived.
 */
export function activeHdrSupport(xml: string, mode: string): boolean | null {
  const preset = losslessPresetFor(mode)
  const want = ourProfileTitle(preset ? preset.title : mode.trim()).trim().toLowerCase()
  const ours = parseProfiles(xml).find((p) => p.ours && p.title.trim().toLowerCase() === want)
  if (!ours) return null
  const text = elementText(ours.block, 'HdrSupport')
  return text === null ? null : text.trim().toLowerCase() === 'true'
}

export interface DesiredLossless {
  targets: UpscaleTarget[]
  /** Seconds after a matching window appears. Clamped here, not trusted from settings. */
  delaySeconds: number
  /**
   * What our **preset** profiles should say about HDR, or null to leave the clone alone.
   *
   * The one field written from a measurement rather than copied or chosen. Lossless
   * Scaling's HDR switch describes the *screen*: on an HDR desktop everything it captures
   * arrives in a high-dynamic-range format whether the game is HDR or not, and a preset
   * that inherited a stale `false` from the profile it cloned presents that picture as
   * though it were SDR. The colour comes out wrong, nothing reports a fault, and the value
   * the user would have to correct is one they never chose — they picked an algorithm.
   *
   * **Null is not false.** A display query that could not answer leaves the cloned value
   * exactly as it found it; writing `false` on an unknown is the same bug pointing the
   * other way.
   *
   * Applied to presets and to nothing else. A mode naming one of the user's own profiles
   * is cloned and not corrected, because that value is theirs.
   */
  hdr: boolean | null
}

export interface LosslessConfigResult {
  xml: string
  /**
   * The profile list differs from what was on disk, so the file has to be rewritten — and
   * that can only be done while Lossless Scaling is not running.
   *
   * False in the steady state, and everything about how the profiles are built is in
   * service of that. It is a harder requirement here than it is for Magpie: Magpie can be
   * stopped and restarted around a write, and this program cannot stop the user's Lossless
   * Scaling at all. A result that reported a change on every launch would mean the file
   * could never be brought up to date after the first game of a session.
   */
  changed: boolean
  /** Modes that named no profile of the user's. Nothing was written for these. */
  missing: string[]
  /**
   * A preset was asked for and there was no profile of the user's to build it on.
   *
   * Distinct from `missing`, because it is a different problem with a different answer: a
   * missing mode is a name to correct, this is a Lossless Scaling that has never been
   * opened. Telling somebody their profile "Sakura Quality" was not found would send them
   * looking for something that was never theirs to make.
   */
  noBase: boolean
  /** How many profiles of ours the result holds. */
  written: number
}

/**
 * Merge the profiles we want into the file that is there.
 *
 * One profile per *mode*, not per game — the executables that share a mode share a
 * profile, joined by the semicolons Lossless Scaling's own filter field uses. A library of
 * two hundred games would otherwise put two hundred entries into a list the user reads in
 * their own program, to say a handful of distinct things.
 *
 * Full paths rather than executable names, because `game.exe` is not a rare name in this
 * library; two folders with the same one are ordinary, and a filter on the bare name would
 * scale both with whichever profile came first.
 *
 * **The written order is sorted, not ranked.** `upscaleTargets` hands these over most
 * recently played first, which is the right order for deciding *which* games fit under the
 * cap and the wrong one for writing them down: it changes every time anything is launched,
 * and the resulting file would differ from the last one on every single launch. Since a
 * rewrite requires Lossless Scaling to be closed, that would mean the config could never
 * be updated once the first game of a session had started it.
 */
export function buildSettingsXml(xml: string, desired: DesiredLossless): LosslessConfigResult {
  const region = profilesRegion(xml)
  const profiles = parseProfiles(xml)
  const delay = Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.round(desired.delaySeconds)))

  // Grouped case-insensitively, but remembering the spelling that was actually stored, so
  // the profile we write is named the way the user's own list spells it.
  const groups = new Map<string, { mode: string; exes: string[] }>()
  for (const target of desired.targets) {
    const mode = target.mode.trim()
    if (mode === '') continue
    const key = mode.toLowerCase()
    const group = groups.get(key) ?? { mode, exes: [] }
    group.exes.push(target.exe)
    groups.set(key, group)
  }

  const missing: string[] = []
  const blocks: string[] = []
  const titles = new Set<string>()
  let noBase = false

  /**
   * Keep two of our profiles from carrying the same name.
   *
   * Only reachable when the user has a profile titled exactly like a preset — a profile
   * called `Quality` alongside the Quality preset — which is rare and not an error. Two
   * identically named entries in their list would be, though: they would have no way to
   * tell which of their games each one covered. Deterministic because the groups are
   * already sorted, so this cannot make `changed` unstable.
   */
  const unique = (title: string): string => {
    let out = title
    for (let n = 2; titles.has(out); n++) out = `${title} (${n})`
    titles.add(out)
    return out
  }

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!
    const preset = losslessPresetFor(group.mode)

    // A preset clones the user's default and overrides a handful of elements; a mode that
    // names one of their profiles clones that one and overrides none. Everything after this
    // is the same for both, which is the point — a preset is not a second mechanism.
    const source = preset ? baseProfile(profiles) : findProfile(profiles, group.mode)
    if (!source) {
      if (preset) noBase = true
      else missing.push(group.mode)
      continue
    }

    const exes = [...new Set(group.exes)].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0
    )
    let block = source.block
    for (const [name, value] of Object.entries(preset?.fields ?? {})) {
      block = setElement(block, name, value)
    }

    // Only a preset is told about the screen. A preset is this program's choice of a
    // scaling algorithm, which makes the fields deciding whether the picture is *correct*
    // this program's to get right; a mode naming one of the user's own profiles is a clone
    // and overrides nothing, so a disagreement there is pointed out in the settings page
    // and left alone. Deliberately not a member of `LOSSLESS_PRESETS.fields`: that table
    // describes a preset and this describes the machine, and putting it there would freeze
    // a measurement into a constant, five times over.
    if (preset && desired.hdr !== null) {
      block = setElement(block, 'HdrSupport', desired.hdr ? 'true' : 'false')
    }
    block = setElement(
      block,
      'Title',
      unique(ourProfileTitle(preset ? preset.title : source.title.trim()))
    )
    block = setElement(block, 'Path', exes.join(';'))
    block = setElement(block, 'AutoScale', 'true')
    block = setElement(block, 'AutoScaleDelay', String(delay))
    blocks.push(source.indent + block)
  }

  // No `<GameProfiles>` at all — a file Lossless Scaling has not written yet, or one shaped
  // in a way this scanner does not recognise. There is nothing to clone from either, so
  // every mode is reported missing and the file is left exactly as found. Creating the
  // element would mean authoring a profile out of nothing, which is the one thing this
  // module refuses to do.
  if (!region) {
    return {
      xml,
      changed: false,
      missing: [...groups.values()].filter((g) => !losslessPresetFor(g.mode)).map((g) => g.mode),
      noBase: [...groups.values()].some((g) => losslessPresetFor(g.mode)),
      written: 0
    }
  }

  const inner = xml.slice(region.start, region.end)
  const kept = profiles.filter((p) => !p.ours)
  const lines = [...kept.map((p) => p.indent + p.block), ...blocks]

  // The newline layout the region already had, so a file written by Lossless Scaling keeps
  // looking like one. `tail` is what sits before `</GameProfiles>` — the closing tag's own
  // indentation — and is also the whole answer when nothing at all is left to write: a
  // region emptied that way still has to *become* empty, or a library that switched every
  // game off would keep the profiles it no longer wants.
  const eol = /^\r?\n/.exec(inner)?.[0] ?? '\n'
  const tail = /\r?\n[^\S\n]*$/.exec(inner)?.[0] ?? ''
  const rebuilt = lines.length > 0 ? eol + lines.join(eol) + tail : tail

  return {
    xml: xml.slice(0, region.start) + rebuilt + xml.slice(region.end),
    changed: rebuilt !== inner,
    missing,
    noBase,
    written: blocks.length
  }
}
