# GS-11: Studio — skill prompt update for MCP tools

**Phase:** 4
**Effort:** 0.5 day
**Depends on:** GS-10 (MCP bridge works)
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Teach Kimi K2.6 (via `src/skills/wan-i2v.md`) when and how to use the
MCP tools landed in GS-10. Without this, Kimi has the tools available
but won't think to call them. Goal: ground every prompt iteration in
the actual Rails question + similar successful patterns from the
project.

## Why a separate ticket

Skills doc edits are the bulk of the value but the technical loop
needs to exist first (GS-10). Separating keeps the GS-10 PR small +
testable, and lets the skills tweaks land + get tuned without
re-deploying the underlying bridge.

## Acceptance criteria

- [ ] New section in `src/skills/wan-i2v.md`: **"What you can look up"**
  - Lists available MCP tools by name with one-line use-cases:
    - `SearchQuestions` — find existing questions matching a topic /
      cognitive type / signage code
    - `GetQuestion` — fetch full details (image URL, prompt history,
      cognitive_type, parent assets) for a single question by id or
      composite (`GE/14`)
    - `ListTopics` — discover the canonical topic taxonomy when the
      user mentions a concept like "right-of-way" or "blind spot"
- [ ] New section: **"When to look things up"**
  - Specific triggers that should prompt a tool call:
    1. User says "this is for Q<N>" or mentions a question id →
       `GetQuestion("<country>/<N>")` for grounding
    2. User asks "do we have a similar one" / "how did we handle X" →
       `SearchQuestions({ topic: "...", has_animation: true })`
    3. User uses ambiguous topic word ("intersection priority",
       "merging") and you're unsure of the canonical phrasing →
       `ListTopics()`
    4. After a generation fails twice in a row → search for
       successfully-animated questions with same `cognitive_type` and
       extract the working prompt pattern
- [ ] New section: **"When NOT to look things up"**
  - Don't tool-call for self-evident things: the start frame is right
    in front of you, the user just told you what they want
  - One tool call per turn is usually enough; if you need more, ask
    the user to confirm rather than recursing
  - Don't speculatively dump 5 similar prompts on the user without
    being asked
- [ ] New section: **"How to surface what you found"**
  - When citing a tool result, name the question explicitly:
    "Looking at Q22, which is also procedural intersection-priority..."
  - Don't paste raw JSON. Summarise in plain language.
  - Reference question by `Q<external_ref>` (no DB ids — those mean
    nothing to the user)
- [ ] Existing skills.md sections updated to reference these new
      capabilities where relevant:
  - "What you can see" section → add "and you can look up Rails project
    data via tool calls"
  - "Common failure modes" → for each mode, add a "consider also
    searching for similar successful animations via SearchQuestions"
    hint
- [ ] Soft 5 KB cap still respected — current size is ~6.5 KB; this
      adds ~1 KB. Run `pnpm check-skills` and verify still <15 KB.
      (Architect mentioned a hard 15 KB cap; we're far from it.)
- [ ] Increment `SKILLS_FINGERPRINT` automatically since the file
      content changed — verify by checking `workspace.chat[N].skillsFingerprint`
      after a fresh chat turn

## Implementation notes

- Tone matches existing skills.md: imperative, direct, no hedging.
- Tools section should be SHORTER than the failure-modes section to
  keep prompt-eng knowledge central.
- For "When NOT to look things up" — explicit anti-patterns are more
  persuasive than vague guidance, per LLM prompt-engineering common
  sense.
- Don't paste tool-result JSON shape verbatim — Kimi sees the actual
  return type at runtime; we just describe the use cases.

## Files touched

**Modified:**
- `src/skills/wan-i2v.md` — three new sections + edits to existing

## Test plan

- [ ] After Studio rebuild, send "this is for Q14" in chat → Kimi
      acknowledges + calls `GetQuestion("GE/14")` automatically (verify
      via DevTools dev logs or by Kimi's response citing image details
      it couldn't have seen from text alone)
- [ ] Send "the car keeps flying — have we solved this in a similar
      question?" → Kimi calls SearchQuestions with relevant filters
- [ ] Ambiguous "make the cars merge properly" → Kimi calls ListTopics
      to find the canonical concept name
- [ ] Send "describe what you see" with start frame attached → Kimi
      does NOT call any tool (image alone is enough)
- [ ] Generate fails twice → on third iteration Kimi calls
      SearchQuestions for working-pattern lookup unprompted
- [ ] Verify `SKILLS_FINGERPRINT` changed (check workspace.json
      `chat[].skillsFingerprint` before/after the skills edit)
- [ ] Re-run a previous chat history (existing workspace) → no errors
      (older messages keep their old fingerprint; new turns get the new
      one)

## Out of scope

- A/B testing different skill prompt wordings (manual iteration is
  fine for 3 users)
- Per-country skills (universal for now; if Italy needs different
  prompting later, fork via section guards or split files — separate
  ticket)
- Self-improving skills (auto-extract patterns from successful
  iterations) — future feature, possibly Phase 5
