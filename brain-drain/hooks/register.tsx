import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import * as agentBars from './agents.ts'
import * as children from './children.ts'
import * as core from './core.ts'
import * as notify from './notify.ts'
import type { DrainAgent, DrainAgents, DrainMeta, DrainMiss, DrainNotify, DrainPrefs, DrainReading } from '../types'

// Brain Drain, the mod: the data source for the VS Code extension (the bridge's
// session file) and a coloured line under the prompt (or above it, by choice). Never calls a model,
// never compacts, never rewrites the prompt. The one thing it hands the model is the self-notice:
// a line of facts when a threshold is crossed, at set context stages unless turned off, and the
// facts alone at a session's start, after a compaction or a five-hour reset, and every so often.

const reading = atom({ plugin: 'brain-drain', key: 'reading' } as const, null)
const prefs = atom({ plugin: 'brain-drain', key: 'prefs' } as const, null)
const drafting = atom({ plugin: 'brain-drain', key: 'drafting' } as const, false)
const turns = atom({ plugin: 'brain-drain', key: 'turns' } as const, null)
const meta = atom({ plugin: 'brain-drain', key: 'meta' } as const, null)
const agents = atom({ plugin: 'brain-drain', key: 'agents' } as const, null)

const DEFAULT_PREFS: DrainPrefs = { style: core.DEFAULT_STYLE, place: 'below', warnSeconds: 60, sound: false, agents: true, notify: notify.DEFAULT_NOTIFY }
const CHIME = 'assets/chime.wav'
const MISS_RETENTION_S = 60 * 86400

type $ = EngineInterface

async function nowS($: $): Promise<number> {
  return (await $.clock.now()) / 1000
}

/** The prefs in `$.store`, sanitised and merged over the defaults. */
async function loadPrefs($: $): Promise<DrainPrefs> {
  const stored = (await $.store.get('prefs')) as Partial<DrainPrefs> | undefined
  const p: DrainPrefs = { ...DEFAULT_PREFS, ...(stored ?? {}) }
  if (!core.isStyle(p.style)) p.style = core.DEFAULT_STYLE
  if (p.place !== 'below' && p.place !== 'above') p.place = 'below'
  // Until 0.4 the rows were off and every saved change stored `agents: false` with the rest,
  // so a stored value counts only when the user chose it with /drain agents on|off.
  p.agents = stored?.agentsChosen === true ? stored.agents === true : DEFAULT_PREFS.agents
  p.notify = notify.sanitize(notify.chosen(stored?.notify))
  return p
}

/** The notice's fields as the user set them, the only ones stored, so a later default reaches every field they never set. */
async function storedNotify($: $): Promise<Record<string, unknown> | undefined> {
  return notify.chosen(((await $.store.get('prefs')) as { notify?: unknown } | undefined)?.notify)
}

/**
 * The session's prefs. While `$.state` is blank (a /clear, not yet seeded again)
 * the stored ones, so a `/drain` change made then keeps the other stored choices.
 * Reads only: a timer or a render may call it.
 */
async function getPrefs($: $): Promise<DrainPrefs> {
  return (await read($, prefs)) ?? (await loadPrefs($))
}

/** `notifySet`: the notice's fields as the user set them, given when a `/drain notify` command changed one. */
async function setPrefs($: $, change: Partial<DrainPrefs>, notifySet?: Record<string, unknown>): Promise<DrainPrefs> {
  const next = { ...(await getPrefs($)), ...change }
  await update($, prefs, () => next)
  const { notify: _, ...rest } = next
  const set = notifySet ?? (await storedNotify($))
  await $.store.set('prefs', set ? { ...rest, notify: set } : rest)
  return next
}

async function getMeta($: $): Promise<DrainMeta> {
  return (await read($, meta)) ?? {}
}

async function patchMeta($: $, change: Partial<DrainMeta>): Promise<void> {
  await update($, meta, m => ({ ...(m ?? {}), ...change }))
}

async function patchReading($: $, fn: (r: DrainReading) => DrainReading): Promise<DrainReading> {
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
  // Who holds the status line is checked before every write, not only at a
  // turn's end: after Connect Status Line the bridge writes the extension's
  // directory at once, and a long turn must not keep writing it too (MC-4983).
  await refreshOutDir($)
  const m = await getMeta($)
  const r = await read($, reading)
  if (!r) return
  // A `claude -p` run has no status line, so the bridge writes no file for it,
  // and in the gauge's folders the mod's would take over a VS Code gauge. Its
  // file goes to a folder of its own, once the figures are in, so a reader that
  // finds it fresh can leave the figures to the note (MC-8152).
  const dir = m.interactive ? m.outDir : m.interactive === false && r.rateLimits.length > 0 ? await headlessDir($, m.home) : undefined
  if (!dir) return
  const ids = { sessionId: await $.session.id(), cwd: await $.session.cwd(), projectDir: await $.session.root() }
  const account = await currentAccount($).catch(() => undefined)
  const file = core.sessionFile(r, ids, await nowS($), account)
  await writeAtomic($, `${dir}/${ids.sessionId}.json`, JSON.stringify(file, null, 2))
}

// The headless folder is made once per process; without host commands it is not
// made, and a headless run writes nothing, as before.
let headlessMade: Promise<boolean> | undefined

async function headlessDir($: $, home: string | undefined): Promise<string | undefined> {
  if (!home) return undefined
  const dir = `${home}/${core.HEADLESS_DIR}`
  headlessMade ??= $.process.run(['mkdir', '-p', dir], { timeoutMs: 5000 }).then(r => r.exitCode === 0, () => false)
  return (await headlessMade) ? dir : undefined
}

// ---------------------------------------------------------------- the account (MC-8006)

// Read when the process writes its first file. A host's variables stand for the
// whole process. The folder's record is read again at most once a minute (it is
// a large file, rewritten often): a first account not yet found is taken from
// it, and once it names another account the file names none for good
// (core.accountChanged).
const ACCOUNT_RECHECK_MS = 60_000
let accountRead = false
let firstAccount: core.Account | undefined
let accountGone = false
let accountCheckedMs = 0

async function readAccount($: $, home: string | undefined): Promise<core.Account | undefined> {
  const envUuid = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const envEmail = await $.env.get('CLAUDE_CODE_USER_EMAIL')
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.replace(/\/+$/, '')
  const recordPath = configDir ? `${configDir}/.claude.json` : home ? `${home}/.claude.json` : undefined
  // Both variables set: the host's word is whole, and the record is not read.
  const whole = !!envUuid?.trim() && !!envEmail?.trim()
  const record = whole || !recordPath ? undefined : await readJson($, recordPath)
  return core.sessionAccount(envUuid, envEmail, record)
}

/** The account this session's figures belong to; undefined when none was found, `changed` after a change of login. */
async function currentAccount($: $): Promise<core.Account | 'changed' | undefined> {
  const home = (await getMeta($)).home
  const nowMs = await $.clock.now()
  if (!accountRead) {
    accountRead = true
    accountGone = false
    accountCheckedMs = nowMs
    firstAccount = await readAccount($, home)
  } else if (!accountGone && firstAccount?.source !== 'session' && nowMs - accountCheckedMs >= ACCOUNT_RECHECK_MS) {
    accountCheckedMs = nowMs
    const now = await readAccount($, home)
    if (!firstAccount) firstAccount = now
    else if (core.accountChanged(firstAccount, now)) accountGone = true
  }
  return accountGone ? 'changed' : firstAccount
}

// The labels file (core.LABELS_FILE) is read at most once a minute too, like
// the record. Missing or unreadable means no labels, and says nothing.
let labelsCheckedMs: number | undefined
let labels: core.Labels = new Map()

async function currentLabels($: $): Promise<core.Labels> {
  const nowMs = await $.clock.now()
  if (labelsCheckedMs !== undefined && nowMs - labelsCheckedMs < ACCOUNT_RECHECK_MS) return labels
  labelsCheckedMs = nowMs
  const home = (await getMeta($)).home
  labels = home ? core.labelsFrom(await readJson($, `${home}/${core.LABELS_FILE}`)) : new Map()
  return labels
}

/** The account as a note names it: its label, else its email, else `account not certain`. */
async function noteAccount($: $): Promise<string> {
  const a = await currentAccount($).catch(() => undefined)
  return core.accountLabel(a, await currentLabels($).catch(() => undefined))
}

/**
 * session.start fires once per process, never on /clear or /resume. Claude
 * Code 2.1.300 empties `$.state` on /clear, and `ensureSeeded` builds it again.
 * It keeps `$.state` on a /resume in the same process, and so may another host
 * on /clear; that lands here: when the id changes the reading starts again,
 * from this mod's own file for that id (a /resume), else empty but for the
 * account's TTL, the rate limits and the model. The 1-second tick notices the
 * change (`followSession`), so it does not wait for a request.
 */
async function syncSession($: $): Promise<void> {
  const id = await $.session.id()
  const m = await getMeta($)
  if (m.sessionId === id) return
  // Transcripts are named after their session, side by side; findTranscript checks the path.
  const oldName = `/${m.sessionId}.jsonl`
  const transcriptPath = m.transcriptPath?.endsWith(`/${id}.jsonl`)
    ? m.transcriptPath
    : m.sessionId !== undefined && m.transcriptPath?.endsWith(oldName) ? `${m.transcriptPath.slice(0, -oldName.length)}/${id}.jsonl` : undefined
  await patchMeta($, {
    sessionId: id,
    transcriptPath,
    alertedFor: undefined,
    pendingMiss: undefined,
    notified: undefined,
    noticeTokens: undefined,
    noticeAt: undefined,
    noticeFiveReset: undefined,
    noticeAccount: undefined,
    noticeCompacted: undefined,
  })
  await clearAgents($)
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

/** Re-reads the status line, so re-wiring it mid-session moves the writes at the next write. */
async function refreshOutDir($: $): Promise<void> {
  const m = await getMeta($)
  if (!m.home) return
  const where = await chooseOutDir($, m.home)
  if (where.outDir !== m.outDir) await patchMeta($, where)
}

async function accountTtl($: $, m: DrainMeta): Promise<number | undefined> {
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
// labels.json is the user's (or another tool's) file: never pruned.
const META_FILES = new Set(['account_ttl.json', 'config.json', 'labels.json'])
// A headless run's file is wanted while it is fresh; scripted runs, many a day,
// would otherwise pile up for 36 hours.
const HEADLESS_MAX_AGE_MS = 6 * 3600_000

async function pruneShadow($: $, m: DrainMeta): Promise<void> {
  if (!canMove) return
  if (m.interactive === false && m.home) await pruneDir($, `${m.home}/${core.HEADLESS_DIR}`, HEADLESS_MAX_AGE_MS)
  if (m.shadow && m.interactive && m.outDir) await pruneDir($, m.outDir, SESSION_MAX_AGE_MS)
}

async function pruneDir($: $, dir: string, sessionMaxAge: number): Promise<void> {
  const now = await $.clock.now()
  const stale: string[] = []
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.kind !== 'file' || META_FILES.has(entry.name)) continue
    const maxAge = entry.name.endsWith('.tmp') ? TMP_MAX_AGE_MS : entry.name.endsWith('.json') ? sessionMaxAge : undefined
    if (maxAge === undefined) continue
    const path = `${dir}/${entry.name}`
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

/**
 * No mod event names the transcript, and the classic events that do are skipped
 * on a Team org by Claude Code 2.1.304's own cc-plugin-sec-default (MC-5712). So
 * the path is where Claude Code keeps it, the project folder with every other
 * character a dash, under CLAUDE_CONFIG_DIR when it is set, and is kept only if
 * the file is there.
 */
async function findTranscript($: $): Promise<void> {
  const m = await getMeta($)
  const id = await $.session.id()
  if (m.transcriptPath?.endsWith(`/${id}.jsonl`)) return
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.replace(/\/+$/, '')
  const bases = [configDir, m.home && `${m.home}/.claude`].filter((b): b is string => !!b)
  for (const base of new Set(bases)) {
    for (const dir of new Set([await $.session.root(), await $.session.cwd()])) {
      const path = `${base}/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
      try {
        await $.fs.stat(path)
      } catch {
        continue
      }
      await patchMeta($, { transcriptPath: path })
      return
    }
  }
}

async function refreshTtl($: $): Promise<void> {
  await findTranscript($)
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

// ---------------------------------------------------------------- subagent token bars (prototype)

// Read on a timer, never while drawing: the rows draw from `agents` in $.state.
const AGENT_REFRESH_MS = 5000
/** Each `tail` answers at most 4 MiB; a long addition catches up over several reads. */
const READS_PER_FILE = 8
const WHOLE_READ_MAX = 16 * 1024 * 1024

type Tracked = { acc: agentBars.Acc; label?: string; detail?: string; finished?: boolean; foreground?: boolean }
let agentDir: string | undefined
let tracked = new Map<string, Tracked>()
let agentBusy = false
let lastAgentSig: string | undefined

/** `<dir>/<sessionId>.jsonl` → `<dir>/<sessionId>/subagents`. */
function subagentDir(transcriptPath: string): string | undefined {
  return transcriptPath.endsWith('.jsonl') ? `${transcriptPath.slice(0, -'.jsonl'.length)}/subagents` : undefined
}

/** Agent transcripts: the directory's own, and a workflow's one level down in `workflows/<wf>/`. */
async function agentFiles($: $, dir: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const out: { path: string; size: number; mtimeMs: number }[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    let entries: { name: string; kind: string; size: number; mtimeMs: number }[]
    try {
      entries = await $.fs.list(d)
    } catch {
      return
    }
    for (const e of entries) {
      if (e.kind === 'file' && e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) out.push({ path: `${d}/${e.name}`, size: e.size, mtimeMs: e.mtimeMs })
      else if (e.kind === 'dir' && (depth === 0 ? e.name === 'workflows' : depth === 1)) await walk(`${d}/${e.name}`, depth + 1)
    }
  }
  await walk(dir, 0)
  return out
}

/** Reads what the file gained since the last refresh. */
async function readNew($: $, path: string, t: Tracked, size: number): Promise<void> {
  if (size < t.acc.offset) t.acc = agentBars.newAcc() // replaced, not appended to
  if (size === t.acc.offset) return
  // The first read takes the file whole, one call and no process; a host command reads only what each later refresh adds.
  if (canMove && (t.acc.offset > 0 || size > WHOLE_READ_MAX)) {
    try {
      for (let i = 0; i < READS_PER_FILE && t.acc.offset < size; i++) {
        const before = t.acc.offset
        const r = await $.process.run(['tail', '-c', `+${before + 1}`, path], { timeoutMs: 5000 })
        if (r.exitCode !== 0) return
        agentBars.feed(t.acc, r.stdout, r.isStdoutTruncated)
        if (!r.isStdoutTruncated || t.acc.offset === before) return
      }
      return
    } catch {
      // No host commands here: read the file whole instead.
    }
  }
  if (size > WHOLE_READ_MAX) return
  const acc = agentBars.newAcc()
  agentBars.feed(acc, (await $.fs.read(path)) as string)
  t.acc = acc
}

async function clearAgents($: $): Promise<void> {
  agentDir = undefined
  tracked = new Map()
  childTracked = new Map()
  childIgnored = new Set()
  lastAgentSig = undefined
  if ((await read($, agents)) !== null) await update($, agents, () => null)
}

async function setAgents($: $, next: DrainAgents): Promise<void> {
  // The guess moves with the clock, so it is part of what counts as a change.
  const now = await $.clock.now()
  const sig = JSON.stringify(next) + next.agents.map(a => `${agentBars.activity(a, now) ?? ''}${agentBars.inPanel(a, now) ? '+' : ''}`).join(',')
  if (sig === lastAgentSig) return
  lastAgentSig = sig
  await update($, agents, () => next)
  $.ui.invalidate('ui.render')
}

async function refreshAgents($: $): Promise<void> {
  if (!(await getPrefs($)).agents) return
  await findTranscript($)
  const m = await getMeta($)
  const dir = m.transcriptPath ? subagentDir(m.transcriptPath) : undefined
  if (dir !== agentDir) {
    await clearAgents($)
    agentDir = dir
  }
  if (!dir || (await $.session.surfaces()).length === 0) return
  const files = await agentFiles($, dir)
  const status = new Map<string, string>()
  try {
    for (const a of await $.agent.list()) status.set(a.id, a.status)
  } catch {
    // No agent list here: the file's last write is the only clue.
  }
  const list: DrainAgent[] = []
  for (const f of files) {
    const id = f.path.slice(f.path.lastIndexOf('/') + 1 + 'agent-'.length, -'.jsonl'.length)
    let t = tracked.get(f.path)
    if (!t) tracked.set(f.path, (t = { acc: agentBars.newAcc() }))
    const st = status.get(id) ?? status.get(`agent-${id}`)
    // The sidecar names the agent, and is rewritten with `finished: true` when it
    // ends (MC-6748), so it is read again on each refresh until it says so, unless
    // the engine already says the agent ended. A few hundred bytes per agent.
    const ended = st === 'completed' || st === 'failed' || st === 'killed'
    if (t.label === undefined || (!t.finished && !ended)) {
      const sidecar = await readJson($, `${f.path.slice(0, -'.jsonl'.length)}.meta.json`)
      if (sidecar !== undefined) {
        t.label ??= agentBars.labelFrom(sidecar, id)
        t.detail ??= agentBars.detailFrom(sidecar)
        const s = sidecar as { finished?: unknown; requestShape?: unknown }
        if (s.finished === true) t.finished = true
        // Not in the types either; Claude Code writes it from the agent's start (MC-7035).
        if (s.requestShape === 'foreground') t.foreground = true
      }
    }
    try {
      await readNew($, f.path, t, f.size)
    } catch {
      // unreadable this time; the next refresh tries again
    }
    const a = t.acc
    // An agent the engine lists as live is counted from its start, as a process is: one that
    // answers in a single long reply has no finished request until it ends (seen live, 14 Nov).
    if (a.requests === 0 && st !== 'running' && st !== 'pending' && st !== 'waiting') continue
    list.push({
      id, label: t.label ?? id, ...(t.detail ? { detail: t.detail } : {}), tokens: a.tokens, output: a.output, context: a.context, requests: a.requests,
      model: a.model, effort: a.effort, mtimeMs: f.mtimeMs, ...(st === undefined ? {} : { status: st }),
      ...(t.finished ? { finished: true } : {}),
      ...(f.path.includes('/workflows/') ? { workflow: true } : {}),
      ...(t.foreground ? { foreground: true } : {}),
    })
  }
  try {
    await childAgents($, m, list)
  } catch (err) {
    $.ui.log(`brain-drain: child processes: ${String(err)}`, { to: 'debug' })
  }
  await setAgents($, { dir, agents: list })
}

// ---------------------------------------------------------------- Claude Code processes this session started

type ChildTracked = Tracked & { rec: children.ChildRecord; transcript?: string; name?: string; endedMs?: number }
let childTracked = new Map<string, ChildTracked>()
/** Records that name another session, or sit in a legal folder: not read again this session. */
let childIgnored = new Set<string>()
let announcedFor: string | undefined

/**
 * The rule for folders a session must not show, as far as a mod applies it: a
 * folder on a mounted volume, or under a folder holding a `.legal` marker, is
 * refused. Only names are listed; no file there is opened. Then, when the user
 * placed a legal check program of their own, every folder it does not clear is
 * refused too, so the user's own rules count as well.
 */
async function isLegal($: $, dirs: string[], home: string | undefined): Promise<boolean> {
  const all = [...new Set(dirs)]
  for (const dir of all) {
    if (children.onVolume(dir)) return true
    for (const d of children.ancestors(dir, home)) {
      try {
        if ((await $.fs.list(d)).some(e => e.name === '.legal')) return true
      } catch {
        // unreadable: no marker seen there
      }
    }
  }
  if (!home) return false
  const check = `${home}/.claude/${children.LEGAL_CHECK}`
  try {
    await $.fs.stat(check)
  } catch {
    return false // no check placed: the marker and the volume rule are all there is
  }
  try {
    const r = await $.process.run([check, ...all], { timeoutMs: 10_000 })
    return !children.legalCheckClears(r.exitCode, r.stdout, all.length)
  } catch {
    return true // the check is there and could not answer: nothing is cleared
  }
}

/**
 * A session started from another session's Bash call (it inherits that
 * session's CLAUDE_CODE_SESSION_ID, or a clean-environment launcher named it in
 * BRAIN_DRAIN_PARENT) writes one record naming its parent, once
 * per session, so the parent's mod can show it. Nothing from a legal folder.
 */
async function announceChild($: $, home: string | undefined, interactive: boolean): Promise<void> {
  if (!home || !canMove) return
  const own = await $.session.id()
  if (announcedFor === own || !children.safeId(own)) return
  announcedFor = own
  const parent = children.parentOf(await $.env.get('CLAUDE_CODE_SESSION_ID'), own)
    ?? children.parentOf(await $.env.get('BRAIN_DRAIN_PARENT'), own)
  if (!parent) return
  const root = await $.session.root()
  const cwd = await $.session.cwd()
  if (await isLegal($, [root, cwd], home)) return
  let pid: number | undefined
  try {
    // The shell's parent is this Claude Code process; CLAUDE_PID would name the parent's.
    const r = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 5000 })
    const n = Number(r.stdout.trim())
    if (r.exitCode === 0 && Number.isInteger(n) && n > 1) pid = n
  } catch {
    // no pid: the parent falls back to the transcript's last write
  }
  const rec: children.ChildRecord = { v: 1, parent, session: own, startedAt: await $.clock.now(), root, cwd, interactive, ...(pid ? { pid } : {}) }
  const dir = `${home}/.claude/${children.CHILDREN_DIR}`
  await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5000 })
  await writeAtomic($, `${dir}/${own}.json`, JSON.stringify(rec))
}

/**
 * Child records older than 36 hours are removed at every session start, whatever
 * the agents setting: with rows off nothing else reads the folder, and each
 * `claude` started from a Bash call would leave a file naming a project folder.
 */
async function pruneChildren($: $, home: string | undefined): Promise<void> {
  if (!home || !canMove) return
  const dir = `${home}/.claude/${children.CHILDREN_DIR}`
  let entries: { name: string; kind: string; mtimeMs: number }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  const now = await $.clock.now()
  const stale = entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.mtimeMs < now - children.CHILD_MAX_AGE_MS)
    .map(e => `${dir}/${e.name}`)
  if (stale.length > 0) await $.process.run(['rm', '-f', ...stale], { timeoutMs: 5000 }).catch(() => undefined)
}

/** Whether the child's process still runs as that session, from Claude Code's own record of it; its user-given name too. */
async function childAlive($: $, home: string, pid: number, session: string): Promise<{ alive: boolean; name?: string }> {
  // Only `<pid>.json`; the `.key` file beside it is never opened.
  const s = (await readJson($, `${home}/.claude/sessions/${pid}.json`)) as { sessionId?: unknown; name?: unknown; nameSource?: unknown } | undefined
  if (!s || s.sessionId !== session) return { alive: false }
  return { alive: true, ...(s.nameSource === 'user' && typeof s.name === 'string' ? { name: s.name } : {}) }
}

/**
 * The rows for this session's own child processes: each record naming this
 * session, its transcript read as a subagent's is. A child whose process has
 * gone reads done; records older than 36 hours are removed.
 */
async function childAgents($: $, m: DrainMeta, list: DrainAgent[]): Promise<void> {
  if (!m.home || !m.transcriptPath) return
  const own = await $.session.id()
  const dir = `${m.home}/.claude/${children.CHILDREN_DIR}`
  let entries: { name: string; kind: string; size: number; mtimeMs: number }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  const now = await $.clock.now()
  const tp = m.transcriptPath
  const projects = tp.slice(0, tp.lastIndexOf('/', tp.lastIndexOf('/') - 1))
  const stale: string[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || childIgnored.has(e.name)) continue
    const path = `${dir}/${e.name}`
    let c = childTracked.get(e.name)
    if (!c) {
      if (e.mtimeMs < now - children.CHILD_MAX_AGE_MS) {
        stale.push(path)
        continue
      }
      const rec = children.parseRecord(await readJson($, path))
      if (!rec || rec.parent !== own || (await isLegal($, [rec.root, rec.cwd], m.home))) {
        childIgnored.add(e.name)
        continue
      }
      c = { acc: agentBars.newAcc(), rec }
      childTracked.set(e.name, c)
    }
    if (!c.transcript) {
      for (const p of children.transcriptCandidates(projects, c.rec)) {
        try {
          await $.fs.stat(p)
          c.transcript = p
          break
        } catch {
          // not this one
        }
      }
      if (!c.transcript) {
        const age = now - c.rec.startedAt
        if (age >= children.TRANSCRIPT_GRACE_MS && age < children.UNSEEN_ROW_MS) {
          list.push({
            id: c.rec.session, label: children.childLabel(c.rec, c.name), tokens: 0, output: 0, requests: 0,
            mtimeMs: c.rec.startedAt, process: true, status: 'unseen', runS: age / 1000,
          })
        }
        continue
      }
    }
    let st: { size: number; mtimeMs: number }
    try {
      st = await $.fs.stat(c.transcript)
      await readNew($, c.transcript, c, st.size)
    } catch {
      continue
    }
    if (c.endedMs === undefined && c.rec.pid !== undefined) {
      const live = await childAlive($, m.home, c.rec.pid, c.rec.session)
      if (live.name) c.name = live.name
      if (!live.alive) c.endedMs = Math.max(st.mtimeMs, c.rec.startedAt)
    }
    const status = c.rec.pid === undefined ? undefined : c.endedMs === undefined ? 'running' : 'completed'
    const a = c.acc
    // A live process is listed from its start; its figures read '–' until its first response ends.
    if (a.requests === 0 && status !== 'running') continue
    list.push({
      id: c.rec.session, label: children.childLabel(c.rec, c.name), tokens: a.tokens, output: a.output, context: a.context,
      requests: a.requests, model: a.model, effort: a.effort, mtimeMs: st.mtimeMs, process: true,
      ...(status === undefined ? {} : { status }),
      runS: ((c.endedMs ?? (status === 'running' ? now : st.mtimeMs)) - c.rec.startedAt) / 1000,
    })
  }
  if (stale.length > 0) await $.process.run(['rm', '-f', ...stale], { timeoutMs: 5000 }).catch(() => undefined)
}

/** One refresh at a time; a tick that finds one running skips. */
async function refreshAgentsOnce($: $): Promise<void> {
  if (agentBusy) return
  agentBusy = true
  try {
    await refreshAgents($)
  } catch (err) {
    $.ui.log(`brain-drain: agents: ${String(err)}`, { to: 'debug' })
  } finally {
    agentBusy = false
  }
}

// ---------------------------------------------------------------- display

let lastStatus: string | undefined

async function currentView($: $): Promise<{ view: core.View; r: DrainReading } | undefined> {
  const r = await read($, reading)
  if (!r) return undefined
  return { view: core.makeView(r, await nowS($), await read($, drafting)), r }
}

/**
 * The surfaces that raise the band above the prompt but no hint line under it:
 * the Claude desktop app and Anthropic's VS Code chat panel (both seen live on
 * 13 Nov 2026, MC-7763). There the band is the gauge's place whatever `place`
 * says. The panel used to offer only the pinned status line (MC-7430).
 */
function bandOnly(surface: string): boolean {
  return surface === 'desktop' || surface === 'vscode'
}

/** The pinned status line: the `line` style's text, on every surface. */
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

let following: Promise<void> | undefined

/**
 * An in-process /resume changes the session id and keeps `$.state`, and no
 * event reaches the mod until the next request. Checked every second: one id
 * read, and files only when the id changed.
 */
async function followSession($: $): Promise<void> {
  if (following || seeding) return
  const id = await $.session.id()
  if ((await getMeta($)).sessionId === id || following) return
  following = (async () => {
    await ensureSeeded($)
    await syncSession($)
    // A /resume names a transcript with rows already in it.
    await refreshTtl($).catch(() => undefined)
    await writeSessionFile($)
    await refreshStatusLine($)
  })()
    .catch(err => $.ui.log(`brain-drain: following the session: ${String(err)}`, { to: 'debug' }))
    .finally(() => {
      following = undefined
    })
  await following
}

async function tick($: $): Promise<void> {
  await followSession($)
  const p = await getPrefs($)
  const r = await read($, reading)
  if (!r) return
  const t = await nowS($)
  const c = core.cacheState(r, t)
  const isTicking = c.kind === 'live' || (c.kind === 'expired' && c.since <= 2)
  if (isTicking && core.isBandStyle(p.style)) $.ui.invalidate('ui.render')
  // Every second: the line style's text follows the reading.
  await refreshStatusLine($)

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

async function misses($: $): Promise<DrainMiss[]> {
  const out: DrainMiss[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('miss:')) continue
    const v = (await $.store.get(key)) as DrainMiss | undefined
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

// ---------------------------------------------------------------- the self-notice

async function notifySettings($: $): Promise<DrainNotify> {
  return notify.effective(notify.sanitize((await getPrefs($)).notify), (await getMeta($)).notifyEnv)
}

let notifyChain: Promise<unknown> = Promise.resolve()

/** What a note marked as told: the thresholds it reported, and the meta it set with what stood before. */
type Taken = { text: string; crossed: string[]; told: Partial<DrainMeta>; was: Partial<DrainMeta> }

/**
 * The note to hand the model now, or undefined. Marks what it reports as fired
 * and told before it returns, one call at a time, so two tool calls ending
 * together cannot both carry it. Works whatever `meta.interactive` says: a
 * `claude -p` run gets the note, and its file goes to the headless folder.
 *
 * A crossed threshold gives the facts and the level's words; otherwise the
 * facts alone go when `notify.factsDue` says so (MC-8006).
 */
function takeNotice($: $): Promise<Taken | undefined> {
  const run = notifyChain.then(async (): Promise<Taken | undefined> => {
    // The first prompt after a /clear comes before any request: seed first, so
    // BRAIN_DRAIN_NOTIFY and the stored thresholds count.
    await ensureSeeded($).catch(() => undefined)
    const n = await notifySettings($)
    if (!n.on) return undefined
    await syncSession($)
    const usage = await $.session.usage()
    const f = notify.figures(usage.context, core.limitsFrom(usage.rateLimits))
    const m = await getMeta($)
    const prior = m.notified ?? []
    // A large fall since the last figure is a compaction (or a rewind), whether or
    // not a session.compact hook saw it: the earlier notes went into the summary.
    // So is a figure gone unknown after a known one; it is told once known again.
    const tokens = f.context?.tokens
    const dropped = notify.contextDropped(m.noticeTokens, tokens)
    const compacted = m.noticeCompacted === true || dropped || (tokens === undefined && m.noticeTokens !== undefined)
    const before = dropped ? prior.filter(k => !k.startsWith('context:')) : prior
    const t = await nowS($)
    const { crossed, fired } = notify.evaluate(f, n, before, t)
    const account = await noteAccount($)
    const goes = crossed.length > 0 || notify.factsDue(f, n, { at: m.noticeAt, fiveReset: m.noticeFiveReset, account: m.noticeAccount }, account, compacted, t)
    const change: Partial<DrainMeta> = {}
    if (fired.length !== prior.length || fired.some(k => !prior.includes(k))) change.notified = fired
    if (tokens !== undefined && tokens !== m.noticeTokens) change.noticeTokens = tokens
    // A compaction waits for a known figure; any note told with one tells it.
    const stillCompacted = compacted && !(goes && f.context) ? true : undefined
    if (stillCompacted !== m.noticeCompacted) change.noticeCompacted = stillCompacted
    let told: Partial<DrainMeta> = {}
    const was: Partial<DrainMeta> = { noticeAt: m.noticeAt, noticeFiveReset: m.noticeFiveReset, noticeAccount: m.noticeAccount, noticeCompacted: m.noticeCompacted }
    if (goes) {
      told = { noticeAt: t, noticeFiveReset: f.fiveHour?.resetsAt, noticeAccount: account }
      Object.assign(change, told)
    }
    if (Object.keys(change).length > 0) await patchMeta($, change)
    return goes ? { text: notify.noticeText(f, n, crossed, t, account), crossed, told, was } : undefined
  })
  notifyChain = run.catch(() => undefined)
  return run
}

/**
 * A note that never reached the model (the prompt was dropped): its thresholds
 * fire again next time, and what it told counts as not told, unless a later
 * note has been told since.
 */
async function unfire($: $, note: Taken): Promise<void> {
  await update($, meta, m => {
    const cur = m ?? {}
    const back = cur.noticeAt === note.told.noticeAt ? note.was : {}
    return { ...cur, ...back, notified: (cur.notified ?? []).filter(k => !note.crossed.includes(k)) }
  })
}

/**
 * A compaction put the earlier notes into the summary: the context stages are
 * cleared, so the first figure after it is told again, whether a hook next sees
 * it unknown or already low, and the facts are told then even below every
 * stage. In the notice's queue, so a note being taken cannot write its marks
 * back over the clearing.
 */
function clearContextStages($: $): Promise<unknown> {
  const run = notifyChain.then(() =>
    update($, meta, m => ({ ...(m ?? {}), notified: (m?.notified ?? []).filter(k => !k.startsWith('context:')), noticeCompacted: true })),
  )
  notifyChain = run.catch(() => undefined)
  return run
}

/** Stores the notice fields given, over the ones the user set before. */
async function saveNotify($: $, change: Partial<DrainNotify>): Promise<void> {
  // `v` marks a block this version stored, so it is never read as the one 0.2.1 saved along.
  const set = { ...((await storedNotify($)) ?? {}), ...change, v: 2 }
  await setPrefs($, { notify: notify.sanitize(set) }, set)
}

const ASKED_KEY = 'notifyAsked'
const ASK_ON = 'On at 20, 30, 35, 50%'
const ASK_OFF = 'Off'
const ASK_QUESTION =
  'Brain Drain can tell Claude how full its context is, so a session knows when to wind down: a note at 20%, ' +
  'at 30% to finish the piece in hand and start nothing new, a suggestion to finish and close at 35%, and at 50% to close now. Under Other, type your own levels, e.g. 25 40 60. Turn it on?'

/**
 * Setting up: the first interactive session of a user who never chose any
 * notice setting asks whether to turn the notice on, offering the default
 * levels. Asked once per user: the mark is stored before the question shows, so
 * a session nobody answers does not ask again, and the defaults stand. A run with
 * BRAIN_DRAIN_NOTIFY set was chosen for by its launcher and is not asked.
 */
async function askAtSetup($: $): Promise<void> {
  if ((await getMeta($)).notifyEnv !== undefined) return
  if ((await $.store.get(ASKED_KEY)) !== undefined || (await storedNotify($)) !== undefined) return
  await $.store.set(ASKED_KEY, Math.floor(await nowS($)))
  let answer: string
  try {
    answer = (await $.ui.ask(ASK_QUESTION, { header: 'Brain Drain', options: [ASK_ON, ASK_OFF] })).trim()
  } catch (err) {
    // Dismissed, refused by a hook, or a host that cannot ask: the default stands, and the user is told.
    $.ui.log(`brain-drain: setup question: ${String(err)}`, { to: 'debug' })
    await $.ui.toast('Brain Drain: the context notice is on at 20, 30, 35 and 50%. /drain notify off stops it; /drain notify changes it.')
    return
  }
  const levels = notify.levelsFrom(answer)
  if (answer === ASK_OFF || /^(off|no)\b/i.test(answer)) {
    await saveNotify($, { on: false })
    await $.ui.toast('Context notice off. /drain notify on turns it on.')
  } else if (answer === ASK_ON) {
    await saveNotify($, { on: true })
    await $.ui.toast('Context notice on at 20, 30, 35 and 50%. /drain notify shows or changes it.')
  } else if (levels && levels.length > 0) {
    await saveNotify($, { on: true, context: levels })
    await $.ui.toast(`Context notice on at ${levels.join(', ')}%. /drain notify shows or changes it.`)
  } else {
    await $.ui.toast('Brain Drain read no levels in that answer; the notice is on at 20, 30, 35 and 50%. /drain notify changes it.')
  }
}

const THRESHOLD_KIND: Record<string, 'context' | 'fiveHour'> ={ context: 'context', '5h': 'fiveHour', '5-hour': 'fiveHour' }

/** Strips one pair of surrounding quotes, as typed in `/drain notify text context 35 "stop"`. */
function unquote(s: string): string {
  const t = s.trim()
  return t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) ? t.slice(1, -1) : t
}

async function notifyCommand($: $, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const sub = (words[0] ?? '').toLowerCase()
  const saved = notify.sanitize((await getPrefs($)).notify)
  const m = await getMeta($)
  const save = (change: Partial<DrainNotify>) => saveNotify($, change)
  const envNote = m.notifyEnv ? ` This run follows ${notify.ENV_NAME}, which overrides the saved settings until it ends.` : ''
  if (sub === '') {
    const n = await notifySettings($)
    const usage = await $.session.usage()
    const account = await noteAccount($)
    const now = notify.factsLine(notify.figures(usage.context, core.limitsFrom(usage.rateLimits)), n, await nowS($), account)
    return [...notify.describe(n, m.notifyEnv !== undefined, m.notifyEnvError, m.notified ?? [], now), 'Change with /drain notify on|off, context <n..>, 5h <n..>, week on|off, margin <n>, refresh <min>|off, text <kind> [n] "<text>".'].join('\n')
  }
  if (sub === 'on' || sub === 'off') {
    await save({ on: sub === 'on' })
    return sub === 'on'
      ? `Self-notice on: when this session crosses a threshold, the model gets a line of facts and what to do, with the next prompt or tool result. /drain notify shows the thresholds.${envNote}`
      : `Self-notice off.${envNote}`
  }
  const kind = THRESHOLD_KIND[sub]
  if (kind) {
    const rest = words.slice(1)
    if (rest.length === 1 && rest[0]!.toLowerCase() === 'off') {
      await save({ [kind]: [] })
      return `${sub} thresholds off.${envNote}`
    }
    const nums = rest.map(w => Number(w.replace(/%$/, '')))
    if (nums.length === 0 || nums.length > 10 || !nums.every(x => Number.isFinite(x) && x >= 0 && x <= 100)) {
      return `Give up to ten percentages from 0 to 100, e.g. /drain notify ${sub} ${kind === 'context' ? '70 90' : '80 95'}, or /drain notify ${sub} off.`
    }
    const list = [...new Set(nums)].sort((a, b) => a - b)
    await save({ [kind]: list })
    return `${sub} thresholds: ${list.map(t => `${t}%`).join(', ')}.${saved.on ? '' : ' (The self-notice is off; /drain notify on turns it on.)'}${envNote}`
  }
  if (sub === 'week') {
    const v = (words[1] ?? '').toLowerCase()
    if (v !== 'on' && v !== 'off') return 'Use /drain notify week on or /drain notify week off.'
    await save({ week: v === 'on' })
    return v === 'on' ? `Weekly pace threshold on: fires when the week's use passes the pace line (plus ${saved.margin} points).${envNote}` : `Weekly pace threshold off.${envNote}`
  }
  if (sub === 'margin') {
    const n = Number(words[1])
    if (words.length !== 2 || !Number.isFinite(n) || Math.abs(n) > 100) return 'Give the margin in points, e.g. /drain notify margin 5.'
    await save({ margin: n })
    return `Pace line margin: ${n} points.${envNote}`
  }
  if (sub === 'refresh') {
    const v = (words[1] ?? '').toLowerCase()
    const min = v === 'off' ? 0 : Number(v.replace(/min$/, ''))
    if (words.length !== 2 || v === '' || !notify.isRefresh(min)) return `Give the minutes between notes, e.g. /drain notify refresh 30, or /drain notify refresh off (0 to ${notify.MAX_REFRESH}).`
    await save({ refresh: min })
    return min > 0 ? `The facts are told again ${min} min after the last note.${envNote}` : `No timed refresh: the facts still go at a session's start, after a compaction, a five-hour reset or a change of account.${envNote}`
  }
  if (sub === 'text') {
    // text context 35 "..." | text 5h 80 "..." | text week "..."; no text clears it.
    const k = (words[1] ?? '').toLowerCase()
    const tk = THRESHOLD_KIND[k]
    let key: string
    let restStart: number
    if (k === 'week') {
      key = 'week'
      restStart = 2
    } else if (tk && words[2] !== undefined && Number.isFinite(Number(words[2]))) {
      key = `${tk === 'context' ? 'context' : '5h'}:${Number(words[2])}`
      restStart = 3
    } else {
      return 'Use /drain notify text context 35 "your text", /drain notify text 5h 80 "your text" or /drain notify text week "your text". Leave the text out to clear it.'
    }
    const text = unquote(args.trim().split(/\s+/).slice(restStart).join(' '))
    // From the store, as the other fields are: a text another session saved meanwhile stays.
    // Clearing a stage that has default words stores an empty string, which silences them.
    const next = notify.storedText(await storedNotify($))
    if (text !== '') next[key] = text
    else if (key in notify.DEFAULT_TEXT) next[key] = ''
    else delete next[key]
    await save({ text: next })
    const label = key.replace(':', ' ')
    if (text === '') return `Text for ${label} cleared.${envNote}`
    const configured = key === 'week' ? saved.week : key.startsWith('context:') ? saved.context.includes(Number(key.slice(8))) : saved.fiveHour.includes(Number(key.slice(3)))
    return `When ${label} fires, the note adds: ${text}${configured ? '' : ` (No ${label} threshold is set yet.)`}${envNote}`
  }
  return 'Unknown /drain notify option. Use /drain notify on|off, context <n..>, 5h <n..>, week on|off, margin <n>, refresh <min>|off, text <kind> [n] "<text>", or /drain notify to show the settings.'
}

// ---------------------------------------------------------------- /drain

const SAMPLE: DrainReading = {
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
  const [first = '', ...rest] = args.trim().split(/\s+/)
  let sub = first.toLowerCase()
  let arg = rest.join(' ')
  // `/drain bars` and `/drain styles bars` are shorthand for `/drain style bars`.
  if (core.isStyle(sub)) [sub, arg] = ['style', sub]
  else if (sub === 'styles' && arg !== '') sub = 'style'
  switch (sub) {
    case 'help':
      return ['Brain Drain commands:', ...core.HELP].join('\n')
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
      lines.push('', 'Switch with /drain <name>, e.g. /drain gauge.')
      return lines.join('\n')
    }
    case 'style': {
      const name = arg.toLowerCase()
      if (!core.isStyle(name)) return `Unknown style "${arg}". Styles: ${core.STYLES.join(', ')}.`
      await setPrefs($, { style: name })
      await refreshStatusLine($)
      $.ui.invalidate('ui.render')
      const said = name === 'off'
        ? 'Display off. The session file for the VS Code extension is still written.'
        : name === 'line'
          ? 'Style: line (plain text under the prompt; Claude Code prefixes it with the mod name).'
          : `Style: ${name}.`
      return said
    }
    case 'place': {
      if (arg !== 'below' && arg !== 'above') return 'Place: below (under the prompt, the default) or above (the band above the prompt).'
      await setPrefs($, { place: arg })
      $.ui.invalidate('ui.render')
      return `Place: ${arg} the prompt.`
    }
    case 'warn': {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 0 || n > 3600) return 'Give whole seconds from 0 to 3600, e.g. /drain warn 90. 0 turns the alert off.'
      await setPrefs($, { warnSeconds: n })
      return n === 0 ? 'Expiry alert off.' : `Expiry alert ${n} s before the cache expires.`
    }
    case 'sound': {
      const v = arg.toLowerCase()
      if (v !== 'on' && v !== 'off') return 'Use /drain sound on or /drain sound off.'
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
    case 'agents': {
      const v = arg.toLowerCase()
      if (v === 'on' || v === 'off') {
        await setPrefs($, { agents: v === 'on', agentsChosen: true })
        if (v === 'on') await refreshAgentsOnce($)
        else await clearAgents($)
        $.ui.invalidate('ui.render')
        return v === 'on'
          ? 'Subagent rows on: under the gauge, one row for each subagent of this session that Claude Code\'s own agent panel does not list: finished agents, a workflow\'s agents, failed or stopped ones once the panel lets them go, and Claude Code processes this session started from a Bash call (with how long they ran). A running subagent, in the foreground or the background, is listed by the panel and gets no row; its name and size go on the total line. "holds" (or "held") is the agent\'s context, its latest request\'s input + cache write + cache read + output, close to the figure Claude Code reports when it finishes; "wrote" is all its output. The total line\'s "tokens processed" sums every request, so a cache re-read counts each time. With two rows or more, the bars compare their sizes against the largest. A finished agent\'s row retires once three rows stand above it; the total line still counts it. Each row ends with running, idle, done, failed or stopped, as Claude Code reports the agent; "running?" is a guess from the transcript\'s last write.'
          : 'Subagent bars off.'
      }
      if (v !== '') return 'Use /drain agents on, /drain agents off, or /drain agents to list them.'
      if (!(await getPrefs($)).agents) return 'Subagent bars are off. /drain agents on turns them on.'
      await refreshAgentsOnce($)
      return agentBars.agentText((await read($, agents))?.agents ?? [], await $.clock.now())
    }
    case 'notify':
      return notifyCommand($, args.trim().slice(first.length))
    case '':
    case 'report': {
      const p = await getPrefs($)
      const m = await getMeta($)
      const r = await read($, reading)
      const dir = m.outDir && m.home ? m.outDir.replace(m.home, '~') : '(not writing: no HOME)'
      const lines = ['Brain Drain · cache misses (a request after the TTL ran out that re-wrote the cache)']
      lines.push(...core.ledgerReport(await misses($), await nowS($)))
      lines.push('Cost is the session ledger\'s measured rise over the turn that opened cold; misses before a cost reading have none.')
      lines.push('')
      lines.push(`TTL ${r ? `${r.ttl >= 3600 ? '1h' : '5m'} (${r.ttlSource})` : 'unknown'} · style ${p.style} · alert ${p.warnSeconds > 0 ? `${p.warnSeconds} s` : 'off'} · sound ${p.sound ? 'on' : 'off'} · agents ${p.agents ? 'on' : 'off'} · notify ${(await notifySettings($)).on ? 'on' : 'off'}`)
      if (!m.interactive) lines.push(`Session file: ${m.home ? `~/${core.HEADLESS_DIR}` : '(not writing: no HOME)'} (not an interactive session: kept apart from the gauge's folders, written once the limits are known)`)
      else lines.push(`Session file: ${dir}${m.shadow ? ' (shadow copy: the bridge is still the status line, so its directory is left alone)' : ''}`)
      lines.push('More: /drain help')
      return lines.join('\n')
    }
    default:
      return `Unknown subcommand "${first}".\n${core.HELP.join('\n')}`
  }
}

// ---------------------------------------------------------------- setup

/** Once per load of this code, from session.start. The command and the timers survive /clear. */
async function setup($: $, interactive: boolean): Promise<void> {
  await $.command.register({
    name: 'drain',
    description: 'Brain Drain: cache-miss report, display styles, expiry alert',
    argumentHint: '[help|styles|<style>|place below|above|warn <s>|sound on|off|agents on|off|notify ...]',
    immediate: true,
  })
  $.clock.every(1000, () => {
    void tick($).catch(() => undefined)
  })
  $.clock.every(AGENT_REFRESH_MS, () => {
    void refreshAgentsOnce($)
  })
  await seed($, () => seedSession($, interactive, false))
  // Not awaited: the question stays up while the session starts.
  if (interactive) void askAtSetup($).catch(err => $.ui.log(`brain-drain: notify: ${String(err)}`, { to: 'debug' }))
}

// One seeding at a time. A module variable survives /clear; a hot reload resets
// it, and session.start seeds again after one.
let seeding: Promise<void> | undefined
/**
 * What session.start said, kept for the seedings after a /clear, and set once
 * `takePanel` finds Anthropic's VS Code chat panel. The process stays what it
 * was: a `-p` run must not start writing a file after a /clear. Unknown (a hook
 * ran before this load's session.start) counts as not interactive: no guess
 * from surfaces alone may make a session write a file, and session.start seeds
 * again with the true value right after, a hot reload included.
 */
let startInteractive: boolean | undefined

async function seed($: $, run: () => Promise<void>): Promise<void> {
  while (seeding) await seeding
  seeding = run()
    .catch(err => $.ui.log(`brain-drain: seeding failed: ${String(err)}`, { to: 'debug' }))
    .finally(() => {
      seeding = undefined
    })
  await seeding
}

/**
 * Seeds `$.state` again when the host has emptied it: Claude Code 2.1.300
 * empties it on /clear, under a new session id, and fires no session.start.
 * (An in-process /resume keeps it; `followSession` handles that.) `interactive`
 * is set by every seeding, so its absence marks a blank state. Called first
 * thing by the hooks that run after a /clear, and by the tick.
 */
async function ensureSeeded($: $): Promise<void> {
  while (seeding) await seeding
  if ((await getMeta($)).interactive !== undefined) return
  if (seeding) return ensureSeeded($)
  await seed($, async () => {
    // Re-checked inside the slot: another caller may have seeded meanwhile.
    if ((await getMeta($)).interactive !== undefined) return
    await seedSession($, startInteractive ?? false, true)
  })
}

/**
 * Anthropic's VS Code chat panel starts its sessions as not interactive, though
 * a person is at its prompt, and attaches its surface after session.start. Such
 * a session writes the file a terminal session writes, so the extension's gauge
 * covers the panel (MC-5948). Told by a drawing surface: the panel's own, or
 * any surface with CLAUDE_CODE_ENTRYPOINT=claude-vscode. A `-p` run draws
 * nowhere, so one started from inside a panel session, carrying its
 * environment, stays silent.
 */
async function isPanel($: $): Promise<boolean> {
  const surfaces = await $.session.surfaces()
  if (surfaces.includes('vscode')) return true
  return surfaces.length > 0 && (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-vscode'
}

/**
 * The Code tab of the Claude desktop app, which also starts its sessions as not
 * interactive and attaches its surface later. It raises the band above the
 * prompt and no hint line under it (seen on 2.1.321, MC-7763). Told the same
 * way as the panel, so a `-p` run started from inside it stays silent.
 */
async function isDesktopApp($: $): Promise<boolean> {
  const surfaces = await $.session.surfaces()
  if (surfaces.includes('desktop') && !surfaces.includes('vscode')) return true
  return surfaces.length > 0 && (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
}

/** Makes a chat-panel or desktop-app session one that writes, from its first request or /drain on. */
async function takePanel($: $): Promise<void> {
  if (startInteractive === undefined || (await getMeta($)).interactive !== false) return
  if (!(await isPanel($)) && !(await isDesktopApp($))) return
  startInteractive = true
  await patchMeta($, { interactive: true })
}

/**
 * Puts into `$.state` what this session needs: prefs, where to write, the
 * reading and the context window. `blank`: the host emptied `$.state`, so a
 * reading found there is a stray made since and is built again; otherwise (a hot
 * reload) a kept reading stays.
 */
async function seedSession($: $, interactive: boolean, blank: boolean): Promise<void> {
  const p = await loadPrefs($)
  await update($, prefs, () => p)
  const env = notify.parseEnv(await $.env.get('BRAIN_DRAIN_NOTIFY'))
  if (env.error) $.ui.log(`brain-drain: ${env.error}`, { to: 'debug' })

  const home = await $.env.get('HOME')
  const where = home ? await chooseOutDir($, home) : { outDir: undefined, shadow: false }
  await patchMeta($, { interactive, notifyEnv: env.value, notifyEnvError: env.error, home, outDir: where.outDir, shadow: where.shadow })
  await announceChild($, home, interactive).catch(err => $.ui.log(`brain-drain: announcing to the parent session: ${String(err)}`, { to: 'debug' }))
  await pruneChildren($, home).catch(err => $.ui.log(`brain-drain: pruning child records: ${String(err)}`, { to: 'debug' }))
  await syncSession($)
  const m = await getMeta($)

  // A reload keeps the reading in $.state. A new process or an emptied state
  // seeds it from this mod's own earlier file (a resume), else from the account's TTL.
  if ((blank || !(await read($, reading))) && m.outDir) {
    const acct = await accountTtl($, m)
    const ttl = acct ?? core.DEFAULT_TTL
    const source = acct ? 'account' : 'default'
    const own = core.readingFromFile(await readJson($, `${m.outDir}/${await $.session.id()}.json`), ttl, source)
    await update($, reading, () => own ?? core.emptyReading(ttl, source))
  } else if (blank || !(await read($, reading))) {
    await update($, reading, () => core.emptyReading())
  }

  const usage = await $.session.usage()
  await patchReading($, r => applyContext({ ...r, rateLimits: core.limitsFrom(usage.rateLimits), costUsd: usage.cost?.usd ?? r.costUsd }, usage.context))
  await pruneMisses($)
  await pruneShadow($, m)
  await writeSessionFile($)
  lastStatus = undefined
  await refreshStatusLine($)
}

function applyContext(r: DrainReading, c: { tokens?: number; window: number; percent?: number }): DrainReading {
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
      startInteractive = e.isInteractive
      accountRead = false
      headlessMade = undefined
      await setup($, e.isInteractive)
    } catch (err) {
      $.ui.log(`brain-drain: setup failed: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  // One model request. Main thread only: subagents keep caches of their own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      await dropTurn($, e.turnId).catch(() => undefined)
      return yield* next(e)
    }
    await ensureSeeded($).catch(() => undefined)
    await takePanel($).catch(() => undefined)
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
          // something else kept warm must not pass for the 1-hour tier until the turn ends.
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
          ...core.stepFill(usage, cur.window),
          model: usage.model || e.model,
          effort: e.effort === undefined ? undefined : String(e.effort),
          ...(upgrade ? { ttl: 3600, ttlSource: 'warm-gap' as const } : {}),
        }))
        if (kind === 'miss' && prev.lastApiS !== undefined) {
          const sessionId = await $.session.id()
          const root = await $.session.root()
          const key = core.missKey(startMs, sessionId)
          const miss: DrainMiss = {
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
      $.ui.log(`brain-drain: turn.step: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  // Observe only: the compaction goes back exactly as it came. A subagent's own
  // compaction, a precompute (nothing installed) and a skip leave the stages.
  // Where the built-in guard loads (managed settings, a Team or Enterprise
  // login) this hook never runs; takeNotice then sees the compaction as the
  // context figure's fall (MC-7602).
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await clearContextStages($).catch(err => $.ui.log(`brain-drain: notify: ${String(err)}`, { to: 'debug' }))
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      await ensureSeeded($)
      await patchReading($, r => applyContext({ ...r, rateLimits: core.limitsFrom(e.rateLimits), costUsd: e.cost?.usd ?? r.costUsd }, e.context))
      const m = await getMeta($)
      if (m.pendingMiss && e.cost && e.changed.includes('cost')) {
        const pending = m.pendingMiss
        const stored = (await $.store.get(pending.key)) as DrainMiss | undefined
        if (stored) await $.store.set(pending.key, { ...stored, costUsd: e.cost.usd - pending.costBefore })
        await patchMeta($, { pendingMiss: undefined })
      }
      await writeSessionFile($)
    } catch (err) {
      $.ui.log(`brain-drain: session.measure: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  // The alert waits while a main turn runs. A subagent's turn leaves the list at
  // its first request, so a background agent never holds the alert off.
  on('turn.start', async ($, e, next) => {
    await update($, turns, t => [...(t ?? []), e.turnId])
    return next(e)
  })

  // The TTL is read once the turn's rows are on disk. The mod registers no
  // classic hook: a managed plugin above it skips them on Team
  // logins, and Claude Code prints a line saying so (MC-5712, MC-5779).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await dropTurn($, e.turnId)
    if (e.agentId !== undefined) return result
    try {
      await ensureSeeded($)
      await refreshOutDir($)
      await refreshTtl($)
      await writeSessionFile($)
    } catch {
      // the TTL falls back to the previous value or the account's
    }
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

  // The self-notice rides on the prompt (attached on the way down) and on a
  // main-loop tool result, so a long run with no new prompt still hears it.
  on('prompt.submit', async ($, e, next) => {
    if (lastDrafting !== false) {
      lastDrafting = false
      await update($, drafting, () => false).catch(() => undefined)
    }
    const note = await takeNotice($).catch(err => {
      $.ui.log(`brain-drain: notify: ${String(err)}`, { to: 'debug' })
      return undefined
    })
    if (!note) return next(e)
    const result = await next({ ...e, context: [...(e.context ?? []), note.text] })
    if (result.drop !== undefined) await unfire($, note).catch(() => undefined)
    return result
  })

  // Subagents' calls (agentId set) and a plugin's own $.tool.call (no context reaches a model there) pass untouched.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || next.origin.plugin !== 'engine' || result.deny !== undefined) return result
    try {
      const note = await takeNotice($)
      if (note) return { ...result, context: [...(result.context ?? []), note.text] }
    } catch (err) {
      $.ui.log(`brain-drain: notify: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  on('command.run', { command: 'drain' }, async ($, e) => {
    await ensureSeeded($).catch(() => undefined)
    await takePanel($).catch(() => undefined)
    return { text: await runCommand($, e.args) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const others = await next(e)
    if (e.props.hasSurvey) return others
    const p = await read($, prefs)
    // The desktop app and the VS Code panel raise no hint line, so the band is their only place.
    if ((p?.place ?? 'below') !== 'above' && !bandOnly(e.surface)) return others
    const rows = await gaugeRows($, p, e.props.bodyColumns).catch(() => undefined)
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
    // These surfaces draw the gauge in their band (above); never twice.
    if (bandOnly(e.surface)) return engine
    const p = await read($, prefs)
    if ((p?.place ?? 'below') !== 'below') return engine
    const rows = await gaugeRows($, p, e.viewport?.columns).catch(() => undefined)
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

/** The rows to draw, or undefined to draw nothing. Callers swallow a throw (a state read refused mid-unload) and pass the other rows through. */
async function gaugeRows($: $, p: DrainPrefs | null, cols: number | undefined): Promise<core.Row[] | undefined> {
  const style = p?.style ?? core.DEFAULT_STYLE
  if (!core.isBandStyle(style)) return undefined
  const r = await read($, reading)
  if (!r) return undefined
  const view = core.makeView(r, await nowS($), await read($, drafting))
  const rows = core.renderRows(style, view, cols)
  if (p?.agents && rows.length > 0) {
    const a = await read($, agents)
    if (a && a.agents.length > 0) rows.push(...agentBars.agentRows(a.agents, await $.clock.now(), cols))
  }
  return rows
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawRows(Text: any, rows: core.Row[]) {
  return rows.map((row, i) => (
    <Text key={i === 0 ? 'gauge' : `row-${i}`} wrap="truncate-end">
      {row.map(seg => (
        <Text color={seg.color} dimColor={seg.dim} bold={seg.bold}>
          {seg.text}
        </Text>
      ))}
    </Text>
  ))
}
