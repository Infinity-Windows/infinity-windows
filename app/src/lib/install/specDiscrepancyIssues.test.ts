import { describe, expect, it } from "vitest";
import {
  canManageSpecDiscrepancyIssues,
  describeDiscrepancyForIssue,
  issueActionForAcknowledgement,
  issueActionForWithdrawal,
  projectLabel,
  SPEC_GAP_ISSUE_KIND,
  type IssueLink,
} from "./specDiscrepancyIssues";
import type { Discrepancy, DiscrepancyKind } from "./specReconciliation";

function discrepancy(over: Partial<Discrepancy> = {}): Discrepancy {
  return {
    mark: "7",
    kind: "mark_without_spec",
    units: 1,
    isDoor: false,
    style: null,
    hasSize: false,
    acknowledged: false,
    note: null,
    ...over,
  };
}

const BLACK_DESERT = "Black Desert (BLACK22)";

/** Walk the state machine the way the RPC does, tracking what it did. */
function simulate(steps: ("label" | "unlabel")[]) {
  const link: IssueLink = { issueId: null, issueStatus: null };
  const log: string[] = [];
  let created = 0;
  for (const step of steps) {
    if (step === "label") {
      const action = issueActionForAcknowledgement(link);
      log.push(action);
      if (action === "create") {
        created += 1;
        link.issueId = `issue-${created}`;
        link.issueStatus = "open";
      } else if (action === "reopen") {
        link.issueStatus = "open";
      }
    } else {
      const action = issueActionForWithdrawal(link);
      log.push(action);
      if (action === "resolve") link.issueStatus = "resolved";
    }
  }
  return { log, created, link };
}

describe("which issue kind a spec gap gets", () => {
  it("is its own kind, not a missing delivery", () => {
    // 'missing' means an undelivered physical unit everywhere else in the app:
    // it is written with a window_id, cleared by receiving, counted into
    // reorder needs, and shown under "Missing deliveries". A supplier paperwork
    // gap filed there would be invisible to whoever chases suppliers.
    // Its display label ("Spec sheet gap") is guaranteed by the compiler:
    // KIND_LABELS is a Record<IssueKind, string>, so adding the kind without
    // labelling it fails typecheck. Importing it here would drag the Supabase
    // client into a pure unit test.
    expect(SPEC_GAP_ISSUE_KIND).toBe("spec_gap");
    expect(SPEC_GAP_ISSUE_KIND).not.toBe("missing");
  });
});

describe("the first label raises exactly one issue", () => {
  it("creates one when nothing has been raised yet", () => {
    expect(issueActionForAcknowledgement({ issueId: null })).toBe("create");
  });

  it("creates one issue and one only", () => {
    const { log, created } = simulate(["label"]);
    expect(log).toEqual(["create"]);
    expect(created).toBe(1);
  });
});

describe("re-labelling and re-extraction never duplicate", () => {
  it("does nothing when the issue is already open", () => {
    expect(
      issueActionForAcknowledgement({ issueId: "i1", issueStatus: "open" }),
    ).toBe("none");
  });

  it("survives the same label being pressed again", () => {
    const { log, created } = simulate(["label", "label"]);
    expect(log).toEqual(["create", "none"]);
    expect(created).toBe(1);
  });

  it("survives extraction being re-run over and over", () => {
    // A re-extract recomputes the discrepancies but leaves the label row —
    // and its issue link — exactly where it was, so every subsequent label
    // lands on `none`.
    const { log, created } = simulate([
      "label",
      "label",
      "label",
      "label",
      "label",
    ]);
    expect(created).toBe(1);
    expect(log.filter((a) => a === "create")).toHaveLength(1);
  });

  it("treats an unknown issue status as still open rather than raising again", () => {
    expect(
      issueActionForAcknowledgement({ issueId: "i1", issueStatus: null }),
    ).toBe("none");
    expect(issueActionForAcknowledgement({ issueId: "i1" })).toBe("none");
  });
});

describe("un-labelling resolves rather than deletes", () => {
  it("resolves the open issue", () => {
    expect(issueActionForWithdrawal({ issueId: "i1", issueStatus: "open" })).toBe(
      "resolve",
    );
  });

  it("is idempotent — withdrawing twice resolves once", () => {
    const { log, link } = simulate(["label", "unlabel", "unlabel"]);
    expect(log).toEqual(["create", "resolve", "none"]);
    expect(link.issueStatus).toBe("resolved");
  });

  it("does nothing when no issue was ever raised", () => {
    expect(issueActionForWithdrawal({ issueId: null })).toBe("none");
  });
});

describe("re-labelling after a withdrawal reuses the same issue", () => {
  it("reopens instead of creating a second one", () => {
    expect(
      issueActionForAcknowledgement({ issueId: "i1", issueStatus: "resolved" }),
    ).toBe("reopen");
  });

  it("keeps one issue across a full label / unlabel / label cycle", () => {
    const { log, created, link } = simulate(["label", "unlabel", "label"]);
    expect(log).toEqual(["create", "resolve", "reopen"]);
    expect(created).toBe(1);
    expect(link.issueId).toBe("issue-1");
    expect(link.issueStatus).toBe("open");
  });

  it("keeps one issue no matter how many times a foreman changes their mind", () => {
    const { created, link } = simulate([
      "label",
      "unlabel",
      "label",
      "unlabel",
      "label",
      "label",
      "unlabel",
    ]);
    expect(created).toBe(1);
    expect(link.issueId).toBe("issue-1");
    expect(link.issueStatus).toBe("resolved");
  });
});

describe("who may raise and resolve these", () => {
  it("is foreman and above", () => {
    expect(canManageSpecDiscrepancyIssues("foreman")).toBe(true);
    expect(canManageSpecDiscrepancyIssues("lead")).toBe(true);
    expect(canManageSpecDiscrepancyIssues("supervisor")).toBe(true);
    expect(canManageSpecDiscrepancyIssues("owner")).toBe(true);
  });

  it("is never an installer", () => {
    // Chasing a supplier is an office job. An installer sees one calm line on
    // the unit in their hand and never the project-wide report, so there is
    // nothing here for them to raise or resolve.
    expect(canManageSpecDiscrepancyIssues("installer")).toBe(false);
    expect(canManageSpecDiscrepancyIssues(null)).toBe(false);
    expect(canManageSpecDiscrepancyIssues(undefined)).toBe(false);
    expect(canManageSpecDiscrepancyIssues("mystery")).toBe(false);
  });
});

describe("what the issue says", () => {
  it("names the job, the mark and the errand for a missing sheet", () => {
    // Black Desert #7: absent from the supplier's own panel numbering.
    expect(
      describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({ mark: "7" }),
      }),
    ).toBe(
      "Black Desert (BLACK22): mark #7 has no spec sheet in the supplier's set — " +
        "1 unit on the plans. Ask the supplier for the missing sheet.",
    );
  });

  it("pluralises the unit count", () => {
    expect(
      describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({ mark: "8", units: 3 }),
      }),
    ).toContain("3 units on the plans");
  });

  it("describes the orphan spec and its blank panel", () => {
    // Black Desert #25: an interior French door whose drawing panel the
    // supplier left struck through, so it has no size and no opening.
    expect(
      describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({
          mark: "25",
          kind: "spec_without_mark",
          units: 0,
          hasSize: false,
        }),
      }),
    ).toBe(
      "Black Desert (BLACK22): the spec sheet covers mark #25 but no window on " +
        "the plans uses it — and it carries no size. Check with the supplier " +
        "whether it belongs on this job.",
    );
  });

  it("leaves out the size aside when the orphan spec is dimensioned", () => {
    const text = describeDiscrepancyForIssue({
      projectLabel: BLACK_DESERT,
      discrepancy: discrepancy({
        mark: "25",
        kind: "spec_without_mark",
        units: 0,
        hasSize: true,
      }),
    });
    expect(text).not.toContain("no size");
  });

  it("says what to go and get for a size-less spec", () => {
    expect(
      describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({ mark: "12", kind: "spec_without_size", units: 2 }),
      }),
    ).toBe(
      "Black Desert (BLACK22): mark #12 has a spec but no size on it — " +
        "2 units on the plans. Get the dimensions from the supplier before " +
        "anything is cut.",
    );
  });

  it("says what to go and get for a missing drawing", () => {
    expect(
      describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({ mark: "18B", kind: "spec_without_drawing" }),
      }),
    ).toBe(
      "Black Desert (BLACK22): mark #18B has a written spec but no drawing — " +
        "1 unit on the plans. Ask the supplier for the elevation so the crew " +
        "can check the shape.",
    );
  });

  it("carries the foreman's own note through to whoever picks it up", () => {
    expect(
      describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({ mark: "7" }),
        note: "  emailed Strata 7/28  ",
      }),
    ).toContain("Note: emailed Strata 7/28");
  });

  it("says door only when the plans say door", () => {
    expect(
      describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({ mark: "31", isDoor: true }),
      }),
    ).toContain("mark #31 (door)");
  });

  it("drops the unit count when the plans have none of it", () => {
    const text = describeDiscrepancyForIssue({
      projectLabel: BLACK_DESERT,
      discrepancy: discrepancy({ mark: "25", kind: "spec_without_size", units: 0 }),
    });
    expect(text).not.toContain("units on the plans");
    expect(text).not.toContain("0 unit");
  });

  it("is readable on its own, without opening the app", () => {
    const kinds: DiscrepancyKind[] = [
      "mark_without_spec",
      "spec_without_mark",
      "spec_without_size",
      "spec_without_drawing",
    ];
    for (const kind of kinds) {
      const text = describeDiscrepancyForIssue({
        projectLabel: BLACK_DESERT,
        discrepancy: discrepancy({ kind }),
      });
      expect(text).toContain("Black Desert (BLACK22)");
      expect(text).toContain("#7");
      expect(text.trim()).toMatch(/\.$/);
    }
  });
});

describe("projectLabel", () => {
  it("reads as a human would name the job", () => {
    expect(projectLabel({ job_code: "BLACK22", name: "Black Desert" })).toBe(
      "Black Desert (BLACK22)",
    );
  });

  it("falls back to whichever half it has", () => {
    expect(projectLabel({ job_code: "BLACK22", name: null })).toBe("BLACK22");
    expect(projectLabel({ job_code: null, name: "Black Desert" })).toBe("Black Desert");
    expect(projectLabel(null)).toBe("this job");
    expect(projectLabel({ job_code: "  ", name: "  " })).toBe("this job");
  });
});
