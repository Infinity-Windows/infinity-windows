// One honest sync status (Release 0, K0.6 + F5).
//
// The report from the crews: photos stuck at "queued" while the app said
// "All synced". Three things have to be true from now on, and each is pinned
// here against the real UI with Supabase mocked at the network layer:
//
//   1. a photo taken with no signal is COUNTED — on the pill, on /stuck with
//      its age — from the moment it is saved on the phone until it lands;
//   2. a relaunch and a reconnect send it exactly ONCE (one attachments row,
//      one client id), never twice;
//   3. items left in the retired upload queue on phones in the field are
//      moved and sent once, under the id they already had.
//
// House style (photos-upload.spec.ts): assert what the app actually SENDS —
// the attachments rows — rather than that something rendered.
import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, pngFile, stubGeolocationDenied } from "./support/specHelpers";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/**
 * The phone's signal, as far as Supabase is concerned. While `down`, every
 * storage and attachments request fails the way a dead zone fails — the
 * browser still says it is online, which is the harder case: the outbox
 * TRIES, fails, and has to keep the photo and tell the truth about it.
 */
function signal(page: Page) {
  const state = { down: false };
  const rows: Record<string, unknown>[] = [];
  const install = async () => {
    await page.route("**/storage/v1/object/**", (route) => {
      if (state.down) return route.abort("internetdisconnected");
      if (route.request().url().includes("/object/sign/")) {
        return json(route, { signedURL: "/fixture.jpg" });
      }
      return json(route, { Key: "install-media/x.jpg" });
    });
    await page.route("**/rest/v1/attachments**", async (route) => {
      if (state.down) return route.abort("internetdisconnected");
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        for (const r of Array.isArray(body) ? body : [body]) rows.push(r as Record<string, unknown>);
        return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
      }
      return json(route, []);
    });
  };
  return { state, rows, install };
}

/** The pill a phone shows (the rail's copy is display:none at 390px). */
const pill = (page: Page) => page.locator(".sync-pill:visible").first();
const pillText = (page: Page) => page.locator(".sync-pill-text:visible").first();

async function openTheSheet(page: Page) {
  await page.goto(`/photos?project=${BLACK22.projectId}`);
  await page.getByRole("button", { name: "Add photo" }).click();
  await expect(page.getByRole("dialog", { name: "Add job photos" })).toBeVisible();
}

test("a photo taken with no signal is counted everywhere, and sends exactly once after a relaunch", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  // The fixture host legitimately mismatches the real project; the banner it
  // draws sits over the pill this spec taps.
  await hideWrongProjectBanner(page);
  const net = signal(page);
  await net.install();

  await openTheSheet(page);
  await expect(pillText(page)).toHaveText("All synced");

  // The dead zone begins after the sheet is open — the capture itself needs
  // nothing from the network.
  net.state.down = true;
  await page.locator('.jobphoto-actions input[type="file"]:not([capture])').setInputFiles(pngFile("no-signal.png"));
  await expect(page.getByText("1 photo waiting to upload", { exact: true })).toBeVisible();

  // THE BUG, in one assertion: never "All synced" over a photo still on the
  // phone. The pill counts it, and it is not lost — the phone has it.
  await expect(pillText(page)).toContainText("Photos 1");
  await expect(pillText(page)).not.toContainText("All synced");
  expect(net.rows).toHaveLength(0);

  // Relaunch, still with no signal. The photo is in IndexedDB; the pill opens
  // /stuck (F5), where a WAITING item is listed with its state and its age —
  // not only the ones that gave up.
  await expect(pill(page)).toHaveAttribute("href", "/stuck");
  await page.goto("/stuck");
  await expect(page.getByRole("heading", { name: "Waiting to send" })).toBeVisible();
  await expect(page.getByText("Photo", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved on this phone", { exact: true })).toBeVisible();
  await expect(page.getByText("Queued just now")).toBeVisible();
  // Not stuck, so no Throw away: it is going to send itself.
  await expect(page.getByRole("button", { name: "Throw away" })).toHaveCount(0);
  await expect(pillText(page)).toContainText("Photos 1");
  expect(net.rows).toHaveLength(0);

  // Signal returns. "Send now" skips the backoff a dead zone bought and sends
  // the ONE photo: one row, one client id.
  net.state.down = false;
  await page.getByRole("button", { name: "Send now" }).click();
  await expect.poll(() => net.rows.length, { timeout: 60_000 }).toBe(1);
  expect(net.rows[0]).toMatchObject({
    project_id: BLACK22.projectId,
    kind: "photo",
    created_by: TEST_USER.email,
  });
  expect(net.rows[0].client_id).toEqual(expect.any(String));
  const clientId = net.rows[0].client_id;

  // Third state, on the same screen: it reached the server.
  await expect(page.getByText("Saved in Forge", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting to send" })).toHaveCount(0);
  await expect(pillText(page)).toHaveText("All synced");

  // A relaunch after the send finds nothing to send: still one row.
  await page.reload();
  await expect(pillText(page)).toHaveText("All synced");
  await expect(page.getByText("Nothing stuck", { exact: false })).toBeVisible();
  expect(net.rows).toHaveLength(1);
  expect(net.rows[0].client_id).toBe(clientId);
});

test("a photo left in the retired upload queue is moved on the next start and sent exactly once", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  // The fixture host legitimately mismatches the real project; the banner it
  // draws sits over the pill this spec taps.
  await hideWrongProjectBanner(page);
  const net = signal(page);
  await net.install();

  await page.goto(`/photos?project=${BLACK22.projectId}`);
  await expect(page.getByRole("button", { name: "Add photo", exact: true })).toBeVisible();
  await expect(pillText(page)).toHaveText("All synced");

  // What a phone in the field has right now: an item the OLD queue wrote,
  // three days ago, that nothing ever counted.
  const legacyId = "ab222222-2222-4222-8222-222222222222";
  const path = `${BLACK22.projectId}/W1/1720000000-after.jpg`;
  const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  await page.evaluate(
    async ({ id, email, project, path, createdAt, png }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("wops-upload-queue", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("uploads", { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const meta = {
        v: 1,
        id,
        bucket: "install-media",
        path,
        contentType: "image/png",
        kind: "photo",
        installEventId: "evt-old",
        windowId: null,
        createdBy: email,
        createdAt,
        projectId: project,
      };
      const tx = db.transaction("uploads", "readwrite");
      tx.objectStore("uploads").put({
        id,
        meta: JSON.stringify(meta),
        blob: new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: "image/png" }),
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    {
      id: legacyId,
      email: TEST_USER.email,
      project: BLACK22.projectId,
      path,
      createdAt,
      png: pngFile("after.png").buffer.toString("base64"),
    },
  );

  // The next start moves it into the outbox under the SAME id and sends it.
  await page.reload();
  await expect.poll(() => net.rows.length, { timeout: 60_000 }).toBe(1);
  expect(net.rows[0]).toMatchObject({
    client_id: legacyId,
    storage_path: `install-media/${path}`,
    kind: "photo",
    install_event_id: "evt-old",
    created_by: TEST_USER.email,
    project_id: BLACK22.projectId,
  });
  await expect(pillText(page)).toHaveText("All synced");

  // The old store is gone, not merely emptied — a phone that has moved its
  // items never opens it again.
  await expect
    .poll(async () =>
      page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "wops-upload-queue")),
    )
    .toBe(false);

  // And it is on /stuck as a photo that reached the server this session.
  await pill(page).click();
  await expect(page).toHaveURL(/\/stuck$/);
  await expect(page.getByText("Saved in Forge", { exact: true })).toBeVisible();
  await expect(page.getByText("Photo", { exact: true })).toBeVisible();

  // Another start finds nothing to move and nothing to send: still one row.
  await page.reload();
  await expect(pillText(page)).toHaveText("All synced");
  expect(net.rows).toHaveLength(1);
});

test("the pill opens the same place whatever is queued, and a refused work change is listed there", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  // The fixture host legitimately mismatches the real project; the banner it
  // draws sits over the pill this spec taps.
  await hideWrongProjectBanner(page);
  const net = signal(page);
  await net.install();

  // A custom-work command the server refused, sitting in this person's queue.
  await page.addInitScript(
    ({ userId }) => {
      window.localStorage.setItem(
        `forge-custom-work-v1:${userId}`,
        JSON.stringify([
          { id: "c-1", userId, action: "stop", data: {}, error: "Shift already closed." },
        ]),
      );
    },
    { userId: TEST_USER.id },
  );

  await page.goto(`/photos?project=${BLACK22.projectId}`);
  await expect(pillText(page)).toHaveText("Work needs review");
  // F5: /stuck, not Current Work — the same tap, the same door.
  await expect(pill(page)).toHaveAttribute("href", "/stuck");

  await pill(page).click();
  await expect(page).toHaveURL(/\/stuck$/);
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.getByText("Work change", { exact: true })).toBeVisible();
  await expect(page.getByText("Couldn't send — needs you", { exact: true })).toBeVisible();
  await expect(page.getByText("Shift already closed.")).toBeVisible();
  // Its review still belongs to Current Work, which exports before it removes.
  await expect(page.getByRole("link", { name: "Review in Current Work" })).toHaveAttribute(
    "href",
    "/current-work",
  );
  await expect(page.getByRole("button", { name: "Throw away" })).toHaveCount(0);
});
