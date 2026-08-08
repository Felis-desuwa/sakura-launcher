/**
 * Reading dropped files from a drag that came in from Explorer.
 *
 * Two things here are easy to get wrong and both make a drop silently do nothing:
 *
 * An element only becomes a valid drop target if it cancels *both* `dragenter` and
 * `dragover`. Cancelling only the latter leaves Chromium refusing the drop, with no
 * error and no visible sign that anything was ever offered.
 *
 * And `File.path` was removed in Electron 32, so the path has to come from
 * `webUtils.getPathForFile` in the preload. When that returns nothing there is no path
 * to be had — which must be reported rather than filtered away, or the drop looks
 * exactly like a drop onto dead space.
 */

/**
 * Whether a drag carries files rather than something from inside the window.
 *
 * `dataTransfer.files` is empty until the drop itself, so while the pointer is still
 * moving the advertised types are the only thing to go on.
 */
export function dragHasFiles(e: React.DragEvent): boolean {
  return [...e.dataTransfer.types].includes('Files')
}

export interface DroppedPaths {
  paths: string[]
  /** Files that were offered but whose path could not be read. */
  unreadable: number
}

export function pathsFromDrop(e: React.DragEvent): DroppedPaths {
  const files = [...e.dataTransfer.files]
  const paths: string[] = []
  let unreadable = 0

  for (const file of files) {
    let resolved = ''
    try {
      resolved = window.sakura.pathForFile(file) || ''
    } catch {
      resolved = ''
    }
    // Electron before 32 put the path on the File itself; harmless to try, and it
    // costs nothing to keep working if the runtime ever hands one back.
    if (!resolved) resolved = (file as File & { path?: string }).path ?? ''
    if (resolved) paths.push(resolved)
    else unreadable++
  }

  return { paths, unreadable }
}
