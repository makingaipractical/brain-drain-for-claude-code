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
  /** Rows under the gauge for subagents and the Claude Code processes this session started. On unless turned off. */
  agents: boolean
  /** Set once the user has run `/drain agents on|off`: only then does a stored `agents` count, so a default reaches everyone who never chose. */
  agentsChosen?: boolean
  /** The self-notice: a facts-only note to the main session's model when a threshold is crossed. On for the context stages unless turned off; stored with only the fields the user set. */
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
  /** Minutes after the last note when the facts are told again, crossed or not; 0 turns this off. */
  refresh: number
}

/** One subagent of this session, as its transcript adds up. */
export type DrainAgent = {
  /** The file's stem after `agent-`, as the engine names the agent. */
  id: string
  label: string
  /** The sidecar's `description`, the few words the Agent call gave; shown after the label when two rows share one. */
  detail?: string
  /** Every request's input + cache write + cache read + output, each response counted once. */
  tokens: number
  output: number
  /** The latest response's input + cache write + cache read + output: the agent's context now. Absent on a row stored before 0.3.0. */
  context?: number
  requests: number
  model?: string
  effort?: string
  /** The transcript's last write, epoch milliseconds. */
  mtimeMs: number
  /** The engine's word for the agent (`$.agent.list()`), when it lists it. */
  status?: string
  /** The meta sidecar says `finished: true`, which Claude Code writes when an ordinary subagent ends. */
  finished?: boolean
  /** A workflow's agent (its file under `workflows/<wf>/`): Claude Code's agent panel shows the run as one line, never this agent. */
  workflow?: boolean
  /** The sidecar's `requestShape` is `foreground`: Claude waits for it, and the agent panel gives it no row. */
  foreground?: boolean
  /** A Claude Code process this session started (MC-7061), read from the record its own mod wrote. */
  process?: boolean
  /** A process's run time so far, or until its transcript's last write once it ended, in seconds. */
  runS?: number
}

export type DrainAgents = { dir: string; agents: DrainAgent[] }

export type DrainMeta = {
  /** False under `claude -p` and the SDK: no session file then, as the bridge writes none. True again once the VS Code chat panel is found drawing (MC-5948). */
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
  /** The last context figure, in tokens, the notice read in this session: a large fall from it is a compaction (MC-7602). */
  noticeTokens?: number
  /** When the last note reached the model, epoch seconds; none yet in this session means the next chance tells the facts (MC-8006). */
  noticeAt?: number
  /** The five-hour reset the last note named, epoch seconds; undefined when it named none. */
  noticeFiveReset?: number
  /** The account the last note named, as it named it. */
  noticeAccount?: string
  /** A compaction seen and not yet told: the next note with a known context figure tells it. */
  noticeCompacted?: boolean
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
