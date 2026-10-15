import { describe, expect, test } from 'claude-code/testing'
import * as core from '../hooks/core.ts'
import type { DrainReading } from '../types'

const NOW = 2_000_000_000
const base: DrainReading = {
  ...core.emptyReading(3600, 'transcript'),
  percent: 16, tokens: 160000, window: 1000000,
  rateLimits: [{ kind: 'five_hour', pct: 95 }, { kind: 'seven_day', pct: 44 }],
  model: 'claude-opus-5-5', effort: 'medium', lastApiS: NOW - 2, observed: true,
}
const view = (r: Partial<DrainReading> = {}, drafting = false) => core.makeView({ ...base, ...r }, NOW, drafting)

describe('styles', () => {
  test('minimal', () => {
    expect(core.styleText('minimal', view())).toBe('🧠 16% │ ◷ 59:58 │ 5h 95% · wk 44% │ opus·medium')
  })
  test('bars', () => {
    expect(core.styleText('bars', view())).toBe('ctx ▰▰▱▱▱▱▱▱▱▱ 16% │ cache ▰▰▰▰▰▰▰▰▰▰ 59:58 │ 5h ▰▰▰▰▰ 95%  wk ▰▰▱▱▱ 44% │ opus·medium')
  })
  test('gauge', () => {
    expect(core.styleText('gauge', view())).toBe('E ━━━━━━━━━━━━━◆── F 84% left │ ◷ 59:58 │ 5h 95% · wk 44% │ opus·medium')
  })
  test('compact', () => {
    expect(core.styleText('compact', view())).toBe('🧠16% ◷59:58 5h95 wk44')
  })
  test('line', () => {
    expect(core.styleText('line', view())).toBe('🧠 16% · cache 59:58 · 5h 95% · wk 44% · opus·medium')
  })
  test('off draws nothing', () => {
    expect(core.renderRows('off', view())).toHaveLength(0)
    expect(core.renderRows('line', view())).toHaveLength(0)
  })
  test('no cache yet, no limits', () => {
    expect(core.styleText('minimal', view({ lastApiS: undefined, rateLimits: [] }))).toBe('🧠 16% │ opus·medium')
  })
  test('narrow width degrades to compact', () => {
    const rows = core.renderRows('bars', view(), 30)
    expect(core.plain(rows[0]!)).toBe('🧠16% ◷59:58 5h95 wk44')
    const mid = core.renderRows('minimal', view(), 40)
    expect(core.plain(mid[0]!)).toBe('🧠 16% │ ◷ 59:58 │ 5h 95% · wk 44%')
  })
  test('the brain glyph counts two cells', () => {
    expect(core.cellWidth('🧠1')).toBe(3)
  })
})

describe('the 5-hour reset time', () => {
  // Expected clock times are worked out here, in local time, not with core.clock.
  const hhmm = (s: number) => {
    const d = new Date(s * 1000)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const reset = NOW + 3 * 3600 + 20 * 60
  const withReset = (fiveAt?: number, weekAt?: number) =>
    view({ rateLimits: [{ kind: 'five_hour', pct: 95, resetsAt: fiveAt }, { kind: 'seven_day', pct: 44, resetsAt: weekAt }] })

  test('minimal shows when the 5-hour window resets', () => {
    expect(core.styleText('minimal', withReset(reset))).toBe(`🧠 16% │ ◷ 59:58 │ 5h 95% ↻${hhmm(reset)} · wk 44% │ opus·medium`)
  })
  test('only the 5-hour window, never the week', () => {
    expect(core.styleText('minimal', withReset(undefined, NOW + 3 * 86400))).toBe('🧠 16% │ ◷ 59:58 │ 5h 95% · wk 44% │ opus·medium')
  })
  test('a reset already past is not shown', () => {
    expect(core.styleText('minimal', withReset(NOW - 60))).toBe('🧠 16% │ ◷ 59:58 │ 5h 95% · wk 44% │ opus·medium')
  })
  test('the other styles are unchanged', () => {
    const v = withReset(reset)
    for (const style of ['bars', 'gauge', 'compact', 'line'] as const) expect(core.styleText(style, v)).not.toContain('↻')
  })
  test('when space is short the model goes first, then the reset time', () => {
    const v = withReset(reset)
    const noModel = `🧠 16% │ ◷ 59:58 │ 5h 95% ↻${hhmm(reset)} · wk 44%`
    const cols = core.cellWidth(noModel)
    expect(core.plain(core.renderRows('minimal', v, cols)[0]!)).toBe(noModel)
    expect(core.plain(core.renderRows('minimal', v, cols - 1)[0]!)).toBe('🧠 16% │ ◷ 59:58 │ 5h 95% · wk 44%')
  })
})

describe('colours', () => {
  test('context thresholds', () => {
    expect(view({ percent: 59 }).ctx.color).toBe('success')
    expect(view({ percent: 60 }).ctx.color).toBe('warning')
    expect(view({ percent: 79 }).ctx.color).toBe('warning')
    expect(view({ percent: 80 }).ctx.color).toBe('error')
  })
  test('unknown and implausible are uncoloured and marked', () => {
    const u = view({ unknown: true })
    expect(u.ctx.color).toBeUndefined()
    expect(core.styleText('compact', u)).toStartWith('🧠~16%')
    const i = view({ tokens: 1200000, window: 1000000, percent: 120 })
    expect(i.ctx.color).toBeUndefined()
    expect(core.styleText('minimal', i)).toStartWith('🧠 ⚠ 120%')
  })
  test('cache inherits context colour above 60 s, then yellow, red, expired', () => {
    expect(view({ percent: 65, lastApiS: NOW - 3600 + 61 }).cache.color).toBe('warning')
    expect(view({ percent: 10, lastApiS: NOW - 3600 + 61 }).cache.color).toBe('success')
    expect(view({ lastApiS: NOW - 3600 + 59 }).cache.color).toBe('warning')
    expect(view({ lastApiS: NOW - 3600 + 14 }).cache.color).toBe('error')
    const ex = view({ lastApiS: NOW - 3600 - 5 })
    expect(ex.cache.color).toBe('error')
    expect(core.styleText('minimal', ex)).toContain('◷ expired')
  })
  test('rate limits 70 / 90', () => {
    const v = view({ rateLimits: [{ kind: 'five_hour', pct: 69 }, { kind: 'seven_day', pct: 70 }, { kind: 'spend_limit', pct: 90 }] })
    expect(v.limits.map(l => l.color)).toEqual([undefined, 'warning', 'error'])
  })
  test('segments carry the colours into the band', () => {
    const row = core.renderRows('minimal', view({ percent: 85 }))[0]!
    expect(row.find(s => s.text === '85%')?.color).toBe('error')
    expect(row.find(s => s.text === '95%')?.color).toBe('error')
    expect(row.find(s => s.text === 'opus·medium')?.dim).toBe(true)
  })
})
