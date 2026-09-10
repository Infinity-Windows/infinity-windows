// A SOURCE test, for a bug no rendering test can catch.
//
// THE INCIDENT: the capture sheet's "Upload files" input carried
// `capture="environment"`. That attribute tells iOS and Android to open the
// camera and offer nothing else — no Photo Library, no Files app, no Google
// Drive — so a button labelled "Upload files" could only ever take a NEW photo,
// and everything already on the phone was unreachable from the app. Nothing in
// this repo can see that: no headless browser honours `capture` (Chrome,
// Playwright and happy-dom all just open a file dialog), so a rendering test of
// that bug passes on a build that is broken on every phone the crew carries.
//
// What a machine here CAN check is the source: how many places write a file
// input that offers pictures, and which of them ask for `capture`. There is
// one — lib/photo/usePhotoPicker.tsx — and it writes the pair deliberately,
// side by side, with the rule in its header.
//
// This file carried an allow-list for a while: two hand-rolled camera-only
// pickers that predated the hook — the package sheet's "Add a photo" and the
// photo of a missed unit at the wall — named here as a record of work left,
// because moving them was a change to two other screens rather than to
// receipts. Both go through the hook now. The list is DELETED rather than kept
// at zero entries: an empty allow-list is still a place to put a name, and the
// rule below is meant to have nowhere to put one.
//
// WHY THIS IS NOT "no type=file anywhere but the hook". Eight file inputs in
// this app have nothing to do with photos: a markdown import, a planset PDF, a
// bank statement CSV, a catalog import, a training video, a spec sheet, a
// travel attachment. None of them could live in a photo picker and none of them
// can grow this bug. The rule is about inputs that offer IMAGES — and an input
// naming no `accept` offers them too, so two that name none on purpose are
// listed by name below rather than left to slip through a pattern.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The one file allowed to write a picture picker. */
const THE_HOOK = "lib/photo/usePhotoPicker.tsx";

/**
 * The two inputs that name no `accept` on purpose, and so technically offer
 * pictures without being picture pickers:
 *
 *   - the travel attachment ("Add file") — a toll receipt, a boarding pass, a
 *     photo of a fuel slip; narrowing it would be narrowing it to nothing.
 *   - the Knowledge vault FOLDER picker, which carries `webkitdirectory` and
 *     picks a directory rather than a type.
 *
 * Neither carries `capture`, so neither can grow the incident. Listed EXACTLY,
 * for the same reason the legacy pickers are: a third accept-less input cannot
 * join them without somebody editing this test and saying why.
 */
// Workflow accepts arbitrary original documents (CAD, email, PDF, photos) like
// Travel. It must never invoke the camera or compress signed/source files.
const ACCEPT_LESS = ["components/travel/AttachmentsPanel.tsx", "pages/Knowledge.tsx", "pages/proposals/Workflow.tsx"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // The vendored 3D core is somebody else's repo, and its own suite covers it.
      if (name === "vendor") continue;
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Comment lines blanked out, so the PROSE about file inputs — which several of
 * these files carry, this one included — is never mistaken for one.
 *
 * Line-level on purpose. Stripping `/* … *&#47;` by pattern eats real code
 * here: `accept="image/*"` contains the opening of a block comment, so the
 * strip runs from an attribute to the end of the next JSDoc and takes both
 * inputs with it. Every comment in this tree opens its own line, which is all
 * this needs to know.
 */
function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line) ? "" : line))
    .join("\n");
}

/**
 * Every `<input … />` in the file that is a file input, as its own attribute
 * text.
 *
 * Scanned rather than matched with one regex, because an attribute can carry a
 * `>` of its own: `onChange={(e) => …}` is the ordinary spelling here, and a
 * pattern that stops at the first `>` reads exactly the two hand-rolled pickers
 * this test is meant to keep count of as if they had no attributes at all.
 * Braces are counted so the tag ends at the `/>` that belongs to it.
 */
function fileInputs(source: string): string[] {
  const text = stripCommentLines(source);
  const found: string[] = [];
  const re = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && c === "/" && text[i + 1] === ">") break;
      else if (depth === 0 && c === ">") break;
    }
    const attrs = text.slice(m.index + m[0].length, i);
    if (/type=["']file["']/.test(attrs)) found.push(attrs);
  }
  return found;
}

/**
 * Does this input offer PICTURES?
 *
 * An input with NO `accept` offers everything, pictures included — which is why
 * the absence of the attribute counts here rather than being waved through. The
 * first cut of this file asked for the literal text `image/`, so an input that
 * simply named no accept at all was invisible to every assertion below, and the
 * header's "no other file input in the app may offer images" was not a rule the
 * file actually enforced.
 */
function offersImages(attrs: string): boolean {
  return !/\baccept=/.test(attrs) || /image\//.test(attrs);
}

/**
 * A picture input that can ONLY reach the camera — the shape of the incident.
 *
 * `capture` IS the trigger, and an explicit video accept is the only way out.
 * Asking for `image/` instead would have missed the incident written without an
 * accept at all — `<input type="file" capture="environment" />` opens the camera
 * and offers nothing else, exactly as the original bug did, and named no MIME
 * type while doing it.
 *
 * `capture` on a VIDEO input is a different door and not this rule's business:
 * the install sheet's walkthrough video is a thing you record, there is no
 * "video library" equivalent to lose, and no photo picker could serve it.
 */
function isCameraOnlyPicture(attrs: string): boolean {
  return /\bcapture=/.test(attrs) && !/accept=["'][^"']*video\//.test(attrs);
}

const files = walk(srcRoot).map((full) => ({
  path: relative(srcRoot, full),
  source: readFileSync(full, "utf8"),
}));

describe("one place writes a picture picker", () => {
  it("finds the hook itself, so a rename cannot quietly empty this test", () => {
    expect(files.some((f) => f.path === THE_HOOK)).toBe(true);
    expect(fileInputs(files.find((f) => f.path === THE_HOOK)!.source)).toHaveLength(2);
  });

  it("has no file input offering images outside the hook", () => {
    const offenders = files
      .filter((f) => f.path !== THE_HOOK && !ACCEPT_LESS.includes(f.path))
      .filter((f) => fileInputs(f.source).some(offersImages))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("has exactly the documented general-file inputs without accept", () => {
    const acceptLess = files
      .filter((f) => f.path !== THE_HOOK)
      .filter((f) => fileInputs(f.source).some((attrs) => !/\baccept=/.test(attrs)))
      .map((f) => f.path)
      .sort();
    expect(acceptLess).toEqual([...ACCEPT_LESS].sort());
  });

  // No allow-list on this one, and none on the images rule above beyond the two
  // accept-less inputs that are not picture pickers at all. THE INCIDENT was a
  // camera-only picture input, so this is the assertion the whole file is for.
  it("has no PICTURE input asking for `capture` outside the hook", () => {
    const offenders = files
      .filter((f) => f.path !== THE_HOOK)
      .filter((f) => fileInputs(f.source).some(isCameraOnlyPicture))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("keeps the capture sheet itself free of file inputs — it goes through the hook", () => {
    const sheet = files.find((f) => f.path === "components/PhotoCaptureSheet.tsx");
    expect(sheet).toBeDefined();
    expect(fileInputs(sheet!.source)).toEqual([]);
  });

  // The two screens the deleted allow-list used to name, asserted by name so a
  // revert of either one fails HERE — where this comment says what it cost —
  // and not only as an anonymous path in the sweep above.
  it("keeps the package sheet and the missed-unit sheet on the hook", () => {
    for (const path of [
      "pages/storage/PackageSheet.tsx",
      "components/install/AddMissedUnitSheet.tsx",
    ]) {
      const f = files.find((x) => x.path === path);
      expect(f, `${path} moved or was renamed`).toBeDefined();
      expect(fileInputs(f!.source), `${path} grew a file input of its own`).toEqual([]);
      expect(f!.source, `${path} stopped using the hook`).toMatch(/usePhotoPicker/);
    }
  });
});

describe("the hook's two inputs are the camera one and the library one", () => {
  const hook = () => files.find((f) => f.path === THE_HOOK)!.source;

  it("gives `capture=\"environment\"` to exactly one of them", () => {
    const withCapture = fileInputs(hook()).filter((attrs) => /\bcapture=/.test(attrs));
    expect(withCapture).toHaveLength(1);
    expect(withCapture[0]).toMatch(/capture="environment"/);
  });

  it("keeps the camera input pictures-only — a camera cannot hand back a PDF", () => {
    const cameraInput = fileInputs(hook()).find((attrs) => /\bcapture=/.test(attrs))!;
    expect(cameraInput).toMatch(/accept="image\/\*"/);
  });

  it("never puts `capture` on the library input, which is THE INCIDENT", () => {
    const libraryInput = fileInputs(hook()).find((attrs) => !/\bcapture=/.test(attrs))!;
    expect(libraryInput).toBeDefined();
    // Its accept is passed in — "image/*" for a photo, "image/*,application/pdf"
    // for a receipt — so the assertion is about what must NOT be there.
    expect(libraryInput).not.toMatch(/\bcapture=/);
    expect(libraryInput).toMatch(/accept=\{accept\}/);
  });
});

// THE RULES THEMSELVES, exercised on shapes the tree cannot supply because —
// for now — nobody has written them. A scan of a clean tree is green whether
// the rule is right or wrong; these are what catch a rule that has quietly
// stopped covering the thing it is named after.
describe("what counts as a camera-only picture", () => {
  it("catches a `capture` input naming no accept at all — the incident, spelled shorter", () => {
    // Offers the camera and nothing else, exactly as the original bug did, and
    // names no MIME type while doing it. The first cut of this guard, which
    // asked for the literal text `image/`, could not see this at all.
    expect(isCameraOnlyPicture(' type="file" capture="environment" ')).toBe(true);
  });

  it("still catches the spelling the incident actually used", () => {
    expect(isCameraOnlyPicture(' type="file" accept="image/*" capture="environment" ')).toBe(true);
  });

  it("leaves a video recorder alone — a different door, with no library to lose", () => {
    expect(isCameraOnlyPicture(' type="file" accept="video/*" capture="environment" ')).toBe(false);
  });

  it("says nothing about an input that never asked for the camera", () => {
    expect(isCameraOnlyPicture(' type="file" accept="image/*" multiple ')).toBe(false);
  });
});

describe("what counts as offering pictures", () => {
  it("counts an input with no accept, because one offers everything", () => {
    expect(offersImages(' type="file" hidden ')).toBe(true);
  });

  it("counts the receipt picker, which offers pictures AND PDFs", () => {
    expect(offersImages(' type="file" accept="image/*,application/pdf" ')).toBe(true);
  });

  it("leaves the CSV, planset and video pickers alone", () => {
    expect(offersImages(' type="file" accept=".csv,text/csv" ')).toBe(false);
    expect(offersImages(' type="file" accept=".pdf,application/pdf" ')).toBe(false);
    expect(offersImages(' type="file" accept="video/*" ')).toBe(false);
  });
});
