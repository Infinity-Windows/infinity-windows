// Recent trucks, newest first: each delivery is a standby list with an
// against-the-list score — expected vs arrived — linking to its tailgate
// screen.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { supabase } from "../../lib/supabase";
import { listDeliveries } from "../../lib/storage";

export function DeliveriesList() {
  const deliveries = useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries });
  const counts = useQuery({
    queryKey: ["deliveryCounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("packages")
        .select("delivery_id, status")
        .not("delivery_id", "is", null);
      if (error) throw error;
      const byDelivery = new Map<string, { expected: number; arrived: number }>();
      for (const row of data ?? []) {
        const d = row.delivery_id as string;
        const c = byDelivery.get(d) ?? { expected: 0, arrived: 0 };
        c.expected += 1;
        if (row.status !== "minted" && row.status !== "blank") c.arrived += 1;
        byDelivery.set(d, c);
      }
      return byDelivery;
    },
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Deliveries</h1>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>
      <ul className="unit-list">
        {(deliveries.data ?? []).map((d) => {
          const c = counts.data?.get(d.id);
          const line = c
            ? c.arrived >= c.expected
              ? `all ${c.expected} arrived`
              : `${c.arrived} of ${c.expected} arrived`
            : "…";
          return (
            <li key={d.id}>
              <Link to={`/storage/d/${d.id}`} className="project-card home-project">
                <div className="home-project-head">
                  <strong>{d.label ?? "Delivery"}</strong>
                  <span className="muted">
                    {d.arrived_on ?? ""} · {line} ›
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {(deliveries.data ?? []).length === 0 && (
        <p className="muted">
          No deliveries yet. Log one from the warehouse page before the truck
          comes.
        </p>
      )}
    </div>
  );
}
