// A signed toolbox talk has to become a PDF, whatever the talk says.
//
// Crew report, 2026-09-06: signing failed with "Couldn't save: WinAnsi cannot
// encode "✓" (0x2713)". The PDF's built-in Helvetica only has the WinAnsi
// characters, and buildToolboxPdf drew its Do list with a ✓ and its Don't list
// with a ✗ — so every talk from generate-toolbox-talk, which always has both
// lists, could not be signed. The clock-in gate requires today's signature, so
// on those days nobody could self-sign and nobody could clock in.
//
// The markers were only the first character to trip it. Anything else the font
// has no glyph for threw the same way: an arrow or a ≥ in the talk text (the
// grinder talk in the library has one), an emoji in the typed name. These tests
// build the real PDF with real pdf-lib; only the database client is stubbed,
// because nothing here reaches it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";
import type { SafetyTalk } from "./ops";

vi.mock("./supabase", () => ({ supabase: {} }));
vi.mock("./permissions/pushServer", () => ({ sendPush: vi.fn() }));

import { buildToolboxPdf } from "./toolbox";

// A real 1x1 PNG, so the signature block takes its normal path.
const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function talk(over: Partial<SafetyTalk>): SafetyTalk {
  return {
    id: "talk-1",
    title: "Working from ladders",
    body: "",
    talk_date: "2026-09-06",
    ...over,
  };
}

/** Every string handed to page.drawText while `build` ran, in order. */
async function drawnWhile(build: () => Promise<Uint8Array>) {
  const spy = vi.spyOn(PDFPage.prototype, "drawText");
  const bytes = await build();
  const drawn = spy.mock.calls.map((c) => String(c[0]));
  return { bytes, drawn, text: drawn.join(" ") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildToolboxPdf", () => {
  it("signs a talk with Do and Don't lists — the talk the crew could not sign", async () => {
    // Shaped exactly like a generate-toolbox-talk result, every word plain
    // ASCII: the list markers alone were enough to stop the signature.
    const generated = talk({
      title: "Ladder Safety Basics",
      sections_json: {
        intro: "Most ladder falls happen on short jobs. Set it up right every time.",
        key_hazards: ["Overreaching past the rails", "Setting the feet on soft ground"],
        steps: ["Inspect the ladder", "Set it at a 4 to 1 angle", "Keep three points of contact"],
        dos: ["Face the ladder when climbing", "Tie off extension ladders"],
        donts: ["Stand on the top step", "Carry glass up in one hand"],
      },
      visual_aids_json: [{ prompt: "A ladder set at the right angle against a wall" }],
    });

    const { bytes, drawn } = await drawnWhile(() =>
      buildToolboxPdf({
        talk: generated,
        typedName: "Ana Perez",
        signatureDataUrl: SIGNATURE,
        signedAt: new Date(2026, 8, 6, 6, 45),
      }),
    );

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    // Readable markers the font can draw: + for Do, x for Don't.
    expect(drawn.filter((s) => s === "+")).toHaveLength(2);
    expect(drawn.filter((s) => s === "x")).toHaveLength(2);
    expect(drawn).toContain("Face the ladder when climbing");
    expect(drawn).toContain("Carry glass up in one hand");
    expect(drawn).toContain("Signed by: Ana Perez");
    expect(drawn).not.toContain("(signature image unavailable)");
  });

  it("draws symbols as plain text, drops emoji, and keeps Spanish exactly", async () => {
    const hard = talk({
      title: "Escaleras → andamios: trabajo en altura",
      sections_json: {
        intro: "¿Dónde está la escalera? ¡Cuidado, señor! El niño y el pingüino — “siempre” con arnés…",
        key_hazards: ["Wheel RPM ≥ tool RPM", "Sealant won't cure at ≤ 40°F"],
        steps: ["Check the ladder ✓ then climb", "Three points of contact 🪜"],
        dos: ["Wear cut-resistant gloves ✅", "Lift 2-person units → with a partner"],
        donts: ["Stand on the top step ❌", "Phones on the ladder 📵"],
      },
      visual_aids_json: [{ prompt: "Ladder at 75° → 4:1 ratio 🧗" }],
    });

    const { bytes, drawn, text } = await drawnWhile(() =>
      buildToolboxPdf({
        talk: hard,
        typedName: "Ana 👷‍♀️ Pérez",
        signatureDataUrl: SIGNATURE,
        signedAt: new Date(2026, 8, 6, 6, 45),
      }),
    );

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(text).toContain("Escaleras -> andamios: trabajo en altura");
    expect(text).toContain(
      "¿Dónde está la escalera? ¡Cuidado, señor! El niño y el pingüino — “siempre” con arnés…",
    );
    expect(text).toContain("Wheel RPM >= tool RPM");
    expect(text).toContain("Sealant won't cure at <= 40°F");
    expect(text).toContain("Check the ladder + then climb");
    expect(drawn).toContain("Three points of contact");
    expect(drawn).toContain("Wear cut-resistant gloves");
    expect(drawn).toContain("Lift 2-person units -> with a partner");
    expect(drawn).toContain("Stand on the top step");
    expect(drawn).toContain("Diagram: Ladder at 75° -> 4:1 ratio");
    // The emoji goes and the name reads as typed around it.
    expect(drawn).toContain("Signed by: Ana Pérez");

    // Nothing reached the page that Helvetica cannot draw.
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const charset = new Set(font.getCharacterSet());
    const undrawable = [...drawn.join("")].filter((ch) => !charset.has(ch.codePointAt(0)!));
    expect(undrawable).toEqual([]);
  });
});
