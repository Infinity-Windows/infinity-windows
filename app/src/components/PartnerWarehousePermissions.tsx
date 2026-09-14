import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WAREHOUSE_CAPABILITIES, listWarehousePermissions, setWarehousePermissions, type WarehouseCapability } from "../lib/stgWarehouse";
import { QueryError } from "./ui/States";
import { toastError } from "../lib/toast";
export function PartnerWarehousePermissions({ partner }: { partner: string }) {
  const client = useQueryClient();
  const permissions = useQuery({ queryKey: ["partnerWarehousePermissions"], queryFn: listWarehousePermissions });
  const mutation = useMutation({ mutationFn: (capabilities: WarehouseCapability[]) => setWarehousePermissions(partner, capabilities),
    onSuccess: () => client.invalidateQueries({ queryKey: ["partnerWarehousePermissions"] }), onError: (e) => toastError(e) });
  if (permissions.isError) return <QueryError error={permissions.error} onRetry={() => permissions.refetch()} label="Warehouse permissions unavailable" />;
  const allowed = permissions.data?.find(p => p.partner_profile_id === partner)?.capabilities ?? [];
  return <details style={{ marginTop: 12 }}><summary>Warehouse actions</summary><p className="muted">Applies only to this login's granted jobs. Leave unchecked for viewing access.</p>{WAREHOUSE_CAPABILITIES.map(([key,label]) => <label key={key} style={{ display: "flex", gap: 8, padding: "6px 0" }}><input type="checkbox" checked={allowed.includes(key)} disabled={permissions.isLoading || mutation.isPending} onChange={e => mutation.mutate(e.target.checked ? [...allowed,key] : allowed.filter(x => x !== key))} />{label}</label>)}</details>;
}
