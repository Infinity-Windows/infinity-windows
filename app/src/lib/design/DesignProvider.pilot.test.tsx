// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../signedIn";
import { classicDesignSettled } from "../work/scheduleStartWorkIntent";
import { DesignProvider } from "./DesignProvider";
import { useDesign } from "./context";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const OWNER = "00000000-0000-4000-8000-000000000101";
let admitted = false;
let ready = true;
let savedChoice = "new";
const writeChoice = vi.fn(async (_choice: string) => {});
vi.mock("./useRedesignPilot", () => ({ useRedesignPilotState: () => ({ admitted, ready }) }));
vi.mock("../install/api", () => ({
  getRealProfile: async () => ({ id: OWNER, role: "owner", ui_design: savedChoice }),
  setMyUiDesign: (choice: string) => writeChoice(choice),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient | null = null;
let design = "";
let masterOn: boolean | null = null;
let choose: (value: "classic" | "new") => void = () => {};
function Reader() {
  const value = useDesign();
  design = value.design;
  masterOn = value.masterOn;
  choose = value.setChoice;
  return <span>{design}</span>;
}
async function mount() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={qc!}>
    <DesignProvider><Reader /></DesignProvider>
  </QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); qc?.clear();
  root = null; host = null; qc = null;
  admitted = false; ready = true; savedChoice = "new"; writeChoice.mockClear();
  rememberSignedIn(null); localStorage.clear();
});

describe("owner pilot front door", () => {
  it("does not use a shared-device new-design cache before account admission", async () => {
    localStorage.setItem("forge.design", "new");
    await mount();
    expect(design).toBe("classic");
    act(() => choose("new"));
    expect(writeChoice).not.toHaveBeenCalled();
  });

  it("does not discard a pending Start work intent while owner admission loads", async () => {
    ready = false;
    await mount();
    expect(design).toBe("classic");
    expect(masterOn).toBeNull();
    expect(classicDesignSettled({ choice: savedChoice, masterOn })).toBe(false);
  });

  it("lets the admitted owner see their new choice, then closes when admission ends", async () => {
    admitted = true;
    rememberSignedIn({ user: { id: OWNER } });
    await mount();
    expect(design).toBe("new");
    admitted = false;
    await act(async () => root!.render(<QueryClientProvider client={qc!}>
      <DesignProvider><Reader /></DesignProvider>
    </QueryClientProvider>));
    expect(design).toBe("classic");
  });
});
