// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { procSequence } from "../lib/glossary";

const award = vi.hoisted(() => vi.fn(async (_items: { key: string; correct: boolean }[]) => ({ pointsAwarded: 0, newTerms: 0, alreadyHad: 1 })));
vi.mock("../lib/learn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/learn")>()),
  awardEducationQuiz: award,
}));

import { Sequence } from "./Education";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; award.mockClear(); });

describe("install-sequence rounds", () => {
  it("scores five correct answers in each of two rounds, without repeating a question", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Sequence /></QueryClientProvider>));
    const seen: string[][] = [];
    for (let round = 0; round < 2; round++) {
      const ids: string[] = [];
      for (let question = 0; question < 5; question++) {
        const label = host.querySelector(".detail-card strong")?.textContent;
        const steps = procSequence("win");
        const index = steps.findIndex((step) => step.label === label);
        expect(index).toBeGreaterThanOrEqual(0);
        ids.push(steps[index].id);
        const answer = [...host.querySelectorAll<HTMLButtonElement>(".action-list button")].find((button) => button.textContent === steps[index + 1].label);
        expect(answer).toBeTruthy();
        await act(async () => answer!.click());
        await act(async () => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Next")!.click());
      }
      seen.push(ids);
      expect(new Set(ids).size).toBe(5);
      expect(host.textContent).toContain("5/5");
      if (round === 0) await act(async () => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Another round")!.click());
    }
    expect(seen[1].some((id) => seen[0].includes(id))).toBe(false);
    expect(award).toHaveBeenCalledTimes(2);
    expect(award.mock.calls.every(([items]) => items[0].correct === true)).toBe(true);
  });
});
