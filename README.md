# Brain Drain for Claude Code

How full Claude's context is, when its cache goes cold, and how much of your 5-hour and weekly
limits is left — right under the prompt in Claude Code.

```
🧠 16% │ ◷ 59:58 │ 5h 95% · wk 44% │ opus·medium
```

Brain Drain is a Claude Code mod: a plugin that runs inside Claude Code and reads its figures
from Claude Code itself. It never calls a model, makes no network requests, and never changes
what you type.

Not made by or affiliated with Anthropic.

## What it shows

- **Context:** how full the context window is, green, then yellow from 60%, red from 80%.
- **Cache countdown:** how long until the prompt cache expires, using the TTL Claude Code actually
  wrote (one hour or five minutes), read from the session transcript rather than guessed.
- **Limits:** your 5-hour and weekly usage, yellow from 70%, red from 90%.
- **Model and effort**, for example `opus·medium`.

Why the cache matters: Claude Code's documentation says that "after a long enough gap, the next
request recomputes the full input and re-establishes the cache, which is why the first turn back
after stepping away can be noticeably slower." It also says that once you go over your plan's
usage limit and draw on usage credits, "Claude Code drops the main conversation to the
five-minute TTL" ([How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)).
The countdown follows that switch.

## What it warns you about

- **A cold cache while you type.** If the cache has already expired, a red line appears under the
  gauge as soon as you start typing, before you send:
  `▲ cache expired · your next message re-writes ~312k tokens`
- **Expiry coming up.** A notice 60 seconds before the cache expires (`/drain warn` changes the
  lead time; `/drain sound on` adds a short chime).
- **What misses cost.** `/drain` lists the cache misses of today and the last 7 days, with the
  tokens re-written and the cost Claude Code measured for them. Misses are kept for 60 days.

## Telling Claude its own levels (off by default)

With `/drain notify on`, Brain Drain adds one line of facts to Claude's own context when a
threshold is crossed, so the session itself knows where it stands:

```
Brain Drain: context 71% (712k of 1M) · 5-hour window 82%, resets 18:20 · week 40% (pace line 48%)
```

- It speaks once per threshold, after a tool call or when you send a prompt, and again only after
  the figure has dropped back below it. It speaks to the main conversation only, never to
  subagents.
- Default thresholds: context 70% and 90%, 5-hour window 80% and 95%, and the weekly pace line:
  the share of the week gone since your weekly reset, plus 5 points.
- The line states facts only. To tell Claude what to do about them, attach your own words to a
  threshold: `/drain notify text context 90 "wrap up and summarise"`.
- It works in non-interactive `claude -p` runs too, from the first tool call on. Nothing can
  arrive before Claude Code's first response, because the figures do not exist until then.

For unattended runs, the environment variable `BRAIN_DRAIN_NOTIFY` overrides your saved settings
for one run. It takes `on`, `off`, or JSON with any of these keys: `on`, `context` (a list),
`5h` (a list), `week` (true or false), `margin`, and `text` (keys `"context:35"`, `"5h:80"`,
`"week"`). For example:

```
BRAIN_DRAIN_NOTIFY='{"context":[30,35],"5h":[80],"text":{"context:35":"stop and write down your state"}}' claude -p "..."
```

## Install

Requires Claude Code v2.1.287 or later in the terminal (the first version with mods). Tested
with v2.1.296 on macOS.

```
claude plugin marketplace add makingaipractical/brain-drain-for-claude-code
claude plugin install brain-drain@brain-drain
```

Then run `/reload-plugins` in an open session, or start a new one.

Mods are switched off by `disableAllHooks` in your settings, by an organisation's
`allowManagedModsOnly`, and for one session by `--safe-mode`
([Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)). Claude Code marks the
mods API as early access, so a Claude Code update can break a mod; if Brain Drain stops drawing,
please open an issue with your Claude Code version.

## Commands

| Command | What it does |
|---|---|
| `/drain` | The cache-miss report, the TTL and where it came from, and your settings |
| `/drain styles` | Previews every display style with your current figures |
| `/drain <style>` | Switches style: `minimal` (default), `bars`, `gauge`, `compact`, `line`, `off` |
| `/drain place below\|above` | Draws under the prompt (default) or in the band above it |
| `/drain warn <seconds>` | Lead time of the expiry notice (default 60; 0 turns it off) |
| `/drain sound on\|off` | A short chime with the expiry notice (off by default) |
| `/drain notify ...` | The notice to Claude, above; `/drain notify` shows its settings |
| `/drain agents on\|off` | Prototype: one token bar per subagent under the gauge (off by default) |
| `/drain help` | The full list |

## With the VS Code extension

Brain Drain writes a small file per session to `~/.claude/fuel-gauge/`, which the
[Brain Drain VS Code extension](https://github.com/makingaipractical/claude-code-fuel-gauge) reads
to show the same figures in VS Code's status bar. If that extension's status-line bridge is
still connected, the mod leaves the bridge's folder alone and writes a copy to
`~/.claude/fuel-gauge-mod/` instead, so the two never overwrite each other. In `claude -p` runs
it writes no session file.

## What it touches

- Reads: Claude Code's own figures, and the last part of the current session's transcript (for
  the exact cache TTL and, with agent bars on, the subagent transcripts beside it).
- Writes: the session file above, and its own saved data inside Claude Code's plugin storage.
- Runs `tail`, `mv` and `rm` on those files only. Nothing else.

To remove it: `claude plugin uninstall brain-drain@brain-drain`.

## Licence

MIT
