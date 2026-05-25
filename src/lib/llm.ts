// Chat assistant — wraps the Rust `fireworks_chat` command and bundles
// the Wan-specific system prompt + a heuristic "Apply to prompt"
// extractor.
//
// The renderer hands the assistant a flat history every turn (system,
// user, assistant, …) — Fireworks is stateless so the entire context
// is shipped each call. ChatPanel keeps the running history in the
// workspace's `chat` field; this module only does the round-trip.

import { invoke } from "@tauri-apps/api/core";
import wanSkills from "../skills/wan-i2v.md?raw";
import fluxSkills from "../skills/flux-image-edit.md?raw";
import type {
  ChatMessage as PersistedChatMessage,
  PersistedTab,
  QuestionContext,
} from "./workspace";

/**
 * Stable 6-char identifier for the loaded skills doc, so each persisted
 * chat turn can be traced back to the exact skills content that was
 * driving the assistant at that moment. Useful when a regression turns
 * out to be caused by a skills.md edit — `git log src/skills/wan-i2v.md`
 * plus the fingerprint on the offending message narrows the diff fast.
 *
 * djb2 — short, fast, no crypto needed (this isn't a security signal).
 * Truncated to 6 hex chars; collisions don't matter, this is a hint not
 * an integrity check.
 */
function djb2Hash(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * Skills doc + fingerprint per domain. The chat assistant ships the
 * system prompt that matches the active tab — Generate / Stitch / no
 * tab use Wan skills (animation prompts); Transform uses Flux skills
 * (image edits). The fingerprint persisted on each assistant message
 * is the hash of WHICHEVER doc was active at that turn, so future
 * regressions are traceable to the exact skills version.
 */
const WAN_SKILLS_FINGERPRINT = djb2Hash(wanSkills);
const FLUX_SKILLS_FINGERPRINT = djb2Hash(fluxSkills);

export type SkillContext = "wan" | "flux";

/** Maps a tab kind → which skills doc to load. Generate / extract /
 *  trim / stitch / no-active-tab all stay on Wan because the
 *  conversational context is animation-driven; only `transform` switches
 *  to Flux because the user is talking about pixel-level image edits. */
export function skillContextForTab(
  kind: PersistedTab["kind"] | undefined,
): SkillContext {
  return kind === "transform" ? "flux" : "wan";
}

export function skillsForContext(ctx: SkillContext): string {
  return ctx === "flux" ? fluxSkills : wanSkills;
}

export function fingerprintForContext(ctx: SkillContext): string {
  return ctx === "flux" ? FLUX_SKILLS_FINGERPRINT : WAN_SKILLS_FINGERPRINT;
}


/** Soft cap for prose sections injected into the system prompt. `why` and
 *  `situation` can be paragraph-length; the standing context is resent every
 *  turn (Fireworks is stateless) and a thinking model deliberates over all of
 *  it, so capping keeps both token cost and latency down. Cuts on a word
 *  boundary near the limit and appends an ellipsis. */
function capSection(text: string, limit = 400): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + "…";
}

/**
 * Format the question's answer/explanation/scene context as a plain-text
 * block to append to the system prompt. This is how the chat stops being
 * "blind": the assistant learns the correct answer and the scene dynamics
 * (who moves vs. who stays, from resolve `can_proceed`) before the
 * contractor describes the animation.
 *
 * Appended to the SYSTEM prompt — not injected as a seed chat message — on
 * purpose: it's workspace-level standing context, so it shouldn't show up as
 * a bubble or distort the user/assistant turn accounting. Returns "" when
 * there's no usable context so the caller can append unconditionally.
 */
export function buildQuestionContextBlock(
  ctx: QuestionContext | null | undefined,
): string {
  if (!ctx) return "";

  const parts: string[] = [];
  if (ctx.correctAnswer) parts.push(`Correct answer: ${ctx.correctAnswer}`);

  const exp = ctx.explanation;
  if (exp?.answer) parts.push(`Explanation — answer: ${exp.answer}`);
  if (exp?.situation)
    parts.push(`Explanation — situation: ${capSection(exp.situation)}`);
  if (exp?.why) parts.push(`Explanation — why: ${capSection(exp.why)}`);

  if (ctx.sceneSummary) parts.push(`Scene: ${ctx.sceneSummary}`);
  if (ctx.sceneTypes.length > 0) {
    parts.push(`Scene types: ${ctx.sceneTypes.join(", ")}`);
  }

  if (ctx.actorObligations.length > 0) {
    const lines = ctx.actorObligations.map(
      (o) =>
        `- ${o.actorId} ${o.canProceed ? "proceeds" : "yields / stops"}: ${o.reason}`,
    );
    parts.push(`Who moves vs. who stays:\n${lines.join("\n")}`);
  }
  if (ctx.actorRelations.length > 0) {
    const lines = ctx.actorRelations.map((r) => `- ${r.reason}`);
    parts.push(`Priority:\n${lines.join("\n")}`);
  }

  if (parts.length === 0) return "";

  return (
    "\n\n## Question context (from the driving-theory database)\n" +
    "Reference — the correct answer and scene dynamics for this question. " +
    "Use it to ground any Wan prompt you write. Do NOT propose a prompt yet — " +
    "wait until the designer describes the motion they want.\n\n" +
    parts.join("\n\n")
  );
}

/** Fireworks-side message — `content` is either a string (text-only)
 *  or an array of parts (OpenAI vision format). We construct multipart
 *  content when the renderer attaches an image to the latest user
 *  message, otherwise stay with the cheaper string form. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type WireMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

export type ChatResponse = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** `"stop"` means clean finish. `"length"` means `max_tokens` hit
   *  and the output is truncated — the UI should warn the user the
   *  response is incomplete. Other Fireworks-specific values
   *  (`"content_filter"`, model errors) pass through unchanged. */
  finishReason: string;
};

/** Kimi K2.6 — handles both text and vision input on Fireworks
 *  (`supports_image_input: true` per the model card). Single slug
 *  because the model thrashing of an earlier text/vision split bought
 *  no quality and added decision noise. */
export const CHAT_MODEL = "accounts/fireworks/models/kimi-k2p6";

/** What gets injected into the latest user message's text — short
 *  studio-state snapshot so the AI grounds references to "the current
 *  prompt", "the input asset", etc. */
function tabContextBlock(m: PersistedChatMessage): string {
  if (!m.tabContext) return "";
  const ctx = m.tabContext;
  const parts: string[] = [`[Studio context — current tab: ${ctx.tabKind}]`];
  if (ctx.inputAssetLabel) parts.push(`Input: ${ctx.inputAssetLabel}`);
  if (ctx.prompt) parts.push(`Current prompt:\n${ctx.prompt}`);
  return parts.join("\n") + "\n\n---\n\n";
}

/**
 * Convert persisted history → wire messages. The latest user message
 * may carry an `attachImageDataUri` payload (from the caller) — we
 * inflate that one's content to a multipart array so the vision model
 * sees the image. Older messages stay text-only — re-attaching every
 * image across history would inflate token cost without adding signal
 * (the start frame is static for a single iteration loop).
 */
function toWireMessages(
  history: PersistedChatMessage[],
  attachImageDataUri: string | null,
): WireMessage[] {
  const out: WireMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    const isLatestUser =
      m.role === "user" && i === history.length - 1 && attachImageDataUri;
    const textBody = tabContextBlock(m) + m.text;
    if (isLatestUser) {
      out.push({
        role: m.role,
        content: [
          { type: "text", text: textBody },
          { type: "image_url", image_url: { url: attachImageDataUri! } },
        ],
      });
    } else {
      out.push({ role: m.role, content: textBody });
    }
  }
  return out;
}

/**
 * Strip raw chain-of-thought from a model response. Kimi K2.6 emits
 * its reasoning inline in `<think>…</think>` (sometimes `<thinking>` or
 * `<reasoning>`) before the user-facing answer. That's useful as an
 * internal trace but noisy in the chat bubble — the user gets a "🧠
 * Thinking…" placeholder while we wait, so once the response lands
 * they want the answer, not the trace.
 *
 * Handles a few tag variants so a model swap doesn't suddenly start
 * leaking reasoning into the UI. If the response is *only* a thinking
 * block (no answer), fall back to the original — better to show
 * something weird than a blank bubble.
 */
export function stripThinking(text: string): string {
  const cleaned = text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/\[(?:thinking|reasoning)\][\s\S]*?\[\/(?:thinking|reasoning)\]/gi, "")
    .trim();
  return cleaned.length > 0 ? cleaned : text.trim();
}

export async function chat(
  history: PersistedChatMessage[],
  opts: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    /** Data URI (e.g. `data:image/jpeg;base64,...`) attached to the
     *  latest user message. When provided, the call routes to a
     *  vision-capable model unless `opts.model` overrides. */
    attachImageDataUri?: string;
    /** Which skills doc to load as the system prompt. Defaults to Wan
     *  (animation) — caller should override to "flux" when the user
     *  is in a Transform tab so the assistant knows it's writing
     *  image-edit prompts, not animation prompts. */
    skillContext?: SkillContext;
    /** Standing question context (answer/explanation/scene) appended to the
     *  system prompt so the assistant grounds prompts in the correct answer.
     *  Build with `buildQuestionContextBlock`; "" / undefined is a no-op. */
    questionContextBlock?: string;
    /** Kimi K2.6 reasoning control (Fireworks `thinking` field). Defaults to
     *  disabled — measured: a question with the full skills system prompt
     *  takes ~19s with reasoning on (and `reasoning_effort:"low"` is no
     *  better/worse) vs ~1.5s disabled. Pass `{type:"enabled",budget_tokens:N}`
     *  (N >= 1024) to allow capped reasoning if prompt quality needs it. */
    thinking?: { type: "disabled" } | { type: "enabled"; budget_tokens: number };
  } = {},
): Promise<ChatResponse> {
  const model = opts.model ?? CHAT_MODEL;
  const context = opts.skillContext ?? "wan";
  const messages: WireMessage[] = [
    {
      role: "system",
      content: skillsForContext(context) + (opts.questionContextBlock ?? ""),
    },
    ...toWireMessages(history, opts.attachImageDataUri ?? null),
  ];
  const res = await invoke<{
    text: string;
    prompt_tokens: number;
    completion_tokens: number;
    finish_reason: string;
  }>("fireworks_chat", {
    req: {
      model,
      messages,
      // 16384: Kimi K2.6 is a "thinking" model — even with strict
      // output rules in skills.md, completion_tokens spent on internal
      // reasoning are billed against `max_tokens` even when the
      // visible answer is short. Observed turns where the rendered
      // bubble is ~100 tokens but Fireworks reports 4096 completion
      // tokens (and `finish_reason: "length"`). 16384 gives ~40×
      // safety margin over the ideal answer size (~400 tokens) while
      // costing nothing extra — `max_tokens` is an upper bound, only
      // actually-generated tokens are billed.
      max_tokens: opts.maxTokens ?? 16384,
      temperature: opts.temperature ?? 0.7,
      thinking: opts.thinking ?? { type: "disabled" },
    },
  });
  return {
    text: stripThinking(res.text),
    promptTokens: res.prompt_tokens,
    completionTokens: res.completion_tokens,
    finishReason: res.finish_reason,
  };
}

/**
 * Single-pass parse of an assistant reply. The system prompt asks the
 * model to produce a 1-3 sentence reasoning paragraph followed by the
 * prompt in a ` ```prompt` fence. We extract the same fence once and
 * slice the text around it so the UI doesn't need a second regex
 * (earlier code had `extractProposedPrompt` + `Bubble.splitOnFence`
 * which used subtly different patterns and disagreed when the model
 * preceded the prompt with another fenced block like ` ```diff`).
 *
 * Returns:
 * - `reasoning`: text before the prompt fence (usually the explanation)
 * - `prompt`: contents of the ` ```prompt` block, or `null` if no
 *   structured prompt was emitted (e.g. the assistant asked a
 *   clarifying question instead)
 * - `body`: text after the prompt fence (usually empty — the system
 *   prompt asks for prompt-last)
 */
export type ParsedReply = {
  reasoning: string;
  prompt: string | null;
  body: string;
};

export function parseAssistantReply(text: string): ParsedReply {
  // Prefer the labelled ` ```prompt` fence; only fall back to a
  // generic fenced block if the model forgot to label. Either way we
  // use the SAME match for both the prompt content and the slice
  // boundaries — no opportunity for two regexes to disagree.
  const labelled = /```prompt\s*\n([\s\S]*?)```/.exec(text);
  const generic = labelled ? null : /```(?:\w+)?\s*\n([\s\S]*?)```/.exec(text);
  const match = labelled ?? generic;
  if (!match) {
    return { reasoning: text.trim(), prompt: null, body: "" };
  }
  return {
    reasoning: text.slice(0, match.index).trim(),
    prompt: match[1]!.trim(),
    body: text.slice(match.index + match[0].length).trim(),
  };
}

/**
 * Cost estimate. Kimi K2.5 on Fireworks is $0.60/M input tokens and
 * $2.50/M output as of May 2026 — these constants are good enough for
 * a "you've spent ~$X this session" indicator. If the user swaps models
 * the absolute numbers go off but the relative trend stays meaningful.
 */
const INPUT_COST_PER_M = 0.6;
const OUTPUT_COST_PER_M = 2.5;

export function estimateCostUsd(
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1_000_000) * INPUT_COST_PER_M +
    (completionTokens / 1_000_000) * OUTPUT_COST_PER_M
  );
}
