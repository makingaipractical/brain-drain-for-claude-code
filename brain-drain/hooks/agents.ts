// Pure logic for the per-subagent token bars (prototype, `/drain agents on`): no `$`, so the tests call it directly.
//
// A session's subagents write `<transcript dir>/<sessionId>/subagents/agent-<id>.jsonl`
// (workflow agents one level down, in `workflows/<wf>/`), append-only, beside an
// `agent-<id>.meta.json` naming the agent. register.tsx reads the new bytes of each
// file on a timer and feeds them here; the prompt draws from the stored result.
import { bar, cellWidth, effortLabel, fmtTokens, plain, shortModel } from './core.ts'
import type { Row, Seg } from './core.ts'
import type { DrainAgent } from '../types'

/** An agent counts as running, as a guess, while its file changed this recently. */
export const RUNNING_GUESS_MS = 30_000
export const MAX_ROWS = 5

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
  requests: number
  model?: string
  effort?: string
}

export function newAcc(): Acc {
  return { offset: 0, seen: {}, tokens: 0, output: 0, requests: 0 }
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

/** `running` from the engine's own agent list, `running?` guessed from the file's last write, else nothing. */
export function activity(a: DrainAgent, nowMs: number): 'running' | 'running?' | undefined {
  if (a.status === 'running' || a.status === 'pending' || a.status === 'waiting') return 'running'
  if (a.status !== undefined) return undefined
  return nowMs - a.mtimeMs <= RUNNING_GUESS_MS ? 'running?' : undefined
}

function fit(label: string, width: number): string {
  const chars = [...label]
  if (chars.length <= width) return label + ' '.repeat(width - chars.length)
  return `${chars.slice(0, width - 1).join('')}…`
}

type Level = { cells: number; out: boolean; model: boolean; labelMax: number }
const LEVELS: Level[] = [
  { cells: 10, out: true, model: true, labelMax: 18 },
  { cells: 10, out: false, model: true, labelMax: 18 },
  { cells: 10, out: false, model: false, labelMax: 18 },
  { cells: 5, out: false, model: false, labelMax: 12 },
]

/**
 * The rows under the gauge: one per agent (active first, then the most recently
 * written, at most MAX_ROWS), each bar scaled to the session's largest agent,
 * then one total line. Empty when the session has no agents.
 */
export function agentRows(agents: DrainAgent[], nowMs: number, cols?: number): Row[] {
  if (agents.length === 0) return []
  const max = Math.max(1, ...agents.map(a => a.tokens))
  const ranked = [...agents].sort((a, b) => {
    const act = Number(activity(b, nowMs) !== undefined) - Number(activity(a, nowMs) !== undefined)
    return act !== 0 ? act : b.mtimeMs - a.mtimeMs
  })
  const shown = ranked.slice(0, MAX_ROWS)
  const total = agents.reduce((n, a) => n + a.tokens, 0)
  const output = agents.reduce((n, a) => n + a.output, 0)
  const more = agents.length - shown.length

  const build = (lv: Level): Row[] => {
    const width = Math.min(lv.labelMax, Math.max(...shown.map(a => [...a.label].length)))
    const tokW = Math.max(...shown.map(a => fmtTokens(a.tokens).length))
    const outW = Math.max(...shown.map(a => fmtTokens(a.output).length))
    const rows: Row[] = shown.map(a => {
      const row: Row = [{ text: `  ${fit(a.label, width)} `, dim: true }, ...bar(a.tokens / max, lv.cells, undefined)]
      row.push({ text: ` ${fmtTokens(a.tokens).padStart(tokW)}` })
      if (lv.out) row.push({ text: `  out ${fmtTokens(a.output).padEnd(outW)}`, dim: true })
      const model = shortModel(a.model)
      const effort = effortLabel(a.effort)
      if (lv.model && model) row.push({ text: `  ${effort ? `${model}·${effort}` : model}`, dim: true })
      const act = activity(a, nowMs)
      if (act) row.push({ text: `  ${act}` })
      return row
    })
    const sum: Seg[] = [{ text: `  ${agents.length} agent${agents.length === 1 ? '' : 's'} · ${fmtTokens(total)} tokens`, dim: true }]
    if (lv.out) sum.push({ text: ` · ${fmtTokens(output)} out`, dim: true })
    if (more > 0) sum.push({ text: ` · +${more} more`, dim: true })
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
