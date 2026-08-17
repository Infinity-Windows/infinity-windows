// The "What is this?" fold. Every panel explains itself in plain words.
//
// Lived inline in DataHub until the Warehouse grill (2026-08-17) settled that
// every panel gets one, so it moved here rather than being copied a second
// time. Two rules came out of that session and both are load-bearing:
//
//   1. The copy says what to DO, not what the panel is. "Windows that arrived
//      but have no shelf spot yet — until one is put away, nobody can be told
//      where to find it" is right. "Displays inbound inventory" is not.
//   2. It remembers whether you left it open. A foreman who already knows the
//      system should not scroll past the manual every single morning.

import { useCallback, useState, type ReactNode } from "react";

const KEY_PREFIX = "explain-open:";

function readOpen(id: string | undefined, fallback: boolean): boolean {
  if (!id) return fallback;
  try {
    const raw = localStorage.getItem(KEY_PREFIX + id);
    return raw === null ? fallback : raw === "1";
  } catch {
    // Private mode / storage disabled — the fold still works, it just forgets.
    return fallback;
  }
}

export interface ExplainProps {
  children: ReactNode;
  /**
   * Stable id for remembering open/closed. Omit for a fold that should always
   * start closed (a one-off aside rather than a panel's standing note).
   */
  id?: string;
  /** Override the summary text where "What is this?" doesn't read right. */
  summary?: string;
  defaultOpen?: boolean;
  /**
   * Render children bare instead of inside the quoted `<p>`. For folds holding
   * a whole panel (the package map) rather than a sentence — the note styling
   * would fight a panel's own layout.
   */
  raw?: boolean;
}

export function Explain({
  children,
  id,
  summary = "What is this?",
  defaultOpen = false,
  raw = false,
}: ExplainProps) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));

  const onToggle = useCallback(
    (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      const next = e.currentTarget.open;
      setOpen(next);
      if (!id) return;
      try {
        localStorage.setItem(KEY_PREFIX + id, next ? "1" : "0");
      } catch {
        // Nothing to do — the fold works, it just won't be remembered.
      }
    },
    [id],
  );

  return (
    <details className="data-explain" open={open} onToggle={onToggle}>
      <summary>{summary}</summary>
      {raw ? children : <p>{children}</p>}
    </details>
  );
}
