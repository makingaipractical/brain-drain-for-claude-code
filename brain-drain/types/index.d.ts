export type FuelStyle = 'minimal' | 'bars' | 'gauge' | 'compact' | 'line' | 'off'

export type FuelLimit = { kind: string; pct: number; resetsAt?: number }

export type FuelReading = {
  percent?: number
  tokens?: number
  window?: number
  /** Context fill not known since a compact or a resume: the last figure is held. */
  unknown: boolean
  rateLimits: FuelLimit[]
  model?: string
  effort?: string
  /** Epoch seconds of the last main-thread API response. */
  lastApiS?: number
  /** True once this process saw a request of its own; miss detection needs it. */
  observed: boolean
  ttl: number
  ttlSource: 'transcript' | 'previous' | 'account' | 'default' | 'warm-gap'
  cacheRead: number
  cacheCreate: number
  outputTokens: number
  costUsd?: number
}

export type FuelPlace = 'below' | 'above'

export type FuelPrefs = { style: FuelStyle; place: FuelPlace; warnSeconds: number; sound: boolean }

export type FuelMeta = {
  /** False under `claude -p` and the SDK: no session file then, as the bridge writes none. */
  interactive?: boolean
  /** The session the reading belongs to; /clear, /resume and a fork change it. */
  sessionId?: string
  home?: string
  outDir?: string
  shadow?: boolean
  transcriptPath?: string
  alertedFor?: number
  pendingMiss?: { key: string; costBefore: number }
}

export type FuelMiss = {
  at: number
  session: string
  project: string
  tokens: number
  gapS: number
  ttl: number
  costUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'brain-drain': {
      reading: FuelReading | null
      prefs: FuelPrefs | null
      drafting: boolean
      /** Turns begun and not yet complete; a subagent's leaves at its first request. */
      turns: string[] | null
      meta: FuelMeta | null
    }
  }
}
