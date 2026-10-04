// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ViewAsRoleProvider } from "./viewAsRole";
import { useViewAsRole, type ViewAsRoleValue } from "./viewAsRoleContext";
vi.mock("./install/api", () => ({ getRealProfile: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => { cleanup(); sessionStorage.clear(); });
function mount(role = "owner") {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const profile = { id: "owner", role };
  client.setQueryData(["myRealProfile"], profile);
  const host = document.createElement("div"), root = createRoot(host); let value!: ViewAsRoleValue;
  function Read() { value = useViewAsRole(); return <span>{value.previewRole ?? "self"}</span>; }
  act(() => root.render(<QueryClientProvider client={client}><ViewAsRoleProvider><Read /></ViewAsRoleProvider></QueryClientProvider>));
  cleanup = () => { act(() => root.unmount()); client.clear(); host.remove(); };
  return { client, get value() { return value; }, profile };
}
it("keeps old presentation behavior while raw stored preview blocks sensitive work", () => {
  sessionStorage.setItem("infinity.viewAsRole", "owner"); const m = mount("installer");
  expect(m.value.previewRole).toBeNull(); expect(m.value.canPreview).toBe(false);
  expect(m.value.sensitiveLifetime!.admitted("owner", "installer")).toBe(false);
  act(() => m.value.setPreviewRole(null)); expect(sessionStorage.getItem("infinity.viewAsRole")).toBe("owner");
});
it("advances synchronously through batched role and person preview ABA", () => {
  const m = mount(), seam = m.value.sensitiveLifetime!, old = seam.getSnapshot();
  act(() => { m.value.setPreviewRole("installer"); expect(seam.admitted("owner", "owner")).toBe(false); m.value.setPreviewRole(null); });
  expect(seam.getSnapshot()).toBeGreaterThan(old); expect(seam.admitted("owner", "owner")).toBe(true);
  const next = seam.getSnapshot();
  act(() => { m.value.setPreviewPerson({ id: "person", role: "installer", name: "Private" }); m.value.setPreviewPerson(null); });
  expect(seam.getSnapshot()).toBeGreaterThan(next); expect(m.value.previewPerson).toBeNull();
});
it("tracks profile role ABA synchronously and rejects invalidated or other-owner authority", () => {
  const m = mount(), seam = m.value.sensitiveLifetime!, old = seam.getSnapshot();
  act(() => { m.client.setQueryData(["myRealProfile"], { ...m.profile, role: "installer" }); m.client.setQueryData(["myRealProfile"], m.profile); });
  expect(seam.getSnapshot()).toBeGreaterThan(old); expect(seam.admitted("other", "owner")).toBe(false);
  act(() => { void m.client.invalidateQueries({ queryKey: ["myRealProfile"], refetchType: "none" }); });
  expect(seam.admitted("owner", "owner")).toBe(false);
});

it("keeps a raw person preview blocked when a non-owner's presentation suppresses it", () => {
  sessionStorage.setItem("infinity.viewAsPerson", JSON.stringify({ id: "person", name: "Private", role: "installer" }));
  const m = mount("foreman"); expect(m.value.previewPerson).toBeNull();
  expect(m.value.sensitiveLifetime!.admitted("owner", "foreman")).toBe(false);
});

it("lets an installer explicitly clear only their stale session lenses, never create a preview", () => {
  sessionStorage.setItem("infinity.viewAsRole", "owner");
  sessionStorage.setItem("infinity.viewAsPerson", JSON.stringify({ id: "person", name: "Private", role: "installer" }));
  const m = mount("installer"), seam = m.value.sensitiveLifetime!, old = seam.getSnapshot();
  expect(seam.admitted("owner", "installer")).toBe(false);
  act(() => m.value.returnAsYourself!());
  expect(seam.getSnapshot()).toBeGreaterThan(old); expect(seam.admitted("owner", "installer")).toBe(true);
  expect(sessionStorage.getItem("infinity.viewAsRole")).toBeNull(); expect(sessionStorage.getItem("infinity.viewAsPerson")).toBeNull();
  act(() => m.value.setPreviewRole("owner")); expect(m.value.previewRole).toBeNull(); expect(sessionStorage.getItem("infinity.viewAsRole")).toBeNull();
});
it("failed clearing cannot authorize while a stored person lens survives", () => {
  sessionStorage.setItem("infinity.viewAsPerson", JSON.stringify({ id: "person", name: "Private", role: "installer" }));
  const m = mount("installer"), seam = m.value.sensitiveLifetime!, old = seam.getSnapshot();
  const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => { throw new Error("Unavailable"); });
  act(() => m.value.returnAsYourself!());
  expect(seam.getSnapshot()).toBeGreaterThan(old); expect(seam.admitted("owner", "installer")).toBe(false); remove.mockRestore();
});
