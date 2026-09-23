import { beforeEach, expect, it, vi } from "vitest";
import { makeEntry, isRetryableError } from "./outbox-core";
const { rpc, getUser } = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("../supabase", () => ({
  supabaseConfigured: true,
  supabase: { rpc, auth: { getUser } },
}));
const { createSupabaseHandlers, createShiftResolver } = await import(
  "./outboxHandlers"
);
const handlers = createSupabaseHandlers(createShiftResolver());
const payload = {
  actorId: "original-user",
  args: {
    p_id: "original-case",
    p_project_id: "original-job",
    p_question: "Original question",
    p_answer: "Original answer",
    p_sources: [],
  },
};
beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ error: null });
  getUser
    .mockReset()
    .mockResolvedValue({
      data: { user: { id: "original-user" } },
      error: null,
    });
});
it("retries send the original immutable id and arguments", async () => {
  const e = makeEntry({ op: "hex_portal_case", payload }, "outbox-id", 0);
  await handlers.hex_portal_case!(e, { getBlob: async () => null });
  await handlers.hex_portal_case!(e, { getBlob: async () => null });
  expect(rpc.mock.calls).toEqual([
    ["hex_portal_save_case", payload.args],
    ["hex_portal_save_case", payload.args],
  ]);
});
it("an account switch cannot file another person’s case or outcome", async () => {
  getUser.mockResolvedValue({
    data: { user: { id: "another-user" } },
    error: null,
  });
  for (const op of ["hex_portal_case", "hex_portal_outcome"] as const) {
    try {
      await handlers[op]!(makeEntry({ op, payload }, "id", 0), {
        getBlob: async () => null,
      });
      throw Error("accepted");
    } catch (e) {
      expect(isRetryableError(e)).toBe(false);
    }
  }
  expect(rpc).not.toHaveBeenCalled();
});
it("a network failure remains retryable and does not fall back to an unguarded write", async () => {
  const err = new Error("Failed to fetch");
  getUser.mockRejectedValue(err);
  await expect(
    handlers.hex_portal_case!(
      makeEntry({ op: "hex_portal_case", payload }, "id", 0),
      { getBlob: async () => null },
    ),
  ).rejects.toBe(err);
  expect(isRetryableError(err)).toBe(true);
  expect(rpc).not.toHaveBeenCalled();
});
it("a queued lesson draft is sent only as its author, with the same action id and p_actor every retry", async () => {
  const draft = { actorId: "original-user", args: { p_review: "r", p_action: "a", p_case: "c", p_expected_revision: 1, p_content: {}, p_actor: "original-user" } };
  const e = makeEntry({ op: "hex_learning_draft", payload: draft }, "draft-id", 0);
  await handlers.hex_learning_draft!(e, { getBlob: async () => null });
  await handlers.hex_learning_draft!(e, { getBlob: async () => null });
  expect(rpc.mock.calls).toEqual([["hex_learning_save_draft", draft.args], ["hex_learning_save_draft", draft.args]]);
  rpc.mockClear();
  getUser.mockResolvedValue({ data: { user: { id: "another-user" } }, error: null });
  await expect(handlers.hex_learning_draft!(e, { getBlob: async () => null })).rejects.toSatisfy((err) => !isRetryableError(err));
  expect(rpc).not.toHaveBeenCalled();
});
it("a queued draft made stale by another screen dead-letters instead of retrying forever", async () => {
  rpc.mockResolvedValue({ error: { code: "P0001", hint: "stale_revision", message: "This write-up changed on another screen." } });
  const e = makeEntry({ op: "hex_learning_draft", payload: { actorId: "original-user", args: {} } }, "draft-id", 0);
  await expect(handlers.hex_learning_draft!(e, { getBlob: async () => null })).rejects.toSatisfy((err) => !isRetryableError(err));
});
