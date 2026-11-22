// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { InstallStage, type InstallStageProps } from "./InstallStage";

vi.mock("../../../lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./SheetMore", () => ({ SheetMore: () => null }));
vi.mock("../../../components/install/SummonPanel", () => ({ SummonPanel: () => null }));

describe("installer stage recovery", () => {
  it("sends an unstarted unit to Check instead of starting through a second gate", async () => {
    const onReviewChecks = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<InstallStage {...{
        timer: { status: "idle", minutes: null }, startedAt: null, tips: [],
        onOpenClock: vi.fn(), onReviewChecks,
        summon: {
          projectId: "job-1", openingId: "opening-1", openingCode: "1",
          widthIn: null, heightIn: null, myProfileId: null, myName: null,
          effectiveRole: "installer",
        },
        // SheetMore is mocked; this test exercises only the stage action.
        more: {} as InstallStageProps["more"],
      } satisfies InstallStageProps} />));
      const action = host.querySelector("button");
      expect(action?.textContent).toBe("opening.action.reviewChecks");
      await act(async () => action!.click());
      expect(onReviewChecks).toHaveBeenCalledOnce();
      expect(host.textContent).not.toContain("opening.action.startTimer");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
