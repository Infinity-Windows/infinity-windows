// TEMPORARY repro harness (deleted before commit). Mirrors the ProjectMap
// doc-loading effect against the REAL Black Desert plansets so WebKit gives an
// unminified trace of whatever throws.
const BUILDING = new URL("__repro_pdf__.pdf", document.baseURI).href;
const SPECS = new URL("__repro_specs__.pdf", document.baseURI).href;

type Step = { name: string; ok: boolean; detail?: string; stack?: string };
const results: Step[] = [];

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const out = await Promise.race([
      fn(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("HUNG >40s (never settled)")), 40000),
      ),
    ]);
    results.push({ name, ok: true, detail: `ok (${Date.now() - t0}ms)` });
    return out;
  } catch (e) {
    const err = e as Error;
    results.push({
      name,
      ok: false,
      detail: `${err?.name}: ${err?.message} (${Date.now() - t0}ms)`,
      stack: err?.stack || String(e),
    });
    return undefined;
  }
}

async function main() {
  const [bBuf, sBuf] = await Promise.all([
    fetch(BUILDING).then((r) => r.arrayBuffer()),
    fetch(SPECS).then((r) => r.arrayBuffer()),
  ]);
  results.push({
    name: "fetch pdfs",
    ok: true,
    detail: `building=${bBuf.byteLength} specs=${sBuf.byteLength}`,
  });

  const { extractAllText, extractPlanMarkCallouts, loadPdf, renderPageImage } = await import(
    "./lib/install/pdf"
  );
  const { findFloorPlanPages, splitCalloutsByFloorPlan, extractCadDetailPages } = await import(
    "./lib/install/planDetails"
  );
  const { extractBuildingOutline } = await import("./lib/install/outline");

  // --- exactly the ProjectMap effect, building PDF branch ---
  const buildingDoc = await step("loadPdf(building)", () => loadPdf(bBuf));
  if (!buildingDoc) return finish();
  const buildingText = await step("extractAllText(building)", () =>
    extractAllText(buildingDoc),
  );
  const buildingCallouts = await step("extractPlanMarkCallouts(building)", () =>
    extractPlanMarkCallouts(buildingDoc),
  );
  if (buildingText && buildingCallouts) {
    await step("findFloorPlanPages", async () =>
      findFloorPlanPages(buildingText, buildingCallouts),
    );
    await step("splitCalloutsByFloorPlan", async () =>
      splitCalloutsByFloorPlan(buildingCallouts, buildingText),
    );
  }

  // --- specs PDF branch (14 pages) ---
  const specsDoc = await step("loadPdf(specs)", () => loadPdf(sBuf));
  let specsText: Awaited<ReturnType<typeof extractAllText>> | undefined;
  if (specsDoc) {
    specsText = await step("extractAllText(specs 14pp)", () => extractAllText(specsDoc));
  }
  if (specsText) {
    await step("extractCadDetailPages", async () => extractCadDetailPages(specsText, []));
  }

  // --- what the panel does once docsReady flips ---
  await step("renderPageImage(building p1)", () => renderPageImage(buildingDoc, 1));
  await step("extractBuildingOutline(building p1)", () =>
    extractBuildingOutline(buildingDoc, 1),
  );
  if (specsDoc) {
    await step("renderPageImage(specs p1)", () => renderPageImage(specsDoc, 1));
  }
  finish();
}

function finish() {
  const w = window as unknown as { __RESULT__: Step[]; __DONE__: boolean };
  w.__RESULT__ = results;
  document.getElementById("out")!.textContent = JSON.stringify(results, null, 2);
  w.__DONE__ = true;
}

void main().catch((e) => {
  results.push({ name: "main", ok: false, detail: String(e), stack: (e as Error)?.stack });
  finish();
});
