import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateRoleAccessDoc } from "./roleAccessDoc";

// app/src/lib -> repo-root docs/role-access.md
const DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/role-access.md",
);

describe("role-access matrix doc", () => {
  it("stays in sync with the NAV registry", () => {
    const generated = generateRoleAccessDoc();
    // Set UPDATE_DOCS=1 to regenerate the committed doc after intentional changes.
    if (process.env.UPDATE_DOCS) {
      writeFileSync(DOC_PATH, generated);
    }
    const committed = readFileSync(DOC_PATH, "utf8");
    expect(generated).toBe(committed);
  });
});
