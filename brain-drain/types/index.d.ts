export type DrainStyle = 'minimal' | 'bars' | 'gauge' | 'compact' | 'line' | 'off'

export type DrainLimit = { kind: string; pct: number; resetsAt?: number }

export type DrainReading = {
  percent?: number
  tokens?: number
  window?: number
  /** Context fill not known since a compact or a resume: the last figure is held. */
  unknown: boolean
  rateLimits: DrainLimit[]
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

export type DrainPlace = 'below' | 'above'

export type DrainPrefs = {
  style: DrainStyle
  place: DrainPlace
  warnSeconds: number
  sound: boolean
  /** Prototype: per-subagent token bars under the gauge. Off unless asked for. */
  agents: boolean
  /** The self-notice: a facts-only note to the main session's model when a threshold is crossed. Off unless asked for. */
  notify: DrainNotify
}

export type DrainNotify = {
  on: boolean
  /** Context fill thresholds, percent. */
  context: number[]
  /** Five-hour window thresholds, percent. */
  fiveHour: number[]
  /** Weekly utilisation above the pace line: days since the weekly reset / 7 x 100, plus `margin` points. */
  week: boolean
  margin: number
  /** The user's own text, appended after the facts when that threshold fires: `context:35`, `5h:80`, `week`. */
  text: Record<string, string>
}

/** One subagent of this session, as its transcript adds up. */
export type DrainAgent = {
  /** The file's stem after `agent-`, as the engine names the agent. */
  id: string
  label: string
  /** Every request's input + cache write + cache read + output, each response counted once. */
  tokens: number
  output: number
  requests: number
  model?: string
  effort?: string
  /** The transcript's last write, epoch milliseconds. */
  mtimeMs: number
  /** The engine's word for the agent (`$.agent.list()`), when it lists it. */
  status?: string
}

export type DrainAgents = { dir: string; agents: DrainAgent[] }

export type DrainMeta = {
  /** False under `claude -p` and the SDK: no session file then, as the bridge writes none. */
  interactive?: boolean
  /** The session the reading belongs to; /clear, /resume and a fork change it. */
  sessionId?: string
  home?: string
  outDir?: string
  shadow?: boolean
  transcriptPath?: string
  alertedFor?: number
  /** Self-notice thresholds fired in this session and not re-armed: `context:70`, `5h:80`, `week`. */
  notified?: string[]
  /** This run's `BRAIN_DRAIN_NOTIFY`, parsed once at setup. */
  notifyEnv?: Partial<DrainNotify>
  notifyEnvError?: string
  pendingMiss?: { key: string; costBefore: number }
}

export type DrainMiss = {
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
      reading: DrainReading | null
      prefs: DrainPrefs | null
      drafting: boolean
      /** Turns begun and not yet complete; a subagent's leaves at its first request. */
      turns: string[] | null
      meta: DrainMeta | null
      agents: DrainAgents | null
    }
  }
}
