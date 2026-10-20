import {registerCatalog} from "./catalog";
import type {CatalogEntry} from "./translate";
export const CLOCK_READ_CATALOG={
 "clockRead.checking":{en:"Checking your clock",es:"Verificando tu reloj"},
 "clockRead.unavailable":{en:"Cannot check your clock",es:"No se puede verificar tu reloj"},
 "clockRead.checkingBody":{en:"Checking Forge for your current shift. Your saved punches stay on this phone.",es:"Estamos consultando tu turno actual en Forge. Tus marcajes guardados se conservan en este teléfono."},
 "clockRead.body":{en:"We could not confirm your current shift. Your saved punches are kept. Check again before changing this clock.",es:"No pudimos confirmar tu turno actual. Tus marcajes guardados se conservan. Verifica de nuevo antes de cambiar este reloj."},
 "clockRead.saved":{en:"Saved clock",es:"Reloj guardado"},
 "clockRead.savedBody":{en:"Showing the clock saved on this phone. We have not confirmed it with Forge yet. Offline punches are still saved.",es:"Se muestra el reloj guardado en este teléfono. Aún no lo confirmamos con Forge. Los marcajes sin conexión siguen guardándose."},
 "clockRead.retry":{en:"Check again",es:"Verificar de nuevo"},
 "clockRead.diagnostics":{en:"Open diagnostics",es:"Abrir diagnóstico"},
} as const satisfies Record<string,CatalogEntry>;
export type ClockReadKey=keyof typeof CLOCK_READ_CATALOG;
registerCatalog(CLOCK_READ_CATALOG);
