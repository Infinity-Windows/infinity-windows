import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generateRoleAccessDoc } from "../src/lib/roleAccessDoc";

// Emits the living role-access matrix from the NAV registry.
// Run: npx tsx app/scripts/gen-role-access.ts
const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/role-access.md",
);
writeFileSync(outPath, generateRoleAccessDoc());
// eslint-disable-next-line no-console
console.log(`Wrote ${outPath}`);
