// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ReportingMultiSelect } from "./ReportingMultiSelect";

it("shows removable tabs, normalizes all/empty to no filter, and supports bulk selection without action buttons", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const [value, setValue] = useState<string[] | null>([]);
    return <><ReportingMultiSelect label="Floor" options={[{ key:"1",label:"First" },{ key:"2",label:"Second" }]} value={value} onChange={setValue} /><output>{JSON.stringify(value)}</output></>;
  }
  try {
    await act(async () => root.render(<Harness />));
    const all = host.querySelector<HTMLInputElement>('[aria-label="Select/deselect all Floor"]')!;
    const options = host.querySelectorAll<HTMLInputElement>('.report-multi-options input');
    expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(host.querySelectorAll('.report-multi-popover button')).toHaveLength(0);
    await act(async () => options[0].click());
    expect(all.indeterminate).toBe(true);
    expect(host.querySelector('output')?.textContent).toBe('["1"]');
    expect(host.querySelector('[aria-label="Remove Floor First"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove Floor First"]')!.click());
    expect(host.querySelector('output')?.textContent).toBe('null');
    expect(host.querySelector('summary')?.textContent).toContain('All');
    await act(async () => all.click());
    expect([...options].every(option => option.checked)).toBe(true);
    expect(host.querySelector('output')?.textContent).toBe('null');
    await act(async () => all.click());
    expect([...options].every(option => !option.checked)).toBe(true);
    expect(host.querySelector('output')?.textContent).toBe('null');
    await act(async () => options[0].click());
    await act(async () => options[1].click());
    expect(host.querySelector('output')?.textContent).toBe('null');
    expect(host.querySelector('.report-selection-tags')).toBeNull();
    await act(async () => options[1].click());
    expect(host.querySelector('[aria-label="Remove Floor First"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
