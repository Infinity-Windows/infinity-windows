import { useRef, useState, type ReactNode } from "react";

export function FloorIndex({ floors, children }: { floors: string[]; children: (currentFloor: number) => ReactNode }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [currentFloor, setCurrentFloor] = useState(0);

  function updateCurrentFloor(list: HTMLDivElement) {
    const top = list.getBoundingClientRect().top;
    let current = 0;
    for (const [index, section] of Array.from(list.children).entries()) {
      if (section.getBoundingClientRect().top > top + 1) break;
      current = index;
    }
    if (list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 1) {
      current = list.children.length - 1;
    }
    setCurrentFloor(current);
  }

  return <div className="jp-floor-browser">
    <nav aria-label="Jump to floor" className="jp-floor-index">
      {floors.map((floor, index) => <button type="button" key={floor}
        aria-label={`Jump to ${floor}`} aria-current={index === currentFloor ? "location" : undefined}
        onClick={() => {
          const list = listRef.current;
          const group = list?.children[index];
          if (list && group) {
            list.scrollTop += group.getBoundingClientRect().top - list.getBoundingClientRect().top;
            updateCurrentFloor(list);
          }
        }}>{floor.replace("Level ", "L").replace(/Unspecified floor|Floor unspecified/, "No floor")}</button>)}
    </nav>
    <div ref={listRef} className="jp-floor-list" onScroll={event => updateCurrentFloor(event.currentTarget)}>
      {children(currentFloor)}
    </div>
  </div>;
}

