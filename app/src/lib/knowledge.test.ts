import { describe, expect, it } from "vitest";
import {
  ASK_SYSTEM_PROMPT,
  buildAskUserMessage,
  buildContextBlock,
  chunkMarkdown,
  dedupeSources,
  deriveTitle,
  estimateTokens,
  formatSourcesLine,
  hashContent,
  shapeMatches,
  shouldUseLLM,
} from "../../../supabase/functions/_shared/knowledge";
import { liveAnswer, pageNotes, type AskLiveData, type VaultNote } from "./knowledge";
import { addDaysISO } from "./schedule/dates";

describe("chunkMarkdown", () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");

  it("returns nothing for empty/whitespace input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\t  ")).toEqual([]);
  });

  it("keeps a short note as a single chunk at index 0", () => {
    const chunks = chunkMarkdown("A short note about casement flashing.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toBe("A short note about casement flashing.");
  });

  it("keeps every chunk at or below the token ceiling", () => {
    const chunks = chunkMarkdown(words, { maxTokens: 40, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(40);
      expect(estimateTokens(c.content)).toBeLessThanOrEqual(40);
    }
  });

  it("emits chunks in a stable, gap-free index order", () => {
    const chunks = chunkMarkdown(words, { maxTokens: 40, overlapTokens: 8 });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("overlaps consecutive chunks so context isn't cut at a boundary", () => {
    const chunks = chunkMarkdown(words, { maxTokens: 40, overlapTokens: 12 });
    for (let i = 1; i < chunks.length; i++) {
      const prev = new Set(chunks[i - 1].content.split(" "));
      const cur = chunks[i].content.split(" ");
      expect(cur.some((w) => prev.has(w))).toBe(true);
    }
  });

  it("preserves every word across the chunk set (nothing dropped)", () => {
    const chunks = chunkMarkdown(words, { maxTokens: 40, overlapTokens: 8 });
    const seen = new Set(chunks.flatMap((c) => c.content.split(" ")));
    for (let i = 0; i < 400; i++) expect(seen.has(`word${i}`)).toBe(true);
  });
});

describe("hashContent (change detection)", () => {
  it("is deterministic and 8 hex chars", () => {
    const h = hashContent("hello vault");
    expect(h).toBe(hashContent("hello vault"));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when the content changes", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
    expect(hashContent("note v1")).not.toBe(hashContent("note v2"));
  });
});

describe("deriveTitle", () => {
  it("prefers the first markdown H1", () => {
    expect(deriveTitle("playbooks/install.md", "# Install Playbook\n\nbody")).toBe(
      "Install Playbook",
    );
  });

  it("falls back to the file name without extension", () => {
    expect(deriveTitle("vault/specs/CAS3050.md", "no heading here")).toBe("CAS3050");
    expect(deriveTitle("Standards.markdown", "text")).toBe("Standards");
  });
});

describe("shapeMatches", () => {
  it("sorts by similarity desc and drops empty / low-similarity rows", () => {
    const shaped = shapeMatches(
      [
        { title: "A", path: "a.md", content: "alpha", similarity: 0.4 },
        { title: "B", path: "b.md", content: "", similarity: 0.9 },
        { title: "C", path: "c.md", content: "gamma", similarity: 0.8 },
      ],
      { minSimilarity: 0.3 },
    );
    expect(shaped.map((s) => s.title)).toEqual(["C", "A"]);
  });

  it("filters out results below minSimilarity", () => {
    const shaped = shapeMatches(
      [{ title: "Low", path: "l.md", content: "x", similarity: 0.1 }],
      { minSimilarity: 0.5 },
    );
    expect(shaped).toHaveLength(0);
  });

  it("tolerates non-array and doc_-prefixed shapes", () => {
    expect(shapeMatches(null)).toEqual([]);
    const shaped = shapeMatches([
      { doc_title: "D", doc_path: "d.md", content: "delta", similarity: 0.7 },
    ]);
    expect(shaped[0]).toMatchObject({ title: "D", path: "d.md" });
  });
});

describe("dedupeSources / formatSourcesLine", () => {
  it("dedupes by path, keeps first-seen order, labels untitled", () => {
    const sources = dedupeSources([
      { title: "Playbook", path: "p.md" },
      { title: "Playbook (again)", path: "p.md" },
      { title: "", path: "q.md" },
      { title: "Loose" },
    ]);
    expect(sources).toEqual([
      { title: "Playbook", path: "p.md" },
      { title: "q.md", path: "q.md" },
      { title: "Loose", path: "" },
    ]);
  });

  it("formats a human one-line citation, empty when no sources", () => {
    expect(formatSourcesLine([{ title: "A", path: "a.md" }, { title: "B", path: "b.md" }])).toBe(
      "Sources: A, B",
    );
    expect(formatSourcesLine([])).toBe("");
  });
});

describe("buildContextBlock / buildAskUserMessage", () => {
  const chunks = [
    { title: "Flashing Guide", path: "f.md", content: "Use butyl tape.", similarity: 0.9 },
  ];

  it("labels notes with their titles and includes live data sections", () => {
    const block = buildContextBlock(chunks, {
      projects: [{ job_code: "J12", name: "Maple St", status: "active" }],
      windowTypes: [{ type_code: "CAS3050", name: "Casement", n_installs: 9 }],
    });
    expect(block).toContain("Flashing Guide");
    expect(block).toContain("Use butyl tape.");
    expect(block).toContain("Active projects");
    expect(block).toContain("J12 Maple St");
    expect(block).toContain("Window catalog");
  });

  it("is empty when there are no notes and no live data", () => {
    expect(buildContextBlock([], {})).toBe("");
  });

  it("embeds the question and context; handles the no-context branch", () => {
    const withCtx = buildAskUserMessage("How do I flash?", buildContextBlock(chunks, {}));
    expect(withCtx).toContain("How do I flash?");
    expect(withCtx).toContain("Flashing Guide");

    const noCtx = buildAskUserMessage("Anything?", "");
    expect(noCtx).toContain("Anything?");
    expect(noCtx.toLowerCase()).toContain("no company notes");
  });

  it("has a grounded, cite-your-notes system prompt", () => {
    expect(ASK_SYSTEM_PROMPT.toLowerCase()).toContain("only");
    expect(ASK_SYSTEM_PROMPT.toLowerCase()).toContain("cite");
  });
});

describe("shouldUseLLM (client fallback decision)", () => {
  it("uses the cloud only when online AND supabase is configured", () => {
    expect(shouldUseLLM({ online: true, supabaseConfigured: true })).toBe(true);
    expect(shouldUseLLM({ online: false, supabaseConfigured: true })).toBe(false);
    expect(shouldUseLLM({ online: true, supabaseConfigured: false })).toBe(false);
    expect(shouldUseLLM({ online: false, supabaseConfigured: false })).toBe(false);
  });
});

describe("pageNotes (upload batching)", () => {
  const note = (path: string, size: number): VaultNote => ({
    path,
    title: path,
    content: "x".repeat(size),
  });

  it("splits by file count and preserves order and completeness", () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(`n${i}.md`, 10));
    const pages = pageNotes(notes, 12, 1_000_000);
    expect(pages.length).toBe(3);
    expect(pages.every((p) => p.length <= 12)).toBe(true);
    expect(pages.flat().map((n) => n.path)).toEqual(notes.map((n) => n.path));
  });

  it("splits by cumulative size", () => {
    const notes = [note("a.md", 600), note("b.md", 600), note("c.md", 100)];
    const pages = pageNotes(notes, 100, 1000);
    expect(pages).toHaveLength(2);
    expect(pages[0].map((n) => n.path)).toEqual(["a.md"]);
    expect(pages[1].map((n) => n.path)).toEqual(["b.md", "c.md"]);
  });

  it("keeps an oversized single note in its own page", () => {
    const pages = pageNotes([note("big.md", 5000)], 100, 1000);
    expect(pages).toHaveLength(1);
    expect(pages[0][0].path).toBe("big.md");
  });
});

describe("liveAnswer (offline grounding from the query cache)", () => {
  const TODAY = "2026-07-23"; // a Thursday

  const opening = (over: Record<string, unknown>) =>
    ({
      id: "o1",
      project_id: "p1",
      opening_code: "W1",
      status: "assigned",
      window_type_id: null,
      assigned_window_id: null,
      condition: "unknown",
      ro_width_in: null,
      ro_height_in: null,
      sequence: null,
      work_started_at: null,
      label: "Kitchen",
      page_number: 1,
      window_types: { type_code: "SL7248" },
      projects: { job_code: "J12" },
      ...over,
    }) as unknown as NonNullable<AskLiveData["openings"]>[number];

  const base: AskLiveData = { todayISO: TODAY };

  it("returns null for an unrelated question so the caller falls back", () => {
    expect(liveAnswer("what is a nail fin?", { ...base, openings: [opening({})] })).toBeNull();
  });

  it("routes 'my next window' to the top of the ordered worklist", () => {
    const data: AskLiveData = {
      ...base,
      openings: [
        opening({ id: "a", opening_code: "W9", sequence: 2 }),
        opening({ id: "b", opening_code: "W3", sequence: 1 }),
      ],
    };
    const answer = liveAnswer("what's my next window?", data);
    expect(answer).toContain("Your next window:");
    expect(answer).toContain("W3");
    expect(answer).toContain("1 more in your queue");
  });

  it("surfaces an in-progress install as mid-install", () => {
    const data: AskLiveData = {
      ...base,
      openings: [
        opening({ id: "a", opening_code: "W9", sequence: 2, work_started_at: "2026-07-23T15:00:00Z" }),
        opening({ id: "b", opening_code: "W3", sequence: 1 }),
      ],
    };
    const answer = liveAnswer("what's next?", data);
    expect(answer).toContain("You're mid-install:");
    expect(answer).toContain("W9");
  });

  it("says caught up when everything is installed, null when the cache is cold", () => {
    expect(
      liveAnswer("my next window", { ...base, openings: [opening({ status: "installed" })] }),
    ).toContain("caught up");
    expect(liveAnswer("my next window", base)).toBeNull();
  });

  const assignment = (over: Record<string, unknown>) =>
    ({
      id: "s1",
      project_id: "p1",
      start_date: TODAY,
      end_date: TODAY,
      start_time: "06:30:00",
      status: "published",
      members: [],
      project: { job_code: "J12", name: "Maple St" },
      ...over,
    }) as unknown as NonNullable<AskLiveData["schedule"]>[number];

  it("summarizes this week's published schedule", () => {
    const data: AskLiveData = {
      ...base,
      profileId: "me",
      schedule: [assignment({})],
    };
    const answer = liveAnswer("what's on our schedule?", data);
    expect(answer).toContain("Your schedule this week:");
    expect(answer).toContain("Maple St");
  });

  it("reports an empty week and null when the schedule cache is cold", () => {
    expect(
      liveAnswer("my schedule this week", {
        ...base,
        schedule: [assignment({ start_date: "2026-09-01", end_date: "2026-09-01" })],
      }),
    ).toContain("Nothing on your published schedule");
    expect(liveAnswer("my schedule this week", base)).toBeNull();
  });

  const vehicleLink = (over: Record<string, unknown>) =>
    ({
      id: "vl1",
      vehicle_id: "v1",
      project_id: "p1",
      assignment_id: "s1",
      start_date: TODAY,
      end_date: TODAY,
      note: null,
      vehicle: {
        id: "v1",
        kind: "pickup",
        trailer_subtype: null,
        year: 2021,
        make: "Ford",
        model: "F-150",
        color: "White",
        plate: "ABC-1234",
      },
      ...over,
    }) as unknown as NonNullable<AskLiveData["scheduleVehicles"]>[number];

  const trip = (over: Record<string, unknown>) =>
    ({
      id: "t1",
      project_id: "p1",
      name: "Boise install",
      destination: "Boise, ID",
      start_date: TODAY,
      end_date: addDaysISO(TODAY, 2),
      timezone: null,
      notes: null,
      status: "published",
      published_at: "2026-07-20T00:00:00Z",
      created_by: null,
      created_at: "2026-07-20T00:00:00Z",
      updated_at: "2026-07-20T00:00:00Z",
      crew: [{ profile_id: "me", role: "installer" }],
      ...over,
    }) as unknown as NonNullable<AskLiveData["trips"]>[number];

  it("weaves the truck and travel ties into the schedule answer", () => {
    const answer = liveAnswer("what's on our schedule?", {
      ...base,
      profileId: "me",
      schedule: [assignment({})],
      scheduleVehicles: [vehicleLink({})],
      trips: [trip({})],
    });
    expect(answer).toContain("Maple St");
    expect(answer).toContain("Truck: 2021 Ford F-150");
    expect(answer).toContain("Travel: Boise, ID");
  });

  it("answers 'my truck today' from the published schedule's vehicle tie", () => {
    const answer = liveAnswer("my truck today", {
      ...base,
      schedule: [assignment({})],
      scheduleVehicles: [vehicleLink({})],
    });
    expect(answer).toContain("Your truck today:");
    expect(answer).toContain("2021 Ford F-150");
    expect(answer).toContain("Maple St");
  });

  it("says no truck is assigned when nothing is linked, null when cold", () => {
    expect(
      liveAnswer("my truck this week", { ...base, schedule: [assignment({})] }),
    ).toContain("No truck is assigned to your schedule this week.");
    expect(liveAnswer("my truck this week", base)).toBeNull();
  });

  it("answers 'my travel this week' with the crew's published trips", () => {
    const answer = liveAnswer("my travel this week", {
      ...base,
      profileId: "me",
      trips: [trip({})],
    });
    expect(answer).toContain("Your travel:");
    expect(answer).toContain("Boise, ID");
  });

  it("hides drafts, past trips, and trips the user isn't crew on", () => {
    expect(
      liveAnswer("travel this week", {
        ...base,
        profileId: "me",
        trips: [
          trip({ id: "t2", status: "draft" }),
          trip({ id: "t3", start_date: "2026-01-01", end_date: "2026-01-03" }),
          trip({ id: "t4", crew: [{ profile_id: "other", role: "installer" }] }),
        ],
      }),
    ).toContain("No travel on your schedule right now.");
    expect(liveAnswer("travel this week", base)).toBeNull();
  });

  const issue = (over: Record<string, unknown>) =>
    ({
      id: "i1",
      project_id: "p1",
      opening_id: null,
      window_id: null,
      kind: "blocker",
      urgency: "urgent",
      status: "open",
      note: "Missing brackets",
      created_at: "2026-07-20T00:00:00Z",
      ...over,
    }) as unknown as NonNullable<AskLiveData["issues"]>[number];

  const issuesData = (role: string | null): AskLiveData => ({
    ...base,
    role,
    issues: [issue({}), issue({ id: "i2", status: "resolved" })],
    projects: [{ id: "p1", job_code: "J12", name: "Maple St" }],
  });

  it("lists open issues on a named job for a foreman+", () => {
    const answer = liveAnswer("open issues on job J12", issuesData("foreman"));
    expect(answer).toContain("Open issues on J12");
    expect(answer).toContain("Blocker");
    expect(answer).toContain("Missing brackets");
  });

  it("hides issues from a plain installer (role scoping)", () => {
    expect(liveAnswer("open issues on job J12", issuesData("installer"))).toBeNull();
  });

  it("falls back when the named job can't be found", () => {
    expect(liveAnswer("open issues on job ZZ99", issuesData("foreman"))).toBeNull();
  });

  const vehicle = (over: Record<string, unknown>) =>
    ({
      id: "v1",
      kind: "pickup",
      year: 2021,
      make: "Ford",
      model: "F-150",
      plate: "ABC-1234",
      odometer: null,
      next_service_date: "2026-06-01",
      ...over,
    }) as unknown as NonNullable<AskLiveData["vehicles"]>[number];

  it("flags overdue trucks for a supervisor+", () => {
    const answer = liveAnswer("which trucks are overdue for service?", {
      ...base,
      role: "supervisor",
      vehicles: [vehicle({}), vehicle({ id: "v2", next_service_date: "2027-01-01" })],
    });
    expect(answer).toContain("overdue for service");
    expect(answer).toContain("2021 Ford F-150");
    expect(answer).toContain("ABC-1234");
  });

  it("hides vehicle service from a foreman and degrades on a cold cache", () => {
    expect(
      liveAnswer("trucks overdue", { ...base, role: "foreman", vehicles: [vehicle({})] }),
    ).toBeNull();
    expect(liveAnswer("vehicle service", { ...base, role: "supervisor" })).toBeNull();
  });
});
