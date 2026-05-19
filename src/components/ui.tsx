// Shared low-level UI primitives. Kept in one file so the rest of the
// app doesn't end up importing from six different one-component files;
// when we move to shadcn or a real component library this is where the
// swap happens.

import { clsx } from "clsx";

export function Button({
  onClick,
  children,
  variant = "primary",
  disabled,
  className,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const tone = {
    primary:
      "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-neutral-700",
    secondary:
      "border border-neutral-700 text-neutral-200 hover:border-neutral-500 disabled:opacity-50",
    ghost: "text-neutral-300 hover:text-white disabled:opacity-50",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition-colors disabled:cursor-not-allowed",
        tone,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
        {label}
        {hint ? <span className="ml-2 normal-case text-neutral-600">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600";

export function Textarea({
  value,
  onChange,
  rows = 8,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      rows={rows}
      className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm leading-relaxed text-neutral-200 outline-none focus:border-neutral-600"
    />
  );
}

export type StatusState = "idle" | "running" | "done" | "error";

export function StatusPill({
  state,
  message,
}: {
  state: StatusState;
  message?: string;
}) {
  if (state === "idle" && !message) return null;
  const tone = {
    done: "bg-emerald-900/40 text-emerald-300",
    running: "bg-amber-900/40 text-amber-200",
    error: "bg-rose-900/40 text-rose-300",
    idle: "bg-neutral-800 text-neutral-500",
  }[state];
  const text = message ? `${state} · ${message}` : state;
  return (
    <span
      title={text}
      className={`inline-block max-w-md truncate rounded-full px-2 py-0.5 text-xs ${tone}`}
    >
      {text}
    </span>
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
