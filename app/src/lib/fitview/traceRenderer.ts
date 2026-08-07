// @ts-nocheck
/*
 * The window-viewer prototype's plan tracer, ported. Same vendoring rules as
 * fitviewRenderer.ts: mechanical port, keep it diffable, fix bugs only.
 *
 * The tracer draws building footprints over a plan image, calibrates them
 * against a known dimension, drops numbered dots that snap to walls, and
 * submits a building + window placements. The host owns everything the
 * prototype's Sync layer did, injected via `shim`:
 *   planUrl                       - rendered planset page (data URL); absent
 *                                   shows the local file-load fallback
 *   dotSeed | dotSeed(planImg)    - { [unitId]: {x, y} } in PLAN-IMAGE
 *                                   pixels; a function receives the <img> so
 *                                   the host can scale normalized pins by the
 *                                   image's natural size
 *   pushOp({op: "building"|"upsert", ...}) - staged model writes
 *   done()                        - after submit/rescale; host persists staged
 *                                   ops and navigates
 *   toast(msg)
 */

import { elevationsOf } from "./fitviewRenderer";

const TEMPLATE = "\n<div class=\"app loading\">\n\n  <header class=\"titleblock\">\n    <div class=\"tb-row\">\n      <div>\n        <div class=\"tb-ref\" id=\"jobRef\"></div>\n        <div class=\"tb-addr\" id=\"jobAddr\"></div>\n      </div>\n      \n    </div>\n\n    \n    <div class=\"tabs\">\n      <button class=\"tab\" aria-selected=\"true\">Trace plan</button>\n    </div>\n  </header>\n\n  <div class=\"boot\" id=\"boot\">\n    <b>Loading job</b>\n    <span id=\"bootMsg\">Fetching schedule</span>\n  </div>\n\n  <section class=\"view\">\n    <div class=\"toolrow\">\n      <div class=\"seg\" role=\"group\" aria-label=\"Tool\">\n        <button data-mode=\"select\" aria-pressed=\"true\">Select</button>\n        <button data-mode=\"draw\" aria-pressed=\"false\">Draw</button>\n        <button data-mode=\"cal\" aria-pressed=\"false\">Calibrate</button>\n      </div>\n      <button class=\"mini\" id=\"closeShape\">Close shape</button>\n      <button class=\"mini\" id=\"undoPt\">Undo point</button>\n      <button class=\"mini\" id=\"undoAct\" disabled>Undo action</button>\n      <button class=\"mini\" id=\"delPt\" hidden>Delete point</button>\n      <button class=\"mini\" id=\"delBld\" hidden>Delete building</button>\n      <button class=\"mini\" id=\"removeDot\" hidden>Remove dot</button>\n      <button class=\"mini\" id=\"autoBtn\" hidden>Auto-place dots</button>\n      <span class=\"cal-lab\">Line =</span>\n      <input class=\"cal-in\" id=\"calM\" type=\"number\" step=\"0.1\" placeholder=\"ft\">\n      <div class=\"seg\" role=\"group\" aria-label=\"Units\">\n        <button type=\"button\" data-unit=\"ft\" aria-pressed=\"true\">ft</button>\n        <button type=\"button\" data-unit=\"m\" aria-pressed=\"false\">m</button>\n      </div>\n      <button class=\"mini\" id=\"rescaleBtn\" hidden>Rescale</button>\n      <button class=\"mini hot\" id=\"submitBtn\" style=\"margin-left:auto\">Submit</button>\n    </div>\n\n    <div class=\"tray\" id=\"tray\"><span class=\"tray-lab\">Drag onto a wall:</span></div>\n\n    <div class=\"tstage\" id=\"tstage\">\n      <div class=\"world\" id=\"world\">\n        <img id=\"plan\" alt=\"\">\n        <svg id=\"ol\" xmlns=\"http://www.w3.org/2000/svg\"></svg>\n      </div>\n      <div class=\"noplan\" id=\"noplan\" hidden>\n        <span>No plan image on this job yet</span>\n        <label class=\"pbtn\">Load plan image\n          <input id=\"planFile\" type=\"file\" accept=\"image/*\" hidden>\n        </label>\n      </div>\n    </div>\n\n    <div class=\"hint\" style=\"padding:8px 16px;font-family:var(--f-mono);font-size:9px;letter-spacing:0.07em;text-transform:uppercase;color:var(--ink-3)\" id=\"hint\">\n      Draw: tap to add points, tap the first point to close &middot; Select: drag points and dots &middot; pinch or scroll to zoom\n    </div>\n  </section>\n\n  <div class=\"foot\">\n    Trace the outside walls &middot; each closed shape is one building &middot; dots snap to the nearest wall\n  </div>\n\n  <div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n</div>\n";

export function mountTracePlan(host, job, shim) {
  var SHIM = shim || {};
  if (!SHIM.toast) SHIM.toast = function () {};
  if (!SHIM.pushOp) SHIM.pushOp = function () {};
  if (!SHIM.done) SHIM.done = function () {};
  host.innerHTML = TEMPLATE;
  var ROOT = host;
  var cleanups = [];
  function onDoc(ev, fn, opts) {
    document.addEventListener(ev, fn, opts);
    cleanups.push(function () { document.removeEventListener(ev, fn, opts); });
  }

  "use strict";

  var $ = function (id) { return ROOT.querySelector("#" + id); };


  var JOB = null;
  var tstage = $("tstage"), world = $("world"), ol = $("ol"), plan = $("plan");

  var view = { x: 0, y: 0, k: 1 };
  var mode = "select";
  var calUnit = "ft";

  function setUnit(u) {
    calUnit = u === "m" ? "m" : "ft";
    Array.prototype.forEach.call(document.querySelectorAll("[data-unit]"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.unit === calUnit));
    });
    $("calM").placeholder = calUnit;
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-unit]"), function (b) {
    b.addEventListener("click", function () { setUnit(b.dataset.unit); });
  });

  function calMetres(v) { return calUnit === "ft" ? v * 0.3048 : v; }
  var polys = [];              // [{pts:[{x,y}], closed:bool}] in plan-image px
  var cal = { a: null, b: null };
  var dots = {};               // opening id -> {x, y} in plan px (snapped), once placed
  var selV = null;             // {p, i} selected vertex
  var selDot = null;           // selected placed dot id

  /* ---------- action-level undo ----------
     One snapshot per user-sized action: a whole auto-place, a whole drag,
     one deletion, one drawn point. "Undo action" walks back changes the
     size a person thinks in - so a regretted auto-place of forty dots is
     one tap, not forty. The in-draw "Undo point" stays for fine control
     (and is itself undoable). Snapshots are taken BEFORE the mutation. */
  var history = [];
  function snapshot() {
    history.push(JSON.stringify({ polys: polys, dots: dots, cal: cal }));
    if (history.length > 60) history.shift();
    $("undoAct").disabled = false;
  }
  /* An action that turned out to change nothing should not cost an undo
     step; callers that can tell (auto-place with 0 placed) drop it. */
  function dropSnapshot() {
    history.pop();
    if (!history.length) $("undoAct").disabled = true;
  }
  function undoAction() {
    var last = history.pop();
    if (!last) return;
    var s = JSON.parse(last);
    polys = s.polys;
    dots = s.dots;
    cal = s.cal;
    selV = null;
    selDot = null;
    $("delPt").hidden = true;
    $("delBld").hidden = true;
    $("removeDot").hidden = true;
    renderTray();
    redraw();
    if (!history.length) $("undoAct").disabled = true;
    SHIM.toast("Undone");
  }

  function applyView() {
    world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.k + ")";
  }

  function toWorld(cx, cy) {
    var r = tstage.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  }

  /* ---------- geometry helpers ---------- */

  function projectToSeg(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var L2 = dx * dx + dy * dy;
    if (!L2) return { x: a.x, y: a.y, t: 0, d: Math.hypot(p.x - a.x, p.y - a.y) };
    var t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    var q = { x: a.x + t * dx, y: a.y + t * dy };
    return { x: q.x, y: q.y, t: t, d: Math.hypot(p.x - q.x, p.y - q.y) };
  }

  function snapToWalls(p) {
    var best = null;
    polys.forEach(function (poly, pi) {
      if (!poly.closed) return;
      for (var i = 0; i < poly.pts.length; i++) {
        var a = poly.pts[i], b = poly.pts[(i + 1) % poly.pts.length];
        var pr = projectToSeg(p, a, b);
        if (!best || pr.d < best.d) best = { x: pr.x, y: pr.y, d: pr.d, poly: pi, edge: i };
      }
    });
    return best;
  }

  /* ---------- rendering ---------- */

  function redraw() {
    var s = [];
    var px = 1 / view.k;                       // keep handles finger-sized at any zoom

    polys.forEach(function (poly, pi) {
      if (!poly.pts.length) return;
      var d = "M" + poly.pts.map(function (p) { return p.x + " " + p.y; }).join(" L") +
              (poly.closed ? " Z" : "");
      s.push('<path d="' + d + '" fill="' + (poly.closed ? "rgba(232,93,11,0.08)" : "none") +
        '" stroke="var(--accent)" stroke-width="' + (3 * px) + '"/>');
      // fat invisible edge hit-targets for double-tap insert
      for (var i = 0; i < poly.pts.length - (poly.closed ? 0 : 1); i++) {
        var a = poly.pts[i], b = poly.pts[(i + 1) % poly.pts.length];
        s.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
          '" stroke="transparent" stroke-width="' + (18 * px) + '" data-edge="' + pi + "," + i + '"/>');
      }
      poly.pts.forEach(function (p, i) {
        var sel = selV && selV.p === pi && selV.i === i;
        s.push('<rect x="' + (p.x - 7 * px) + '" y="' + (p.y - 7 * px) +
          '" width="' + (14 * px) + '" height="' + (14 * px) +
          '" fill="' + (sel ? "var(--accent)" : "#fff") +
          '" stroke="var(--accent)" stroke-width="' + (2.5 * px) +
          '" data-v="' + pi + "," + i + '"/>');
        if (i === 0 && !poly.closed) {
          s.push('<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (13 * px) +
            '" fill="none" stroke="var(--accent)" stroke-dasharray="' + (4 * px) + '" stroke-width="' + px + '"/>');
        }
      });
    });

    if (cal.a) {
      s.push('<circle cx="' + cal.a.x + '" cy="' + cal.a.y + '" r="' + (6 * px) + '" fill="#c9a"/>');
      if (cal.b) {
        s.push('<line x1="' + cal.a.x + '" y1="' + cal.a.y + '" x2="' + cal.b.x + '" y2="' + cal.b.y +
          '" stroke="#c06" stroke-width="' + (2.5 * px) + '" stroke-dasharray="' + (8 * px) + '"/>');
        s.push('<circle cx="' + cal.b.x + '" cy="' + cal.b.y + '" r="' + (6 * px) + '" fill="#c9a"/>');
      }
    }

    Object.keys(dots).forEach(function (id) {
      var d = dots[id];
      var win = JOB.windows.filter(function (w) { return w.id === id; })[0];
      var col = win && win.door ? "var(--st-installed)" : "var(--st-tofit)";
      var ring = selDot === id
        ? '<circle cx="' + d.x + '" cy="' + d.y + '" r="' + (19 * px) +
          '" fill="none" stroke="var(--accent)" stroke-width="' + (3 * px) +
          '" stroke-dasharray="' + (6 * px) + '"/>'
        : '';
      s.push('<g data-dot="' + id + '">' + ring +
        '<circle cx="' + d.x + '" cy="' + d.y + '" r="' + (13 * px) +
        '" fill="' + col + '" stroke="' + (selDot === id ? "var(--accent)" : "#fff") +
        '" stroke-width="' + (2.5 * px) + '"/>' +
        '<text x="' + d.x + '" y="' + d.y + '" text-anchor="middle" dominant-baseline="central" ' +
        'fill="#fff" font-family="var(--f-mono)" font-weight="700" font-size="' + (11 * px) +
        '" style="pointer-events:none">' + id + '</text></g>');
    });

    ol.innerHTML = s.join("");
    $("delPt").hidden = !selV;
    $("delBld").hidden = !selV;
    $("removeDot").hidden = !selDot;
    if (!selV) delBldArm(false);
  }

  function renderTray() {
    var tray = $("tray");
    Array.prototype.slice.call(tray.querySelectorAll(".chip-dot")).forEach(function (c) { c.remove(); });
    JOB.windows.forEach(function (w) {
      var c = document.createElement("span");
      c.className = "chip-dot " + (w.door ? "d" : "w") + (dots[w.id] ? " placed" : "");
      c.textContent = w.id;
      c.dataset.tray = w.id;
      tray.appendChild(c);
    });
  }

  /* ---------- gestures ---------- */

  var pointers = {}, gesture = null, pinch = null, ghost = null;

  tstage.addEventListener("pointerdown", function (e) {
    try { tstage.setPointerCapture(e.pointerId); } catch (_) {}
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);

    if (ids.length === 2) {
      if (gesture) gesture.multi = true;
      var a = pointers[ids[0]], b = pointers[ids[1]];
      pinch = { d: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)),
                cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
                k: view.k, vx: view.x, vy: view.y };
      return;
    }

    var t = e.target;
    var g = { x: e.clientX, y: e.clientY, moved: 0, multi: false,
              vx: view.x, vy: view.y };
    if (t.dataset && t.dataset.v) {
      var pv = t.dataset.v.split(",");
      g.type = "vertex"; g.p = +pv[0]; g.i = +pv[1];
    } else if (t.closest && t.closest("[data-dot]")) {
      g.type = "dot"; g.id = t.closest("[data-dot]").dataset.dot;
    } else {
      g.type = "empty";
    }
    gesture = g;
  });

  tstage.addEventListener("pointermove", function (e) {
    if (!pointers[e.pointerId]) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);

    if (ids.length >= 2 && pinch) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
      var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      var nk = Math.max(0.05, Math.min(12, pinch.k * (d / pinch.d)));
      var k = nk / pinch.k;
      var r = tstage.getBoundingClientRect();
      var ox = pinch.cx - r.left, oy = pinch.cy - r.top;
      view.x = ox - k * (ox - pinch.vx) + (cx - pinch.cx);
      view.y = oy - k * (oy - pinch.vy) + (cy - pinch.cy);
      view.k = nk;
      applyView(); redraw();
      return;
    }

    if (!gesture || gesture.multi) return;
    var dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    gesture.moved = Math.max(gesture.moved, Math.abs(dx) + Math.abs(dy));

    if (gesture.type === "vertex") {
      // First real movement of a drag = one undo step for the whole drag.
      if (!gesture.snap) { snapshot(); gesture.snap = true; }
      var w = toWorld(e.clientX, e.clientY);
      polys[gesture.p].pts[gesture.i] = { x: w.x, y: w.y };
      redraw();
    } else if (gesture.type === "dot") {
      if (!gesture.snap) { snapshot(); gesture.snap = true; }
      var w2 = toWorld(e.clientX, e.clientY);
      var sn = snapToWalls(w2);
      dots[gesture.id] = sn ? { x: sn.x, y: sn.y } : { x: w2.x, y: w2.y };
      redraw();
    } else if (gesture.moved >= 8) {
      view.x = gesture.vx + dx;
      view.y = gesture.vy + dy;
      applyView();
    }
  });

  ["pointerup", "pointercancel"].forEach(function (ev) {
    tstage.addEventListener(ev, function (e) {
      delete pointers[e.pointerId];
      try { tstage.releasePointerCapture(e.pointerId); } catch (_) {}
      if (Object.keys(pointers).length < 2) pinch = null;
      var g = gesture;
      if (!Object.keys(pointers).length) gesture = null;
      if (!g || g.multi || ev !== "pointerup") return;

      if (g.type === "vertex" && g.moved < 5) {
        selV = (selV && selV.p === g.p && selV.i === g.i) ? null : { p: g.p, i: g.i };
        selDot = null;
        redraw();
        return;
      }
      if (g.type === "dot" && g.moved < 5) {
        selDot = (selDot === g.id) ? null : g.id;
        selV = null;
        redraw();
        return;
      }
      if (g.type !== "empty" || g.moved >= 8) return;

      var w = toWorld(e.clientX, e.clientY);
      if (mode === "draw") {
        var open = polys.filter(function (p) { return !p.closed; })[0];
        if (open && open.pts.length >= 3) {
          var first = open.pts[0];
          if (Math.hypot(w.x - first.x, w.y - first.y) < 16 / view.k) {
            snapshot();
            open.closed = true;
            SHIM.toast("Building " + polys.filter(function (p) { return p.closed; }).length + " closed");
            redraw();
            return;
          }
        }
        snapshot();
        if (!open) { open = { pts: [], closed: false }; polys.push(open); }
        open.pts.push({ x: w.x, y: w.y });
        redraw();
      } else if (mode === "cal") {
        snapshot();
        if (!cal.a || (cal.a && cal.b)) { cal.a = { x: w.x, y: w.y }; cal.b = null; }
        else cal.b = { x: w.x, y: w.y };
        redraw();
      } else {
        selV = null;
        selDot = null;
        redraw();
      }
    });
  });

  tstage.addEventListener("wheel", function (e) {
    e.preventDefault();
    var r = tstage.getBoundingClientRect();
    var ox = e.clientX - r.left, oy = e.clientY - r.top;
    var nk = Math.max(0.05, Math.min(12, view.k * Math.exp(-e.deltaY * 0.0018)));
    var k = nk / view.k;
    view.x = ox - k * (ox - view.x);
    view.y = oy - k * (oy - view.y);
    view.k = nk;
    applyView(); redraw();
  }, { passive: false });

  ol.addEventListener("dblclick", function (e) {
    var t = e.target;
    if (!t.dataset || !t.dataset.edge) return;
    var pe = t.dataset.edge.split(",");
    var poly = polys[+pe[0]];
    var i = +pe[1];
    var w = toWorld(e.clientX, e.clientY);
    var pr = projectToSeg(w, poly.pts[i], poly.pts[(i + 1) % poly.pts.length]);
    poly.pts.splice(i + 1, 0, { x: pr.x, y: pr.y });
    redraw();
  });

  /* ---------- tray drag ---------- */

  $("tray").addEventListener("pointerdown", function (e) {
    var chip = e.target.closest ? e.target.closest(".chip-dot") : null;
    if (!chip || chip.classList.contains("placed")) return;
    e.preventDefault();
    var id = chip.dataset.tray;
    var win = JOB.windows.filter(function (w) { return w.id === id; })[0];
    ghost = document.createElement("div");
    ghost.className = "ghost " + (win.door ? "chip-dot d" : "chip-dot w");
    ghost.style.position = "fixed";
    ghost.textContent = id;
    ghost.dataset.id = id;
    document.body.appendChild(ghost);
    ghost.style.left = e.clientX + "px";
    ghost.style.top = e.clientY + "px";

    function mv(ev2) { ghost.style.left = ev2.clientX + "px"; ghost.style.top = ev2.clientY + "px"; }
    function up(ev2) {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      var r = tstage.getBoundingClientRect();
      if (ev2.clientX >= r.left && ev2.clientX <= r.right &&
          ev2.clientY >= r.top && ev2.clientY <= r.bottom) {
        var w = toWorld(ev2.clientX, ev2.clientY);
        var sn = snapToWalls(w);
        snapshot();
        dots[id] = sn ? { x: sn.x, y: sn.y } : { x: w.x, y: w.y };
        renderTray(); redraw();
      }
      ghost.remove(); ghost = null;
    }
    onDoc("pointermove", mv);
    onDoc("pointerup", up);
  });

  /* ---------- toolbar ---------- */

  Array.prototype.forEach.call(document.querySelectorAll("[data-mode]"), function (b) {
    b.addEventListener("click", function () {
      mode = b.dataset.mode;
      Array.prototype.forEach.call(document.querySelectorAll("[data-mode]"), function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      $("hint").textContent =
        mode === "draw" ? "Tap to add wall points - tap the first point (or Close shape) to finish a building, then keep tapping to start the next" :
        mode === "cal" ? "Tap two points a known distance apart on the plan, then type the real distance in metres" :
        "Drag points and dots to adjust - tap one to select it, then Delete or Remove in the toolbar";
    });
  });

  $("closeShape").addEventListener("click", function () {
    var open = polys.filter(function (p) { return !p.closed; })[0];
    if (!open || open.pts.length < 3) { SHIM.toast("Need at least 3 points first"); return; }
    open.closed = true;
    SHIM.toast("Building " + polys.filter(function (p) { return p.closed; }).length + " closed");
    redraw();
  });

  $("undoPt").addEventListener("click", function () {
    var open = polys.filter(function (p) { return !p.closed; })[0];
    if (!open && !polys.length) return;
    snapshot();
    if (open && open.pts.length) {
      open.pts.pop();
      if (!open.pts.length) polys.splice(polys.indexOf(open), 1);
    } else if (polys.length) {
      polys[polys.length - 1].closed = false;   // reopen the last shape to edit
    }
    redraw();
  });

  $("delPt").addEventListener("click", function () {
    if (!selV) return;
    var poly = polys[selV.p];
    if (poly.closed && poly.pts.length <= 3) { SHIM.toast("A building needs at least 3 points"); return; }
    snapshot();
    poly.pts.splice(selV.i, 1);
    if (!poly.pts.length) polys.splice(selV.p, 1);
    selV = null;
    redraw();
  });

  /* Deleting a whole building is armed-then-confirmed, like the survey's
     opening delete: too big an action for one accidental tap. */
  function delBldArm(on) {
    var b = $("delBld");
    b.dataset.armed = on ? "1" : "0";
    b.textContent = on ? "Tap again to delete" : "Delete building";
    clearTimeout(delBldArm._t);
    if (on) delBldArm._t = setTimeout(function () { delBldArm(false); }, 3500);
  }

  $("delBld").addEventListener("click", function () {
    if (!selV) return;
    if ($("delBld").dataset.armed !== "1") { delBldArm(true); return; }
    snapshot();
    polys.splice(selV.p, 1);
    selV = null;
    delBldArm(false);
    SHIM.toast("Building deleted - its dots are still placed, remove or re-drag them");
    redraw();
  });

  $("removeDot").addEventListener("click", function () {
    if (!selDot) return;
    snapshot();
    delete dots[selDot];
    SHIM.toast(selDot + " back in the tray");
    selDot = null;
    renderTray();
    redraw();
  });

  /* Seed positions read from the numbered plan markup, so the dots start next
     to their numbers and only need a fine drag, not 40 hand placements. */
  var dotSeed = null;

  function loadDotSeed() {
    dotSeed = (typeof SHIM.dotSeed === "function" ? SHIM.dotSeed(plan) : SHIM.dotSeed) || null;
    $("autoBtn").hidden = !dotSeed;
  }

  $("autoBtn").addEventListener("click", function () {
    if (!dotSeed) return;
    snapshot();
    var placed = 0, skipped = 0;
    JOB.windows.forEach(function (w) {
      if (dots[w.id]) { skipped++; return; }           // never move a dot you placed
      var p = dotSeed[w.id];
      if (!p) return;
      var sn = snapToWalls({ x: p.x, y: p.y });
      dots[w.id] = sn ? { x: sn.x, y: sn.y } : { x: p.x, y: p.y };
      placed++;
    });
    // Placed nothing = changed nothing; don't charge an undo step for it.
    if (!placed) dropSnapshot();
    renderTray();
    redraw();
    SHIM.toast(placed + " dots placed from the plan numbers" +
      (skipped ? " (" + skipped + " already yours, untouched)" : "") +
      " - drag any that need a nudge");
  });

  // Desktop: Delete or Backspace removes whatever is selected.
  onDoc("keydown", function (e) {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    var a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    if (selDot) { e.preventDefault(); $("removeDot").click(); }
    else if (selV) { e.preventDefault(); $("delPt").click(); }
  });

  $("undoAct").addEventListener("click", undoAction);

  // Desktop: the undo everyone's hands already know.
  onDoc("keydown", function (e) {
    if (e.key !== "z" && e.key !== "Z") return;
    if (!e.metaKey && !e.ctrlKey) return;
    var a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    e.preventDefault();
    undoAction();
  });

  /* ---------- submit ---------- */

  function compassName(A, used) {
    var base = (A > -45 && A <= 45) ? "South" : (A > 45 && A <= 135) ? "East" :
               (A > -135 && A <= -45) ? "West" : "North";
    used[base] = (used[base] || 0) + 1;
    return used[base] > 1 ? base + " " + used[base] : base;
  }

  $("submitBtn").addEventListener("click", function () {
    var closed = polys.filter(function (p) { return p.closed && p.pts.length >= 3; });
    if (!closed.length) { SHIM.toast("Trace and close at least one building first"); return; }
    var mv = parseFloat($("calM").value);
    if (!cal.a || !cal.b || !(mv > 0)) { SHIM.toast("Calibrate first: two points + the real distance"); return; }
    var scale = calMetres(mv) / Math.hypot(cal.b.x - cal.a.x, cal.b.y - cal.a.y);   // metres per plan px

    // Global bbox centre so the model sits centred like every other job.
    var allPts = [];
    closed.forEach(function (p) { allPts = allPts.concat(p.pts); });
    var gx = allPts.map(function (p) { return p.x; });
    var gy = allPts.map(function (p) { return p.y; });
    var cx = (Math.min.apply(null, gx) + Math.max.apply(null, gx)) / 2;
    var cy = (Math.min.apply(null, gy) + Math.max.apply(null, gy)) / 2;

    var footprints = closed.map(function (poly) {
      var pts = poly.pts.map(function (p) {
        return { x: (p.x - cx) * scale, z: (p.y - cy) * scale };
      });
      // Our wall convention needs counter-clockwise in x-east / z-south.
      var area = 0;
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i], b = pts[(i + 1) % pts.length];
        area += a.x * b.z - b.x * a.z;
      }
      if (area > 0) pts.reverse();
      var used = {};
      return pts.map(function (p, i) {
        var b2 = pts[(i + 1) % pts.length];
        var A = Math.atan2(-(b2.z - p.z), b2.x - p.x) * 180 / Math.PI;
        return { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100,
                 name: compassName(A, used) };
      });
    });

    var probe = { building: { footprints: footprints } };
    var segs = elevationsOf(probe);

    var placed = Object.keys(dots);
    var moves = [];
    placed.forEach(function (id) {
      var win = JOB.windows.filter(function (w) { return w.id === id; })[0];
      if (!win) return;
      var pm = { x: (dots[id].x - cx) * scale, z: (dots[id].y - cy) * scale };
      var best = null;
      segs.forEach(function (s2) {
        var pr = projectToSeg({ x: pm.x, y: pm.z },
          { x: s2.x1, y: s2.z1 }, { x: s2.x2, y: s2.z2 });
        if (!best || pr.d < best.d) best = { seg: s2, t: pr.t, d: pr.d };
      });
      if (!best) return;
      var t = best.t * best.seg.len;
      var copy = JSON.parse(JSON.stringify(win));
      copy.elev = best.seg.key;
      if (win.legs && win.legs.length === 2) {
        // Corner unit: it wraps whichever end of this wall the dot is nearer,
        // and the longer leg goes on the longer of the two walls at that
        // corner - the plan drawings are all outside views, as is the model.
        var wrapEnd = t >= best.seg.len / 2;
        copy.wrap = wrapEnd ? "end" : "start";
        var vx = wrapEnd ? best.seg.x2 : best.seg.x1;
        var vz = wrapEnd ? best.seg.z2 : best.seg.z1;
        var adj2 = null;
        segs.forEach(function (s3) {
          if (s3 === best.seg || s3.poly !== best.seg.poly) return;
          var sx = wrapEnd ? s3.x1 : s3.x2, sz = wrapEnd ? s3.z1 : s3.z2;
          if (Math.abs(sx - vx) < 0.001 && Math.abs(sz - vz) < 0.001) adj2 = s3;
        });
        var lg = Math.max(win.legs[0], win.legs[1]);
        var sm = Math.min(win.legs[0], win.legs[1]);
        copy.legs = (!adj2 || best.seg.len >= adj2.len) ? [lg, sm] : [sm, lg];
        copy.x = wrapEnd
          ? Math.round(Math.max(0, best.seg.len - copy.legs[0] / 1000) * 100) / 100
          : 0;
      } else {
        var x = Math.max(0, Math.min(best.seg.len - win.w / 1000, t - win.w / 2000));
        copy.x = Math.round(x * 100) / 100;
      }
      moves.push(copy);
    });

    // Anything without a dot is deliberately off the model: unplace it
    // explicitly so a stale wall key can never drag it back onto a wall.
    var offModel = 0;
    JOB.windows.forEach(function (w) {
      if (dots[w.id]) return;
      var copy = JSON.parse(JSON.stringify(w));
      copy.elev = "";
      copy.x = 0;
      delete copy.wrap;
      moves.push(copy);
      offModel++;
    });

    var wAll = allPts.map(function (p) { return (p.x - cx) * scale; });
    var zAll = allPts.map(function (p) { return (p.y - cy) * scale; });
    var dotStore = {};
    Object.keys(dots).forEach(function (id) {
      dotStore[id] = { x: Math.round(dots[id].x * 10) / 10, y: Math.round(dots[id].y * 10) / 10 };
    });

    var bld = {
      width: Math.round((Math.max.apply(null, wAll) - Math.min.apply(null, wAll)) * 10) / 10,
      depth: Math.round((Math.max.apply(null, zAll) - Math.min.apply(null, zAll)) * 10) / 10,
      height: JOB.building.height || 4.7,
      rise: JOB.building.rise || 0,
      footprints: footprints,
      // The raw trace, in plan-image pixels, so this screen can restore your
      // outline and dots later - fix the calibration and resubmit, no redrawing.
      trace: {
        cal: { ax: Math.round(cal.a.x), ay: Math.round(cal.a.y),
               bx: Math.round(cal.b.x), by: Math.round(cal.b.y),
               value: mv, unit: calUnit },
        polys: closed.map(function (p) {
          return p.pts.map(function (q) {
            return { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 };
          });
        }),
        dots: dotStore
      }
    };

    SHIM.pushOp({ op: "building", building: bld });
    moves.forEach(function (w) { SHIM.pushOp({ op: "upsert", window: w }); });

    var placedN = moves.length - offModel;
    SHIM.toast(closed.length + (closed.length === 1 ? " building" : " buildings") +
      " traced, " + placedN + " openings placed" +
      (offModel ? " - " + offModel + " left off the model" : ""));
    setTimeout(function () {
      SHIM.done();
    }, 1200);
  });

  /* ---------- plan image ---------- */

  function fitPlan() {
    var r = tstage.getBoundingClientRect();
    if (!plan.naturalWidth) return;
    ol.setAttribute("width", plan.naturalWidth);
    ol.setAttribute("height", plan.naturalHeight);
    ol.setAttribute("viewBox", "0 0 " + plan.naturalWidth + " " + plan.naturalHeight);
    view.k = Math.min(r.width / plan.naturalWidth, r.height / plan.naturalHeight);
    view.x = (r.width - plan.naturalWidth * view.k) / 2;
    view.y = (r.height - plan.naturalHeight * view.k) / 2;
    applyView(); redraw();
  }

  function loadPlan() {
    // The host renders the planset page and hands it over; there is no
    // separate plan store to fetch from any more.
    if (!SHIM.planUrl) { $("noplan").hidden = false; return; }
    plan.onload = fitPlan;
    plan.src = SHIM.planUrl;
    $("noplan").hidden = true;
  }

  $("planFile").addEventListener("change", function () {
    var f = $("planFile").files[0];
    if (!f) return;
    plan.onload = fitPlan;
    plan.src = URL.createObjectURL(f);
    $("noplan").hidden = true;
  });

  window.addEventListener("resize", function () { /* keep current view */ });

  /* ---------- boot ---------- */

  function bootWithJob(job) {
    if (!job) {
      $("bootMsg").textContent = "Could not load the job";
      return;
    }
    JOB = job;
    $("boot").hidden = true;
    ROOT.querySelector(".app").classList.remove("loading");
    $("jobRef").textContent = JOB.ref;
    $("jobAddr").textContent = JOB.addr;

    // Restore a stored trace so the outline and dots come back editable:
    // change the calibration number and resubmit, nothing to redraw.
    var tr = JOB.building && JOB.building.trace;
    if (tr && tr.polys) {
      polys = tr.polys.map(function (pp) {
        return { pts: pp.map(function (q) { return { x: q.x, y: q.y }; }), closed: true };
      });
      Object.keys(tr.dots || {}).forEach(function (id) {
        dots[id] = { x: tr.dots[id].x, y: tr.dots[id].y };
      });
      if (tr.cal) {
        cal.a = { x: tr.cal.ax, y: tr.cal.ay };
        cal.b = { x: tr.cal.bx, y: tr.cal.by };
        $("calM").value = tr.cal.value;
        setUnit(tr.cal.unit || "ft");
      }
      SHIM.toast("Previous trace restored - adjust and resubmit");
    } else if (JOB.building && JOB.building.footprints) {
      // Traced before trace-saving existed: offer a straight rescale instead.
      $("rescaleBtn").hidden = false;
    }

    renderTray();
    redraw();
    loadPlan();
    loadDotSeed();
  };

  $("rescaleBtn").addEventListener("click", function () {
    var f = parseFloat(prompt(
      "Multiply the whole model by this factor (walls grow, window sizes stay true):", "1.5"));
    if (!(f > 0)) return;

    var nb = JSON.parse(JSON.stringify(JOB.building));
    nb.footprints.forEach(function (fp) {
      fp.forEach(function (p) {
        p.x = Math.round(p.x * f * 100) / 100;
        p.z = Math.round(p.z * f * 100) / 100;
      });
    });
    nb.width = Math.round(nb.width * f * 10) / 10;
    nb.depth = Math.round(nb.depth * f * 10) / 10;
    SHIM.pushOp({ op: "building", building: nb });

    // Positions scale with the walls; wrapped corner units re-anchor to their
    // corner because their legs are fixed real sizes.
    var segs2 = elevationsOf({ building: nb });
    JOB.windows.forEach(function (w) {
      var c = JSON.parse(JSON.stringify(w));
      var e = segs2.filter(function (s2) { return s2.key === w.elev; })[0];
      if (w.legs && w.wrap && e) {
        c.x = w.wrap === "end"
          ? Math.round(Math.max(0, e.len - w.legs[0] / 1000) * 100) / 100
          : 0;
      } else {
        c.x = Math.round(w.x * f * 100) / 100;
      }
      SHIM.pushOp({ op: "upsert", window: c });
    });

    SHIM.toast("Rescaled by " + f + "x");
    setTimeout(function () {
      SHIM.done();
    }, 1200);
  });


  bootWithJob(job);

  return {
    destroy: function () {
      cleanups.forEach(function (f) { f(); });
      cleanups.length = 0;
      host.innerHTML = "";
    }
  };
}
