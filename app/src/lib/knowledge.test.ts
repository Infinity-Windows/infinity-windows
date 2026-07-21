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
import { pageNotes, type VaultNote } from "./knowledge";

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
