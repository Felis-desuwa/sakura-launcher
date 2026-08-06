import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { BreakdownEntry } from '../shared/types'
import type { WorkerRequest, WorkerResponse } from './scanner.worker'

type Resolver = (res: WorkerResponse) => void

let worker: Worker | null = null
let seq = 0
const pending = new Map<string, Resolver>()

function workerPath(): string {
  // electron-vite emits the worker beside the main bundle.
  return path.join(__dirname, 'scanner.worker.js')
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(workerPath())
  worker.on('message', (res: WorkerResponse) => {
    const resolve = pending.get(res.id)
    if (resolve) {
      pending.delete(res.id)
      resolve(res)
    }
  })
  worker.on('error', () => {
    // Fail every in-flight request, then let the next call spin up a fresh worker.
    for (const [id, resolve] of pending) {
      resolve({ kind: 'error', id, message: 'worker crashed' })
    }
    pending.clear()
    worker = null
  })
  worker.unref()
  return worker
}

function send(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
  const id = String(++seq)
  const w = ensureWorker()
  return new Promise((resolve) => {
    pending.set(id, resolve)
    w.postMessage({ ...req, id } as WorkerRequest)
  })
}

export async function computeSize(dir: string): Promise<number | null> {
  const res = await send({ kind: 'size', dir })
  return res.kind === 'size' ? res.sizeBytes : null
}

export async function computeBreakdown(
  dir: string
): Promise<{ totalBytes: number; entries: BreakdownEntry[] } | null> {
  const res = await send({ kind: 'breakdown', dir })
  if (res.kind !== 'breakdown') return null
  return { totalBytes: res.totalBytes, entries: res.entries }
}

export function shutdown(): void {
  worker?.terminate()
  worker = null
}
