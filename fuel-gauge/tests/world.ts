// The world beneath the plugin in a test: files, host commands, settings and the session, all in memory.
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

export const HOME = '/h'
export const SID = 'abcdef12-0000-0000-0000-000000000000'
export const ROOT = '/work/proj'
export const BRIDGE_SETTINGS = { statusLine: { type: 'command', command: '/h/.claude/scripts/context-bridge.sh' } }

export type World = {
  files: Map<string, string>
  runs: string[][]
  status: (string | undefined)[]
  toasts: string[]
  store: Map<string, unknown>
  clock: MockClock
}

export type WorldOptions = {
  settings?: unknown
  files?: Record<string, string>
  now?: number
  context?: { tokens?: number; window: number; percent?: number }
  rateLimits?: SessionRateLimit[]
  store?: Record<string, unknown>
  noProcess?: boolean
}

export function world(on: On, o: WorldOptions = {}): World {
  const w: World = {
    files: new Map(Object.entries(o.files ?? {})),
    runs: [],
    status: [],
    toasts: [],
    store: new Map(Object.entries(o.store ?? {})),
    clock: mock.clock(on, { now: o.now ?? Date.UTC(2026, 9, 3, 12, 0, 0) }),
  }
  mock.env(on, { HOME })
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('settings.read', () => ({ value: (o.settings ?? {}) as never }))
  on('fs.read', ($, e) => (w.files.has(e.path) ? { value: w.files.get(e.path)! } : { deny: `ENOENT ${e.path}` }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    w.files.has(e.path) ? { value: { kind: 'file', size: w.files.get(e.path)!.length, mtimeMs: 0, isLink: false } } : { deny: `ENOENT ${e.path}` },
  )
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (o.noProcess) return { deny: 'no host commands here' }
    if (argv[0] === 'mv') {
      const [, , from, to] = argv
      if (from && to && w.files.has(from)) {
        w.files.set(to, w.files.get(from)!)
        w.files.delete(from)
        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      return { value: { exitCode: 1, stdout: '', stderr: 'missing', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'tail') {
      const n = Number(argv[2])
      const text = w.files.get(argv[3] ?? '') ?? ''
      return { value: { exitCode: 0, stdout: text.slice(Math.max(0, text.length - n)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: o.context ?? { window: 1000000 }, rateLimits: o.rateLimits ?? [], cost: { usd: 0 } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('audio.play', () => ({ value: undefined }))
  return w
}

export async function start($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

export function sessionFile(w: World, dir: string): Record<string, unknown> | undefined {
  const text = w.files.get(`${dir}/${SID}.json`)
  return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>)
}
