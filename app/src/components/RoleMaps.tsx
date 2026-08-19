import { useMemo } from "react";
import { type CrewRole } from "../lib/install/types";
import { roleRank } from "../lib/nav";
import { ROLE_FLOWS } from "../lib/roleFlow";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { Explain } from "./ui/Explain";
import { RoleMap } from "./RoleMap";

/**
 * The role maps (owner ask, 2026-08-18): how your day works, drawn in the
 * package map's grammar and collapsible the same way. Your own role's map
 * leads; leads also get the maps of every role they run, since a foreman
 * runs installers and a supervisor runs both. Every door a map names is
 * test-proven openable by that role (roleFlow.test.ts).
 *
 * Lives on whichever page a role lands on at "/" — My Work for installers,
 * Home for foremen, Heartbeat for supervisors and owners (see RoleLanding in
 * App.tsx). All three, or somebody's role never sees its map.
 */
export function RoleMaps() {
  const { effectiveRole: role } = useEffectiveRole();
  const flows = useMemo(() => {
    if (!role) return [];
    const mine = ROLE_FLOWS.filter(
      (f) => roleRank(f.role) <= roleRank(role as CrewRole),
    );
    return [...mine].sort((a, b) => roleRank(b.role) - roleRank(a.role));
  }, [role]);
  if (flows.length === 0) return null;
  return (
    <>
      {flows.map((f, i) => (
        <Explain
          key={f.role}
          id={`role-map-${f.role}`}
          summary={i === 0 ? "How your day works" : f.title}
          raw
        >
          <RoleMap flow={f} />
        </Explain>
      ))}
    </>
  );
}
