// What a staged Monday row becomes when the office builds it into a real job
// (Wave J, J3). The mapping is the whole point: est_arrival has been synced
// into monday_jobs since the connector shipped and thrown away at build time,
// and an imported job used to arrive claiming to be ready when nobody had
// looked at it.

import { describe, expect, it } from "vitest";
import {
  buildInputFromMonday,
  filesOnMonday,
  fileSizeLabel,
  guessMondayFileKind,
  pullCounts,
  pullRequestFiles,
  type MondayFile,
  type MondayFileChoice,
  type MondayJob,
  type MondayPullResult,
} from "./mondaySync";

const staged: MondayJob = {
  id: "row-1",
  monday_item_id: "9001",
  name: "Sand Hollow",
  group_title: "Ready to Schedule",
  status: "Ready",
  job_type: "New construction",
  start_date: "2026-10-05",
  end_date: "2026-10-20",
  est_arrival: "2026-09-15",
  budget: 82000,
  flashing_note: "Peel and stick",
  synced_at: "2026-09-03T13:00:00Z",
  project_id: null,
  dismissed_at: null,
};

const office = { jobCode: "SANDHOLLOW", name: "Sand Hollow" };

describe("buildInputFromMonday", () => {
  it("carries Monday's arrival estimate over as the job's windows ETA", () => {
    expect(buildInputFromMonday(staged, office).materialsEta).toBe("2026-09-15");
  });

  it("makes an imported job Not ready — nobody has walked that site", () => {
    expect(buildInputFromMonday(staged, office).readyState).toBe("not_ready");
  });

  it("keeps everything the office typed", () => {
    const out = buildInputFromMonday(staged, {
      ...office,
      name: "Sand Hollow — Phase 2",
      notes: "Imported from Monday.com",
      startDate: "2026-10-05",
    });
    expect(out.jobCode).toBe("SANDHOLLOW");
    expect(out.name).toBe("Sand Hollow — Phase 2");
    expect(out.notes).toBe("Imported from Monday.com");
    expect(out.startDate).toBe("2026-10-05");
  });

  it("leaves the ETA empty when Monday has no arrival date", () => {
    const out = buildInputFromMonday({ ...staged, est_arrival: null }, office);
    expect(out.materialsEta).toBeNull();
    // Still Not ready: not knowing when the windows come is a reason to check,
    // not a reason to assume everything is fine.
    expect(out.readyState).toBe("not_ready");
  });

  it("never overrides a decision the caller made", () => {
    const out = buildInputFromMonday(staged, {
      ...office,
      readyState: "ready",
      materialsEta: "2026-09-30",
    });
    expect(out.readyState).toBe("ready");
    expect(out.materialsEta).toBe("2026-09-30");
  });
});

// ---------------------------------------------------------------------------
// Which slot a Monday file belongs in (Monday files, F2)
// ---------------------------------------------------------------------------
// Every name below was read off the real Ops Gantt Chart on 2026-09-04. That is
// the whole point of this suite: the rule is the office's own shorthand, not
// something invented here, so it is pinned against the files the office has
// actually attached rather than against tidy invented examples.

describe("guessMondayFileKind", () => {
  const buildingPlans = [
    "Estates at Sand Hollow 20 - Marked Plans.pdf",
    "HC24 - LP.pdf",
    "SR - LP.pdf",
    "SV2 - LP.pdf",
  ];
  const specSheets = [
    "Estates at Sand Hollow 20 CADs - units.pdf",
    "Estates at Sand Hollow 20 CADs -June24_26 - FINAL - signed.pdf",
    "HC24 - CU.pdf",
    "CD - CADS.pdf",
    "SR - CADS.pdf",
    "SV2 - CU.pdf",
  ];
  const documents = [
    "Estates at Sand Hollow 20 - FINAL - Iron - signed.pdf",
    "HC24 - Iron C.pdf",
    "Paul Smith-Sun River 20260602(1).pdf",
    "Summit View 2 - July16_26 - IRON.pdf",
  ];

  for (const name of buildingPlans) {
    it(`reads "${name}" as the building plan`, () => {
      expect(guessMondayFileKind(name, ".pdf")).toBe("building");
    });
  }

  for (const name of specSheets) {
    it(`reads "${name}" as the specs`, () => {
      expect(guessMondayFileKind(name, ".pdf")).toBe("specs");
    });
  }

  for (const name of documents) {
    it(`reads "${name}" as a job document`, () => {
      expect(guessMondayFileKind(name, ".pdf")).toBe("document");
    });
  }

  it("keeps every real name accounted for exactly once", () => {
    // Guards the three lists above against a copy-paste that quietly drops a
    // name: fourteen files were sampled off the board and fourteen are pinned.
    const all = [...buildingPlans, ...specSheets, ...documents];
    expect(new Set(all).size).toBe(14);
  });

  it("sends anything that is not a PDF, DWG or DXF to documents", () => {
    // The other two slots feed a plan renderer and an extractor. A spreadsheet
    // named "LP" is still a spreadsheet.
    expect(guessMondayFileKind("SV2 - LP.xlsx", ".xlsx")).toBe("document");
    expect(guessMondayFileKind("SV2 - CU.docx", ".docx")).toBe("document");
    expect(guessMondayFileKind("site photo - plans.jpg", ".jpg")).toBe("document");
  });

  it("keeps CAD drawings in their slots", () => {
    expect(guessMondayFileKind("SV2 - LP.dwg", ".dwg")).toBe("building");
    expect(guessMondayFileKind("SV2 - CU.dxf", ".dxf")).toBe("specs");
  });

  it("only matches whole words", () => {
    // Real name shapes that must not be misread: "LP" inside a place name, and
    // "CU" inside an ordinary English word.
    expect(guessMondayFileKind("Alpine Ridge 12.pdf", ".pdf")).toBe("document");
    expect(guessMondayFileKind("Cut List - Summit View.pdf", ".pdf")).toBe("document");
    expect(guessMondayFileKind("Help sheet.pdf", ".pdf")).toBe("document");
  });

  it("calls a sheet named for both the plans, because that is the emptier slot", () => {
    expect(guessMondayFileKind("HC24 - LP and CADs.pdf", ".pdf")).toBe("building");
  });

  it("reads the extension off the name when Monday did not say", () => {
    expect(guessMondayFileKind("HC24 - LP.pdf")).toBe("building");
    expect(guessMondayFileKind("HC24 - LP.xlsx")).toBe("document");
    // No extension anywhere: nothing can be opened, so nothing is claimed.
    expect(guessMondayFileKind("HC24 - LP")).toBe("document");
  });
});

describe("filesOnMonday", () => {
  it("reads a row from before the migration as having no files", () => {
    // A phone can be running ahead of the database. The column simply is not
    // in the row, and that has to mean "nothing known" rather than a crash.
    expect(filesOnMonday({ files: undefined })).toEqual([]);
    expect(filesOnMonday({ files: null })).toEqual([]);
  });

  it("drops anything with no asset id — there is nothing to pull", () => {
    const good = {
      asset_id: "3100578592",
      name: "HC24 - LP.pdf",
      ext: ".pdf",
      size: 17904294,
      column_id: "files_1",
      uploaded_at: "2026-07-09T19:10:07Z",
    };
    expect(filesOnMonday({ files: [good, { ...good, asset_id: "" }] })).toEqual([good]);
  });
});

// ---------------------------------------------------------------------------
// What the Build form asks the server for (Monday files, F3)
// ---------------------------------------------------------------------------

const hc24: MondayFile[] = [
  {
    asset_id: "3100578588",
    name: "HC24 - Iron C.pdf",
    ext: ".pdf",
    size: 271770,
    column_id: "files_1",
    uploaded_at: "2026-07-09T19:10:07Z",
  },
  {
    asset_id: "3100578589",
    name: "HC24 - CU.pdf",
    ext: ".pdf",
    size: 837632,
    column_id: "files_1",
    uploaded_at: "2026-07-09T19:10:07Z",
  },
  {
    asset_id: "3100578592",
    name: "HC24 - LP.pdf",
    ext: ".pdf",
    size: 17904294,
    column_id: "files_1",
    uploaded_at: "2026-07-09T19:10:07Z",
  },
];

const ticked = (files: MondayFile[]): Record<string, MondayFileChoice> =>
  Object.fromEntries(
    files.map((f) => [
      f.asset_id,
      { kind: guessMondayFileKind(f.name, f.ext), selected: true },
    ]),
  );

describe("pullRequestFiles", () => {
  it("asks for every ticked file in the slot its name suggests", () => {
    expect(pullRequestFiles(hc24, ticked(hc24))).toEqual([
      { asset_id: "3100578588", kind: "document" },
      { asset_id: "3100578589", kind: "specs" },
      { asset_id: "3100578592", kind: "building" },
    ]);
  });

  it("leaves out anything the office un-ticked", () => {
    const choices = ticked(hc24);
    choices["3100578588"] = { ...choices["3100578588"], selected: false };
    expect(pullRequestFiles(hc24, choices).map((f) => f.asset_id)).toEqual([
      "3100578589",
      "3100578592",
    ]);
  });

  it("honours an override — the guess is a guess", () => {
    const choices = ticked(hc24);
    choices["3100578592"] = { kind: "specs", selected: true };
    expect(
      pullRequestFiles(hc24, choices).find((f) => f.asset_id === "3100578592"),
    ).toEqual({ asset_id: "3100578592", kind: "specs" });
  });

  it("takes a file with no choice recorded, at the guessed slot", () => {
    // The form ticks everything; a file that somehow has no entry should behave
    // like the rest rather than silently going missing.
    expect(pullRequestFiles(hc24, {})).toEqual([
      { asset_id: "3100578588", kind: "document" },
      { asset_id: "3100578589", kind: "specs" },
      { asset_id: "3100578592", kind: "building" },
    ]);
  });

  it("refuses to send a spreadsheet to the plans slot even if asked", () => {
    // The picker locks this on screen; this is the second lock. A plan slot fed
    // a spreadsheet is a broken map.
    const sheet: MondayFile[] = [
      {
        asset_id: "1",
        name: "HC24 - LP.xlsx",
        ext: ".xlsx",
        size: 1000,
        column_id: "files_1",
        uploaded_at: null,
      },
    ];
    expect(
      pullRequestFiles(sheet, { "1": { kind: "building", selected: true } }),
    ).toEqual([{ asset_id: "1", kind: "document" }]);
  });

  it("asks for nothing when everything is un-ticked", () => {
    const choices = Object.fromEntries(
      hc24.map((f) => [f.asset_id, { kind: "document" as const, selected: false }]),
    );
    expect(pullRequestFiles(hc24, choices)).toEqual([]);
  });
});

describe("pullCounts", () => {
  const result = (asset_id: string, ok: boolean): MondayPullResult => ({
    asset_id,
    name: `${asset_id}.pdf`,
    ok,
    where: ok ? "plans" : null,
  });

  it("counts what came across and what did not", () => {
    expect(pullCounts([result("a", true), result("b", false), result("c", true)]))
      .toEqual({ pulled: 2, failed: 1, total: 3 });
  });

  it("a job with no files pulls nothing and fails nothing", () => {
    expect(pullCounts([])).toEqual({ pulled: 0, failed: 0, total: 0 });
  });

  it("a file that was already on the job counts as pulled", () => {
    // Pressing Get twice is not an error and must not read like one.
    expect(
      pullCounts([{ ...result("a", true), already: true }]).pulled,
    ).toBe(1);
  });
});

describe("fileSizeLabel", () => {
  it("says megabytes plainly enough to judge over cell signal", () => {
    expect(fileSizeLabel(17904294)).toBe("17 MB");
    expect(fileSizeLabel(837632)).toBe("818 KB");
    expect(fileSizeLabel(2871616)).toBe("2.7 MB");
    expect(fileSizeLabel(400)).toBe("400 B");
  });

  it("says nothing when Monday did not say", () => {
    expect(fileSizeLabel(null)).toBe("");
    expect(fileSizeLabel(undefined)).toBe("");
    expect(fileSizeLabel(Number.NaN)).toBe("");
  });
});
