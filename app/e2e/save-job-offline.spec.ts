// "Save for offline" puts a job on the phone and remembers that it did.
//
// The whole promise, in one test: open a job with signal, tap Save, the button
// turns into "Saved offline · just now", and after a reload — the moment a PWA
// forgets everything it held in memory — it still says so, because the record
// is on the phone with the job. What the save actually stores (openings,
// specs, the map's outlines, the planset bytes, the drawings) has unit tests
// under lib/offline; this proves the tap reaches them and the label tells the
// truth afterwards.
//
// Fixture-backed like every spec here: no login, no network, no real project.
// The planset downloads and the page renders happen against the committed
// BLACK22 sheet, which is why the save is given a generous timeout — a 4 MB
// PDF rendered page by page is the slow part of this suite.
import { expect, test } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

// A real save of BLACK22 is 85 steps, 36 of them a page render at print
// resolution, and this laptop is often running two other builders' suites at
// the same time. The config's three minutes is for a single planset read;
// this is the one spec that does the whole job, so it gets five.
test.setTimeout(300_000);

test("a foreman saves a job for offline and the job page remembers it", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await page.goto(`/projects/${BLACK22.projectId}`);

  const button = page.getByTestId("save-job-offline");
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-state", "idle");
  await expect(button).toHaveText(/Save for offline|Guardar sin señal/);

  await button.click();
  await expect(button).toHaveAttribute("data-state", "saving");
  await expect(button).toHaveAttribute("data-state", "saved", { timeout: 280_000 });
  // The committed storage backup holds one of BLACK22's three sheets, so the
  // save lands with pictures missing and must SAY so — "Saved, but N pictures
  // could not be downloaded" — rather than claim a clean save. Either wording
  // starts with "Saved"; a save that ended in "Couldn't save" would not.
  await expect(button).toHaveText(/^(Saved|Guardado)/);

  await page.reload();
  const after = page.getByTestId("save-job-offline");
  await expect(after).toHaveAttribute("data-state", "saved");
  await expect(after).toHaveText(/^(Saved offline|Guardado sin señal)/);
  // And the record survived the reload with its honesty intact.
  await expect(after).toHaveText(/missing|faltan/);
});

test("the landing strip counts the jobs on this phone and offers to save them all", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await page.goto("/");
  const strip = page.getByTestId("save-jobs-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(/0 of \d+ jobs saved|0 de \d+ trabajos/);
  await expect(strip.getByRole("button")).toHaveText(/Save all for offline|Guardar todos/);
});
