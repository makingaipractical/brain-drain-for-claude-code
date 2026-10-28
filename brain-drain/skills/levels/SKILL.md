---
name: levels
description: How full this session's context window is, and how much of the account's five-hour and weekly usage is left, read from Brain Drain. Use before a large piece of work or a fan-out of subagents, when a line starting "Brain Drain:" appears in your context, or when asked how full your context is or how much usage is left.
---

# Your levels, from Brain Drain

Brain Drain is a Claude Code mod that reads Claude Code's own figures. Three of them bear on your work.

**Context window:** this session's own working memory: the conversation, files read, command output, instructions. As it nears its limit Claude Code compacts it: older tool output is cleared, the rest is summarised, and instructions given only in the conversation may be lost.

**Five-hour window and week:** the account's usage, not this session's. All activity on the account, in Claude Code and in Claude, counts against the same two limits, so parallel sessions and subagents spend what you were counting on. Each resets at a time Brain Drain reports.

## Reading them

1. **The notice line.** Brain Drain adds one line to your context when the context passes 20, 30, 35, 50, 70 and 90%, unless the user turned it off (`/drain notify off`) or set other stages:
   `Brain Drain: context 31% (312k of 1M) · 5-hour window 82%, resets 18:20 · week 40% (pace line 48%)`
   Each stage is told once, and again after a compaction. The 5-hour and weekly figures ride along as facts; they have thresholds of their own only if the user turned them on. The pace line is the share of the week gone since the weekly reset, plus a margin; above it, the week is being spent faster than it lasts. Any line after it is the user's own instruction for that stage: follow it.
2. **The session file**, when no line has arrived. Brain Drain writes one file per interactive session, named by the session id Claude Code puts in `CLAUDE_CODE_SESSION_ID`:
   ```bash
   f=~/.claude/fuel-gauge-mod/$CLAUDE_CODE_SESSION_ID.json; [ -f "$f" ] || f=~/.claude/fuel-gauge/$CLAUDE_CODE_SESSION_ID.json; cat "$f"
   ```
   `used_percentage` of `context_window_size` is the context. `rate_limit_5h_pct` and `rate_limit_7d_pct` are the two windows (-1: not reported), `rate_limit_5h_reset` and `rate_limit_7d_reset` their reset times in Unix seconds. `timestamp` says how old the reading is. `context_unknown: true` means just compacted or cleared: no figure until the next reply.
   A `claude -p` run writes no file; there only the notice line reports. A subagent gets no notice line, and the file describes the main session, not the subagent.
3. **Neither.** Brain Drain is not installed here, or not telling you. Say that you cannot see your levels; the user sees them with `/context` and `/usage`.

## What a level means for the work

The project's own rules on thresholds come first. Where it has none:

- Never call the context full, or wind down for its sake, without a figure. Read it first (above).
- Below 50% context (the 20, 30 and 35% notices), the line is information: carry on with the work.
- From 50%, finish the piece in hand and save it before starting anything large.
- From 70%, compaction is coming: write down where you are somewhere that survives it (a file, a ticket) before starting anything new.
- With the five-hour window nearly spent, do not fan out subagents: each draws on the same window, and one cut off mid-run leaves half-done work. Work one at a time, or stop at a clean point and name the reset time.
- With the week above its pace line, prefer the smaller way to the same result.

Never change the user's Brain Drain settings unasked (`/drain` commands, thresholds, style, its saved data): they are the user's. Report what you read, and suggest a change if one would help.

Sources: context window and compaction, code.claude.com/docs/en/glossary; shared limits, support.claude.com/en/articles/11145838; `/usage` and what drives limits, code.claude.com/docs/en/whats-new/2026-w16; `CLAUDE_CODE_SESSION_ID`, code.claude.com/docs/en/env-vars; everything about Brain Drain, its own code.
