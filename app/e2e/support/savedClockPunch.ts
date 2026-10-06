import type { Page } from "@playwright/test";

/** Read the immutable identity of a locally saved Start day without changing it. */
export async function savedClockPunch(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wops-write-outbox");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise<Array<{ meta: string }>>((resolve, reject) => {
        const request = db.transaction("entries", "readonly").objectStore("entries").getAll();
        request.onsuccess = () => resolve(request.result as Array<{ meta: string }>);
        request.onerror = () => reject(request.error);
      });
      return rows.map((row) => JSON.parse(row.meta) as {
        id: string;
        op: string;
        ownerId: string;
        payload: { clientId: string; tappedAt: string; projectId: string };
      }).filter((row) => row.op === "clock_in").map((row) => ({
        id: row.id,
        ownerId: row.ownerId,
        payload: {
          clientId: row.payload.clientId,
          tappedAt: row.payload.tappedAt,
          projectId: row.payload.projectId,
        },
      }));
    } finally {
      db.close();
    }
  });
}
