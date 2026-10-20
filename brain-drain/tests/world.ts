// The world beneath the plugin in a test: files, host commands, settings and the session, all in memory.
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

export const HOME = '/h'
export const SID = 'abcdef12-0000-0000-0000-000000000000'
export const ROOT = '/work/proj'
/** Where Claude Code keeps a session's transcript: the project folder, every other character a dash. */
export const transcript = (sid = SID) => `${HOME}/.claude/projects/${ROOT.replace(/[^A-Za-z0-9]/g, '-')}/${sid}.jsonl`
export const BRIDGE_SETTINGS = { statusLine: { type: 'command', command: '/h/.claude/scripts/context-bridge.sh' } }

export type World = {
  files: Map<string, string>
  runs: string[][]
  status: (string | undefined)[]
  toasts: string[]
  store: Map<string, unknown>
  clock: MockClock
  /** The session id `$.session.id()` answers; a /clear changes it. */
  sid: string
  settings: unknown
  context: { tokens?: number; window: number; percent?: number }
  /** What `$.session.usage()` answers for the 5h and weekly windows; a test may change it. */
  rateLimits: SessionRateLimit[]
  mtimes: Map<string, number>
  surfaces: string[]
  /** Most characters one `tail -c +N` answers, as the engine caps stdout at 4 MiB. */
  tailCap: number
  /** While set, every `mv` waits for it, so a test can see what waits on the move. */
  mvGate?: Promise<void>
  /** Every `ui.invalidate` the plugin asked for. */
  invalidates: number
  /**
   * What Claude Code 2.1.300 does on /clear: a new session id, every `$.state`
   * value empty, no session.start. (An in-process /resume keeps `$.state`; a
   * test does that by setting `sid` alone.)
   */
  clear: (sid: string) => void
}

export type WorldOptions = {
  settings?: unknown
  files?: Record<string, string>
  now?: number
  context?: { tokens?: number; window: number; percent?: number }
  rateLimits?: SessionRateLimit[]
  store?: Record<string, unknown>
  noProcess?: boolean
  /** Every `mv` exits 1, as when the target directory is not writable. */
  mvFails?: boolean
  /** Environment beyond HOME. */
  env?: Record<string, string>
}

export function world(on: On, o: WorldOptions = {}): World {
  const w: World = {
    files: new Map(Object.entries(o.files ?? {})),
    runs: [],
    status: [],
    toasts: [],
    store: new Map(Object.entries(o.store ?? {})),
    clock: mock.clock(on, { now: o.now ?? Date.UTC(2026, 9, 3, 12, 0, 0) }),
    sid: SID,
    settings: o.settings ?? {},
    context: o.context ?? { window: 1000000 },
    rateLimits: o.rateLimits ?? [],
    mtimes: new Map(),
    surfaces: ['terminal'],
    tailCap: 4 * 1024 * 1024,
    invalidates: 0,
    clear: sid => {
      wiped = true
      setSince.clear()
      w.sid = sid
    },
  }
  // An emptied value reads as never written, at the version the kit holds, so a
  // compare-and-set still lands; a value written since reads as the kit has it.
  let wiped = false
  const setSince = new Set<string>()
  on('state.get', async ($, e, next) => {
    const got = (await next(e)) as { value?: { value: unknown; version: number } }
    if (!wiped || setSince.has(e.key) || !got.value) return got as never
    return { ...got, value: { ...got.value, value: undefined } } as never
  })
  on('state.set', async ($, e, next) => {
    setSince.add(e.key)
    return next(e)
  })
  mock.env(on, { HOME, ...(o.env ?? {}) })
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
  on('settings.read', () => ({ value: w.settings as never }))
  on('fs.read', ($, e) => (w.files.has(e.path) ? { value: w.files.get(e.path)! } : { deny: `ENOENT ${e.path}` }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    w.mtimes.set(e.path, w.clock.now())
    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    w.files.has(e.path)
      ? { value: { kind: 'file', size: w.files.get(e.path)!.length, mtimeMs: w.mtimes.get(e.path) ?? w.clock.now(), isLink: false } }
      : { deny: `ENOENT ${e.path}` },
  )
  on('fs.list', ($, e) => {
    const dir = e.path.endsWith('/') ? e.path : `${e.path}/`
    const names = [...w.files.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
    // A directory exists while a file sits somewhere below it.
    const dirs = [...new Set([...w.files.keys()].filter(k => k.startsWith(dir) && k.slice(dir.length).includes('/')).map(k => k.slice(dir.length).split('/')[0]!))]
    if (names.length === 0 && dirs.length === 0) return { deny: `ENOENT ${e.path}` }
    return {
      value: [
        ...names.map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: w.files.get(k)!.length, mtimeMs: w.mtimes.get(k) ?? w.clock.now(), isLink: false })),
        ...dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
      ] as never,
    }
  })
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (o.noProcess) return { deny: 'no host commands here' }
    if (argv[0] === 'mv') {
      if (w.mvGate) await w.mvGate
      if (o.mvFails) return { value: { exitCode: 1, stdout: '', stderr: 'denied', isStdoutTruncated: false, isStderrTruncated: false } }
      const [, , from, to] = argv
      if (from && to && w.files.has(from)) {
        w.files.set(to, w.files.get(from)!)
        w.mtimes.set(to, w.mtimes.get(from) ?? w.clock.now())
        w.files.delete(from)
        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      return { value: { exitCode: 1, stdout: '', stderr: 'missing', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'rm') {
      for (const f of argv.slice(1)) if (!f.startsWith('-')) w.files.delete(f)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'tail') {
      const text = w.files.get(argv[3] ?? '') ?? ''
      // `tail -c +N` starts at byte N (1-based); fixtures are ASCII, so a byte is a character.
      if (argv[2]?.startsWith('+')) {
        const from = Number(argv[2].slice(1)) - 1
        const out = text.slice(from, from + w.tailCap)
        return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: from + w.tailCap < text.length, isStderrTruncated: false } }
      }
      const n = Number(argv[2])
      return { value: { exitCode: 0, stdout: text.slice(Math.max(0, text.length - n)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: w.sid }))
  on('session.surfaces', () => ({ value: w.surfaces as never }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: w.context, rateLimits: w.rateLimits, cost: { usd: 0 } },
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
  on('ui.invalidate', () => {
    w.invalidates++
    return { value: undefined }
  })
  on('audio.play', () => ({ value: undefined }))
  return w
}

export async function start(
  $: { session: { start: (e: { cwd: string; surface: 'terminal' | null; isInteractive: boolean }) => Promise<unknown> } },
  isInteractive = true,
): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: isInteractive ? 'terminal' : null, isInteractive })
}

// The runtime has timers; the hooks module's types (no DOM, no Node) do not declare them.
const timer = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }

/** Resolves after `ms` of real time, not the mock clock's. */
export function sleep(ms: number): Promise<void> {
  return new Promise(r => timer.setTimeout(r, ms))
}

/** Lets queued work (a write the hook did not wait for) finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await sleep(0)
}

export function sessionFile(w: World, dir: string, sid = SID): Record<string, unknown> | undefined {
  const text = w.files.get(`${dir}/${sid}.json`)
  return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>)
}
