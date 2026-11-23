// Pure logic: no `$`, so the tests call it directly. register.tsx wires it to events.
import type { DrainLimit, DrainMiss, DrainReading, DrainStyle } from '../types'

export const STYLES: readonly DrainStyle[] = ['minimal', 'bars', 'gauge', 'compact', 'line', 'off']
export const BAND_STYLES: readonly DrainStyle[] = ['minimal', 'bars', 'gauge', 'compact']
export const DEFAULT_STYLE: DrainStyle = 'minimal'
export const DEFAULT_TTL = 300

// Theme keys, so the light, dark and colour-blind themes each pick a readable shade.
export const OK = 'success'
export const WARN = 'warning'
export const BAD = 'error'

// The extension's thresholds: context 60/80, rate limits 70/90; the cache has its
// own (MC-7064): a one-hour cache 25 min/5 min, a five-minute cache 60 s/15 s.
export const CONTEXT_WARN = 60
export const CONTEXT_DANGER = 80
export const CACHE_WARN_S = 60
export const CACHE_DANGER_S = 15
export const CACHE_LONG_WARN_S = 25 * 60
export const CACHE_LONG_DANGER_S = 5 * 60
export const LIMIT_WARN = 70
export const LIMIT_DANGER = 90

// A request counts as a cache miss only when it re-wrote at least this much.
export const MIN_MISS_TOKENS = 2000

export const TAIL_WINDOWS = [65536, 262144, 1048576] as const

export function isStyle(s: string): s is DrainStyle {
  return (STYLES as readonly string[]).includes(s)
}

export function isBandStyle(s: DrainStyle): boolean {
  return BAND_STYLES.includes(s)
}

// ---------------------------------------------------------------- colours

export function isImplausible(r: Pick<DrainReading, 'percent' | 'tokens' | 'window'>): boolean {
  if (r.window !== undefined && r.window > 0 && r.tokens !== undefined && r.tokens > r.window) return true
  return (r.percent ?? 0) > 100
}

export function contextColor(pct: number | undefined, unknown: boolean, implausible: boolean): string | undefined {
  if (unknown || implausible || pct === undefined) return undefined
  if (pct >= CONTEXT_DANGER) return BAD
  if (pct >= CONTEXT_WARN) return WARN
  return OK
}

export type CacheState =
  | { kind: 'none' }
  | { kind: 'live'; left: number }
  | { kind: 'expired'; since: number }

export function cacheState(r: Pick<DrainReading, 'lastApiS' | 'ttl'>, nowS: number): CacheState {
  if (r.lastApiS === undefined || r.lastApiS <= 0) return { kind: 'none' }
  const left = Math.floor(r.lastApiS + r.ttl - nowS)
  if (left <= 0) return { kind: 'expired', since: -left }
  return { kind: 'live', left }
}

/**
 * The countdown's colour is its own, never the context's: otherwise a 57-minute
 * cache shows yellow because the context reached its warning level. Green, then
 * for a cache that lives longer than five minutes (the one-hour cache) yellow
 * from 25 minutes left and red from 5; a five-minute cache keeps yellow under 60
 * seconds and red under 15, since the one-hour cache's minutes would make it red
 * from its first second.
 */
export function cacheColor(c: CacheState, ttl: number): string | undefined {
  if (c.kind === 'expired') return BAD
  if (c.kind === 'none') return undefined
  if (ttl > 300) {
    if (c.left <= CACHE_LONG_DANGER_S) return BAD
    if (c.left <= CACHE_LONG_WARN_S) return WARN
    return OK
  }
  if (c.left < CACHE_DANGER_S) return BAD
  if (c.left < CACHE_WARN_S) return WARN
  return OK
}

export function limitColor(pct: number): string | undefined {
  if (pct >= LIMIT_DANGER) return BAD
  if (pct >= LIMIT_WARN) return WARN
  return undefined
}

// ---------------------------------------------------------------- formatting

export function fmtCountdown(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function shortModel(id: string | undefined): string | undefined {
  if (!id) return undefined
  const m = id.toLowerCase()
  for (const family of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(family)) return family
  return id
}

const EFFORT_LABELS: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'x-high', max: 'max' }

export function effortLabel(e: string | undefined): string | undefined {
  if (!e) return undefined
  return EFFORT_LABELS[e] ?? e
}

/** Local wall-clock time, `18:20`. */
export function clock(epochS: number): string {
  const d = new Date(epochS * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Local day and time, `Sun 22 Nov 08:00`: for a moment days away, such as the weekly reset. */
export function dayClock(epochS: number): string {
  const d = new Date(epochS * 1000)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(epochS)}`
}

/**
 * Time left until a moment, `in 46 min`, `in 1 h 5 min`, `in 2 h`, and from a
 * day on `in 5 d 8 h`, `in 1 d`; undefined once it has come. Minutes round up,
 * so a moment not yet come never reads as `in 0 min`; past a day the minutes
 * are dropped, since the clock time beside it says the rest.
 */
export function timeLeft(untilS: number, nowS: number): string | undefined {
  const s = untilS - nowS
  if (s <= 0) return undefined
  const min = Math.ceil(s / 60)
  if (min < 60) return `in ${min} min`
  if (min >= 1440) {
    const d = Math.floor(min / 1440)
    const h = Math.floor((min % 1440) / 60)
    return h === 0 ? `in ${d} d` : `in ${d} d ${h} h`
  }
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`
}

/** Whether two moments fall on the same local calendar day. */
export function sameDay(aS: number, bS: number): boolean {
  const a = new Date(aS * 1000)
  const b = new Date(bS * 1000)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * A reset moment as a note names it: the clock time alone when it falls today
 * (local time), else with its weekday and date, `Sun 22 Nov 08:00`. A five-hour
 * reset after midnight is not today, so it gets the date too.
 */
export function resetClock(atS: number, nowS: number): string {
  return sameDay(atS, nowS) ? clock(atS) : dayClock(atS)
}

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'wk'
  if (kind === 'spend_limit') return '$'
  return kind
}

// ---------------------------------------------------------------- the view

export type View = {
  ctx: { pct?: number; unknown: boolean; implausible: boolean; color?: string }
  cache: CacheState & { color?: string; ttl: number }
  /**
   * `resetsAt` only for the 5-hour window, and only while it lies ahead.
   * `pct` is missing on the 5-hour entry when Claude Code sends a weekly
   * figure but none for the 5-hour window: it is drawn as `5h –`, so a plan
   * without a 5-hour limit does not look like a broken gauge.
   */
  limits: { label: string; pct?: number; color?: string; resetsAt?: number }[]
  modelEffort?: string
  /** Set while the prompt box holds text and the cache has expired. */
  cold?: { tokens?: number }
}

function viewLimits(list: DrainLimit[], nowS: number): View['limits'] {
  const out: View['limits'] = list.map(l => ({
    label: limitLabel(l.kind),
    pct: l.pct,
    color: limitColor(l.pct),
    resetsAt: l.kind === 'five_hour' && l.resetsAt !== undefined && l.resetsAt > nowS ? l.resetsAt : undefined,
  }))
  // A weekly figure with no 5-hour one: the plan reports no 5-hour limit. With
  // neither figure (an API key, or before the first response) nothing is drawn.
  const week = list.findIndex(l => l.kind === 'seven_day')
  if (week >= 0 && !list.some(l => l.kind === 'five_hour')) out.splice(week, 0, { label: limitLabel('five_hour') })
  return out
}

/** A limit's figure: `95%`, or `–` when the plan sends none. */
function limitNum(l: View['limits'][number], withPct: boolean): string {
  return l.pct === undefined ? '–' : `${Math.round(l.pct)}${withPct ? '%' : ''}`
}

export function makeView(r: DrainReading, nowS: number, drafting: boolean): View {
  const implausible = isImplausible(r)
  const ctxColor = contextColor(r.percent, r.unknown, implausible)
  const cache = cacheState(r, nowS)
  const model = shortModel(r.model)
  const effort = effortLabel(r.effort)
  return {
    ctx: { pct: r.percent, unknown: r.unknown, implausible, color: ctxColor },
    cache: { ...cache, color: cacheColor(cache, r.ttl), ttl: r.ttl },
    limits: viewLimits(r.rateLimits, nowS),
    modelEffort: model === undefined ? undefined : effort === undefined ? model : `${model}·${effort}`,
    cold: drafting && cache.kind === 'expired' ? { tokens: r.tokens } : undefined,
  }
}

// ---------------------------------------------------------------- rows

export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Row = Seg[]

const WIDE = new Set(['🧠'])

/** Terminal cells a string takes; the brain glyph is a wide character. */
export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += WIDE.has(ch) ? 2 : 1
  return n
}

export function plain(row: Row): string {
  return row.map(s => s.text).join('')
}

function pctText(v: View): string {
  if (v.ctx.pct === undefined) return '–%'
  const n = Math.round(v.ctx.pct)
  if (v.ctx.implausible) return `⚠ ${n}%`
  return v.ctx.unknown ? `~${n}%` : `${n}%`
}

function cacheText(v: View): string | undefined {
  if (v.cache.kind === 'none') return undefined
  return v.cache.kind === 'expired' ? 'expired' : fmtCountdown(v.cache.left)
}

const SEP: Seg = { text: ' │ ', dim: true }

function joinGroups(groups: Row[]): Row {
  const out: Row = []
  for (const g of groups) {
    if (g.length === 0) continue
    if (out.length > 0) out.push(SEP)
    out.push(...g)
  }
  return out
}

function limitsGroup(v: View, glue: string, withPct: boolean, withReset = false): Row {
  const g: Row = []
  v.limits.forEach((l, i) => {
    if (i > 0) g.push({ text: glue, dim: true })
    g.push({ text: `${l.label} `, dim: true }, { text: limitNum(l, withPct), color: l.color })
    if (withReset && l.resetsAt !== undefined) g.push({ text: ` ↻${clock(l.resetsAt)}`, dim: true })
  })
  return g
}

export function bar(fraction: number, cells: number, color: string | undefined): Row {
  const f = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(f * cells)
  const row: Row = []
  if (filled > 0) row.push({ text: '▰'.repeat(filled), color })
  if (cells - filled > 0) row.push({ text: '▱'.repeat(cells - filled), dim: true })
  return row
}

function minimalRow(v: View, withModel: boolean, withReset: boolean): Row {
  const groups: Row[] = [[{ text: '🧠 ' }, { text: pctText(v), color: v.ctx.color, bold: true }]]
  const c = cacheText(v)
  if (c) groups.push([{ text: '◷ ', dim: true }, { text: c, color: v.cache.color }])
  groups.push(limitsGroup(v, ' · ', true, withReset))
  if (withModel && v.modelEffort) groups.push([{ text: v.modelEffort, dim: true }])
  return joinGroups(groups)
}

function barsRow(v: View, withModel: boolean, wide: boolean): Row {
  const ctxCells = wide ? 10 : 5
  const groups: Row[] = [[
    { text: 'ctx ', dim: true },
    ...bar((v.ctx.pct ?? 0) / 100, ctxCells, v.ctx.color),
    { text: ` ${pctText(v)}`, color: v.ctx.color, bold: true },
  ]]
  const c = cacheText(v)
  if (c) {
    const left = v.cache.kind === 'live' ? v.cache.left : 0
    groups.push([
      { text: 'cache ', dim: true },
      ...bar(left / Math.max(left, v.cache.ttl, 1), ctxCells, v.cache.color),
      { text: ` ${c}`, color: v.cache.color },
    ])
  }
  const lim: Row = []
  v.limits.forEach((l, i) => {
    if (i > 0) lim.push({ text: '  ' })
    if (l.pct === undefined) {
      lim.push({ text: `${l.label} `, dim: true }, { text: '–' })
      return
    }
    lim.push({ text: `${l.label} `, dim: true }, ...bar(l.pct / 100, wide ? 5 : 3, l.color), {
      text: ` ${Math.round(l.pct)}%`,
      color: l.color,
    })
  })
  groups.push(lim)
  if (withModel && v.modelEffort) groups.push([{ text: v.modelEffort, dim: true }])
  return joinGroups(groups)
}

function gaugeRow(v: View, withModel: boolean, track: number): Row {
  const left = Math.max(0, Math.min(100, 100 - (v.ctx.pct ?? 0)))
  const pos = Math.round((left / 100) * (track - 1))
  const needle: Row = [{ text: 'E ', dim: true }]
  if (pos > 0) needle.push({ text: '━'.repeat(pos), color: v.ctx.color })
  needle.push({ text: '◆', color: v.ctx.color, bold: true })
  if (track - 1 - pos > 0) needle.push({ text: '─'.repeat(track - 1 - pos), dim: true })
  needle.push({ text: ' F ', dim: true })
  const leftText = v.ctx.pct === undefined ? '–' : v.ctx.unknown ? `~${Math.round(left)}%` : `${Math.round(left)}%`
  needle.push({ text: v.ctx.implausible ? '⚠ ?' : leftText, color: v.ctx.color, bold: true }, { text: ' left', dim: true })
  const groups: Row[] = [needle]
  const c = cacheText(v)
  if (c) groups.push([{ text: '◷ ', dim: true }, { text: c, color: v.cache.color }])
  groups.push(limitsGroup(v, ' · ', true))
  if (withModel && v.modelEffort) groups.push([{ text: v.modelEffort, dim: true }])
  return joinGroups(groups)
}

function compactRow(v: View, withLimits: boolean): Row {
  const row: Row = [{ text: '🧠' }, { text: pctText(v), color: v.ctx.color, bold: true }]
  const c = cacheText(v)
  if (c) row.push({ text: ' ◷', dim: true }, { text: v.cache.kind === 'expired' ? 'exp' : c, color: v.cache.color })
  if (withLimits) {
    for (const l of v.limits) {
      row.push({ text: ` ${l.label}`, dim: true }, { text: limitNum(l, false), color: l.color })
    }
  }
  return row
}

function coldRows(v: View): Row[] {
  if (!v.cold) return []
  const amount = v.cold.tokens === undefined ? 'the whole context' : `~${fmtTokens(v.cold.tokens)} tokens`
  return [
    [{ text: '▲ cache expired', color: BAD, bold: true }, { text: ` · your next message re-writes ${amount}`, color: BAD }],
    [{ text: '▲ cold', color: BAD, bold: true }, { text: ` · next msg re-writes ${v.cold.tokens === undefined ? 'all' : `~${fmtTokens(v.cold.tokens)}`}`, color: BAD }],
  ]
}

/** The gauge row's candidates for a style, widest first. */
function candidates(style: DrainStyle, v: View): Row[] {
  switch (style) {
    case 'minimal':
      // Widest first. When space is short, the model is dropped first, then the 5-hour reset time.
      return [minimalRow(v, true, true), minimalRow(v, false, true), minimalRow(v, false, false), compactRow(v, true), compactRow(v, false)]
    case 'bars':
      return [barsRow(v, true, true), barsRow(v, false, true), barsRow(v, false, false), compactRow(v, true), compactRow(v, false)]
    case 'gauge':
      return [gaugeRow(v, true, 16), gaugeRow(v, false, 16), gaugeRow(v, false, 8), compactRow(v, true), compactRow(v, false)]
    case 'compact':
      return [compactRow(v, true), compactRow(v, false)]
    default:
      return []
  }
}

function fit(rows: Row[], cols: number | undefined): Row | undefined {
  if (rows.length === 0) return undefined
  if (cols === undefined) return rows[0]
  return rows.find(r => cellWidth(plain(r)) <= cols) ?? rows[rows.length - 1]
}

/**
 * The band's rows for a style: the gauge row, and under it the cold-cache
 * warning while one applies. Narrower forms are picked when `cols` is tight.
 */
export function renderRows(style: DrainStyle, v: View, cols?: number): Row[] {
  const main = fit(candidates(style, v), cols)
  if (!main) return []
  const out: Row[] = [main]
  const cold = coldRows(v)
  if (cold.length > 0) {
    const pick = style === 'compact' ? cold[1] : fit(cold, cols)
    if (pick) out.push(pick)
  }
  return out
}

/** The `line` style: one plain line for `$.ui.status`, which takes no colour. */
export function lineText(v: View): string {
  const parts = [`🧠 ${pctText(v)}`]
  const c = cacheText(v)
  if (c) parts.push(v.cache.kind === 'expired' ? 'cache expired' : `cache ${c}`)
  for (const l of v.limits) parts.push(`${l.label} ${limitNum(l, true)}`)
  if (v.modelEffort) parts.push(v.modelEffort)
  let text = parts.join(' · ')
  if (v.cold) {
    const amount = v.cold.tokens === undefined ? 'the whole context' : `~${fmtTokens(v.cold.tokens)} tokens`
    text += ` · next message re-writes ${amount}`
  }
  return text
}

/** Text form of a style, for `/drain styles`. */
export function styleText(style: DrainStyle, v: View): string {
  if (style === 'line') return lineText(v)
  if (style === 'off') return '(nothing drawn; the session file is still written)'
  return renderRows(style, v).map(plain).join('\n')
}

// ---------------------------------------------------------------- handover

/** True while the effective status line is the bridge script, so the bridge owns the session file. */
export function bridgeLive(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false
  const sl = (settings as { statusLine?: unknown }).statusLine
  if (typeof sl !== 'object' || sl === null) return false
  const cmd = (sl as { command?: unknown }).command
  return typeof cmd === 'string' && cmd.includes('context-bridge.sh')
}

export const SHADOW_DIR = '.claude/fuel-gauge-mod'
export const PRIMARY_DIR = '.claude/fuel-gauge'
/**
 * A non-interactive run's file (`claude -p`, an SDK run) goes here and nowhere
 * else. Every reader of session files lists only the top of fuel-gauge/ and
 * fuel-gauge-mod/, so a VS Code gauge never draws a headless run, and another
 * tool that wants one reads this folder.
 */
export const HEADLESS_DIR = '.claude/fuel-gauge-mod/headless'

export function outDirFor(home: string, live: boolean): string {
  return `${home}/${live ? SHADOW_DIR : PRIMARY_DIR}`
}

// ---------------------------------------------------------------- TTL from the transcript

/**
 * The cache TTL the most recent main-thread cache write used, read from the end
 * of a transcript. `cutFirst` drops the first line, which a read from the
 * middle of the file cuts in half. Mirrors the bridge's ttl_from_transcript.
 */
export function ttlFromTail(text: string, cutFirst: boolean): { ttl: number; atS: number } | undefined {
  const lines = text.split('\n')
  if (cutFirst && lines.length > 0) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('ephemeral_')) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const r = row as { isSidechain?: unknown; message?: unknown; timestamp?: unknown }
    if (r.isSidechain) continue
    const msg = r.message as { usage?: { cache_creation?: Record<string, unknown> } } | undefined
    const tiers = msg && typeof msg === 'object' ? msg.usage?.cache_creation : undefined
    if (typeof tiers !== 'object' || tiers === null) continue
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
    const atS = Number.isFinite(at) ? Math.floor(at / 1000) : 0
    if (Number(tiers.ephemeral_1h_input_tokens ?? 0) > 0) return { ttl: 3600, atS }
    if (Number(tiers.ephemeral_5m_input_tokens ?? 0) > 0) return { ttl: 300, atS }
  }
  return undefined
}

/** The bridge's account_ttl.json rule: write only a new value observed no earlier than the stored one. */
export function shouldWriteAccountTtl(
  stored: { detected_ttl?: number; detected_at?: number } | undefined,
  ttl: number,
  atS: number,
): boolean {
  if (ttl <= 0 || atS <= 0) return false
  const prevTtl = stored?.detected_ttl ?? 0
  const prevAt = stored?.detected_at ?? 0
  return ttl !== prevTtl && atS >= prevAt
}

// ---------------------------------------------------------------- misses

export type StepUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type CacheUsage = Pick<StepUsage, 'cache_read_input_tokens' | 'cache_creation_input_tokens'>

/**
 * The context fill one request reports: the three input counters the status line
 * sums, over the same raw window, rounded as the bridge's figure is. Set on every
 * request so a long turn does not show its first request's fill until the turn
 * ends; session.measure still has the last word at turn end (MC-4986).
 */
export function stepFill(usage: StepUsage, window: number | undefined): { tokens: number; percent?: number; unknown: false } {
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (window === undefined || window <= 0) return { tokens, unknown: false }
  return { tokens, percent: Math.round(tokens / window * 100), unknown: false }
}

/**
 * Classifies one main-thread request. `first`: nothing earlier was seen in this
 * process (a new or resumed session), never a miss. `miss`: the gap since the
 * last request outran the TTL and the request re-wrote more than it read.
 */
export function classifyStep(
  prev: Pick<DrainReading, 'lastApiS' | 'observed' | 'ttl'>,
  startS: number,
  usage: CacheUsage,
): 'first' | 'warm' | 'miss' {
  if (!prev.observed || prev.lastApiS === undefined || prev.lastApiS <= 0) return 'first'
  const gap = startS - prev.lastApiS
  const wrote = usage.cache_creation_input_tokens
  const readTokens = usage.cache_read_input_tokens
  if (gap > prev.ttl && wrote >= MIN_MISS_TOKENS && readTokens < wrote) return 'miss'
  return 'warm'
}

/**
 * The bridge's fallback upgrade, made stricter: a cache that served most of a
 * request after more than five minutes cannot be on the five-minute tier.
 * Only when the transcript gave no answer.
 */
export function warmGapUpgrade(prev: Pick<DrainReading, 'lastApiS' | 'observed' | 'ttl' | 'ttlSource'>, startS: number, usage: CacheUsage): boolean {
  if (prev.ttlSource === 'transcript' || prev.ttl >= 3600) return false
  if (!prev.observed || prev.lastApiS === undefined) return false
  return startS - prev.lastApiS > 310 && usage.cache_read_input_tokens > usage.cache_creation_input_tokens
}

export function missKey(atMs: number, session: string): string {
  return `miss:${Math.round(atMs)}:${session.slice(0, 8)}`
}

function startOfLocalDayS(nowS: number): number {
  const d = new Date(nowS * 1000)
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function tally(list: DrainMiss[]): string {
  if (list.length === 0) return 'no misses'
  const tokens = list.reduce((n, m) => n + m.tokens, 0)
  const priced = list.filter(m => typeof m.costUsd === 'number')
  const usd = priced.reduce((n, m) => n + (m.costUsd ?? 0), 0)
  const cost = priced.length === 0 ? 'no measured cost' : `$${usd.toFixed(2)} measured (${priced.length} of ${list.length})`
  return `${list.length} miss${list.length === 1 ? '' : 'es'} · ${fmtTokens(tokens)} tokens re-written · ${cost}`
}

export function ledgerReport(misses: DrainMiss[], nowS: number): string[] {
  const today = startOfLocalDayS(nowS)
  const week = nowS - 7 * 86400
  const lines = [
    `Today:        ${tally(misses.filter(m => m.at >= today))}`,
    `Last 7 days:  ${tally(misses.filter(m => m.at >= week))}`,
  ]
  const last = [...misses].sort((a, b) => b.at - a.at)[0]
  if (last) {
    const when = new Date(last.at * 1000)
    const stamp = `${when.toDateString().slice(4, 10)} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    lines.push(
      `Last miss:    ${stamp} in ${last.project || 'a session'}, ${fmtTokens(last.tokens)} tokens after ${fmtDuration(last.gapS)} idle (TTL ${last.ttl >= 3600 ? '1h' : '5m'})`,
    )
  }
  return lines
}

// ---------------------------------------------------------------- the account (MC-8006)

/**
 * The account a session's figures belong to. The engine's rate limits are the
 * session's own login's, and every reader of the session files used to infer
 * that account (from the weekly reset moment) because the file named none. A
 * wrong guess put another account's week in front of a session.
 *
 * `$.session.identity()` answers only a mod managed settings install, so the
 * mod reads what Claude Code itself reads: the host's word first
 * (CLAUDE_CODE_ACCOUNT_UUID and CLAUDE_CODE_USER_EMAIL, which the desktop app
 * and SDK hosts set, and which Claude Code only reads), then the login record
 * of the session's configuration folder (`oauthAccount` in `.claude.json`
 * under CLAUDE_CONFIG_DIR, else the home folder). The record holds the
 * account's identity, never the credential.
 *
 * All of it correct or none of it: a part the host leaves out is taken from the
 * record only when the record names the same account.
 */
export type Account = { uuid?: string; email?: string; source: 'session' | 'folder' }

const word = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/** The account a login record (a parsed `.claude.json`) names, or undefined. */
export function accountInRecord(record: unknown): { uuid?: string; email?: string } | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const a = (record as { oauthAccount?: unknown }).oauthAccount
  if (typeof a !== 'object' || a === null) return undefined
  const o = a as Record<string, unknown>
  const uuid = word(o.accountUuid)
  const email = word(o.emailAddress)
  return uuid || email ? { uuid, email } : undefined
}

/** Which account the session runs on, from the host's two variables and the folder's record. */
export function sessionAccount(envUuid: string | undefined, envEmail: string | undefined, record: unknown): Account | undefined {
  const uuid = word(envUuid)
  const email = word(envEmail)
  const rec = accountInRecord(record)
  if (uuid || email) {
    const same = rec !== undefined && (uuid ? rec.uuid === uuid : rec.email?.toLowerCase() === email!.toLowerCase())
    return { uuid: uuid ?? (same ? rec.uuid : undefined), email: email ?? (same ? rec.email : undefined), source: 'session' }
  }
  return rec ? { ...rec, source: 'folder' } : undefined
}

export function sameAccount(a: Account | undefined, b: Account | undefined): boolean {
  if (!a || !b) return false
  if (a.uuid && b.uuid) return a.uuid === b.uuid
  return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase()
}

/**
 * Whether the folder's record now names another account than the one first
 * read for this process. A /login since (here or in another process on the
 * same folder) rewrites the record, and which login the running process then
 * spends is not known from outside, so the file names no account from then on
 * rather than a possibly wrong one. A record that cannot be read, or names no
 * account, is no sign of a change. The host's variables never change for a
 * process, so an account they named never changes either.
 */
export function accountChanged(first: Account | undefined, now: Account | undefined): boolean {
  if (!first || first.source === 'session' || !now) return false
  return !sameAccount(first, now)
}

/**
 * The account as the self-notice names it: the short label the labels file
 * gives its uuid, else the email, else `account` and the first 8 characters of
 * its uuid, else `account not certain` (none found, or the login changed while
 * the process ran). A label never stands in for an account not known.
 */
export function accountLabel(a: Account | 'changed' | undefined, labels?: Labels): string {
  if (a === 'changed' || !a) return 'account not certain'
  const label = a.uuid ? labels?.get(a.uuid) : undefined
  if (label) return label
  if (a.email) return a.email
  return a.uuid ? `account ${a.uuid.slice(0, 8)}` : 'account not certain'
}

/**
 * Short names for accounts, keyed by account uuid, from an optional file that
 * another program on the machine writes (MC-8006). It sits at this fixed place
 * under the home folder, whatever CLAUDE_CONFIG_DIR says. The mod only reads it.
 */
export const LABELS_FILE = '.claude/fuel-gauge-mod/labels.json'
export const LABEL_MAX = 64
export type Labels = ReadonlyMap<string, string>

const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The labels a parsed labels file holds. Anything but an object of strings
 * gives none; a label that is empty, longer than LABEL_MAX characters or holds
 * a control character (a line break would split the note) is left out alone.
 */
export function labelsFrom(parsed: unknown): Labels {
  const out = new Map<string, string>()
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (!entries.every(([, v]) => typeof v === 'string')) return out
  for (const [uuid, v] of entries) {
    const label = (v as string).trim()
    if (uuid.trim() === '' || label === '' || label.length > LABEL_MAX || CONTROL.test(label)) continue
    out.set(uuid.trim(), label)
  }
  return out
}

/**
 * The session file's account fields: null where the account is not known, so a
 * reader does not guess. `changed`: the folder's login changed while this
 * process ran, so its account is not known for the rest of it.
 */

export function accountFields(a: Account | 'changed' | undefined): Record<string, string | null> {
  if (a === 'changed') return { account_uuid: null, account_email: null, account_source: 'changed' }
  return { account_uuid: a?.uuid ?? null, account_email: a?.email ?? null, account_source: a ? a.source : null }
}

// ---------------------------------------------------------------- the session file

export type Ids = { sessionId: string; cwd: string; projectDir: string }

function limitFields(limits: DrainLimit[], kind: string): { pct: number; reset: number } {
  const l = limits.find(x => x.kind === kind)
  return { pct: l ? l.pct : -1, reset: l?.resetsAt ?? 0 }
}

/** The bridge's session file, field for field, plus `writer: "mod"`. */
export function sessionFile(r: DrainReading, ids: Ids, nowS: number, account?: Account | 'changed'): Record<string, unknown> {
  const used = r.percent ?? 0
  const h5 = limitFields(r.rateLimits, 'five_hour')
  const d7 = limitFields(r.rateLimits, 'seven_day')
  return {
    cwd: ids.cwd,
    project_dir: ids.projectDir,
    used_percentage: used,
    remaining_percentage: Math.max(0, 100 - used),
    context_unknown: r.unknown,
    window_implausible: isImplausible(r),
    total_input_tokens: r.tokens ?? 0,
    total_output_tokens: r.outputTokens,
    context_window_size: r.window ?? 200000,
    model: r.model ?? 'unknown',
    session_id: ids.sessionId,
    timestamp: nowS,
    cache_read_input_tokens: r.cacheRead,
    cache_creation_input_tokens: r.cacheCreate,
    detected_ttl: r.ttl,
    last_api_call_ts: r.lastApiS ?? 0,
    rate_limit_5h_pct: h5.pct,
    rate_limit_5h_reset: h5.reset,
    rate_limit_7d_pct: d7.pct,
    rate_limit_7d_reset: d7.reset,
    effort_level: r.effort ?? '',
    // The account the rate limits above belong to (MC-8006); null: not known.
    ...accountFields(account),
    writer: 'mod',
  }
}

export function emptyReading(ttl = DEFAULT_TTL, source: DrainReading['ttlSource'] = 'default'): DrainReading {
  return { unknown: false, rateLimits: [], observed: false, ttl, ttlSource: source, cacheRead: 0, cacheCreate: 0, outputTokens: 0 }
}

/** A new session in the same process (/clear): the account's TTL, limits and the model carry over, nothing else. */
export function freshSession(prev: DrainReading): DrainReading {
  return { ...emptyReading(prev.ttl, prev.ttlSource), rateLimits: prev.rateLimits, model: prev.model, effort: prev.effort, window: prev.window }
}

/** A reading restored from this mod's own earlier file (a resume or a fresh process). */
export function readingFromFile(file: unknown, fallbackTtl: number, fallbackSource: DrainReading['ttlSource']): DrainReading | undefined {
  if (typeof file !== 'object' || file === null) return undefined
  const f = file as Record<string, unknown>
  if (f.writer !== 'mod') return undefined
  const num = (k: string): number | undefined => (typeof f[k] === 'number' ? (f[k] as number) : undefined)
  const ttl = num('detected_ttl')
  const r = emptyReading(ttl && ttl > 0 ? ttl : fallbackTtl, ttl && ttl > 0 ? 'previous' : fallbackSource)
  const last = num('last_api_call_ts')
  r.lastApiS = last && last > 0 ? last : undefined
  r.percent = num('used_percentage')
  r.window = num('context_window_size')
  r.model = typeof f.model === 'string' && f.model !== 'unknown' ? f.model : undefined
  r.effort = typeof f.effort_level === 'string' && f.effort_level !== '' ? f.effort_level : undefined
  return r
}

export function limitsFrom(list: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): DrainLimit[] {
  return list.map(l => {
    const t = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    return Number.isFinite(t) ? { kind: l.kind, pct: l.percentUsed, resetsAt: Math.floor(t / 1000) } : { kind: l.kind, pct: l.percentUsed }
  })
}

export const HELP = [
  '/drain                cache-miss report: today, last 7 days, tokens re-written, measured cost',
  '/drain styles         preview every display style with the current figures',
  '/drain <style>        switch style: minimal, bars, gauge, compact, line, off',
  '                      (/drain style <name> and /drain styles <name> work too)',
  '/drain place below|above  draw under the prompt (default) or in the band above it',
  '/drain warn <seconds>  how long before expiry the alert fires (default 60, 0 turns it off)',
  '/drain sound on|off   play a short chime with the alert (off by default)',
  '/drain agents on|off  one row per subagent or started session under the gauge, its context (on by default)',
  '/drain agents         the subagent rows as text',
  '/drain notify on|off  self-notice: a line of facts and what to do, to the model when a threshold is crossed (asked at setup; default on: context 20 30 35 50)',
  '/drain notify         the self-notice settings and the note as it would read now',
  '/drain notify context 30 50 | 5h 80 95 | week on|off | margin 5   thresholds (each list replaces the last; off clears)',
  '/drain notify refresh 30 | off   the facts again this many minutes after the last note (default 30)',
  '/drain notify text context 35 "your text"   your own words after the facts when that threshold fires',
  '                      (text 5h 80 "...", text week "..."; no text clears it)',
  '                      BRAIN_DRAIN_NOTIFY in the environment overrides these for one run (see the README)',
  '/drain help           this list',
]

/**
 * Every surface the session draws on: what `surfaces` answers (`$.session.surfaces()`)
 * where this Claude Code has it (MC-8315 item 6: no public source says which version
 * brought it in). Where the call fails, as calling a method a version lacks does, the
 * deprecated `surface`'s one answer; where that fails too, what `surfaces()` documents
 * for the two plain cases: `terminal` under an interactive session's prompt, nothing in
 * a `-p` run. So a terminal session still writes its agents' rows, and a `-p` run, or a
 * panel session not yet known as one, never becomes a writer by the guess. The calls
 * come as functions because a hooks module spells `$.session.surfaces()` where it calls it.
 */
export async function surfacesOf(
  surfaces: () => Promise<readonly string[]>,
  surface: () => Promise<string | null>,
  interactive: boolean,
): Promise<readonly string[]> {
  try {
    return await surfaces()
  } catch {
    // Missing or failing: try the older call.
  }
  try {
    const one = await surface()
    return one ? [one] : []
  } catch {
    // Neither here: answer as the documented plain cases.
  }
  return interactive ? ['terminal'] : []
}
