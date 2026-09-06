# 03 — The yard: home page as a map of boxes

Status: ready-for-agent
Type: task
Size: L

## Build
- `/warehouse` becomes the yard: every box drawn as a box (kind-shaped: conex has a door end), sized by contents, striped by job colour; `@xyflow/react` + `react-zoom-pan-pinch`; drag once to match the real yard, positions saved on `storage_containers`.
- One Scan button, one Find bar, the next truck, three problem chips (loose, split, damaged) — the existing cards logic reduced to chips.
- Find's unit answer shows piece tiles and lights the box; "Walk me there" opens the box page with the third lit.
- Box page: front / middle / back thirds drawn from the door end; pieces as chips coloured by job; dropping a chip sets the area (`set_package_area`); the selection bar.

## Removes
Station strip, four count cards, container tiles, "How does tracking work?" fold, Testing section, Other tools fold. The 3D viewer stays as a link on boxes that have a shell.

## Test
Typing 16 lights exactly the boxes holding window 16's pieces; dropping a chip into "back" calls `set_package_area` with `back`.
