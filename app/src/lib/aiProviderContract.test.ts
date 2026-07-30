import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Which AI company each feature is on.
 *
 * The decision: every word the app generates is written by Claude, and OpenAI is
 * kept for exactly the three jobs Anthropic cannot do — embeddings for the
 * company brain, Whisper for voice memos, and the safety-talk diagrams. Two AI
 * bills for the same work is the thing being removed.
 *
 * Source-contract assertions rather than behaviour tests, for the same reason
 * onboardingContract.test.ts is: no unit test can honestly prove a live function
 * called a provider. What these guard is the drift that nothing else would
 * catch — one function quietly put back on OpenAI text generation months from
 * now, and a bill nobody can explain. The real end-to-end proof is exercising
 * the deployed functions, which is recorded in the PR.
 */

const functionsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/functions",
);
const read = (p: string) => readFileSync(join(functionsDir, p), "utf8");

const deployable = readdirSync(functionsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
  .map((e) => e.name)
  .sort();

/** Every function that generates prose or structured text from a prompt. */
const TEXT_FUNCTIONS = [
  "ask",
  "extract-schedule",
  "extract-specs",
  "generate-howto",
  "generate-toolbox-talk",
  "synthesize-type-tips",
  "transcribe-install-memo",
];

describe("no text generation is left on OpenAI", () => {
  it("nothing anywhere calls the OpenAI chat endpoint", () => {
    for (const name of deployable) {
      expect(read(`${name}/index.ts`), name).not.toContain("chat/completions");
    }
    for (const shared of readdirSync(join(functionsDir, "_shared"))) {
      expect(read(`_shared/${shared}`), shared).not.toContain("chat/completions");
    }
  });

  it("the OpenAI helper no longer offers a chat function to fall back to", () => {
    // Leaving a working `chatJson` behind is how a feature drifts back onto a
    // second bill without anyone deciding to do that.
    const openai = read("_shared/openai.ts");
    expect(openai).not.toMatch(/export\s+async\s+function\s+chatJson/);
    expect(openai).not.toMatch(/export\s+async\s+function\s+chatJsonVision/);
  });

  it("every text feature asks Claude", () => {
    for (const name of TEXT_FUNCTIONS) {
      expect(read(`${name}/index.ts`), name).toMatch(
        /anthropicChat|anthropicVisionChat|anthropicChatJson/,
      );
    }
  });

  it("no function sends temperature, which claude-sonnet-5 rejects with a 400", () => {
    for (const name of deployable) {
      expect(read(`${name}/index.ts`), name).not.toMatch(/temperature/);
    }
  });
});

describe("the three things OpenAI is still for", () => {
  it("keeps embeddings on text-embedding-3-small, the shape the brain is stored in", () => {
    const openai = read("_shared/openai.ts");
    expect(openai).toContain("api.openai.com/v1/embeddings");
    expect(openai).toContain("text-embedding-3-small");
  });

  it("keeps Whisper for voice memos", () => {
    const openai = read("_shared/openai.ts");
    expect(openai).toContain("api.openai.com/v1/audio/transcriptions");
    expect(openai).toContain("whisper-1");
  });

  it("keeps image generation for the safety-talk diagrams", () => {
    const talk = read("generate-toolbox-talk/index.ts");
    expect(talk).toContain("api.openai.com/v1/images/generations");
  });
});

describe("a missing OpenAI key costs pictures and search, never words", () => {
  it("the safety talk feature-detects the image key instead of demanding it", () => {
    // The positive `Deno.env.get` test is also what scripts/function_secrets.py
    // reads as "optional", which is what keeps the deploy from insisting on an
    // OpenAI key for a talk whose words come from Claude.
    expect(read("generate-toolbox-talk/index.ts")).toContain(
      'if (Deno.env.get("OPENAI_API_KEY"))',
    );
  });

  it("Ask Infinity still treats its OpenAI-powered document search as optional", () => {
    expect(read("ask/index.ts")).toContain('if (Deno.env.get("OPENAI_API_KEY"))');
  });

  it("the three text-only features import nothing that needs an OpenAI key", () => {
    for (const name of [
      "extract-schedule",
      "generate-howto",
      "synthesize-type-tips",
    ]) {
      const src = read(`${name}/index.ts`);
      expect(src, name).not.toContain("OPENAI_API_KEY");
      expect(src, name).toContain("requireAnthropic");
    }
  });
});
