import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import corpus from "./__fixtures__/sourceMatchedWire.json";
const transport = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), client: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { auth: { getSession: transport.session } }, clientWithToken: transport.client }));
import { fetchUnitContributors, type UnitContributorsScope } from "./api";
import { UnitContributorsUnavailableError } from "./protocol";

const ACTOR = "00000000-0000-4000-8000-000000250002";
const PROJECT = "00000000-0000-4000-8000-000000250010";
const UNIT = "00000000-0000-4000-8000-000000250030";
const OTHER = "00000000-0000-4000-8000-000000999999";
const scope: UnitContributorsScope = { projectId: PROJECT, unitId: UNIT, unitIncarnation: "0" };
const unavailable = { protocolVersion: 1, availability: "unavailable", contributors: null };
const session = () => ({ data: { session: { access_token: "fixture-checked-token", user: { id: ACTOR } } }, error: null });
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(() => {
  rememberSignedIn({ user: { id: ACTOR } });
  vi.stubGlobal("navigator", { onLine: true });
  transport.rpc.mockReset().mockResolvedValue({ data: unavailable, error: null });
  transport.session.mockReset().mockResolvedValue(session());
  transport.client.mockReset().mockReturnValue({ rpc: transport.rpc });
});
afterEach(() => { rememberSignedIn(null); vi.unstubAllGlobals(); });

describe("current-login selected-unit contributor read", () => {
  it("keeps unavailable distinct from zero and sends only exact v1 scope on the checked token", async () => {
    expect(await fetchUnitContributors(scope, signInMark(), () => true)).toEqual(unavailable);
    expect(transport.client).toHaveBeenCalledWith("fixture-checked-token");
    expect(transport.rpc).toHaveBeenCalledOnce();
    expect(transport.rpc).toHaveBeenCalledWith("work_unit_contributors_read", {
      p_project_id: PROJECT, p_unit_id: UNIT, p_protocol_version: 1,
    });
  });
  it("passes the actual SQL reply without rebinding employees or times", async () => {
    transport.rpc.mockResolvedValue({ data: corpus.calls[0].reply, error: null });
    expect(await fetchUnitContributors(scope, signInMark(), () => true)).toEqual(corpus.calls[0].reply);
  });
  it("keeps exact canonical legacy PostgreSQL scope IDs without a new identity", async () => {
    const legacy = { projectId: "00000000-0000-0000-0000-000000000001",
      unitId: "00000000-0000-0000-0000-000000000002", unitIncarnation: "0" };
    expect(await fetchUnitContributors(legacy, signInMark(), () => true)).toEqual(unavailable);
    expect(transport.rpc).toHaveBeenCalledWith("work_unit_contributors_read", {
      p_project_id: legacy.projectId, p_unit_id: legacy.unitId, p_protocol_version: 1,
    });
  });
  it.each(["project", "unit", "missing incarnation", "leading zero", "newline", "overflow", "offline", "closed admission", "signed out"])
    ("refuses %s before session discovery or RPC", async kind => {
      const request = { ...scope };
      if (kind === "project") request.projectId = "bad";
      if (kind === "unit") request.unitId = "bad";
      if (kind === "missing incarnation") request.unitIncarnation = undefined as unknown as string;
      if (kind === "leading zero") request.unitIncarnation = "00";
      if (kind === "newline") request.unitIncarnation = "0\n";
      if (kind === "overflow") request.unitIncarnation = "9223372036854775808";
      if (kind === "offline") vi.stubGlobal("navigator", { onLine: false });
      if (kind === "signed out") rememberSignedIn(null);
      await expect(fetchUnitContributors(request, signInMark(), () => kind !== "closed admission"))
        .rejects.toThrow(UnitContributorsUnavailableError);
      expect(transport.session).not.toHaveBeenCalled(); expect(transport.rpc).not.toHaveBeenCalled();
    });
  it.each(["login ABA", "admission closure", "offline", "foreign session", "missing token", "session error"])
    ("fences %s while the current token is being read", async kind => {
      const token = held<ReturnType<typeof session>>();
      let admitted = true;
      transport.session.mockReturnValueOnce(token.promise);
      const read = fetchUnitContributors(scope, signInMark(), () => admitted);
      if (kind === "login ABA") { rememberSignedIn(null); rememberSignedIn({ user: { id: ACTOR } }); }
      if (kind === "admission closure") admitted = false;
      if (kind === "offline") vi.stubGlobal("navigator", { onLine: false });
      const reply = session();
      if (kind === "foreign session") reply.data.session.user.id = OTHER;
      if (kind === "missing token") reply.data.session.access_token = "";
      if (kind === "session error") reply.error = { message: "private diagnostic" } as unknown as null;
      token.resolve(reply);
      await expect(read).rejects.toThrow(UnitContributorsUnavailableError);
      expect(transport.client).not.toHaveBeenCalled(); expect(transport.rpc).not.toHaveBeenCalled();
    });
  it("rechecks admission after making the token-bound client", async () => {
    let admitted = true;
    transport.client.mockImplementationOnce(() => { admitted = false; return { rpc: transport.rpc }; });
    await expect(fetchUnitContributors(scope, signInMark(), () => admitted)).rejects.toThrow(UnitContributorsUnavailableError);
    expect(transport.rpc).not.toHaveBeenCalled();
  });
  it.each(["login ABA", "unit lifetime", "offline", "network", "malformed", "wrong actor", "wrong unit", "wrong incarnation"])
    ("drops late %s without a fallback, another read or a named response", async kind => {
      const response = held<{ data: unknown; error: unknown }>();
      let admitted = true;
      transport.rpc.mockReturnValueOnce(response.promise);
      const read = fetchUnitContributors(scope, signInMark(), () => admitted);
      await vi.waitFor(() => expect(transport.rpc).toHaveBeenCalledOnce());
      if (kind === "login ABA") { rememberSignedIn(null); rememberSignedIn({ user: { id: ACTOR } }); }
      if (kind === "unit lifetime") admitted = false;
      if (kind === "offline") vi.stubGlobal("navigator", { onLine: false });
      const data = structuredClone(corpus.calls[0].reply);
      if (data.availability !== "available" || !data.contributors) throw Error("Expected the actual source reply");
      if (kind === "wrong actor") data.contributors.actorId = OTHER;
      if (kind === "wrong unit") data.contributors.unitId = OTHER;
      if (kind === "wrong incarnation") data.contributors.unitIncarnation = "1";
      response.resolve({ data: kind === "malformed" ? { ...unavailable, contributors: { secretName: "private" } } : data,
        error: kind === "network" ? { message: "private network diagnostic" } : null });
      await expect(read).rejects.toThrow("Unit contributions are unavailable. Check the current records again.");
      expect(transport.rpc).toHaveBeenCalledOnce();
    });
  it("copies the request and original login before waiting", async () => {
    const token = held<ReturnType<typeof session>>(), request = { ...scope }, mark = { ...signInMark() };
    transport.session.mockReturnValueOnce(token.promise);
    transport.rpc.mockResolvedValue({ data: corpus.calls[0].reply, error: null });
    const read = fetchUnitContributors(request, mark, () => true);
    request.unitId = OTHER; request.unitIncarnation = "1"; mark.userId = OTHER;
    token.resolve(session());
    expect(await read).toEqual(corpus.calls[0].reply);
    expect(transport.rpc).toHaveBeenCalledWith("work_unit_contributors_read", {
      p_project_id: PROJECT, p_unit_id: UNIT, p_protocol_version: 1,
    });
  });
});
