import { parentPort } from 'node:worker_threads'
import { breakdownOf, dirSize } from './scan-core'

export type WorkerRequest =
  | { kind: 'size'; id: string; dir: string }
  | { kind: 'breakdown'; id: string; dir: string }

export type WorkerResponse =
  | { kind: 'size'; id: string; dir: string; sizeBytes: number }
  | {
      kind: 'breakdown'
      id: string
      dir: string
      totalBytes: number
      entries: { name: string; path: string; sizeBytes: number; isDir: boolean }[]
    }
  | { kind: 'error'; id: string; message: string }

if (!parentPort) throw new Error('scanner.worker must run as a worker thread')

const port = parentPort

port.on('message', (req: WorkerRequest) => {
  try {
    if (req.kind === 'size') {
      const sizeBytes = dirSize(req.dir)
      port.postMessage({ kind: 'size', id: req.id, dir: req.dir, sizeBytes } satisfies WorkerResponse)
      return
    }
    const { totalBytes, entries } = breakdownOf(req.dir)
    port.postMessage({
      kind: 'breakdown',
      id: req.id,
      dir: req.dir,
      totalBytes,
      entries
    } satisfies WorkerResponse)
  } catch (err) {
    port.postMessage({
      kind: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err)
    } satisfies WorkerResponse)
  }
})
