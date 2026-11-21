import type { DrainLimit, DrainNotify } from '../types'
import { clock, fmtTokens, resetClock, timeLeft } from './core.ts'

// The self-notice: a one-line note of facts handed to the main session's model
// when a figure crosses a threshold, and facts alone at the session's first
// chance, after a compaction, a five-hour reset or a change of account, and
// every `refresh` minutes (MC-8006). Pure: register.tsx reads the figures, keeps
// which thresholds have fired, and attaches the text.

// On by default for the context stages (MC-6373): a session that is not told
// does not know to look. The first interactive session asks the user, offering
// these. 20 is information; at 30 the note says to finish the piece in hand
// and start nothing new, at 35 it suggests closing, at 50 it says to close. A user's own words for a stage replace these; stored as an
// empty string, they silence them. The 5-hour and weekly thresholds are there
// to turn on.
export const DEFAULT_TEXT: Readonly<Record<string, string>> = {
  'context:20': 'For information: carry on.',
  'context:30': 'Wind down: finish the piece in hand, commit it, and start nothing new.',
  'context:35': 'Consider closing: finish the piece in hand and close the session, unless it clearly makes sense to go on.',
  'context:50': 'Close now: finish the piece in hand, commit it, write a summary of where things stand, and end the session.',
}
export const DEFAULT_NOTIFY: DrainNotify = { on: true, context: [20, 30, 35, 50], fiveHour: [], week: false, margin: 5, text: { ...DEFAULT_TEXT }, refresh: 30 }
/** The longest refresh interval accepted, in minutes: a day. */
export const MAX_REFRESH = 1440

// 0.2.1 and earlier stored the whole block, defaults included, with any other
// /drain change. A block exactly like this one was never chosen by anyone.
const LEGACY_DEFAULT: Omit<DrainNotify, 'refresh'> = { on: false, context: [70, 90], fiveHour: [80, 95], week: true, margin: 5, text: {} }

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

// A compaction seen as a fall in the context figure (MC-7602). Where an
// organization manages Claude Code (a managed settings file is enough), the
// built-in guard passes over a user's session.compact hooks, so the notice
// notices the compaction itself. The fall has to be large on both counts: earlier
// turns' thinking dropped from a request lowers the figure a little, a
// compaction or a rewind by a large share.
export const DROP_SHARE = 0.4
export const DROP_MIN_TOKENS = 20000

/** True when the context fell from `before` to `after` tokens as only a compaction or a rewind makes it fall. */
export function contextDropped(before: number | undefined, after: number | undefined): boolean {
  if (before === undefined || after === undefined) return false
  const fall = before - after
  return fall >= DROP_MIN_TOKENS && fall >= before * DROP_SHARE
}

/**
 * Which thresholds are newly crossed, and the fired set after this reading:
 * a crossed threshold fires once; one whose figure fell back below re-arms; one
 * whose figure is not known keeps its state. A context not known (just
 * compacted or resumed) clears the context stages, so the first figure after
 * it is told again: the earlier notes went into the summary.
 */
export function evaluate(f: Figures, n: DrainNotify, fired: readonly string[], nowS: number): { crossed: string[]; fired: string[] } {
  const kept = f.context ? fired : fired.filter(k => !k.startsWith('context:'))
  const was = new Set(kept)
  const now = new Set(kept)
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

/** Says the account is not known. A note never names an account it is not sure of. */
export const NO_ACCOUNT = 'account not certain'

/**
 * The facts, one line, with the account they belong to and when they were read:
 * `Brain Drain, work@, read 23:14: context 11% (110k of 1M) · 5-hour window 75% used, resets 00:00 (in 46 min) · week 36% used, resets Sun 22 Nov 08:00 (in 4 d 8 h; pace line 43%)`.
 * A reset names its clock time, with weekday and date only when it is not
 * today (local time), and how long until it. A window whose reset has passed
 * shows no figure: the one held is the old window's.
 */
export function factsLine(f: Figures, n: DrainNotify, nowS: number, account: string = NO_ACCOUNT): string {
  const parts: string[] = []
  if (f.context) parts.push(`context ${Math.round(f.context.pct)}% (${fmtTokens(f.context.tokens)} of ${fmtTokens(f.context.window)})`)
  if (f.fiveHour) {
    const r = f.fiveHour.resetsAt
    const left = r !== undefined ? timeLeft(r, nowS) : undefined
    if (r !== undefined && !left) parts.push(`5-hour window reset at ${resetClock(r, nowS)}, no new figure yet`)
    else parts.push(`5-hour window ${Math.round(f.fiveHour.pct)}% used${r !== undefined ? `, resets ${resetClock(r, nowS)} (${left})` : ''}`)
  }
  if (f.week) {
    const r = f.week.resetsAt
    const left = r !== undefined ? timeLeft(r, nowS) : undefined
    if (r !== undefined && !left) parts.push(`week reset at ${resetClock(r, nowS)}, no new figure yet`)
    else parts.push(`week ${Math.round(f.week.pct)}% used${r !== undefined ? `, resets ${resetClock(r, nowS)} (${left}; pace line ${Math.round(paceLine(r, nowS, n.margin))}%)` : ''}`)
  }
  return `Brain Drain, ${account}, read ${clock(nowS)}: ${parts.length > 0 ? parts.join(' · ') : 'no figures yet'}`
}

/** What the last note in this session told: when, the five-hour reset it named, the account it named. */
export type Told = { at?: number; fiveReset?: number; account?: string }

/**
 * Whether the facts go to the model now, though no threshold was crossed
 * (MC-8006): at the session's first chance; after a compaction not yet told,
 * once the new context figure is known; when the account named changes; when
 * the five-hour window has started again, once its new reset is known (or a
 * five-hour figure is known for the first time); and `refresh` minutes after
 * the last note.
 */
export function factsDue(f: Figures, n: DrainNotify, told: Told, account: string, compacted: boolean, nowS: number): boolean {
  if (told.at === undefined) return true
  if (compacted && f.context) return true
  if (told.account !== undefined && told.account !== account) return true
  const five = f.fiveHour?.resetsAt
  if (five !== undefined && five !== told.fiveReset && (told.fiveReset === undefined || nowS >= told.fiveReset)) return true
  return n.refresh > 0 && nowS - told.at >= n.refresh * 60
}

/** Ends the facts line of every note: who speaks. */
export const NOTE_SOURCE = 'An automatic note from the Brain Drain mod, not typed by the user.'
/**
 * Opens each line of a level's words: they were set ahead of time, not written now.
 * It names no author: the words may be the user's, the default they accepted, or
 * those of whatever launched the session for them (BRAIN_DRAIN_NOTIFY, MC-7275).
 */
export const LEVEL_PREFIX = 'Set ahead of time for this level: '

/**
 * The note as the model receives it: the facts and who speaks, then the words
 * for each kind of threshold just crossed, one per line. Where several stages
 * of one kind cross together (30 and 35 after a big tool result), the words of
 * the highest one that has any, alone.
 *
 * Since Claude Code 2.1.318 a note attached at prompt.submit arrives inside
 * the user's turn (labelled only "prompt.submit hook additional context"), so
 * the note names its source itself and marks the level's words as set in
 * advance: a model must not take them for the user's message of the moment
 * (MC-6969).
 */
export function noticeText(f: Figures, n: DrainNotify, crossed: readonly string[], nowS: number, account: string = NO_ACCOUNT): string {
  const top = new Map<string, string>()
  for (const k of crossed) {
    const t = n.text[k]
    if (typeof t !== 'string' || t.trim() === '') continue
    const [kind, v] = k.split(':')
    const held = top.get(kind!)
    if (held === undefined || Number(v) > Number(held.split(':')[1])) top.set(kind!, k)
  }
  return [`${factsLine(f, n, nowS, account)}. ${NOTE_SOURCE}`, ...[...top.values()].map(k => LEVEL_PREFIX + n.text[k]!)].join('\n')
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
    out[k] = t.trim() === '' ? '' : t
  }
  return out
}

function sameList(a: unknown, b: readonly number[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * The fields of a stored block the user chose, or undefined for none. The
 * block 0.2.1 saved along with another setting, untouched, counts as none, so
 * the new defaults reach everyone who never set the notice.
 */
export function chosen(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const d = LEGACY_DEFAULT
  const untouched =
    Object.keys(o).length === 6 && o.on === d.on && sameList(o.context, d.context) && sameList(o.fiveHour, d.fiveHour) &&
    o.week === d.week && o.margin === d.margin && typeof o.text === 'object' && o.text !== null && Object.keys(o.text).length === 0
  return untouched ? undefined : o
}

/** Saved prefs, field by field: a field missing or of the wrong shape falls back to its default. */
export function sanitize(v: unknown): DrainNotify {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  return {
    on: typeof o.on === 'boolean' ? o.on : DEFAULT_NOTIFY.on,
    context: lines(o.context) ?? DEFAULT_NOTIFY.context,
    fiveHour: lines(o.fiveHour) ?? DEFAULT_NOTIFY.fiveHour,
    week: typeof o.week === 'boolean' ? o.week : DEFAULT_NOTIFY.week,
    margin: typeof o.margin === 'number' && Number.isFinite(o.margin) && Math.abs(o.margin) <= 100 ? o.margin : DEFAULT_NOTIFY.margin,
    text: { ...DEFAULT_TEXT, ...storedText(o) },
    refresh: isRefresh(o.refresh) ? o.refresh : DEFAULT_NOTIFY.refresh,
  }
}

/** A refresh interval in minutes: 0 (off) to a day. */
export function isRefresh(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_REFRESH
}

/** The words the user set themselves, an empty string where they silenced a default. */
export function storedText(v: unknown): Record<string, string> {
  return (typeof v === 'object' && v !== null ? texts((v as Record<string, unknown>).text) : undefined) ?? {}
}

/**
 * Levels typed as an answer: `25 40 60`, `25, 40 and 60%`. Undefined unless the
 * answer is numbers alone, so a stray prompt (`fix ticket 42`) sets nothing, and
 * when one is out of range.
 */
export function levelsFrom(answer: string): number[] | undefined {
  if (!/^[\d\s.,;%]+$/.test(answer.replace(/\band\b/gi, ' '))) return undefined
  const nums = (answer.match(/\d+(\.\d+)?/g) ?? []).map(Number)
  return nums.length > 0 ? lines(nums) : undefined
}

/**
 * `BRAIN_DRAIN_NOTIFY`, the per-run override for launchers: `on`, `off`, or a
 * JSON object with any of `on`, `context`, `5h`, `week`, `margin`, `text`, `refresh`.
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
    if (!['on', 'context', '5h', 'week', 'margin', 'text', 'refresh'].includes(k)) return { error: `${ENV_NAME}: unknown key "${k}"` }
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
  if ('refresh' in src) {
    if (!isRefresh(src.refresh)) return { error: `${ENV_NAME}: "refresh" must be minutes from 0 (off) to ${MAX_REFRESH}` }
    out.refresh = src.refresh
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
  // Words go level by level: an override's words for one level leave the others' as they were.
  return override ? { ...saved, ...override, text: { ...saved.text, ...(override.text ?? {}) } } : saved
}

/** `/drain notify` with no arguments: the settings in force and where they come from. */
export function describe(n: DrainNotify, fromEnv: boolean, envError: string | undefined, fired: readonly string[], now: string): string[] {
  const out = [`Self-notice ${n.on ? 'on' : 'off'}${fromEnv ? ` (this run: ${ENV_NAME} overrides the saved settings)` : ''}`]
  if (envError) out.push(`${envError}; the saved settings stand.`)
  out.push(`  context  ${n.context.length > 0 ? n.context.map(t => `${t}%`).join(', ') : 'off'}`)
  out.push(`  5h       ${n.fiveHour.length > 0 ? n.fiveHour.map(t => `${t}%`).join(', ') : 'off'}`)
  out.push(`  week     ${n.week ? `above the pace line (days since the weekly reset / 7 x 100, plus ${n.margin} points)` : 'off'}`)
  out.push(`  refresh  ${n.refresh > 0 ? `every ${n.refresh} min since the last note` : 'off'}`)
  out.push('  facts alone also at a session\'s first prompt or tool call, after a compaction, when the five-hour window starts again and when the account changes')
  // Words for a level that is not set never show, so they are not listed.
  const set = (k: string) => (k === 'week' ? n.week : k.startsWith('context:') ? n.context.includes(Number(k.slice(8))) : n.fiveHour.includes(Number(k.slice(3))))
  const keys = Object.keys(n.text).filter(k => n.text[k]!.trim() !== '' && set(k))
  if (keys.length > 0) {
    out.push('  words after the facts:')
    for (const k of keys) out.push(`    ${k.replace(':', ' ')}: ${n.text[k]}`)
  }
  out.push(`  fired this session: ${fired.length > 0 ? fired.map(k => k.replace(':', ' ')).join(', ') : 'none'}`)
  out.push(`The note reads, now: ${now}`)
  return out
}
