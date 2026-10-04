import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import * as core from './core.ts'
import type { FuelMeta, FuelMiss, FuelPrefs, FuelReading } from '../types'

// Fuel Gauge as a mod: the data source for the VS Code extension (the bridge's
// session file) and a coloured band above the prompt. Never calls a model,
// never compacts, never touches the prompt: every prompt hook passes through.

const reading = atom({ plugin: 'fuel-gauge', key: 'reading' } as const, null)
const prefs = atom({ plugin: 'fuel-gauge', key: 'prefs' } as const, null)
const drafting = atom({ plugin: 'fuel-gauge', key: 'drafting' } as const, false)
const turns = atom({ plugin: 'fuel-gauge', key: 'turns' } as const, null)
const meta = atom({ plugin: 'fuel-gauge', key: 'meta' } as const, null)

const DEFAULT_PREFS: FuelPrefs = { style: core.DEFAULT_STYLE, place: 'below', warnSeconds: 60, sound: false }
const CHIME = 'assets/chime.wav'
const MISS_RETENTION_S = 60 * 86400

type $ = EngineInterface

async function nowS($: $): Promise<number> {
  return (await $.clock.now()) / 1000
}

async function getPrefs($: $): Promise<FuelPrefs> {
  return (await read($, prefs)) ?? DEFAULT_PREFS
}

async function setPrefs($: $, change: Partial<FuelPrefs>): Promise<FuelPrefs> {
  const next = { ...(await getPrefs($)), ...change }
  await update($, prefs, () => next)
  await $.store.set('prefs', next)
  return next
}

async function getMeta($: $): Promise<FuelMeta> {
  return (await read($, meta)) ?? {}
}

async function patchMeta($: $, change: Partial<FuelMeta>): Promise<void> {
  await update($, meta, m => ({ ...(m ?? {}), ...change }))
}

async function patchReading($: $, fn: (r: FuelReading) => FuelReading): Promise<FuelReading> {
  let out = core.emptyReading()
  await update($, reading, r => {
    out = fn(r ?? core.emptyReading())
    return out
  })
  return out
}

async function readJson($: $, path: string): Promise<unknown> {
  try {
    return JSON.parse((await $.fs.read(path)) as string)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- writing files

// `$.fs.write` is not atomic, so a file is written beside its target and moved
// into place. A failed move removes its temp file; `$.fs` cannot delete, so a
// host with no commands at all leaves that one file, once per process.
let canMove = true

async function writeAtomic($: $, path: string, text: string): Promise<void> {
  if (canMove) {
    const tmp = `${path}.mod-${Math.random().toString(36).slice(2, 10)}.tmp`
    await $.fs.write(tmp, text)
    try {
      const moved = await $.process.run(['mv', '-f', tmp, path], { timeoutMs: 5000 })
      if (moved.exitCode === 0) return
      await $.process.run(['rm', '-f', tmp], { timeoutMs: 5000 }).catch(() => undefined)
    } catch {
      // No host commands here (a host other than the CLI): write in place from now on.
      canMove = false
    }
  }
  await $.fs.write(path, text)
}

let writeChain: Promise<void> = Promise.resolve()

/** Queues a write of this session's file; writes run one at a time, each from the latest reading. */
function writeSessionFile($: $): Promise<void> {
  writeChain = writeChain.then(() => doWriteSessionFile($)).catch(() => undefined)
  return writeChain
}

async function doWriteSessionFile($: $): Promise<void> {
  await syncSession($)
  const m = await getMeta($)
  const r = await read($, reading)
  // A `claude -p` run has no status line, so the bridge writes no file for it.
  // Neither does the mod: in primary mode it would take over the VS Code gauge.
  if (!m.interactive || !m.outDir || !r) return
  const ids = { sessionId: await $.session.id(), cwd: await $.session.cwd(), projectDir: await $.session.root() }
  const file = core.sessionFile(r, ids, await nowS($))
  await writeAtomic($, `${m.outDir}/${ids.sessionId}.json`, JSON.stringify(file, null, 2))
}

/**
 * session.start fires once per process, never on /clear, so the reading would
 * outlive its session. When the id changes the reading starts again: from this
 * mod's own file for that id (a /resume), else empty but for the account's
 * TTL, the rate limits and the model.
 */
async function syncSession($: $): Promise<void> {
  const id = await $.session.id()
  const m = await getMeta($)
  if (m.sessionId === id) return
  await patchMeta($, { sessionId: id, alertedFor: undefined, pendingMiss: undefined })
  const prev = await read($, reading)
  if (m.sessionId === undefined || !prev) return
  const own = m.outDir ? core.readingFromFile(await readJson($, `${m.outDir}/${id}.json`), prev.ttl, prev.ttlSource) : undefined
  const usage = await $.session.usage()
  const next = { ...(own ?? core.freshSession(prev)), rateLimits: core.limitsFrom(usage.rateLimits), costUsd: usage.cost?.usd }
  await update($, reading, () => applyContext(next, usage.context))
}

// ---------------------------------------------------------------- the bridge handover

async function chooseOutDir($: $, home: string): Promise<{ outDir: string; shadow: boolean }> {
  let live = true
  try {
    // The merged settings: what this session actually runs, a project's override included.
    live = core.bridgeLive(await $.settings.read())
  } catch {
    // Unreadable: assume the bridge is live and stay out of its directory.
  }
  return { outDir: core.outDirFor(home, live), shadow: live }
}

async function accountTtl($: $, m: FuelMeta): Promise<number | undefined> {
  const paths = [`${m.outDir}/account_ttl.json`]
  if (m.home && m.shadow) paths.push(`${m.home}/${core.PRIMARY_DIR}/account_ttl.json`)
  for (const p of paths) {
    const f = (await readJson($, p)) as { detected_ttl?: unknown } | undefined
    if (f && typeof f.detected_ttl === 'number' && f.detected_ttl > 0) return f.detected_ttl
  }
  return undefined
}

// The extension prunes its own directory (session files after 36 h, temp files
// after 1 h). Nothing prunes the shadow directory, so the mod does, alike.
const SESSION_MAX_AGE_MS = 36 * 3600_000
const TMP_MAX_AGE_MS = 3600_000
const META_FILES = new Set(['account_ttl.json', 'config.json'])

async function pruneShadow($: $, m: FuelMeta): Promise<void> {
  if (!m.shadow || !m.interactive || !m.outDir || !canMove) return
  const now = await $.clock.now()
  const stale: string[] = []
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(m.outDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.kind !== 'file' || META_FILES.has(entry.name)) continue
    const maxAge = entry.name.endsWith('.tmp') ? TMP_MAX_AGE_MS : entry.name.endsWith('.json') ? SESSION_MAX_AGE_MS : undefined
    if (maxAge === undefined) continue
    const path = `${m.outDir}/${entry.name}`
    try {
      if ((await $.fs.stat(path)).mtimeMs < now - maxAge) stale.push(path)
    } catch {
      // gone already
    }
  }
  if (stale.length > 0) await $.process.run(['rm', '-f', ...stale], { timeoutMs: 5000 }).catch(() => undefined)
}

// ---------------------------------------------------------------- exact TTL from the transcript

async function tail($: $, path: string, bytes: number, size: number): Promise<string> {
  if (canMove) {
    try {
      const r = await $.process.run(['tail', '-c', String(bytes), path], { timeoutMs: 5000 })
      if (r.exitCode === 0) return r.stdout
    } catch {
      // fall through to a whole read
    }
  }
  if (size > 4 * 1024 * 1024) throw new Error('transcript too large to read whole')
  const text = (await $.fs.read(path)) as string
  return text.slice(Math.max(0, text.length - bytes))
}

async function refreshTtl($: $): Promise<void> {
  const m = await getMeta($)
  const path = m.transcriptPath
  if (!path || !m.outDir) return
  // Headless with nothing drawing: the TTL would show nowhere, so spawn nothing for it.
  if (!m.interactive && (await $.session.surfaces()).length === 0) return
  let size = 0
  try {
    size = (await $.fs.stat(path)).size
  } catch {
    return
  }
  let found: { ttl: number; atS: number } | undefined
  for (const window of core.TAIL_WINDOWS) {
    const cut = size > window
    try {
      found = core.ttlFromTail(await tail($, path, window, size), cut)
    } catch {
      return
    }
    if (found || !cut) break
  }
  if (!found) return
  const hit = found
  await patchReading($, r => ({ ...r, ttl: hit.ttl, ttlSource: 'transcript' }))
  const accountPath = `${m.outDir}/account_ttl.json`
  const stored = (await readJson($, accountPath)) as { detected_ttl?: number; detected_at?: number } | undefined
  if (m.interactive && core.shouldWriteAccountTtl(stored, hit.ttl, hit.atS)) {
    await writeAtomic($, accountPath, JSON.stringify({ detected_ttl: hit.ttl, detected_at: hit.atS }))
  }
}

// turn.start does not say whose turn it is; turn.step and turn.complete do.
async function dropTurn($: $, turnId: string): Promise<void> {
  if (!(await read($, turns))?.includes(turnId)) return
  await update($, turns, t => (t ?? []).filter(id => id !== turnId))
}

// ---------------------------------------------------------------- display

let lastStatus: string | undefined

async function currentView($: $): Promise<{ view: core.View; r: FuelReading } | undefined> {
  const r = await read($, reading)
  if (!r) return undefined
  return { view: core.makeView(r, await nowS($), await read($, drafting)), r }
}

async function refreshStatusLine($: $): Promise<void> {
  const p = await getPrefs($)
  let text: string | undefined
  if (p.style === 'line') {
    const cv = await currentView($)
    text = cv ? core.lineText(cv.view) : undefined
  }
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function tick($: $): Promise<void> {
  const p = await getPrefs($)
  const r = await read($, reading)
  if (!r) return
  const t = await nowS($)
  const c = core.cacheState(r, t)
  const isTicking = c.kind === 'live' || (c.kind === 'expired' && c.since <= 2)
  if (isTicking && core.isBandStyle(p.style)) $.ui.invalidate('ui.render')
  if (p.style === 'line') await refreshStatusLine($)

  // The expiry alert: once per cache window, only while no turn runs.
  if (c.kind !== 'live' || p.warnSeconds <= 0 || c.left > p.warnSeconds) return
  if ((await read($, turns))?.length) return
  const m = await getMeta($)
  if (m.alertedFor === r.lastApiS) return
  await patchMeta($, { alertedFor: r.lastApiS })
  $.ui.toast(`Cache expires in ${c.left} s · the next message re-writes ~${core.fmtTokens(r.tokens ?? 0)} tokens`, { timeoutMs: 8000 })
  if (p.sound) $.audio.play({ asset: CHIME }).catch(() => undefined)
}

// ---------------------------------------------------------------- the ledger

async function misses($: $): Promise<FuelMiss[]> {
  const out: FuelMiss[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('miss:')) continue
    const v = (await $.store.get(key)) as FuelMiss | undefined
    if (v && typeof v.at === 'number') out.push(v)
  }
  return out
}

async function pruneMisses($: $): Promise<void> {
  const cutoff = (await nowS($)) - MISS_RETENTION_S
  for (const key of await $.store.keys()) {
    if (!key.startsWith('miss:')) continue
    const atMs = Number(key.split(':')[1])
    if (Number.isFinite(atMs) && atMs / 1000 < cutoff) await $.store.delete(key)
  }
}

// ---------------------------------------------------------------- /fuel

const SAMPLE: FuelReading = {
  ...core.emptyReading(3600, 'transcript'),
  percent: 31,
  tokens: 312000,
  window: 1000000,
  rateLimits: [
    { kind: 'five_hour', pct: 72 },
    { kind: 'seven_day', pct: 44 },
  ],
  model: 'claude-opus-5-5',
  effort: 'xhigh',
  lastApiS: 0,
  observed: true,
}

async function runCommand($: $, args: string): Promise<string> {
  const [sub = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (sub.toLowerCase()) {
    case 'help':
      return ['Fuel Gauge commands:', ...core.HELP].join('\n')
    case 'styles': {
      const live = await read($, reading)
      const t = await nowS($)
      const r = live && live.percent !== undefined ? live : { ...SAMPLE, lastApiS: t - 2 }
      const p = await getPrefs($)
      const lines = [live && live.percent !== undefined ? 'Styles, with this session\'s figures:' : 'Styles, with sample figures:']
      for (const style of core.STYLES) {
        lines.push('', `${style}${style === p.style ? '  (current)' : ''}`)
        lines.push(...core.styleText(style, core.makeView(r, t, false)).split('\n').map(l => `  ${l}`))
      }
      lines.push('', 'While the cache has expired and the prompt box holds text, the band adds:')
      lines.push(`  ${core.styleText('minimal', core.makeView({ ...r, lastApiS: t - r.ttl - 60 }, t, true)).split('\n')[1] ?? ''}`)
      lines.push('', 'Switch with /fuel style <name>.')
      return lines.join('\n')
    }
    case 'style': {
      if (!core.isStyle(arg)) return `Unknown style "${arg}". Styles: ${core.STYLES.join(', ')}.`
      await setPrefs($, { style: arg })
      await refreshStatusLine($)
      $.ui.invalidate('ui.render')
      return arg === 'off'
        ? 'Display off. The session file for the VS Code extension is still written.'
        : arg === 'line'
          ? 'Style: line (plain text under the prompt; Claude Code prefixes it with the mod name).'
          : `Style: ${arg}.`
    }
    case 'place': {
      if (arg !== 'below' && arg !== 'above') return 'Place: below (under the prompt, the default) or above (the band above the prompt).'
      await setPrefs($, { place: arg })
      $.ui.invalidate('ui.render')
      return `Place: ${arg} the prompt.`
    }
    case 'warn': {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 0 || n > 3600) return 'Give whole seconds from 0 to 3600, e.g. /fuel warn 90. 0 turns the alert off.'
      await setPrefs($, { warnSeconds: n })
      return n === 0 ? 'Expiry alert off.' : `Expiry alert ${n} s before the cache expires.`
    }
    case 'sound': {
      const v = arg.toLowerCase()
      if (v !== 'on' && v !== 'off') return 'Use /fuel sound on or /fuel sound off.'
      await setPrefs($, { sound: v === 'on' })
      if (v === 'on') {
        try {
          await $.audio.play({ asset: CHIME })
        } catch (err) {
          return `Sound on, but the sample did not play: ${String(err)}`
        }
        return 'Sound on (that was the chime).'
      }
      return 'Sound off.'
    }
    case '':
    case 'report': {
      const p = await getPrefs($)
      const m = await getMeta($)
      const r = await read($, reading)
      const dir = m.outDir && m.home ? m.outDir.replace(m.home, '~') : '(not writing: no HOME)'
      const lines = ['Fuel Gauge · cache misses (a request after the TTL ran out that re-wrote the cache)']
      lines.push(...core.ledgerReport(await misses($), await nowS($)))
      lines.push('Cost is the session ledger\'s measured rise over the turn that opened cold; misses before a cost reading have none.')
      lines.push('')
      lines.push(`TTL ${r ? `${r.ttl >= 3600 ? '1h' : '5m'} (${r.ttlSource})` : 'unknown'} · style ${p.style} · alert ${p.warnSeconds > 0 ? `${p.warnSeconds} s` : 'off'} · sound ${p.sound ? 'on' : 'off'}`)
      if (!m.interactive) lines.push('Session file: not written (not an interactive session)')
      else lines.push(`Session file: ${dir}${m.shadow ? ' (shadow copy: the bridge is still the status line, so its directory is left alone)' : ''}`)
      lines.push('More: /fuel help')
      return lines.join('\n')
    }
    default:
      return `Unknown subcommand "${sub}".\n${core.HELP.join('\n')}`
  }
}

// ---------------------------------------------------------------- setup

async function setup($: $): Promise<void> {
  await $.command.register({
    name: 'fuel',
    description: 'Fuel Gauge: cache-miss report, display styles, expiry alert',
    argumentHint: '[help|styles|style <name>|place below|above|warn <s>|sound on|off]',
    immediate: true,
  })

  const stored = (await $.store.get('prefs')) as Partial<FuelPrefs> | undefined
  const p: FuelPrefs = { ...DEFAULT_PREFS, ...(stored ?? {}) }
  if (!core.isStyle(p.style)) p.style = core.DEFAULT_STYLE
  if (p.place !== 'below' && p.place !== 'above') p.place = 'below'
  await update($, prefs, () => p)

  const home = await $.env.get('HOME')
  const where = home ? await chooseOutDir($, home) : { outDir: undefined, shadow: false }
  await patchMeta($, { home, outDir: where.outDir, shadow: where.shadow })
  await syncSession($)
  const m = await getMeta($)

  // A reload keeps the reading in $.state. A new process seeds it from this
  // mod's own earlier file (a resume), else from the account's TTL.
  if (!(await read($, reading)) && m.outDir) {
    const acct = await accountTtl($, m)
    const ttl = acct ?? core.DEFAULT_TTL
    const source = acct ? 'account' : 'default'
    const own = core.readingFromFile(await readJson($, `${m.outDir}/${await $.session.id()}.json`), ttl, source)
    await update($, reading, () => own ?? core.emptyReading(ttl, source))
  } else if (!(await read($, reading))) {
    await update($, reading, () => core.emptyReading())
  }

  const usage = await $.session.usage()
  await patchReading($, r => applyContext({ ...r, rateLimits: core.limitsFrom(usage.rateLimits), costUsd: usage.cost?.usd ?? r.costUsd }, usage.context))
  await pruneMisses($)
  await pruneShadow($, m)
  await writeSessionFile($)
  lastStatus = undefined
  await refreshStatusLine($)
  $.clock.every(1000, () => {
    void tick($).catch(() => undefined)
  })
}

function applyContext(r: FuelReading, c: { tokens?: number; window: number; percent?: number }): FuelReading {
  if (c.tokens === undefined) {
    // A fresh session has no fill yet. After a compact (or on a resume) the
    // fill is not known: hold the last figure and flag it, as the bridge does.
    const held = (r.percent ?? 0) > 0
    return {
      ...r,
      window: c.window,
      unknown: held,
      percent: held ? r.percent : 0,
      // A compact seen by this process starts the cache clock again.
      lastApiS: held && r.observed ? undefined : r.lastApiS,
      observed: held && r.observed ? false : r.observed,
    }
  }
  return { ...r, tokens: c.tokens, window: c.window, percent: c.percent ?? r.percent, unknown: false }
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await patchMeta($, { interactive: e.isInteractive })
      await setup($)
    } catch (err) {
      $.ui.log(`fuel-gauge: setup failed: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  // One model request. Main thread only: subagents keep caches of their own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      await dropTurn($, e.turnId).catch(() => undefined)
      return yield* next(e)
    }
    await syncSession($).catch(() => undefined)
    const startMs = await $.clock.now()
    const costAtStart = (await read($, reading))?.costUsd
    const result = yield* next(e)
    try {
      const usage = result.usage
      if (usage) {
        const endS = (await $.clock.now()) / 1000
        const prev = (await read($, reading)) ?? core.emptyReading()
        const startS = startMs / 1000
        const kind = core.classifyStep(prev, startS, usage)
        let upgrade = core.warmGapUpgrade(prev, startS, usage)
        if (upgrade) {
          // The earlier requests' rows are on disk and name the tier exactly. A cache
          // something else kept warm must not pass for the 1-hour tier until Stop.
          await refreshTtl($).catch(() => undefined)
          if ((await read($, reading))?.ttlSource === 'transcript') upgrade = false
        }
        const r = await patchReading($, cur => ({
          ...cur,
          lastApiS: endS,
          observed: true,
          cacheRead: usage.cache_read_input_tokens,
          cacheCreate: usage.cache_creation_input_tokens,
          outputTokens: usage.output_tokens,
          model: usage.model || e.model,
          effort: e.effort === undefined ? undefined : String(e.effort),
          ...(upgrade ? { ttl: 3600, ttlSource: 'warm-gap' as const } : {}),
        }))
        if (kind === 'miss' && prev.lastApiS !== undefined) {
          const sessionId = await $.session.id()
          const root = await $.session.root()
          const key = core.missKey(startMs, sessionId)
          const miss: FuelMiss = {
            at: Math.floor(startS),
            session: sessionId,
            project: root.split('/').pop() ?? '',
            tokens: usage.cache_creation_input_tokens,
            gapS: Math.round(startS - prev.lastApiS),
            ttl: prev.ttl,
          }
          // If the session ledger already moved for this request, the cost is known now.
          if (costAtStart !== undefined && r.costUsd !== undefined && r.costUsd !== costAtStart) {
            miss.costUsd = r.costUsd - costAtStart
          } else if (costAtStart !== undefined) {
            await patchMeta($, { pendingMiss: { key, costBefore: costAtStart } })
          }
          await $.store.set(key, miss)
        }
        // Queued, not awaited: the next request must not wait on a file move.
        void writeSessionFile($)
      }
    } catch (err) {
      $.ui.log(`fuel-gauge: turn.step: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      await patchReading($, r => applyContext({ ...r, rateLimits: core.limitsFrom(e.rateLimits), costUsd: e.cost?.usd ?? r.costUsd }, e.context))
      const m = await getMeta($)
      if (m.pendingMiss && e.cost && e.changed.includes('cost')) {
        const pending = m.pendingMiss
        const stored = (await $.store.get(pending.key)) as FuelMiss | undefined
        if (stored) await $.store.set(pending.key, { ...stored, costUsd: e.cost.usd - pending.costBefore })
        await patchMeta($, { pendingMiss: undefined })
      }
      await writeSessionFile($)
    } catch (err) {
      $.ui.log(`fuel-gauge: session.measure: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  // The transcript's path rides on every classic event; the TTL is read once the turn's rows are on disk.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    try {
      await syncSession($)
      if (e.transcript_path) await patchMeta($, { transcriptPath: e.transcript_path })
      await refreshTtl($)
      await writeSessionFile($)
    } catch {
      // the TTL falls back to the previous value or the account's
    }
    return result
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.transcript_path) await patchMeta($, { transcriptPath: e.transcript_path })
      await refreshTtl($)
      await writeSessionFile($)
    } catch {
      // as above
    }
    return result
  })

  // The alert waits while a main turn runs. A subagent's turn leaves the list at
  // its first request, so a background agent never holds the alert off.
  on('turn.start', async ($, e, next) => {
    await update($, turns, t => [...(t ?? []), e.turnId])
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await dropTurn($, e.turnId)
    return result
  })

  // Observe only: the box the editor computed goes back exactly as it came.
  let lastDrafting: boolean | undefined
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const has = box.text.trim().length > 0
    if (has !== lastDrafting) {
      lastDrafting = has
      await update($, drafting, () => has).catch(() => undefined)
    }
    return box
  })

  on('prompt.submit', async ($, e, next) => {
    if (lastDrafting !== false) {
      lastDrafting = false
      await update($, drafting, () => false).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'fuel' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const others = await next(e)
    if (e.props.hasSurvey) return others
    const p = await read($, prefs)
    if ((p?.place ?? 'below') !== 'above') return others
    const rows = await gaugeRows($, p, e.props.bodyColumns)
    if (!rows) return others
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawRows(Text, rows)}
        {others}
      </Box>
    )
  })

  // Below the prompt: the gauge takes the hint line's place and the engine's
  // own line (shortcuts, "esc to interrupt") is kept underneath it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    const p = await read($, prefs)
    if ((p?.place ?? 'below') !== 'below') return engine
    const rows = await gaugeRows($, p, e.viewport?.columns)
    if (!rows) return engine
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawRows(Text, rows)}
        {engine}
      </Box>
    )
  })
}

async function gaugeRows($: $, p: FuelPrefs | null, cols: number | undefined): Promise<core.Row[] | undefined> {
  const style = p?.style ?? core.DEFAULT_STYLE
  if (!core.isBandStyle(style)) return undefined
  const r = await read($, reading)
  if (!r) return undefined
  const view = core.makeView(r, await nowS($), await read($, drafting))
  return core.renderRows(style, view, cols)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawRows(Text: any, rows: core.Row[]) {
  return rows.map((row, i) => (
    <Text key={i === 0 ? 'gauge' : 'cold'} wrap="truncate-end">
      {row.map(seg => (
        <Text color={seg.color} dimColor={seg.dim} bold={seg.bold}>
          {seg.text}
        </Text>
      ))}
    </Text>
  ))
}
