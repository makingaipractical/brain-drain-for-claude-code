// Pure logic for the per-subagent token bars (prototype, `/drain agents on`): no `$`, so the tests call it directly.
//
// A session's subagents write `<transcript dir>/<sessionId>/subagents/agent-<id>.jsonl`
// (workflow agents one level down, in `workflows/<wf>/`), append-only, beside an
// `agent-<id>.meta.json` naming the agent. register.tsx reads the new bytes of each
// file on a timer and feeds them here; the prompt draws from the stored result.
import { OK, WARN, bar, cellWidth, effortLabel, fmtTokens, plain, shortModel } from './core.ts'
import { fmtRun } from './children.ts'
import type { Row, Seg } from './core.ts'
import type { DrainAgent } from '../types'

/** An agent counts as running, as a guess, while its file changed this recently. */
export const RUNNING_GUESS_MS = 30_000
export const MAX_ROWS = 5
/**
 * A done row retires once this many rows stand above it, so finished agents do
 * not fill the screen while others run. A retired agent leaves no row and no
 * "+N more"; it stays in the total line's done count and its sums.
 */
export const DONE_ROWS = 3

/**
 * One transcript's running count. A response is written as one record per content
 * block, each carrying the response's usage; the input fields repeat and
 * `output_tokens` grows to its final figure on the last block. So each response is
 * counted once, by `message.id`, with the largest output count seen.
 */
export type Acc = {
  /** Bytes of the file consumed: always just past a newline. */
  offset: number
  /** Per response: [input + cache write + cache read, output] as last seen. */
  seen: Record<string, [number, number]>
  tokens: number
  output: number
  /** The latest response's input + cache write + cache read + output: the agent's context now. */
  context: number
  requests: number
  model?: string
  effort?: string
}

export function newAcc(): Acc {
  return { offset: 0, seen: {}, tokens: 0, output: 0, context: 0, requests: 0 }
}

/** UTF-8 bytes a string takes; the module has no TextEncoder to ask. */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function take(acc: Acc, line: string): void {
  if (!line.includes('"usage"')) return
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  if (typeof row !== 'object' || row === null) return
  const r = row as { type?: unknown; message?: unknown; requestId?: unknown; uuid?: unknown; effort?: unknown }
  if (r.type !== 'assistant' || typeof r.message !== 'object' || r.message === null) return
  const m = r.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> }
  const u = m.usage
  if (typeof u !== 'object' || u === null || m.model === '<synthetic>') return
  const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
  let out = num(u.output_tokens)
  const key = typeof m.id === 'string' ? m.id : typeof r.requestId === 'string' ? r.requestId : typeof r.uuid === 'string' ? r.uuid : undefined
  const prev = key === undefined ? undefined : acc.seen[key]
  if (prev) {
    // The count only grows over a response's blocks; a lower one is never the final figure.
    out = Math.max(out, prev[1])
    acc.tokens -= prev[0] + prev[1]
    acc.output -= prev[1]
  } else acc.requests++
  if (key !== undefined) acc.seen[key] = [input, out]
  acc.tokens += input + out
  acc.output += out
  // Records come in the order they were written, so the last one seen is the latest response.
  acc.context = input + out
  if (typeof m.model === 'string') acc.model = m.model
  if (typeof r.effort === 'string') acc.effort = r.effort
}

/**
 * Feeds text read from `acc.offset` onwards. Only whole lines are taken: a last
 * line still being written stays unread, and the offset stops before it.
 * `cut` says the read was cut short (stdout's cap): a chunk with no newline is
 * then the middle of one huge line, passed over so the file cannot stall on it.
 * A read that starts mid-line skips to the next line.
 */
export function feed(acc: Acc, text: string, cut = false): void {
  const end = text.lastIndexOf('\n')
  if (end < 0) {
    if (cut) acc.offset += utf8Bytes(text)
    return
  }
  const midLine = acc.offset > 0 && text[0] !== '{' && text[0] !== '\n'
  let body = text.slice(0, end + 1)
  acc.offset += utf8Bytes(body)
  if (midLine) body = body.slice(body.indexOf('\n') + 1)
  for (const line of body.split('\n')) if (line) take(acc, line)
}

/** The label a meta sidecar gives: the agent's name, else its type. */
export function labelFrom(meta: unknown, id: string): string {
  if (typeof meta === 'object' && meta !== null) {
    const m = meta as { name?: unknown; agentType?: unknown }
    if (typeof m.name === 'string' && m.name) return m.name
    if (typeof m.agentType === 'string' && m.agentType) return m.agentType
  }
  return id
}

/** The sidecar's `description`: the few words the Agent call gave, "bg counter". Undefined when it has none. */
export function detailFrom(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const d = (meta as { description?: unknown }).description
  return typeof d === 'string' && d.trim() ? d.trim() : undefined
}

/**
 * A row's label at this level. Two agents of one type read alike
 * ("general-purpose", "general-purpose": seen live on 6 November), so a row whose
 * label another shown row shares gets its description after it, as Claude Code's
 * own panel writes it: "general-purpose bg counter". Narrow levels drop it first.
 */
function rowLabel(a: DrainAgent, shared: Set<string>, lv: Level): string {
  return lv.detail && a.detail && shared.has(a.label) ? `${a.label} ${a.detail}` : a.label
}

export type Activity = 'running' | 'running?' | 'idle' | 'done' | 'failed' | 'stopped' | 'no transcript'

/** The engine's AgentStatus (2.1.316) in the row's words. Ended is completed, failed or killed. */
const WORD: Record<string, Activity> = {
  running: 'running', pending: 'running', waiting: 'running',
  idle: 'idle', completed: 'done', failed: 'failed', killed: 'stopped',
  // Ours, not the engine's: a started session announced itself but its transcript is not where this one looks.
  unseen: 'no transcript',
}

/**
 * The row's last word (MC-6748). First the engine's own agent list; then the
 * agent's meta sidecar, which Claude Code rewrites with `finished: true` when an
 * ordinary subagent ends (not in the types, so only a second source); then
 * `running?`, a guess from the file's last write. Nothing when none of them
 * knows: a workflow agent, which no list names and whose sidecar never says
 * finished, once its file has been quiet for 30 seconds.
 */
export function activity(a: DrainAgent, nowMs: number): Activity | undefined {
  const word = a.status === undefined ? undefined : WORD[a.status]
  if (word) return word
  if (a.finished) return 'done'
  return nowMs - a.mtimeMs <= RUNNING_GUESS_MS ? 'running?' : undefined
}

/** Still working, as far as anyone knows: these rows sort first. */
export function live(a: DrainAgent, nowMs: number): boolean {
  const w = activity(a, nowMs)
  return w === 'running' || w === 'running?'
}

/** Claude Code's agent panel keeps a failed or stopped agent's row this long after it ends. */
export const PANEL_KEEPS_MS = 30_000

/**
 * Whether Claude Code's own agent panel, under the prompt, lists this agent now
 * (MC-7035). The panel cannot be hidden and a mod cannot see it, so this follows
 * its rules (2.1.318): a subagent has a row there while the engine says it is
 * pending, running, waiting or idle, and for 30 seconds after it failed or was
 * stopped; a finished one leaves at once. That holds for a subagent Claude waits
 * for (foreground) too: seen live on 6 November, the panel listed one by name while
 * it ran, so it is folded like a background one (the duty had assumed it got no
 * row there). A workflow's agents share one progress line there, so they always
 * keep a row here, as does a Claude Code process the session started (MC-7061),
 * which no panel lists. An agent the panel lists is not
 * drawn twice: it is folded into the total line, by name and size.
 *
 * A failed or stopped agent's 30 seconds count from its transcript's last write,
 * which can be earlier than its end; then its row here appears a little early.
 */
export function inPanel(a: DrainAgent, nowMs: number): boolean {
  if (a.workflow || a.process) return false
  const s = a.status
  if (s === 'running' || s === 'pending' || s === 'waiting' || s === 'idle') return true
  return (s === 'failed' || s === 'killed') && nowMs - a.mtimeMs <= PANEL_KEEPS_MS
}

/**
 * A running row's word, bar and count on the total line: the theme's success
 * green, the gauge's own colour for a context that is fine, with the word bold. A
 * done row is grey throughout: its word, bar and size faint. Live work catches
 * the eye; a finished agent wants nothing.
 */
export const RUNNING_COLOR = OK

/**
 * A failed agent's word and count: the theme's warning colour, so it is not
 * missed now that the panel has let it go (MC-7035). Never red: nothing in the
 * block asks for action, and red stays the gauge's danger colour.
 */
export const FAILED_COLOR = WARN

/** What colour and weight a state's word takes, here and on the total line. Only done is drawn faint. */
function wordSeg(w: Activity, text: string): Seg {
  if (w === 'done') return { text, dim: true }
  if (w === 'failed' || w === 'no transcript') return { text, color: FAILED_COLOR }
  if (w === 'running') return { text, color: RUNNING_COLOR, bold: true }
  return { text }
}

/** The total line's counts that take their word's colour or weight; the others stay faint. */
const STRONG = new Set<Activity>(['running', 'failed', 'no transcript'])

/** The states the total line counts, in the order it names them. `running?` counts as running. */
const COUNTED: Activity[] = ['running', 'idle', 'done', 'failed', 'stopped', 'no transcript']

/** An agent's state as the total line counts it. */
function counted(a: DrainAgent, nowMs: number): Activity | undefined {
  const w = activity(a, nowMs)
  return w === 'running?' ? 'running' : w
}

/**
 * The total line's opening: how many agents are in each state, "1 running · 2 done".
 * When some agents have no word (a quiet workflow agent), the count of all agents
 * follows, so the figures still add up: "1 running · 4 agents".
 */
export function stateCounts(agents: DrainAgent[], nowMs: number): string {
  return stateParts(agents, nowMs).map(p => p.text).join(' · ')
}

/** stateCounts as its parts, each with the state it counts (none for the count of all agents). */
export function stateParts(agents: DrainAgent[], nowMs: number): { state?: Activity; text: string }[] {
  const n: Partial<Record<Activity, number>> = {}
  let known = 0
  for (const a of agents) {
    const w = counted(a, nowMs)
    if (w === undefined) continue
    n[w] = (n[w] ?? 0) + 1
    known++
  }
  const parts: { state?: Activity; text: string }[] = COUNTED.filter(w => n[w]).map(w => ({ state: w, text: `${n[w]} ${w}` }))
  if (known < agents.length) parts.push({ text: `${agents.length} agent${agents.length === 1 ? '' : 's'}` })
  return parts
}

function fit(label: string, width: number): string {
  const chars = [...label]
  if (chars.length <= width) return label + ' '.repeat(width - chars.length)
  return `${chars.slice(0, width - 1).join('')}…`
}

/** A label cut to `width` characters, not padded. */
function cut(label: string, width: number): string {
  return fit(label, width).trimEnd()
}

/**
 * The word before an agent's size, so a row such as "226k out 76k" is not left to
 * guesswork. The size is what the agent's latest request carried, its context: what
 * it holds while it works, what it held when it stopped.
 */
export function sizeVerb(w: Activity | undefined): string {
  return w === 'running' || w === 'running?' || w === 'idle' ? 'holds' : 'held'
}

type Level = {
  cells: number
  out: boolean
  model: boolean
  labelMax: number
  /** The words that say what each figure is: "holds", "wrote", "tokens processed". */
  words: boolean
  /** The total line says how the processed figure counts, and what the bars compare. */
  explain: boolean
  /** Agents the panel lists, after their count: every one by name and size (at most PANEL_NAMES), the first only, or none. */
  panel: 'all' | 'first' | 'none'
  /** Rows whose label repeats show their description after it, in a label column up to DETAIL_MAX wide. */
  detail: boolean
}
/** The label column's width when it carries descriptions. */
const DETAIL_MAX = 34
const LEVELS: Level[] = [
  { cells: 10, out: true, model: true, labelMax: 18, words: true, explain: true, panel: 'all', detail: true },
  { cells: 10, out: true, model: true, labelMax: 18, words: true, explain: false, panel: 'all', detail: true },
  { cells: 10, out: true, model: true, labelMax: 18, words: true, explain: false, panel: 'all', detail: false },
  { cells: 10, out: true, model: true, labelMax: 18, words: true, explain: false, panel: 'first', detail: false },
  { cells: 10, out: false, model: true, labelMax: 18, words: true, explain: false, panel: 'first', detail: false },
  { cells: 10, out: false, model: false, labelMax: 18, words: true, explain: false, panel: 'first', detail: false },
  { cells: 5, out: false, model: false, labelMax: 12, words: false, explain: false, panel: 'none', detail: false },
]
const PANEL_NAMES = 3

/** An agent's context now; a row stored before the field existed reads 0 until the next refresh. */
const ctx = (a: DrainAgent): number => a.context ?? 0

/**
 * A row's figures, or a dash before its first response has ended: a transcript
 * gets its first usage record only then. Only a running process the session
 * started is listed that early (seen live on 6 November: a `claude -p` that
 * answered in one long response showed nowhere until it ended).
 */
const sizeText = (a: DrainAgent): string => (a.requests === 0 ? '–' : fmtTokens(ctx(a)))
const wroteText = (a: DrainAgent): string => (a.requests === 0 ? '–' : fmtTokens(a.output))

/**
 * The agents the panel lists in one state, for the total line: "opus-executor holds 226k, Explore 40k".
 * A label the one before it already gave is not repeated: "opus-executor holds 589k, 418k, 271k, +1".
 */
function panelText(list: DrainAgent[], lv: Level, nowMs: number): string {
  const named = lv.panel === 'all' ? list.slice(0, PANEL_NAMES) : list.slice(0, 1)
  const one = (a: DrainAgent, i: number) => {
    const label = i > 0 && named[i - 1]!.label === a.label ? '' : `${cut(a.label, lv.labelMax)} `
    // Before its first request ends an agent has no size yet: its name alone, or '–' after a repeated one.
    if (a.requests === 0) return label.trimEnd() || '–'
    return `${label}${i === 0 ? `${sizeVerb(activity(a, nowMs))} ` : ''}${fmtTokens(ctx(a))}`
  }
  const rest = list.length - named.length
  return [...named.map(one), ...(rest > 0 ? [`+${rest}`] : [])].join(', ')
}

/**
 * The rows under the gauge (MC-7035): one per agent Claude Code's agent panel does
 * not list (finished agents, a workflow's agents, and failed
 * or stopped ones once the panel let them go), live first, then the most recently
 * written, at most MAX_ROWS; then one total line. A done row retires once
 * DONE_ROWS rows stand above it: it is counted on the total line, not drawn. An agent the panel lists gets no
 * row: its name and size go on the total line beside its state's count.
 *
 * A row's size is the agent's context, its latest request's input + cache write +
 * cache read + output (close to the figure Claude Code reports when the agent
 * finishes, 0.5 to 0.9% under it on 28 October); "wrote" is all its output. The
 * total line's processed figure sums every request, so each re-read counts again.
 * The bar compares the rows' sizes, so with a single row there is none: alone, it
 * would only ever look full. Empty when the session has no agents.
 */
export function agentRows(agents: DrainAgent[], nowMs: number, cols?: number): Row[] {
  if (agents.length === 0) return []
  const folded = agents.filter(a => inPanel(a, nowMs)).sort((a, b) => ctx(b) - ctx(a))
  const own = agents.filter(a => !inPanel(a, nowMs))
  const ranked = [...own].sort((a, b) => {
    const act = Number(live(b, nowMs)) - Number(live(a, nowMs))
    return act !== 0 ? act : b.mtimeMs - a.mtimeMs
  })
  // Live rows first, then the rest by last write; a done row only while fewer than DONE_ROWS stand above it.
  const shown: DrainAgent[] = []
  let more = 0
  for (const a of ranked) {
    if (activity(a, nowMs) === 'done' && shown.length >= DONE_ROWS) continue
    if (shown.length < MAX_ROWS) shown.push(a)
    else more++
  }
  const withBar = shown.length >= 2
  const max = Math.max(1, ...shown.map(ctx))
  const total = agents.reduce((n, a) => n + a.tokens, 0)
  const output = agents.reduce((n, a) => n + a.output, 0)
  // While no row has a figure yet (a process before its first answer ends), the sums are unknown, not zero.
  const known = agents.some(a => a.requests > 0)
  const counts = stateParts(agents, nowMs)

  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const a of shown) (seen.has(a.label) ? shared : seen).add(a.label)

  const build = (lv: Level): Row[] => {
    const labels = shown.map(a => rowLabel(a, shared, lv))
    const labelCap = lv.detail && shared.size > 0 ? Math.max(lv.labelMax, DETAIL_MAX) : lv.labelMax
    const width = Math.min(labelCap, Math.max(0, ...labels.map(l => [...l].length)))
    const tokW = Math.max(0, ...shown.map(a => sizeText(a).length))
    const outW = Math.max(0, ...shown.map(a => wroteText(a).length))
    const rows: Row[] = shown.map((a, i) => {
      const act = activity(a, nowMs)
      const row: Row = [{ text: `  ${fit(labels[i]!, width)} `, dim: true }]
      const done = act === 'done'
      const cells = bar(ctx(a) / max, lv.cells, act === 'running' ? RUNNING_COLOR : undefined)
      if (withBar) row.push(...(done ? cells.map(c => ({ ...c, dim: true })) : cells), { text: ' ' })
      if (lv.words) row.push({ text: `${sizeVerb(act).padEnd(5)} `, dim: true })
      row.push(done ? { text: sizeText(a).padStart(tokW), dim: true } : { text: sizeText(a).padStart(tokW) })
      if (lv.out) row.push({ text: `  wrote ${wroteText(a).padEnd(outW)}`, dim: true })
      const model = shortModel(a.model)
      const effort = effortLabel(a.effort)
      if (lv.model && model) row.push({ text: `  ${effort ? `${model}·${effort}` : model}`, dim: true })
      if (act) row.push({ text: '  ' }, wordSeg(act, act))
      // A process the session started says how long it ran (MC-7061).
      if (a.runS !== undefined) row.push({ text: ` ${fmtRun(a.runS)}`, dim: true })
      return row
    })
    // A running or failed count takes its row word's colour or weight; the rest of the line stays faint.
    const sum: Seg[] = [{ text: '  ', dim: true }]
    counts.forEach((p, i) => {
      if (i > 0) sum.push({ text: ' · ', dim: true })
      sum.push(p.state && STRONG.has(p.state) ? wordSeg(p.state, p.text) : { text: p.text, dim: true })
      const inP = p.state === undefined ? [] : folded.filter(a => counted(a, nowMs) === p.state)
      if (inP.length > 0 && lv.panel !== 'none') sum.push({ text: ` (${panelText(inP, lv, nowMs)})`, dim: true })
    })
    sum.push({ text: ` · ${known ? fmtTokens(total) : '–'} ${lv.words ? 'tokens processed' : 'processed'}${lv.explain ? ', each re-read counted' : ''}`, dim: true })
    if (lv.out) sum.push({ text: ` · ${known ? fmtTokens(output) : '–'} written`, dim: true })
    if (more > 0) sum.push({ text: ` · +${more} more`, dim: true })
    if (withBar && lv.explain) sum.push({ text: ' · bars against the largest', dim: true })
    rows.push(sum)
    return rows
  }
  for (const lv of LEVELS) {
    const rows = build(lv)
    if (cols === undefined || rows.every(r => cellWidth(plain(r)) <= cols)) return rows
  }
  return build(LEVELS[LEVELS.length - 1]!)
}

/** The rows as plain text, for `/drain agents`. */
export function agentText(agents: DrainAgent[], nowMs: number): string {
  if (agents.length === 0) return 'No subagents in this session yet.'
  return agentRows(agents, nowMs).map(plain).join('\n')
}
