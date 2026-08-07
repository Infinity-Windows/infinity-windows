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

const TEMPLATE = "\n<div class=\"app loading\">\n\n  <header class=\"titleblock\">\n    <div class=\"tb-row\">\n      <div>\n        <div class=\"tb-ref\" id=\"jobRef\"></div>\n        <div class=\"tb-addr\" id=\"jobAddr\"></div>\n      </div>\n      \n    </div>\n\n    \n    <div class=\"tabs\">\n      <button class=\"tab\" aria-selected=\"true\">Trace plan</button>\n    </div>\n  </header>\n\n  <div class=\"boot\" id=\"boot\">\n    <b>Loading job</b>\n    <span id=\"bootMsg\">Fetching schedule</span>\n  </div>\n\n  <section class=\"view\">\n    <div class=\"toolrow\">\n      <div class=\"seg\" role=\"group\" aria-label=\"Tool\">\n        <button data-mode=\"select\" aria-pressed=\"true\">Select</button>\n        <button data-mode=\"draw\" aria-pressed=\"false\">Draw</button>\n        <button data-mode=\"cal\" aria-pressed=\"false\">Calibrate</button>\n      </div>\n      <button class=\"mini\" id=\"closeShape\">Close shape</button>\n      <button class=\"mini\" id=\"undoPt\">Undo point</button>\n      <button class=\"mini\" id=\"undoAct\" disabled>Undo action</button>\n      <button class=\"mini\" id=\"delPt\" hidden>Delete point</button>\n      <button class=\"mini\" id=\"delBld\" hidden>Delete building</button>\n      <button class=\"mini\" id=\"removeDot\" hidden>Remove dot</button>\n      <button class=\"mini\" id=\"autoBtn\" hidden>Auto-place dots</button>\n      <button class=\"mini\" id=\"autoTrace\" hidden>Auto-trace building</button>\n      <span class=\"cal-lab\">Line =</span>\n      <input class=\"cal-in\" id=\"calM\" type=\"number\" step=\"0.1\" placeholder=\"ft\">\n      <div class=\"seg\" role=\"group\" aria-label=\"Units\">\n        <button type=\"button\" data-unit=\"ft\" aria-pressed=\"true\">ft</button>\n        <button type=\"button\" data-unit=\"m\" aria-pressed=\"false\">m</button>\n      </div>\n      <button class=\"mini\" id=\"rescaleBtn\" hidden>Rescale</button>\n      <button class=\"mini hot\" id=\"submitBtn\" style=\"margin-left:auto\">Submit</button>\n    </div>\n\n    <div class=\"strip\" id=\"storyRail\"></div>\n\n    <div class=\"tray\" id=\"tray\"><span class=\"tray-lab\">Drag onto a wall:</span></div>\n\n    <div class=\"tstage\" id=\"tstage\">\n      <div class=\"world\" id=\"world\">\n        <img id=\"plan\" alt=\"\">\n        <svg id=\"ol\" xmlns=\"http://www.w3.org/2000/svg\"></svg>\n      </div>\n      <div class=\"noplan\" id=\"noplan\" hidden>\n        <span>No plan image on this job yet</span>\n        <label class=\"pbtn\">Load plan image\n          <input id=\"planFile\" type=\"file\" accept=\"image/*\" hidden>\n        </label>\n      </div>\n    </div>\n\n    <div class=\"hint\" style=\"padding:8px 16px;font-family:var(--f-mono);font-size:9px;letter-spacing:0.07em;text-transform:uppercase;color:var(--ink-3)\" id=\"hint\">\n      Draw: tap to add points, tap the first point to close &middot; Select: drag points and dots &middot; pinch or scroll to zoom\n    </div>\n  </section>\n\n  <div class=\"foot\">\n    Trace the outside walls &middot; each closed shape is one building &middot; dots snap to the nearest wall\n  </div>\n\n  <div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n</div>\n";

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
  /* stories: each story owns its own trace - footprint polys AND dots (a
     dot on story 2 IS the statement "this window is on story 2"). The
     calibration is global: one plan image, one scale. The legacy `polys` /
     `dots` variables stay, permanently BOUND to the active story, so every
     drawing/snapping/gesture path below keeps working untouched. */
  var stories = [{ name: "Ground", heightM: 3, partial: false, polys: [], dots: {} }];
  var cur = 0;
  var MAXSTORIES = 8;
  var polys = stories[0].polys;
  var cal = { a: null, b: null };
  var dots = stories[0].dots;
  function bindStory() {
    polys = stories[cur].polys;
    dots = stories[cur].dots;
  }
  function dotStoryOf(id) {
    for (var i = 0; i < stories.length; i++) if (stories[i].dots[id]) return i;
    return -1;
  }
  /* Phase 2: where each dot's story assignment CAME from. Auto-placed dots
     carry the sheet-title evidence and submit as "probable"; a human drag
     clears the meta and submits as "confirmed"; a window left in the tray
     with a recorded reason submits as "unclear". */
  var dotMeta = {};
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
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
    history.push(JSON.stringify({ stories: stories, cur: cur, cal: cal, dotMeta: dotMeta }));
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
    stories = s.stories;
    cur = Math.min(s.cur || 0, stories.length - 1);
    cal = s.cal;
    dotMeta = s.dotMeta || {};
    bindStory();
    buildStoryRail();
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

  function snapToWallsOf(st, p) {
    var keep = polys;
    polys = st.polys;
    var r = snapToWalls(p);
    polys = keep;
    return r;
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

    // stories: the story below ghosts under the one you are drawing, so an
    // upper footprint lines up with the walls that will carry it.
    if (cur > 0) {
      stories[cur - 1].polys.forEach(function (poly) {
        if (!poly.closed || poly.pts.length < 3) return;
        var gd = "M" + poly.pts.map(function (q) { return q.x + " " + q.y; }).join(" L") + " Z";
        s.push('<path d="' + gd + '" fill="none" stroke="var(--ink-3)" stroke-width="' +
          (2 * px) + '" stroke-dasharray="' + (6 * px) + " " + (5 * px) +
          '" opacity="0.55" pointer-events="none"/>');
      });
    }

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

  /* stories: the rail. Tap a story to work on it; tap the active story to
     retype its height; "+ Story" copies the footprint below (the 90% case -
     reshape or delete it, both undoable) so there is no dialog to answer. */
  function switchStory(i) {
    if (i === cur) {
      var h = parseFloat((typeof prompt === "function" &&
        prompt("Story height (m)", String(stories[cur].heightM))) || "");
      if (h > 0.5 && h < 12) { snapshot(); stories[cur].heightM = h; buildStoryRail(); }
      return;
    }
    cur = i;
    bindStory();
    selV = null; selDot = null;
    $("delPt").hidden = true; $("delBld").hidden = true; $("removeDot").hidden = true;
    buildStoryRail();
    renderTray();
    redraw();
  }

  function addStory() {
    if (stories.length >= MAXSTORIES) return;
    snapshot();
    var below = stories[cur];
    stories.push({
      name: "Level " + (stories.length + 1),
      heightM: 3,
      partial: false,
      polys: below.polys.filter(function (p) { return p.closed; }).map(function (p) {
        return { pts: p.pts.map(function (q) { return { x: q.x, y: q.y }; }), closed: true };
      }),
      dots: {}
    });
    switchStory(stories.length - 1);
    SHIM.toast("Story " + stories.length + " added - footprint copied from below; " +
      "reshape it, or delete it and draw the smaller upper box");
  }

  function buildStoryRail() {
    var rail = $("storyRail");
    rail.innerHTML = "";
    stories.forEach(function (st, i) {
      var b = document.createElement("button");
      b.className = "elev";
      b.setAttribute("aria-pressed", String(i === cur));
      b.innerHTML = esc(st.name) + " <b>" + st.heightM + "m</b>";
      b.addEventListener("click", function () { switchStory(i); });
      rail.appendChild(b);
    });
    if (stories.length < MAXSTORIES) {
      var add = document.createElement("button");
      add.className = "elev";
      add.id = "addStory";
      add.textContent = "+ Story";
      add.addEventListener("click", addStory);
      rail.appendChild(add);
    }
    if (stories.length > 1) {
      // Removing a story is armed-then-confirmed, same as deleting a
      // building - and undoable even after that.
      var rm = document.createElement("button");
      rm.className = "elev";
      rm.id = "removeStory";
      rm.textContent = "− Top story";
      rm.addEventListener("click", function () {
        if (rm.dataset.armed !== "1") {
          rm.dataset.armed = "1";
          rm.textContent = "Tap again to remove " + stories[stories.length - 1].name;
          setTimeout(function () {
            rm.dataset.armed = "0";
            rm.textContent = "− Top story";
          }, 3500);
          return;
        }
        snapshot();
        var gone = Object.keys(stories[stories.length - 1].dots).length;
        stories.pop();
        if (cur >= stories.length) cur = stories.length - 1;
        bindStory();
        buildStoryRail();
        renderTray();
        redraw();
        SHIM.toast("Story removed" +
          (gone ? " - " + gone + " window(s) back in the tray" : ""));
      });
      rail.appendChild(rm);
    }
  }

  function renderTray() {
    var tray = $("tray");
    Array.prototype.slice.call(tray.querySelectorAll(".chip-dot")).forEach(function (c) { c.remove(); });
    JOB.windows.forEach(function (w) {
      var c = document.createElement("span");
      var at = dotStoryOf(w.id);
      var meta = dotMeta[w.id] || {};
      c.className = "chip-dot " + (w.door ? "d" : "w") +
        (at >= 0 ? " placed" : "") +
        (at >= 0 && at !== cur ? " elsewhere" : "") +
        (at < 0 && meta.unclear ? " unclear" : "");
      if (at >= 0 && at !== cur) c.title = "Placed on " + stories[at].name +
        " - drag to move it to " + stories[cur].name;
      else if (at < 0 && meta.unclear) c.title = "Story unclear: " + meta.unclear;
      else if (at >= 0 && meta.evidence) c.title = meta.evidence;
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
        // stories: one window, one story - placing here claims it from
        // wherever it was.
        stories.forEach(function (st) { delete st.dots[id]; });
        dots[id] = sn ? { x: sn.x, y: sn.y } : { x: w.x, y: w.y };
        dotMeta[id] = { byHand: true };
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

  var storyPlan = null;
  function loadDotSeed() {
    if (SHIM.scaleSuggestion) {
      $("calM").placeholder = "optional";
      SHIM.toast("This sheet declares its scale (" + SHIM.scaleSuggestion.evidence +
        ") - calibration is optional");
    }
    dotSeed = (typeof SHIM.dotSeed === "function" ? SHIM.dotSeed(plan) : SHIM.dotSeed) || null;
    storyPlan = (typeof SHIM.storyPlan === "function" ? SHIM.storyPlan() : SHIM.storyPlan) || null;
    if (storyPlan) {
      SHIM.toast("Sheet titles name " + storyPlan.stories.length +
        " stories - Auto-place will use them");
    }
    $("autoBtn").hidden = !dotSeed;
    $("autoTrace").hidden = !(SHIM.outlineSeed && SHIM.outlineSeed.length);
  }

  // Auto-trace: the app already extracts a building outline from the plan
  // PDF; that polygon lands here as a starting trace — closed, editable,
  // undoable. It replaces nothing you drew: only ADDS when no shape overlaps
  // it, so tapping it twice doesn't stack copies.
  $("autoTrace").addEventListener("click", function () {
    var seed = SHIM.outlineSeed;
    if (!seed || !seed.length) return;
    snapshot();
    var added = 0;
    seed.forEach(function (pts) {
      if (!pts || pts.length < 3) return;
      var cx2 = 0, cy2 = 0;
      pts.forEach(function (p) { cx2 += p.x; cy2 += p.y; });
      cx2 /= pts.length; cy2 /= pts.length;
      // "Same building" is judged against the seed's own size, which works
      // whether or not a plan image ever loaded.
      var sxs = pts.map(function (p) { return p.x; });
      var sys = pts.map(function (p) { return p.y; });
      var span2 = Math.hypot(
        Math.max.apply(null, sxs) - Math.min.apply(null, sxs),
        Math.max.apply(null, sys) - Math.min.apply(null, sys));
      var dup = polys.some(function (poly) {
        if (!poly.pts.length) return false;
        var px2 = 0, py2 = 0;
        poly.pts.forEach(function (p) { px2 += p.x; py2 += p.y; });
        return Math.hypot(px2 / poly.pts.length - cx2, py2 / poly.pts.length - cy2) <
          span2 * 0.1;
      });
      if (dup) return;
      polys.push({
        pts: pts.map(function (p) { return { x: p.x, y: p.y }; }),
        closed: true
      });
      added++;
    });
    if (!added) { dropSnapshot(); SHIM.toast("The traced shape is already here"); return; }
    redraw();
    SHIM.toast(added + (added === 1 ? " building" : " buildings") +
      " traced from the plan - drag any point that needs a nudge, then calibrate");
  });

  $("autoBtn").addEventListener("click", function () {
    if (!dotSeed) return;
    snapshot();
    // Phase 2: the sheet titles named the stories - make sure they exist
    // (never touching ones already traced) so each dot can land on its own.
    if (storyPlan) {
      storyPlan.stories.forEach(function (ds) {
        while (stories.length < ds.n && stories.length < MAXSTORIES) {
          var below = stories[stories.length - 1];
          stories.push({
            name: "Level " + (stories.length + 1), heightM: 3, partial: false,
            polys: below.polys.filter(function (p2) { return p2.closed; }).map(function (p2) {
              return { pts: p2.pts.map(function (q) { return { x: q.x, y: q.y }; }), closed: true };
            }),
            dots: {}
          });
        }
        if (stories[ds.n - 1] && stories[ds.n - 1].name.indexOf("Level ") === 0) {
          stories[ds.n - 1].name = ds.name;
        }
      });
      buildStoryRail();
    }
    var placed = 0, skipped = 0, unclearN = 0;
    JOB.windows.forEach(function (w) {
      if (dotStoryOf(w.id) >= 0) { skipped++; return; }  // never move a dot you placed - any story
      var p = dotSeed[w.id];
      if (!p) return;
      var plan2 = storyPlan && storyPlan.byId[w.id];
      if (storyPlan && !plan2) {
        // The titles couldn't say - the tray is the Unclear queue.
        if (storyPlan.unclear[w.id]) { dotMeta[w.id] = { unclear: storyPlan.unclear[w.id] }; unclearN++; }
        return;
      }
      var target = plan2 ? stories[Math.min(plan2.story, stories.length) - 1] : stories[cur];
      var sn = snapToWallsOf(target, { x: p.x, y: p.y });
      target.dots[w.id] = sn ? { x: sn.x, y: sn.y } : { x: p.x, y: p.y };
      dotMeta[w.id] = plan2
        ? { evidence: plan2.evidence, confidence: plan2.confidence, range: plan2.range }
        : { byHand: true };
      placed++;
    });
    // Placed nothing = changed nothing; don't charge an undo step for it.
    if (!placed) dropSnapshot();
    renderTray();
    redraw();
    SHIM.toast(placed + " dots placed from the plan numbers" +
      (skipped ? " (" + skipped + " already yours, untouched)" : "") +
      (unclearN ? " - " + unclearN + " unclear, left in the tray" : "") +
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
    // stories: every story must have a closed footprint before anything
    // submits - a floating upper box with no walls under it helps nobody.
    function closedOf(st) {
      return st.polys.filter(function (p2) { return p2.closed && p2.pts.length >= 3; });
    }
    for (var sChk = 0; sChk < stories.length; sChk++) {
      if (!closedOf(stories[sChk]).length) {
        SHIM.toast(stories[sChk].name + " has no closed footprint yet - draw one, or remove the story");
        return;
      }
    }
    var mv = parseFloat($("calM").value);
    var scale;
    if (cal.a && cal.b && mv > 0) {
      scale = calMetres(mv) / Math.hypot(cal.b.x - cal.a.x, cal.b.y - cal.a.y);   // metres per plan px
    } else if (SHIM.scaleSuggestion && SHIM.scaleSuggestion.metresPerPx > 0) {
      // Phase 3: the sheet declared its own scale - use it, and say so.
      scale = SHIM.scaleSuggestion.metresPerPx;
      SHIM.toast('Using the sheet\'s declared scale (' + SHIM.scaleSuggestion.evidence + ')');
    } else {
      SHIM.toast("Calibrate first: two points + the real distance");
      return;
    }

    // Global bbox centre across EVERY story, so upper boxes stack exactly
    // where they were traced instead of re-centring themselves.
    var allPts = [];
    stories.forEach(function (st) {
      closedOf(st).forEach(function (p2) { allPts = allPts.concat(p2.pts); });
    });
    var gx = allPts.map(function (p) { return p.x; });
    var gy = allPts.map(function (p) { return p.y; });
    var cx = (Math.min.apply(null, gx) + Math.max.apply(null, gx)) / 2;
    var cy = (Math.min.apply(null, gy) + Math.max.apply(null, gy)) / 2;

    function toFootprints(closedPolys) {
      return closedPolys.map(function (poly) {
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
    }

    // Story datums stack: each floor sits on the plate of the one below.
    var elevAcc = 0;
    var storyDefs = stories.map(function (st, si) {
      var def = { n: si + 1, name: st.name, elevM: Math.round(elevAcc * 100) / 100,
                  heightM: st.heightM, footprints: toFootprints(closedOf(st)) };
      if (st.partial) def.partial = true;
      elevAcc += st.heightM;
      return def;
    });
    var footprints = storyDefs[0].footprints;   // legacy readers see the ground story

    var probe = { building: { stories: storyDefs, height: elevAcc } };
    var segs = elevationsOf(probe);

    var moves = [];
    stories.forEach(function (stg, si) {
      // stories: a dot only ever lands on its own story's walls.
      var storySegs = segs.filter(function (sg) { return (sg.story || 1) === si + 1; });
      Object.keys(stg.dots).forEach(function (id) {
      var win = JOB.windows.filter(function (w) { return w.id === id; })[0];
      if (!win) return;
      var pm = { x: (stg.dots[id].x - cx) * scale, z: (stg.dots[id].y - cy) * scale };
      var best = null;
      storySegs.forEach(function (s2) {
        var pr = projectToSeg({ x: pm.x, y: pm.z },
          { x: s2.x1, y: s2.z1 }, { x: s2.x2, y: s2.z2 });
        if (!best || pr.d < best.d) best = { seg: s2, t: pr.t, d: pr.d };
      });
      if (!best) return;
      var t = best.t * best.seg.len;
      var copy = JSON.parse(JSON.stringify(win));
      copy.elev = best.seg.key;

      // Corner units: authored legs are the surveyor's word and win outright.
      // Without them, the SPEC still knows ("90-degree corner", "Corner
      // meet", "Butt-Jointed Corner" in the style line), so a corner unit
      // dropped on the wall it mostly lives on gets its legs DERIVED: the
      // stretch from the unit's span to the nearest wall end is the main leg,
      // the rest turns the corner - snapped to a real pane boundary when the
      // panel widths are known. No more parking the dot exactly on the
      // vertex to make a corner a corner.
      var legs2 = (win.legs && win.legs.length === 2) ? win.legs.slice() : null;
      var derived = false;
      if (!legs2 && /\bcorner\b/i.test(String(win.type || ""))) {
        var wM = win.w / 1000;
        var distEnd = best.seg.len - t, distStart = t;
        var toV = Math.max(0, Math.min(distEnd, distStart));
        if (toV < wM) {                       // it can actually reach a corner
          var mainMm = Math.min(
            Math.max(wM / 2 + toV, 0.15) * 1000, win.w - 150);
          if (win.panes && win.panes.length > 1) {
            var acc = 0, bestSplit = null;
            for (var pi3 = 0; pi3 < win.panes.length - 1; pi3++) {
              acc += win.panes[pi3];
              if (!bestSplit || Math.abs(acc - mainMm) < Math.abs(bestSplit.mm - mainMm)) {
                bestSplit = { mm: acc, i: pi3 + 1 };
              }
            }
            if (bestSplit) {
              mainMm = bestSplit.mm;
              copy.lightsSplit = [bestSplit.i, win.panes.length - bestSplit.i];
            }
          }
          legs2 = [Math.round(mainMm), Math.round(win.w - mainMm)];
          derived = true;
        }
      }

      if (legs2) {
        // It wraps whichever end of this wall the dot is nearer.
        var wrapEnd = t >= best.seg.len / 2;
        copy.wrap = wrapEnd ? "end" : "start";
        if (derived) {
          // Derived legs came from THIS wall's geometry; keep them as built.
          copy.legs = legs2;
        } else {
          // Authored legs follow the surveyor's rule: the longer leg goes on
          // the longer of the two walls at that corner - the plan drawings
          // are all outside views, as is the model.
          var vx = wrapEnd ? best.seg.x2 : best.seg.x1;
          var vz = wrapEnd ? best.seg.z2 : best.seg.z1;
          var adj2 = null;
          storySegs.forEach(function (s3) {
            if (s3 === best.seg || s3.poly !== best.seg.poly) return;
            var sx = wrapEnd ? s3.x1 : s3.x2, sz = wrapEnd ? s3.z1 : s3.z2;
            if (Math.abs(sx - vx) < 0.001 && Math.abs(sz - vz) < 0.001) adj2 = s3;
          });
          var lg = Math.max(legs2[0], legs2[1]);
          var sm = Math.min(legs2[0], legs2[1]);
          copy.legs = (!adj2 || best.seg.len >= adj2.len) ? [lg, sm] : [sm, lg];
        }
        copy.x = wrapEnd
          ? Math.round(Math.max(0, best.seg.len - copy.legs[0] / 1000) * 100) / 100
          : 0;
      } else {
        var x = Math.max(0, Math.min(best.seg.len - win.w / 1000, t - win.w / 2000));
        copy.x = Math.round(x * 100) / 100;
      }
      // stories: the placement IS the story assignment. A window that just
      // changed story gets a sane default sill relative to its new floor.
      copy.story = si + 1;
      if ((win.story || 1) !== si + 1 || typeof win.y !== "number") {
        copy.y = win.door || copy.door ? 0 : 0.9;
      }
      // Phase 2/3: say where the assignment came from. A title alone is one
      // signal ("probable"); a validated mark prefix agreeing with it is a
      // second, independent one ("confirmed"); a human's drag is the
      // human's word.
      var meta2 = dotMeta[id] || {};
      if (meta2.evidence && !meta2.byHand) {
        copy.storyConfidence = meta2.confidence || "probable";
        copy.storyEvidence = meta2.evidence;
      } else {
        copy.storyConfidence = "confirmed";
        copy.storyEvidence = "placed by hand";
      }
      moves.push(copy);

      // Phase 3: a window tagged on a typical-floor sheet ("LEVELS 2-6")
      // exists once in the schedule but on EVERY story in the range. Clone
      // it upward: same wall (the footprints were copied, so the walls line
      // up edge for edge), same position, per-story id, and always
      // "probable" - the drawings assert near-identity, not identity.
      if (meta2.range && meta2.range.length === 2) {
        var segIdx = storySegs.indexOf(best.seg);
        for (var rn = meta2.range[0] + 1; rn <= meta2.range[1] && rn <= stories.length; rn++) {
          var upSegs = segs.filter(function (sg) { return (sg.story || 1) === rn; });
          if (segIdx < 0 || segIdx >= upSegs.length) break;   // walls diverged: stop honestly
          var clone = JSON.parse(JSON.stringify(copy));
          clone.id = String(win.id) + "@L" + rn;
          clone.story = rn;
          clone.elev = upSegs[segIdx].key;
          clone.storyConfidence = "probable";
          clone.storyEvidence = "cloned from typical sheet: " + meta2.evidence;
          moves.push(clone);
        }
      }
      });
    });

    // Anything without a dot is deliberately off the model: unplace it
    // explicitly so a stale wall key can never drag it back onto a wall.
    var offModel = 0;
    JOB.windows.forEach(function (w) {
      if (dotStoryOf(w.id) >= 0) return;
      var copy = JSON.parse(JSON.stringify(w));
      copy.elev = "";
      copy.x = 0;
      delete copy.wrap;
      delete copy.story;
      var metaU = dotMeta[w.id] || {};
      if (metaU.unclear) {
        copy.storyConfidence = "unclear";
        copy.storyEvidence = metaU.unclear;
      }
      moves.push(copy);
      offModel++;
    });

    var wAll = allPts.map(function (p) { return (p.x - cx) * scale; });
    var zAll = allPts.map(function (p) { return (p.y - cy) * scale; });
    function roundPolys(closedPolys) {
      return closedPolys.map(function (p2) {
        return p2.pts.map(function (q) {
          return { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 };
        });
      });
    }
    function roundDots(dd) {
      var out = {};
      Object.keys(dd).forEach(function (id) {
        out[id] = { x: Math.round(dd[id].x * 10) / 10, y: Math.round(dd[id].y * 10) / 10 };
      });
      return out;
    }

    var bld = {
      width: Math.round((Math.max.apply(null, wAll) - Math.min.apply(null, wAll)) * 10) / 10,
      depth: Math.round((Math.max.apply(null, zAll) - Math.min.apply(null, zAll)) * 10) / 10,
      height: Math.round(elevAcc * 100) / 100,   // the envelope: highest plate
      rise: JOB.building.rise || 0,
      stories: storyDefs,
      footprints: footprints,
      // The raw trace, in plan-image pixels, so this screen can restore your
      // outline and dots later - fix the calibration and resubmit, no
      // redrawing. Storied per level; the legacy polys/dots mirror the ground
      // story for anything older still reading them.
      trace: {
        cal: cal.a && cal.b && mv > 0
          ? { ax: Math.round(cal.a.x), ay: Math.round(cal.a.y),
              bx: Math.round(cal.b.x), by: Math.round(cal.b.y),
              value: mv, unit: calUnit }
          : { declaredScale: scale,
              evidence: SHIM.scaleSuggestion ? SHIM.scaleSuggestion.evidence : "" },
        stories: stories.map(function (st) {
          var ts = { name: st.name, heightM: st.heightM,
                     polys: roundPolys(closedOf(st)), dots: roundDots(st.dots) };
          if (st.partial) ts.partial = true;
          return ts;
        }),
        polys: roundPolys(closedOf(stories[0])),
        dots: roundDots(stories[0].dots)
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
    function polyIn(pp) {
      return { pts: pp.map(function (q) { return { x: q.x, y: q.y }; }), closed: true };
    }
    if (tr && tr.stories && tr.stories.length) {
      // stories: a storied trace brings every story back editable.
      stories = tr.stories.map(function (ts, i) {
        var st = { name: ts.name || ("Level " + (i + 1)), heightM: ts.heightM || 3,
                   partial: !!ts.partial, polys: (ts.polys || []).map(polyIn), dots: {} };
        Object.keys(ts.dots || {}).forEach(function (id) {
          st.dots[id] = { x: ts.dots[id].x, y: ts.dots[id].y };
        });
        return st;
      });
      cur = 0;
      bindStory();
    } else if (tr && tr.polys) {
      // Pre-stories trace: it all lands on the ground story.
      polys.length = 0;
      tr.polys.forEach(function (pp) { polys.push(polyIn(pp)); });
      Object.keys(tr.dots || {}).forEach(function (id) {
        dots[id] = { x: tr.dots[id].x, y: tr.dots[id].y };
      });
      var bs0 = JOB.building.stories && JOB.building.stories[0];
      if (bs0) {
        stories[0].name = bs0.name || stories[0].name;
        stories[0].heightM = bs0.heightM || stories[0].heightM;
      }
    }
    if (tr && (tr.polys || (tr.stories && tr.stories.length))) {
      if (tr.cal && typeof tr.cal.ax === "number") {
        cal.a = { x: tr.cal.ax, y: tr.cal.ay };
        cal.b = { x: tr.cal.bx, y: tr.cal.by };
        $("calM").value = tr.cal.value;
        setUnit(tr.cal.unit || "ft");
      }
      // A trace saved on the sheet's declared scale has no cal points to
      // restore - the suggestion (or a hand calibration) covers resubmit.
      SHIM.toast("Previous trace restored - adjust and resubmit");
    } else if (JOB.building && JOB.building.footprints) {
      // Traced before trace-saving existed: offer a straight rescale instead.
      $("rescaleBtn").hidden = false;
    }

    buildStoryRail();
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
