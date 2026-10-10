import type { DrainLimit, DrainNotify } from '../types'
import { fmtTokens } from './core.ts'

// The self-notice: a one-line note of facts handed to the main session's model
// when a figure crosses a threshold. Pure: register.tsx reads the figures, keeps
// which thresholds have fired, and attaches the text.

export const DEFAULT_NOTIFY: DrainNotify = { on: false, context: [70, 90], fiveHour: [80, 95], week: true, margin: 5, text: {} }

export const ENV_NAME = 'BRAIN_DRAIN_NOTIFY'
const MAX_LINES = 10
const MAX_TEXT = 2000

export type Figures = {
  context?: { pct: number; tokens: number; window: number }
  fiveHour?: { pct: number; resetsAt?: number }
  week?: { pct: number; resetsAt?: number }
}

/** The figures as the engine reports them. A context with no token count (fresh, or just compacted) is not known. */
export function figures(context: { tokens?: number; window: number; percent?: number }, limits: DrainLimit[]): Figures {
  const f: Figures = {}
  if (context.tokens !== undefined && context.window > 0) {
    f.context = { pct: context.percent ?? (context.tokens / context.window) * 100, tokens: context.tokens, window: context.window }
  }
  const five = limits.find(l => l.kind === 'five_hour')
  if (five) f.fiveHour = { pct: five.pct, resetsAt: five.resetsAt }
  const week = limits.find(l => l.kind === 'seven_day')
  if (week) f.week = { pct: week.pct, resetsAt: week.resetsAt }
  return f
}

/** The share of the week gone since the weekly reset, as a percentage, plus the margin. */
export function paceLine(resetsAtS: number, nowS: number, margin: number): number {
  const daysSince = Math.min(7, Math.max(0, 7 - (resetsAtS - nowS) / 86400))
  return (daysSince / 7) * 100 + margin
}

/** Each configured threshold with whether it stands crossed now; undefined where its figure is not known. */
function states(f: Figures, n: DrainNotify, nowS: number): { key: string; crossed?: boolean }[] {
  const out: { key: string; crossed?: boolean }[] = []
  for (const t of n.context) out.push({ key: `context:${t}`, crossed: f.context ? f.context.pct >= t : undefined })
  for (const t of n.fiveHour) out.push({ key: `5h:${t}`, crossed: f.fiveHour ? f.fiveHour.pct >= t : undefined })
  if (n.week) {
    const w = f.week
    out.push({ key: 'week', crossed: w && w.resetsAt !== undefined ? w.pct > paceLine(w.resetsAt, nowS, n.margin) : undefined })
  }
  return out
}

/**
 * Which thresholds are newly crossed, and the fired set after this reading:
 * a crossed threshold fires once; one whose figure fell back below re-arms; one
 * whose figure is not known keeps its state.
 */
export function evaluate(f: Figures, n: DrainNotify, fired: readonly string[], nowS: number): { crossed: string[]; fired: string[] } {
  const was = new Set(fired)
  const now = new Set(fired)
  const crossed: string[] = []
  for (const s of states(f, n, nowS)) {
    if (s.crossed === undefined) continue
    if (s.crossed && !was.has(s.key)) {
      crossed.push(s.key)
      now.add(s.key)
    } else if (!s.crossed) {
      now.delete(s.key)
    }
  }
  return { crossed, fired: [...now] }
}

function clock(epochS: number): string {
  const d = new Date(epochS * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The facts, one line: `Brain Drain: context 71% (712k of 1M) · 5-hour window 82%, resets 18:20 · week 40% (pace line 43%)`. */
export function factsLine(f: Figures, n: DrainNotify, nowS: number): string {
  const parts: string[] = []
  if (f.context) parts.push(`context ${Math.round(f.context.pct)}% (${fmtTokens(f.context.tokens)} of ${fmtTokens(f.context.window)})`)
  if (f.fiveHour) parts.push(`5-hour window ${Math.round(f.fiveHour.pct)}%${f.fiveHour.resetsAt !== undefined ? `, resets ${clock(f.fiveHour.resetsAt)}` : ''}`)
  if (f.week) {
    const pace = f.week.resetsAt !== undefined ? ` (pace line ${Math.round(paceLine(f.week.resetsAt, nowS, n.margin))}%)` : ''
    parts.push(`week ${Math.round(f.week.pct)}%${pace}`)
  }
  return `Brain Drain: ${parts.length > 0 ? parts.join(' · ') : 'no figures yet'}`
}

/** The note as the model receives it: the facts, then the user's own text for each threshold just crossed, one per line. */
export function noticeText(f: Figures, n: DrainNotify, crossed: readonly string[], nowS: number): string {
  const extra = crossed.map(k => n.text[k]).filter((t): t is string => typeof t === 'string' && t.trim() !== '')
  return [factsLine(f, n, nowS), ...extra].join('\n')
}

// ---------------------------------------------------------------- settings

function lines(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_LINES) return undefined
  if (!v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100)) return undefined
  return [...new Set(v as number[])].sort((a, b) => a - b)
}

/** A text key names a threshold kind and, for context and 5h, its value: `context:35`, `5h:80`, `week`. */
export function isTextKey(k: string): boolean {
  return k === 'week' || /^(context|5h):\d+(\.\d+)?$/.test(k)
}

function texts(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, t] of Object.entries(v)) {
    if (!isTextKey(k) || typeof t !== 'string' || t.length > MAX_TEXT) return undefined
    if (t.trim() !== '') out[k] = t
  }
  return out
}

/** Saved prefs, field by field: a field of the wrong shape falls back to its default. */
export function sanitize(v: unknown): DrainNotify {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  return {
    on: o.on === true,
    context: lines(o.context) ?? DEFAULT_NOTIFY.context,
    fiveHour: lines(o.fiveHour) ?? DEFAULT_NOTIFY.fiveHour,
    week: typeof o.week === 'boolean' ? o.week : DEFAULT_NOTIFY.week,
    margin: typeof o.margin === 'number' && Number.isFinite(o.margin) && Math.abs(o.margin) <= 100 ? o.margin : DEFAULT_NOTIFY.margin,
    text: texts(o.text) ?? {},
  }
}

/**
 * `BRAIN_DRAIN_NOTIFY`, the per-run override for launchers: `on`, `off`, or a
 * JSON object with any of `on`, `context`, `5h`, `week`, `margin`, `text`.
 * Each key given replaces the saved value for this run; a JSON value turns the
 * feature on unless it says `"on": false`. Anything else is an error, and the
 * saved prefs stand.
 */
export function parseEnv(raw: string | undefined): { value?: Partial<DrainNotify>; error?: string } {
  if (raw === undefined || raw.trim() === '') return {}
  const s = raw.trim()
  if (s === 'on' || s === 'off') return { value: { on: s === 'on' } }
  let o: unknown
  try {
    o = JSON.parse(s)
  } catch {
    return { error: `${ENV_NAME} is neither on, off nor JSON` }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { error: `${ENV_NAME} must be a JSON object` }
  const src = o as Record<string, unknown>
  const out: Partial<DrainNotify> = { on: true }
  for (const k of Object.keys(src)) {
    if (!['on', 'context', '5h', 'week', 'margin', 'text'].includes(k)) return { error: `${ENV_NAME}: unknown key "${k}"` }
  }
  if ('on' in src) {
    if (typeof src.on !== 'boolean') return { error: `${ENV_NAME}: "on" must be true or false` }
    out.on = src.on
  }
  if ('context' in src) {
    const l = lines(src.context)
    if (!l) return { error: `${ENV_NAME}: "context" must be a list of numbers from 0 to 100` }
    out.context = l
  }
  if ('5h' in src) {
    const l = lines(src['5h'])
    if (!l) return { error: `${ENV_NAME}: "5h" must be a list of numbers from 0 to 100` }
    out.fiveHour = l
  }
  if ('week' in src) {
    if (typeof src.week !== 'boolean') return { error: `${ENV_NAME}: "week" must be true or false` }
    out.week = src.week
  }
  if ('margin' in src) {
    if (typeof src.margin !== 'number' || !Number.isFinite(src.margin) || Math.abs(src.margin) > 100) return { error: `${ENV_NAME}: "margin" must be a number from -100 to 100` }
    out.margin = src.margin
  }
  if ('text' in src) {
    const t = texts(src.text)
    if (!t) return { error: `${ENV_NAME}: "text" must map keys like "context:35", "5h:80" or "week" to strings` }
    out.text = t
  }
  return { value: out }
}

/** The settings in force: the saved ones with the run's override laid over them. */
export function effective(saved: DrainNotify, override: Partial<DrainNotify> | undefined): DrainNotify {
  return override ? { ...saved, ...override } : saved
}

/** `/drain notify` with no arguments: the settings in force and where they come from. */
export function describe(n: DrainNotify, fromEnv: boolean, envError: string | undefined, fired: readonly string[], now: string): string[] {
  const out = [`Self-notice ${n.on ? 'on' : 'off'}${fromEnv ? ` (this run: ${ENV_NAME} overrides the saved settings)` : ''}`]
  if (envError) out.push(`${envError}; the saved settings stand.`)
  out.push(`  context  ${n.context.length > 0 ? n.context.map(t => `${t}%`).join(', ') : 'off'}`)
  out.push(`  5h       ${n.fiveHour.length > 0 ? n.fiveHour.map(t => `${t}%`).join(', ') : 'off'}`)
  out.push(`  week     ${n.week ? `above the pace line (days since the weekly reset / 7 x 100, plus ${n.margin} points)` : 'off'}`)
  const keys = Object.keys(n.text)
  if (keys.length > 0) {
    out.push('  your text:')
    for (const k of keys) out.push(`    ${k.replace(':', ' ')}: ${n.text[k]}`)
  }
  out.push(`  fired this session: ${fired.length > 0 ? fired.map(k => k.replace(':', ' ')).join(', ') : 'none'}`)
  out.push(`The note reads, now: ${now}`)
  return out
}
