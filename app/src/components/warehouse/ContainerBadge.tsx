// A container's stable color, derived from its serial (owner pick 5, W2) —
// no zone/color column exists on storage_containers, and this wave adds
// none. Decorative only: every call site already shows the container's name
// as text right beside the badge, so this never carries information alone.
import type { CSSProperties } from "react";
import { containerHue } from "../../lib/storage";

export function ContainerBadge({
  name,
  serial,
}: {
  name: string;
  serial: string;
}) {
  const initials = name.trim().slice(0, 2).toUpperCase() || "?";
  const style = { "--badge-hue": containerHue(serial) } as CSSProperties;
  return (
    <span className="container-badge" style={style} aria-hidden="true">
      {initials}
    </span>
  );
}
