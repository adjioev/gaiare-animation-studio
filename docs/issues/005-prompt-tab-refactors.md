# 005 — Refactor: prompt-bearing-tab predicate + split PromptLibraryModal

**Status:** Open
**Effort:** ~1h (both)
**Priority:** Low (deferred — code works, these are growth-pain pre-empts)
**Trigger:** When a 3rd prompt-bearing tab kind lands (e.g. narration), OR when the library browse UI grows independent features (tag filter, pagination, sort)

## Context

Two structural smells flagged by architect review of the prompt-library
feature. Neither is a bug — the code is correct and ships clean. They're
noted here so the future change that makes them painful is cheap when it
arrives.

---

## Smell 1 — "prompt-bearing tab" concept duplicated across 4 sites

The knowledge that a tab kind has a prompt textarea (currently
`generate` + `transform`) is hardcoded in four places:

| File | Site | Code |
|---|---|---|
| `src/App.tsx` | `applyPromptToActiveTab` | `if (active.kind !== "generate" && active.kind !== "transform") return` |
| `src/App.tsx` | `libraryKindForActiveTab` | `generate → "wan"; transform → "flux"; else null` |
| `src/App.tsx` | `openLibrary` (draftBody resolution) | `active.kind === "generate" \|\| active.kind === "transform"` |
| `src/components/ChatPanel.tsx` | `Bubble canApply` prop | `activeTab?.kind === "generate" \|\| activeTab?.kind === "transform"` |

**Why it'll bite:** adding a 3rd prompt-bearing tab (e.g. `narration`
with a text-to-speech prompt) means touching all four. Miss one → a
silent bug (the new tab can't apply prompts, or the library button
doesn't appear).

### Fix

Extract a shared predicate + kind-mapping in one place (likely
`src/lib/workspace.ts` or a small `src/lib/tab-kinds.ts`):

```ts
export function isPromptBearingTab(kind: PersistedTab["kind"]): boolean {
  return kind === "generate" || kind === "transform";
}

// kind → prompt-library domain
export function promptKindForTab(
  kind: PersistedTab["kind"],
): PromptKind | null {
  if (kind === "generate") return "wan";
  if (kind === "transform") return "flux";
  return null;
}
```

Then the 4 sites call the helpers. Adding a 3rd tab = one edit in each
helper (2 edits total), not 4 scattered conditionals.

### Acceptance criteria

- [ ] `isPromptBearingTab` + `promptKindForTab` helpers exist in one module
- [ ] All 4 sites above call the helpers instead of inline `kind ===` checks
- [ ] `skillContextForTab` in `src/lib/llm.ts` (a 5th related spot) folded
      in or left consistent — it's the wan/flux skills picker, same axis
- [ ] Adding a hypothetical `narration` kind is verified to need edits in
      only the helpers (grep for `=== "generate"` to confirm no stragglers)

---

## Smell 2 — `PromptLibraryModal` does browse + save in one component

`src/components/PromptLibraryModal.tsx` (~243 lines) has two mode
branches (`browse` / `save`) sharing only the header shell + Esc
handling. The browse list (search, filter, apply, delete) and the save
form (name input, dedup warning, update-or-new) are otherwise
independent.

**Why it'll bite:** if browse grows features — tag filter, pagination,
sort dropdown, multi-select — the two unrelated concerns tangle in one
file. Harder to read, harder to test in isolation.

### Fix

Split into:
- `PromptBrowseModal` (or `PromptBrowsePanel`) — search + list + apply/delete
- `PromptSaveModal` (or inline `PromptSaveForm`) — name + dedup + save
- `PromptModalShell` — shared overlay + header + Esc handling

The parent (`App.tsx`) already tracks `libraryModal.mode`, so routing to
the right sub-component is a one-line switch.

### Acceptance criteria

- [ ] Browse and save are separate components
- [ ] Shared overlay/header/Esc logic not duplicated (extracted to a shell
      or a small hook)
- [ ] `App.tsx`'s `libraryModal` state + handlers unchanged externally
      (refactor is component-internal)

---

## Why deferred

- Only 2 prompt-bearing tab kinds exist; 3rd not on the roadmap
- 243-line modal with a clean `mode ===` split is still readable
- Premature abstraction for a 3-user tool — both fixes are cheap to do
  *at the moment they're needed*, expensive only if forgotten

Do NOT do these speculatively. They earn their keep only when the trigger
condition actually arrives.
