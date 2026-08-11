import type { Game, LaunchTrouble } from '../shared/types'
import { pickErrorDialog } from './diagnose-rules.ts'
import { runningInDir, voidSession } from './playtime'
import { readWindowsIn } from './window-text.ts'

/**
 * Noticing that a game never actually appeared.
 *
 * This is deliberately separate from the play-time tracker, which watches the same folder
 * for the opposite reason. That one is tuned never to declare a game closed too early —
 * its 90-second grace exists so that self-extracting installers, UAC prompts and launcher
 * hand-offs are not mistaken for a two-second session. Reusing it here would mean waiting
 * a minute and a half before admitting that nothing happened, and re-tuning it would
 * break the measurement it exists for.
 *
 * So: a short, separate look. Two samples, then it is done and gone. Nothing here writes
 * to the database, and a game that turns out to be running simply cancels the watch.
 */

/**
 * When to look, counted from the launch.
 *
 * Three samples rather than two, because "it never appeared" and "it appeared and died"
 * are different failures with different answers, and one sample cannot tell them apart.
 * The early one catches a process that is about to crash; the last one is the verdict.
 */
const SAMPLE_MS = [3_000, 8_000, 18_000]

/**
 * A process that vanished this soon after launch crashed rather than being closed.
 *
 * Past this the honest reading is that somebody quit, and saying "it died" about a game
 * the user closed on purpose is exactly the kind of false alarm that would get this
 * feature switched off.
 */
const EARLY_EXIT_MS = 10_000

export interface LaunchTroubleReport {
  game: Game
  trouble: LaunchTrouble
  /** When the launch was made, so the diagnosis knows which logs are fresh. */
  startedAt: number
}

type Reporter = (report: LaunchTroubleReport) => void

let report: Reporter | null = null
const watching = new Set<string>()

export function onLaunchTrouble(fn: Reporter): void {
  report = fn
}

/** Stop watching — the game showed up, or the user is no longer interested. */
export function cancelWatch(gameId: string): void {
  watching.delete(gameId)
}

/**
 * Watch a folder briefly after a launch and speak up if nothing runs out of it.
 *
 * `runningInDir` returns null when the process query itself failed. That must never be
 * read as "nothing is running" — a machine under load can fail a query and would
 * otherwise be told its perfectly healthy game did not start. An inconclusive watch ends
 * quietly.
 */
export function watchLaunch(game: Game): void {
  if (watching.has(game.id)) return
  watching.add(game.id)

  const startedAt = Date.now()
  /** When we last saw a process, so a disappearance can be dated. */
  let lastSeen = 0

  const sample = async (index: number): Promise<void> => {
    if (!watching.has(game.id)) return

    const running = await runningInDir(game.dir)
    if (!watching.has(game.id)) return

    const last = index === SAMPLE_MS.length - 1

    if (running === null) {
      // Could not tell. Saying nothing is the only honest option.
      watching.delete(game.id)
      return
    }

    if (running) {
      lastSeen = Date.now()
      if (last) {
        watching.delete(game.id)
        // A process is not the same as a game. Before calling this a success, look at
        // what is actually on screen — an engine that failed usually says so in a
        // message box, and that box keeps the process alive indefinitely.
        const windows = await readWindowsIn(game.dir)
        const dialog = windows ? pickErrorDialog(windows) : null
        if (dialog) {
          // Whatever this is, it is not being played.
          voidSession(game.id)
          report?.({ game, trouble: 'dialog', startedAt })
        }
        return
      }
    }

    if (!last) {
      setTimeout(() => void sample(index + 1), SAMPLE_MS[index + 1] - SAMPLE_MS[index])
      return
    }

    watching.delete(game.id)
    if (lastSeen === 0) {
      report?.({ game, trouble: 'noshow', startedAt })
      return
    }
    // Seen earlier, gone now. Only call that a crash if it happened fast enough that
    // nobody could plausibly have played and quit.
    if (lastSeen - startedAt < EARLY_EXIT_MS) {
      report?.({ game, trouble: 'earlyexit', startedAt })
    }
  }

  setTimeout(() => void sample(0), SAMPLE_MS[0])
}
