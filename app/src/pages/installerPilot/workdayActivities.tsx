export { ActivityIcon } from "../../components/projects/ActivityIcon";
const SPANISH: Record<string, string> = {
 "Operating machinery": "Operar maquinaria", "Waiting / blocked": "Espera / bloqueo", "Consulting / planning": "Consulta / planificación",
 "Setup": "Preparación", "Loading product": "Cargar material", "Travel": "Traslado", "Travel with product": "Traslado con material", "Unloading product": "Descargar material", "Hauling": "Acarreo", "Safety / game plan": "Seguridad y plan del día", "Pre-planning": "Planificación", "Cleanup": "Limpieza",
 "Staging": "Organizar material", "RO checked": "Revisar vano", "Flashing": "Impermeabilizar vano", "Setting frame": "Colocar marco", "Sealing": "Sellar", "QC / adjustments": "Revisión y ajustes", "Repairs": "Reparaciones", "RO framing": "Preparar vano", "Problem-solving": "Resolver problemas",
 "Company delivery": "Entrega de la empresa", "Container unloading": "Descargar contenedor", "Warehouse work": "Trabajo en almacén", "Equipment / yard": "Equipo y patio", "Training": "Capacitación", "Other company work": "Otro trabajo de la empresa",
};
export const activityLabel = (name: string, es: boolean) => es ? SPANISH[name] ?? name : name;
