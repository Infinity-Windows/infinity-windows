import type { CrewRole } from "./install/types";
import { ROLE_LABELS } from "./install/types";
import { bottomBarForRole, canAccess, menuForRole, NAV } from "./nav";

/**
 * Generates docs/role-access.md straight from the NAV registry so the
 * human-readable spec of "what each role sees and can reach" is always in sync
 * with the code. A snapshot test (roleAccessDoc.test.ts) fails if this output
 * ever drifts from the committed file.
 */

const ROLES: CrewRole[] = ["installer", "foreman", "supervisor", "owner"];

export function generateRoleAccessDoc(): string {
  const lines: string[] = [];
  lines.push("# Role access matrix");
  lines.push("");
  lines.push(
    "_Auto-generated from `app/src/lib/nav.ts`. Do not edit by hand — run " +
      "`npx tsx app/scripts/gen-role-access.ts` (or `UPDATE_DOCS=1 npx vitest run roleAccessDoc`) " +
      "to regenerate. A snapshot test fails if this file drifts from the code._",
  );
  lines.push("");

  for (const role of ROLES) {
    lines.push(`## ${ROLE_LABELS[role]}`);
    lines.push("");

    lines.push("**Bottom bar (phone):**");
    lines.push("");
    for (const tab of bottomBarForRole(role)) {
      if (tab.kind === "menu") lines.push("- Menu (opens the drawer)");
      else if (tab.kind === "capture") lines.push("- Capture (quick-capture sheet)");
      else if (tab.kind === "clock") lines.push("- Clock (time tracking sheet)");
      else lines.push(`- ${tab.label} (\`${tab.to}\`)`);
    }
    lines.push("");

    lines.push("**Menu drawer:**");
    lines.push("");
    const menuItems = menuForRole(role).flatMap((s) => s.items);
    if (menuItems.length === 0) {
      lines.push("- _(none)_");
    } else {
      for (const item of menuItems) {
        if (item.to) lines.push(`- ${item.label} (\`${item.to}\`)`);
        else lines.push(`- ${item.label} (action)`);
      }
    }
    lines.push("");

    const reachable = NAV.filter((d) => canAccess(role, d.to));
    lines.push(`**Can reach (all ${reachable.length} allowed destinations):**`);
    lines.push("");
    for (const d of reachable) {
      lines.push(`- ${d.label} (\`${d.to}\`)`);
    }
    lines.push("");

    const blocked = NAV.filter((d) => !canAccess(role, d.to));
    lines.push("**Blocked:**");
    lines.push("");
    if (blocked.length === 0) {
      lines.push("- _(nothing — full access)_");
    } else {
      for (const d of blocked) {
        lines.push(`- ${d.label} (\`${d.to}\`)`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
