// Read-only view of the question's answer / explanation / scene dynamics
// fetched from Rails (the workspace's `questionContext`). Lets the designer
// see the grounding the AI assistant is working from — the assistant's copy
// in the system prompt is trimmed for prompt size, this shows it in full.
// Collapsed by default so it doesn't crowd the chat transcript.

import { useState, type ReactNode } from "react";
import { clsx } from "clsx";
import type { QuestionContext } from "../lib/workspace";

export function QuestionContextPanel({ ctx }: { ctx: QuestionContext }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-neutral-300 hover:text-neutral-100"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden>📋</span>
          <span className="font-semibold">Question context</span>
          {ctx.correctAnswer && !open && (
            <span className="truncate text-neutral-500">— {ctx.correctAnswer}</span>
          )}
        </span>
        <span className="shrink-0 text-neutral-600">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="space-y-2.5 border-t border-neutral-800 px-3 py-2.5 text-neutral-300">
          {ctx.correctAnswer && (
            <Section label="Correct answer">
              <p className="text-emerald-300">{ctx.correctAnswer}</p>
            </Section>
          )}
          {ctx.explanation?.answer && (
            <Section label="Answer">
              <p className="whitespace-pre-wrap">{ctx.explanation.answer}</p>
            </Section>
          )}
          {ctx.explanation?.situation && (
            <Section label="Situation">
              <p className="whitespace-pre-wrap">{ctx.explanation.situation}</p>
            </Section>
          )}
          {ctx.explanation?.why && (
            <Section label="Why">
              <p className="whitespace-pre-wrap">{ctx.explanation.why}</p>
            </Section>
          )}
          {ctx.sceneSummary && (
            <Section label="Scene">
              <p>{ctx.sceneSummary}</p>
            </Section>
          )}
          {ctx.sceneTypes.length > 0 && (
            <Section label="Scene types">
              <p>{ctx.sceneTypes.join(", ")}</p>
            </Section>
          )}
          {ctx.actorObligations.length > 0 && (
            <Section label="Who moves vs. stays">
              <ul className="space-y-1">
                {ctx.actorObligations.map((o, i) => (
                  <li key={i} className="flex gap-2">
                    <span
                      className={clsx(
                        "shrink-0 font-medium",
                        o.canProceed ? "text-sky-300" : "text-amber-300",
                      )}
                    >
                      {o.canProceed ? "moves" : "stays"}
                    </span>
                    <span className="text-neutral-400">{o.reason}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {ctx.actorRelations.length > 0 && (
            <Section label="Priority">
              <ul className="space-y-1 text-neutral-400">
                {ctx.actorRelations.map((r, i) => (
                  <li key={i}>{r.reason}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      {children}
    </div>
  );
}
