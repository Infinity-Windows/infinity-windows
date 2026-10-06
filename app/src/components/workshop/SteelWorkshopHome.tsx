// Forge Workshop only: the approved "steel" look (Forge-Steel-Homepage
// 2026-10-05) laid over the REAL app. Everything in this file is loaded
// through a lazy import that only exists when `import.meta.env.MODE ===
// "workshop"`, so a production build never emits this chunk or its CSS.
//
// What this is NOT: the prototype's sample data. Every number, name and
// clock state here comes from the same queries the classic screens use, and
// every shortcut is filtered by the same `canAccess` registry the route guards
// use. Where the prototype showed a figure that needs a join no screen
// already makes ("3 of 5 on site", "12 orders ready"), it is left out rather
// than invented. The clock is never punched from here: the workday card
// opens the real clock sheet or sends the person to Work, where Start day
// lives.

import "./steelWorkshop.css";
import { useEffect, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Boxes,
  BriefcaseBusiness,
  CalendarDays,
  ClipboardList,
  Clock as ClockIcon,
  Coffee,
  HeartPulse,
  Menu as MenuIcon,
  NotebookPen,
  Settings as SettingsIcon,
  Sparkles,
  Smartphone,
  Timer,
  TriangleAlert,
  Users,
} from "lucide-react";
import { getMyProfile } from "../../lib/install/api";
import { useClock } from "../../lib/clockContext";
import { useLanguage } from "../../lib/i18n";
import { canAccess, type RoutePath } from "../../lib/nav";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { ClockBadge } from "../clock/ClockBadge";
import { SyncStatusPill } from "../offline/SyncStatusPill";
import logoUrl from "./forge-steel-logo.jpg";

const LOGO_SRC = logoUrl;

/**
 * Puts the steel palette on the document while the workshop shell is mounted.
 *
 * The steel look is a dark one, so the dark token set (job tints, stage
 * colours, component rules keyed on `[data-theme="dark"]`) is switched on with
 * it; the person's own theme choice is put back when the shell unmounts.
 * Also measures the fixed WORKSHOP banner vite injects (vite.config.ts), so
 * the shell starts below it instead of underneath — the banner lets taps
 * through, but a control hidden under a stripe is still a control nobody
 * can see.
 */
function useSteelDocument() {
  useEffect(() => {
    const root = document.documentElement;
    let previousTheme = root.dataset.theme;
    root.dataset.forgeSteel = "on";
    root.dataset.theme = "dark";
    const banner = document.getElementById("forge-workshop-banner");
    const setInset = () =>
      root.style.setProperty("--steel-banner-h", `${Math.ceil(banner?.getBoundingClientRect().height ?? 0)}px`);
    setInset();
    const observer = banner && typeof ResizeObserver !== "undefined" ? new ResizeObserver(setInset) : null;
    if (banner) observer?.observe(banner);
    window.addEventListener("resize", setInset);
    const themeObserver = new MutationObserver(() => {
      if (root.dataset.theme !== "dark") {
        previousTheme = root.dataset.theme;
        root.dataset.theme = "dark";
      }
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer?.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("resize", setInset);
      delete root.dataset.forgeSteel;
      root.style.removeProperty("--steel-banner-h");
      if (previousTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previousTheme;
    };
  }, []);
}

/**
 * The steel top bar. Phones: menu, centred logo, clock corner. Desktop: Ask,
 * clock corner and sync status on the right; the logo lives in the sidebar.
 * The clock corner is the real `ClockBadge` — it renders only while a shift is
 * open and opens the same clock sheet (break / clock out) as every other door.
 */
export function SteelTopbar({
  phone,
  menuOpen,
  onOpenMenu,
}: {
  phone: boolean;
  menuOpen: boolean;
  onOpenMenu: () => void;
}) {
  useSteelDocument();
  const es = useLanguage().lang === "es";
  const embedded = window.self !== window.top;
  return (
    <>
    <header className={`steel-topbar${phone ? " steel-topbar--phone" : ""}`}>
      {phone && (
        <button
          type="button"
          className="steel-icon-button"
          aria-label={es ? "Abrir menú" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={onOpenMenu}
        >
          <MenuIcon size={20} aria-hidden />
        </button>
      )}
      {phone && (
        <Link to="/" className="steel-mobile-brand" aria-label="Forge Windows and Doors home">
          <img src={LOGO_SRC} alt="Forge Windows and Doors" />
        </Link>
      )}
      {!phone && <div className="steel-top-spacer" />}
      {!phone && !embedded && (
        <a href={`${import.meta.env.BASE_URL}workshop-phone.html`} className="steel-outline-button">
          <Smartphone size={18} aria-hidden /> {es ? "Vista de teléfono" : "Phone view"}
        </a>
      )}
      {!phone && (
        <Link to="/ask" className="steel-outline-button">
          <Sparkles size={18} aria-hidden />
          <span>{es ? "Preguntar a Forge AI" : "Ask Forge AI"}</span>
        </Link>
      )}
      <div className="steel-clock-corner">
        <ClockBadge />
        <SyncStatusPill />
      </div>
    </header>
    {/* Honest progress line: the redesigned activity timers and Data are
        being integrated separately; nothing here pretends they shipped. */}
    <p className="steel-progress-note" role="note">
      {es
        ? "Vista del taller · Los temporizadores de actividad y Datos se están conectando."
        : "Workshop preview · Activity timers and Data are being connected."}
      {phone && !embedded && <a className="steel-preview-link" href={`${import.meta.env.BASE_URL}workshop-phone.html`}>{es ? "Vista de teléfono" : "Phone view"}</a>}
    </p>
    </>
  );
}

/** The sidebar's silver logo — same image the phone top bar uses. */
export function SteelBrand() {
  return (
    <Link to="/" className="steel-brand" aria-label="Forge Windows and Doors home">
      <img src={LOGO_SRC} alt="Forge Windows and Doors" />
    </Link>
  );
}

type Shortcut = {
  to: RoutePath | "/work";
  /** Registry path the shortcut is gated on (same rule as the route guard). */
  gate: RoutePath;
  Icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  en: [string, string];
  es: [string, string];
};

// Only destinations that already exist as real screens. Order is the
// prototype's: everyday first, then the office's deeper tools.
const SHORTCUTS: Shortcut[] = [
  { to: "/my-schedule", gate: "/my-schedule", Icon: CalendarDays, en: ["Schedule", "The days ahead, job and start time together"], es: ["Horario", "Los próximos días, con trabajo y hora"] },
  { to: "/projects", gate: "/projects", Icon: BriefcaseBusiness, en: ["Jobs", "Every job, its units and plans"], es: ["Trabajos", "Cada trabajo, sus unidades y planos"] },
  { to: "/warehouse", gate: "/warehouse", Icon: Boxes, en: ["Warehouse", "Stock, movements and job materials"], es: ["Almacén", "Inventario, movimientos y materiales"] },
  { to: "/team", gate: "/team", Icon: Users, en: ["Team", "Who is on the crew and what they do"], es: ["Equipo", "Quién está en el equipo"] },
  { to: "/heartbeat", gate: "/heartbeat", Icon: HeartPulse, en: ["Heartbeat", "The pulse of every active job"], es: ["Pulso", "El pulso de cada trabajo activo"] },
  { to: "/team-timecards", gate: "/team-timecards", Icon: Timer, en: ["Timecards", "Review the crew's hours"], es: ["Tarjetas de tiempo", "Revisar las horas del equipo"] },
  { to: "/data", gate: "/data", Icon: BarChart3, en: ["Data & reports", "Project time, unit work and reports"], es: ["Datos e informes", "Tiempo, unidades e informes"] },
  { to: "/daily-logs", gate: "/daily-logs", Icon: NotebookPen, en: ["Daily logs", "What happened on site, by day"], es: ["Registros diarios", "Lo que pasó en obra, por día"] },
  { to: "/issues", gate: "/issues", Icon: TriangleAlert, en: ["Issues", "Problems waiting on a decision"], es: ["Problemas", "Asuntos que esperan decisión"] },
  { to: "/scheduling", gate: "/scheduling", Icon: ClipboardList, en: ["Scheduling", "Plan and publish crew work"], es: ["Programación", "Planear y publicar el trabajo"] },
  { to: "/settings", gate: "/settings", Icon: SettingsIcon, en: ["Settings", "Language, design and this phone"], es: ["Ajustes", "Idioma, diseño y este teléfono"] },
];

function greeting(es: boolean, hour: number): string {
  if (es) return hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/**
 * The owner / supervisor steel home. Installers and foremen land straight on
 * Work (App.tsx); this page is the office's front door, with Work one tap away.
 */
export function SteelWorkshopHome() {
  const es = useLanguage().lang === "es";
  const { effectiveRole: role, grants } = useEffectiveRole();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const clock = useClock();
  const shift = clock.shift;
  const onBreak = Boolean(shift?.break_started_at);
  const now = new Date();
  const firstName = me.data?.display_name?.trim().split(/\s+/)[0];
  const dateLine = now.toLocaleDateString(es ? "es" : undefined, { weekday: "long", month: "long", day: "numeric" });
  const shortcuts = SHORTCUTS.filter((s) => canAccess(role, s.gate, grants));
  const inAt = shift
    ? new Date(shift.clock_in_at).toLocaleTimeString(es ? "es" : undefined, { hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div className="page steel-home">
      <div className="steel-heading">
        <div>
          <p className="steel-eyebrow">{dateLine}</p>
          <h1>
            {greeting(es, now.getHours())}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="steel-subtitle">{es ? "Un comienzo claro para el día." : "A clear start to the workday."}</p>
        </div>
      </div>

      <div className="steel-grid-main">
        <article className="steel-card">
          <div className="steel-card-head">
            {onBreak ? <Coffee size={18} aria-hidden /> : <ClockIcon size={18} aria-hidden />}
            {es ? "Tu jornada" : "Your workday"}
          </div>
          <div className="steel-focus-body">
            <div className="steel-window-art" aria-hidden><span className="steel-sill" /></div>
            <div className="steel-focus-copy">
              {clock.loading ? (
                <>
                  <h2>{es ? "Revisando tu reloj…" : "Checking your clock…"}</h2>
                  <p>{es ? "Un momento." : "One moment."}</p>
                </>
              ) : shift ? (
                <>
                  <h2>{onBreak ? (es ? "En descanso" : "On break") : (es ? "En el reloj" : "On the clock")}</h2>
                  <p>{es ? `Entraste a las ${inAt}.` : `Clocked in at ${inAt}.`}</p>
                  <button type="button" className="steel-primary-button" onClick={clock.openClock}>
                    {es ? "Descanso o salida" : "Break or clock out"} <ArrowRight size={18} aria-hidden />
                  </button>
                </>
              ) : (
                <>
                  <h2>{es ? "¿Listo para hoy?" : "Ready for today?"}</h2>
                  <p>{es ? "Tu turno, tu trabajo y la charla de seguridad están en Trabajo." : "Your shift, job and toolbox talk are on Work."}</p>
                </>
              )}
              <Link to="/work" className={shift ? "steel-outline-button steel-wide" : "steel-primary-button steel-wide"}>
                {es ? "Abrir Trabajo" : "Open Work"} <ArrowRight size={18} aria-hidden />
              </Link>
            </div>
          </div>
        </article>

        <article className="steel-card steel-ask-card">
          <div className="steel-card-head">
            <Sparkles size={18} aria-hidden />
            Ask Forge AI
          </div>
          <div className="steel-card-body">
            <div className="steel-ask-preview">
              <strong>{es ? "¿Necesitas ayuda?" : "Need a hand?"}</strong>
              <p>
                {es
                  ? "Abre Preguntar para explorar la pantalla. Las respuestas de IA aún no están conectadas en este taller."
                  : "Open Ask to explore the screen. AI responses are not connected in this workshop yet."}
              </p>
            </div>
            <Link to="/ask" className="steel-outline-button steel-wide">
              <Sparkles size={18} aria-hidden /> {es ? "Preguntar a Forge AI" : "Ask Forge AI"}
            </Link>
          </div>
        </article>
      </div>

      <p className="steel-section-caption">{es ? "Espacio de trabajo" : "Workspace"}</p>
      <nav className="steel-shortcuts" aria-label={es ? "Accesos directos" : "Shortcuts"}>
        {shortcuts.map(({ to, Icon, en, es: esCopy }) => {
          const [title, detail] = es ? esCopy : en;
          return (
            <Link key={to} to={to} className="steel-card steel-shortcut">
              <span className="steel-shortcut-icon"><Icon size={20} aria-hidden /></span>
              <span className="steel-shortcut-copy">
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
              <ArrowRight size={18} aria-hidden className="steel-shortcut-arrow" />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
