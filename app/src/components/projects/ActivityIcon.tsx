import { Boxes, BrushCleaning, ClipboardCheck, HardHat, Package, Timer, Truck, Warehouse, Wrench } from "lucide-react";
/** A shared opening silhouette with a different symbol for each installation task. */
export function ActivityIcon({ activity }: { activity: string }) {
 const opening = ["RO checked", "Flashing", "Setting frame", "Sealing", "QC / adjustments", "RO framing"].includes(activity);
 if (opening) return <svg width="36" height="36" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
   <path d="M8 6h16v22H8z" />
   {activity === "RO checked" && <path d="M3 6v22M1 6h4M1 28h4M8 2h16M8 1v3M24 1v3M12 12h8M12 17h5"/>}
   {activity === "Flashing" && <path d="M5 28V3h22v25M5 25h5M22 25h5m-10-15 3-3 3 3M15 7v10"/>}
   {activity === "Setting frame" && <path d="M11 9h10v16H11zM1 16h6m-3-3 3 3-3 3M31 16h-6m3-3-3 3 3 3"/>}
   {activity === "Sealing" && <><path d="M11 9h10v16H11z" strokeDasharray="2 3"/><path d="m25 23 4-4 2 2-4 4-3 1z"/></>}
   {activity === "QC / adjustments" && <path d="m11 16 4 4 7-8" strokeWidth="2.5"/>}
   {activity === "RO framing" && <path d="M11 9h10v16H11zM8 11h3m10 0h3M8 23h3m10 0h3"/>}
 </svg>;
 const Icon = activity === "Waiting / blocked" ? Timer : activity === "Cleanup" ? BrushCleaning : /delivery|Travel/.test(activity) ? Truck : /Warehouse|yard/.test(activity) ? Warehouse : /Loading|Unloading|Hauling|Container|Staging/.test(activity) ? Boxes : /Safety|Training|planning|Consulting/.test(activity) ? ClipboardCheck : /Repair|Problem/.test(activity) ? Wrench : activity === "Setup" ? HardHat : Package;
 return <Icon size={36} aria-hidden="true" />;
}
