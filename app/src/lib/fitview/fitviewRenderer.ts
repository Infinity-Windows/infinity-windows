// @ts-nocheck
/*
 * The window-viewer prototype's 3D fit view, ported.
 *
 * This file is a MECHANICAL port of `window-viewer/index.html` (the <body>
 * markup and the renderer IIFE), produced by scripts/port-fitview notes in
 * docs/. It is deliberately kept as close to the prototype's vanilla source
 * as possible - same names, same style, @ts-nocheck - so that a diff against
 * the prototype stays readable and improvements can flow either way. Treat it
 * as vendored code: fix bugs, but do not "React-ify" it piecemeal.
 *
 * Everything the prototype's Sync layer did (auth, fetch, offline queue,
 * photos, service worker) is the HOST's job now, injected through `shim`:
 *   auth?            { user }            - enables "mine" highlighting
 *   toast(msg)                             - surface a message
 *   openOpening?(id, win)                  - deep-link to the opening sheet
 *   onStatusChange?(win, next)             - absent = read-only sheet
 *   photos?          { photoURL(id) }    - absent = no photo section
 */

// Stories (docs/maps-interactive-stories-design.md): the canonicalizers live
// in stories.ts; the geometry extensions in this file are marked "stories:".
import { envelopeHeight, storiesOf, storyLevels } from "./stories";

const TEMPLATE = "\n<div class=\"app loading\">\n\n  <header class=\"titleblock\">\n    <div class=\"tb-row\">\n      <div>\n        <div class=\"tb-ref\" id=\"jobRef\"></div>\n        <div class=\"tb-addr\" id=\"jobAddr\"></div>\n      </div>\n      \n    </div>\n\n    <div class=\"tb-progress\">\n      <div class=\"bar\"><i id=\"bar\"></i></div>\n      <div class=\"tb-count\" id=\"count\"></div>\n    </div>\n\n    \n    <div class=\"tabs\" role=\"tablist\">\n      <button class=\"tab\" role=\"tab\" aria-selected=\"true\" data-view=\"plan\">Elevations</button>\n      <button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-view=\"sched\">Schedule</button>\n    </div>\n  </header>\n\n  <div class=\"boot\" id=\"boot\">\n    <b>Loading job</b>\n    <span id=\"bootMsg\">Fetching schedule</span>\n  </div>\n\n  <!-- ============ PLAN VIEW ============ -->\n  <section class=\"view on\" id=\"v-plan\">\n    <div class=\"psearch\">\n      <input id=\"pq\" type=\"search\" placeholder=\"Find an opening - ID, room or type\"\n        autocomplete=\"off\" aria-label=\"Find an opening\">\n      <div class=\"pq-results\" id=\"pqr\" hidden></div>\n    </div>\n    <div class=\"stage\" id=\"stage\">\n      <div class=\"persp\" id=\"persp\">\n        <div class=\"house\" id=\"house\"></div>\n      </div>\n      <div class=\"zoomctl\">\n        <button id=\"zin\" type=\"button\" aria-label=\"Zoom in\">+</button>\n        <button id=\"zout\" type=\"button\" aria-label=\"Zoom out\">&#8722;</button>\n        <button id=\"zpan\" type=\"button\" aria-label=\"Pan mode\" aria-pressed=\"false\">Pan</button>\n        <button id=\"zpanp\" type=\"button\" aria-label=\"Pan plus: tilt with a straight horizon\" aria-pressed=\"false\">Pan +</button>\n        <button id=\"zfit\" type=\"button\" aria-label=\"Fit to view\">Fit</button>\n      </div>\n    </div>\n\n    <div class=\"controls\">\n      <div class=\"strip\" id=\"elevStrip\"></div>\n\n      <div class=\"toolrow\">\n        <div class=\"seg\" role=\"group\" aria-label=\"Label detail\">\n          <button data-labels=\"full\" aria-pressed=\"true\">Size</button>\n          <button data-labels=\"id\" aria-pressed=\"false\">ID</button>\n          <button data-labels=\"off\" aria-pressed=\"false\">Off</button>\n        </div>\n        <button class=\"mini\" id=\"mineBtn\" aria-pressed=\"false\">Mine</button>\n        <button class=\"mini\" id=\"assignBtn\" hidden>Assign</button>\n        <div class=\"legend\" id=\"legend\"></div>\n      </div>\n\n      <div class=\"assignbar\" id=\"assignBar\" hidden>\n        <b id=\"assignCount\">0 picked</b>\n        <button class=\"mini\" id=\"pickElev\">+ This elevation</button>\n        <button class=\"mini hot\" id=\"assignGo\">Assign</button>\n        <button class=\"mini\" id=\"assignCancel\">Cancel</button>\n      </div>\n\n      <div class=\"hint\" id=\"hint\">Drag to orbit &middot; pinch or scroll to zoom &middot; tap a window for its spec</div>\n    </div>\n  </section>\n\n  <!-- ============ SCHEDULE VIEW ============ -->\n  <section class=\"view\" id=\"v-sched\">\n    <div class=\"sched\">\n      <div class=\"search\">\n        <input id=\"q\" type=\"search\" placeholder=\"Filter by ID, type or room\" aria-label=\"Filter schedule\">\n      </div>\n      <div id=\"rows\"></div>\n    </div>\n  </section>\n\n  <div class=\"foot\">\n    Prototype &middot; dimensions shown are survey-measured and govern the order &middot; scan estimates are indicative only\n  </div>\n\n  <div class=\"scrim\" id=\"scrim\"></div>\n  <aside class=\"sheet\" id=\"sheet\" role=\"dialog\" aria-modal=\"false\" aria-label=\"Window specification\"></aside>\n  <div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n  <div class=\"lightbox\" id=\"lightbox\" role=\"dialog\" aria-label=\"Photo\">\n    <img id=\"lb-img\" alt=\"Site photo\">\n    <div class=\"lb-cap\" id=\"lb-cap\"></div>\n  </div>\n</div>\n";

/* Millimetres to inches the way a tape reads them: 1511mm -> 59 1/2". */
export function inches(mm) {
  var t = mm / 25.4;
  var whole = Math.floor(t);
  var n = Math.round((t - whole) * 16);
  if (n === 16) { whole += 1; n = 0; }
  if (!n) return whole + '"';
  var d = 16;
  while (n % 2 === 0) { n /= 2; d /= 2; }
  return (whole ? whole + " " : "") + n + "/" + d + '"';
}

/* One elevation per footprint edge; the classic 4 faces when no footprint. */
export function elevationsOf(job) {
  var b = job && job.building;
  // stories: a storied building may carry footprints only inside its stories,
  // so the "no usable polygon" fallback must look through storiesOf, not just
  // at the top-level footprints.
  var anyPoly =
    b && storiesOf(b).some(function (st) {
      return st.footprints.length > 0 && st.footprints[0].length >= 3;
    });
  if (!anyPoly) {
    return [
      { key: "front", name: "Front", ay: 0 },
      { key: "right", name: "Right", ay: -90 },
      { key: "rear", name: "Rear", ay: 180 },
      { key: "left", name: "Left", ay: 90 }
    ];
  }
  // stories: walls enumerate story by story, bottom-up, with one CONTINUOUS
  // key counter — a single-story building therefore produces the exact same
  // "s0…sN" keys it always did, so no stored window loses its wall.
  var stories = storiesOf(b);
  var out = [], k = 0;
  stories.forEach(function (st) {
    st.footprints.forEach(function (fp, pi) {
      for (var i = 0; i < fp.length; i++) {
        var a = fp[i], c = fp[(i + 1) % fp.length];
        var dx = c.x - a.x, dz = c.z - a.z;
        var len = Math.sqrt(dx * dx + dz * dz);
        var A = Math.atan2(-dz, dx) * 180 / Math.PI;   // outward normal vs +z
        out.push({ key: "s" + k, name: a.name || ("Wall " + (k + 1)),
                   poly: pi, len: len, A: A, ay: -A,
                   x1: a.x, z1: a.z, x2: c.x, z2: c.z,
                   story: st.n, base: st.elevM, hM: st.heightM });
        k++;
      }
    });
  });
  return out;
}

export function mountFitView(host, job, shim) {
  var SHIM = shim || {};
  if (!SHIM.toast) SHIM.toast = function () {};
  host.innerHTML = TEMPLATE;
  var ROOT = host;
  var cleanups = [];
  function onDoc(ev, fn, opts) {
    document.addEventListener(ev, fn, opts);
    cleanups.push(function () { document.removeEventListener(ev, fn, opts); });
  }
  function onWin(ev, fn, opts) {
    window.addEventListener(ev, fn, opts);
    cleanups.push(function () { window.removeEventListener(ev, fn, opts); });
  }
  function noopPush() {}

  "use strict";

  var JOB = null;

  var STATUS = {
    tofit:     { label: "To fit",     css: "--st-tofit" },
    installed: { label: "Installed",  css: "--st-installed" },
    issue:     { label: "Issue",      css: "--st-issue" }
  };

  var ELEVS = [
    { key: "front", name: "Front", ax: 0, ay: 0 },
    { key: "right", name: "Right", ax: 0, ay: -90 },
    { key: "rear",  name: "Rear",  ax: 0, ay: 180 },
    { key: "left",  name: "Left",  ax: 0, ay: 90 }
  ];

  var S = 56;                       // pixels per metre
  var B, W, D, H, R, SLOPE, PITCH, TILT, YOFF;
  var STORIES = [], ENVELOPE = 0, LEVELS = [];   // stories: set by computeGeometry
  var FRAMING = false;              // job.framing: render the timber frame, not finished walls
  var FOOT = null;                  // building.footprint: polygon plan, one wall per edge
  var FCX = 0, FCZ = 0;             // footprint bbox centre, metres
  var FMINX = 0, FMINZ = 0;         // footprint bbox origin, metres

  // Derived from the job, so only valid once job.json has loaded.
  function computeGeometry() {
    B = JOB.building;
    FRAMING = !!JOB.framing;
    // stories: the canonical list drives everything vertical. One story =
    // exactly the legacy model; the envelope, the bounding footprint and the
    // framing level bands all derive from the stories from here on.
    STORIES = storiesOf(B);
    ENVELOPE = envelopeHeight(STORIES);
    LEVELS = STORIES.length > 1 ? storyLevels(STORIES) : (B.levels || []);
    var polysrc = [];
    STORIES.forEach(function (st) { polysrc = polysrc.concat(st.footprints); });
    FOOT = (polysrc[0] && polysrc[0].length >= 3) ? polysrc : null;
    ELEVS = elevationsOf(JOB);
    if (FOOT) {
      var all = [];
      FOOT.forEach(function (fp) { all = all.concat(fp); });
      var xs = all.map(function (p) { return p.x; });
      var zs = all.map(function (p) { return p.z; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
      var minZ = Math.min.apply(null, zs), maxZ = Math.max.apply(null, zs);
      FCX = (minX + maxX) / 2;
      FCZ = (minZ + maxZ) / 2;
      FMINX = minX;
      FMINZ = minZ;
      // W/D become the bounding box so fit(), lawn and shadow keep working.
      B = JOB.building;
      W = (maxX - minX) * S;
      D = (maxZ - minZ) * S;
    } else {
      W = B.width * S;
      D = B.depth * S;
    }
    // stories: the house is as tall as its highest plate, not one number.
    H = ENVELOPE * S;
    R = B.rise * S;
    SLOPE = Math.sqrt(Math.pow(D / 2, 2) + Math.pow(R, 2));
    PITCH = Math.atan2(R, D / 2) * 180 / Math.PI;
    TILT = 90 - PITCH;
    // Mass runs from -(H/2 + R) at the ridge to +H/2 at the base, so its visual
    // centre sits at -R/2. Shift by +R/2 so orbit pivots there, not the box centre.
    YOFF = R / 2;
  }

  var state = {
    ax: -16, ay: 0, zoom: 1, fitZoom: 0, panX: 0, panY: 0,   // opens facing south
    panMode: false, panPlus: false,
    sel: null, labels: "full", view: "plan", q: "",
    assignMode: false, picked: {}
  };

  var EMPLOYEES = [];      // {name, role} - loaded once the job is up

  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

  function assignedNames(win) {
    return (win.assigned || []).map(cap).join(", ");
  }

  function isMine(win) {
    return !!(win.assigned && SHIM.auth &&
      win.assigned.indexOf(SHIM.auth.user) > -1);
  }

  var $ = function (id) { return ROOT.querySelector("#" + id); };
  var house = $("house"), stage = $("stage"), sheet = $("sheet"), scrim = $("scrim");
  var persp = $("persp");

  /* ---------- wall adjacency, for corner units that wrap ---------- */

  function elevByKey(k2) {
    for (var i = 0; i < ELEVS.length; i++) if (ELEVS[i].key === k2) return ELEVS[i];
    return null;
  }

  function elevLen(e) {
    if (e.len != null) return e.len;
    return (e.key === "front" || e.key === "rear") ? B.width : B.depth;
  }

  var BOX_ORDER = ["front", "right", "rear", "left"];

  function segAfter(e) {
    if (e.len != null) {           // polygon wall: the edge sharing our end vertex
      for (var i = 0; i < ELEVS.length; i++) {
        var c = ELEVS[i];
        if (c.poly === e.poly && c !== e &&
            Math.abs(c.x1 - e.x2) < 0.001 && Math.abs(c.z1 - e.z2) < 0.001) return c;
      }
      return null;
    }
    return elevByKey(BOX_ORDER[(BOX_ORDER.indexOf(e.key) + 1) % 4]);
  }

  function segBefore(e) {
    if (e.len != null) {
      for (var i = 0; i < ELEVS.length; i++) {
        var c = ELEVS[i];
        if (c.poly === e.poly && c !== e &&
            Math.abs(c.x2 - e.x1) < 0.001 && Math.abs(c.z2 - e.z1) < 0.001) return c;
      }
      return null;
    }
    return elevByKey(BOX_ORDER[(BOX_ORDER.indexOf(e.key) + 3) % 4]);
  }

  /* A unit with legs and a wrap direction becomes two render pieces on two
     adjacent walls, meeting at the shared corner - exactly like the corner
     diagram on its CAD sheet. Everything else stays one piece. */
  function windowFragments() {
    var frags = [];
    JOB.windows.forEach(function (win) {
      var e = elevByKey(win.elev);
      // A wrapped unit walks wall-to-wall around its corner(s): legs[i] lands
      // on the i-th wall along the chain (2 legs = one corner, 3 legs = two,
      // like #32's window that turns twice). wrap "end" walks forward from
      // the main wall's end vertex, "start" walks backward from its start.
      if (win.legs && win.legs.length >= 2 && win.wrap && e) {
        var walls = [e], ok = true;
        for (var li = 1; li < win.legs.length; li++) {
          var nxt = win.wrap === "start" ? segBefore(walls[li - 1]) : segAfter(walls[li - 1]);
          if (!nxt) { ok = false; break; }
          walls.push(nxt);
        }
        if (ok) {
          for (li = 0; li < win.legs.length; li++) {
            var atEnd = (win.wrap === "end") === (li === 0);
            frags.push({ win: win, elev: walls[li].key,
              x: atEnd ? Math.max(0, elevLen(walls[li]) - win.legs[li] / 1000) : 0,
              w: win.legs[li], main: li === 0, idx: li });
          }
          return;
        }
      }
      frags.push({ win: win, elev: win.elev, x: win.x, w: win.w, main: true, idx: 0 });
    });
    return frags;
  }
  var winEls = {};        // opening id -> main render piece
  var winEls2 = {};       // opening id -> first corner-return piece
  var winEls3 = {};       // opening id -> second return piece (double wrap)

  /* Apply a class or style to every render piece of an opening. */
  function eachWinEl(id, fn) {
    if (winEls[id]) fn(winEls[id]);
    if (winEls2[id]) fn(winEls2[id]);
    if (winEls3[id]) fn(winEls3[id]);
  }

  /* ---------- geometry ---------- */

  function faceSpec() {
    return [
      { key: "front", cls: "f-front", w: W, h: H, t: "translateZ(" + (D / 2) + "px)" },
      { key: "rear",  cls: "f-rear",  w: W, h: H, t: "rotateY(180deg) translateZ(" + (D / 2) + "px)" },
      { key: "right", cls: "f-side",  w: D, h: H, t: "rotateY(90deg) translateZ(" + (W / 2) + "px)" },
      { key: "left",  cls: "f-side",  w: D, h: H, t: "rotateY(-90deg) translateZ(" + (W / 2) + "px)" }
    ];
  }

  function place(el, w, h, transform) {
    el.style.width = w + "px";
    el.style.height = h + "px";
    el.style.marginLeft = (-w / 2) + "px";
    el.style.marginTop = (-h / 2) + "px";
    el.style.transform = transform;
  }

  // Stud-wall pattern for one face: corner posts, top and bottom plates, a
  // rim band at each floor level, then studs on 600mm centres underneath.
  // Painted as stacked gradients so the wall stays one cheap element.
  function frameLayers() {
    var layers = [
      "linear-gradient(90deg, var(--plate) 0 5px, transparent 5px)",
      "linear-gradient(270deg, var(--plate) 0 5px, transparent 5px)",
      "linear-gradient(180deg, var(--plate) 0 7px, transparent 7px)",
      "linear-gradient(0deg, var(--plate) 0 7px, transparent 7px)"
    ];
    (LEVELS || []).forEach(function (lv) {
      var yTop = (ENVELOPE - lv) * S - 7;
      layers.push("linear-gradient(transparent " + yTop + "px, var(--band) " +
        yTop + "px " + (yTop + 14) + "px, transparent " + (yTop + 14) + "px)");
    });
    layers.push("repeating-linear-gradient(90deg, var(--stud) 0 3px, transparent 3px " +
      (0.6 * S) + "px)");
    return layers.join(",");
  }

  // Cripple studs, corner bracing and joist end grain. Framing mode only, and
  // built as elements rather than gradients because each one follows the
  // openings or the floor levels rather than sitting on a fixed repeat.
  function addCarpentry(el, elevKey, faceW) {
    var storeys = [0].concat(LEVELS || []).concat([ENVELOPE]);

    // Cripples carry the sill down to the deck the opening sits on. Doors
    // reach the floor, so they have none.
    JOB.windows.filter(function (w) {
      return w.elev === elevKey && !w.door;
    }).forEach(function (w) {
      var floor = 0;
      storeys.forEach(function (lv) { if (lv <= w.y + 0.001) floor = lv; });
      var runPx = (w.y - floor) * S - 6;
      if (runPx < 8) return;                     // sill already sits on the deck

      var x0 = w.x * S, wp = w.w / 1000 * S;
      var top = (ENVELOPE - w.y) * S + 6;        // just under the sill plate
      var n = Math.max(2, Math.round(wp / (0.6 * S)) + 1);
      for (var i = 0; i < n; i++) {
        var c = document.createElement("i");
        c.className = "cripple";
        c.style.left = (x0 + (wp - 3) * (i / (n - 1))) + "px";
        c.style.top = top + "px";
        c.style.height = runPx + "px";
        el.appendChild(c);
      }
    });

    // A let-in diagonal at each end of every storey.
    for (var s = 0; s < storeys.length - 1; s++) {
      var yb = (ENVELOPE - storeys[s]) * S;       // storey bottom, local px
      var rise = yb - (ENVELOPE - storeys[s + 1]) * S;
      if (rise < 20) continue;
      var run = Math.min(1.2 * S, faceW * 0.25);
      var len = Math.sqrt(run * run + rise * rise);
      var ang = Math.atan2(rise, run) * 180 / Math.PI;

      var bl = document.createElement("i");       // bottom-left, rising right
      bl.className = "brace";
      bl.style.left = "3px";
      bl.style.top = (yb - 9) + "px";
      bl.style.width = len + "px";
      bl.style.transform = "rotate(" + (-ang) + "deg)";
      el.appendChild(bl);

      var br = document.createElement("i");       // bottom-right, rising left
      br.className = "brace";
      br.style.left = (faceW - 3) + "px";
      br.style.top = (yb - 9) + "px";
      br.style.width = len + "px";
      br.style.transform = "rotate(" + (180 + ang) + "deg)";
      el.appendChild(br);
    }

    // Noggins: a row of blocking between the studs at mid-storey. The 3px
    // offset in the gradient lands them between studs, not across them.
    for (var t = 0; t < storeys.length - 1; t++) {
      var mid = (storeys[t] + storeys[t + 1]) / 2;
      var ng = document.createElement("i");
      ng.className = "noggins";
      ng.style.top = ((ENVELOPE - mid) * S) + "px";
      ng.style.backgroundImage = "repeating-linear-gradient(90deg, transparent 0 3px, var(--plate) 3px " +
        (0.6 * S) + "px)";
      el.appendChild(ng);
    }

    // King studs flanking each door, full storey height outside the trimmers.
    JOB.windows.filter(function (w) {
      return w.elev === elevKey && w.door;
    }).forEach(function (w) {
      var below = 0, above = ENVELOPE;
      storeys.forEach(function (lv) {
        if (lv <= w.y + 0.001) below = lv;
      });
      for (var i = 0; i < storeys.length; i++) {
        if (storeys[i] > w.y + 0.001) { above = storeys[i]; break; }
      }
      var yTop = (ENVELOPE - above) * S;
      var hPx = (above - below) * S;
      var x0 = w.x * S, wp = w.w / 1000 * S;

      [x0 - 11, x0 + wp + 7].forEach(function (x) {
        var k = document.createElement("i");
        k.className = "king";
        k.style.left = x + "px";
        k.style.top = yTop + "px";
        k.style.height = hPx + "px";
        el.appendChild(k);
      });
    });

    // Joist end grain along every rim band, and under the top plate.
    (LEVELS || []).concat([ENVELOPE]).forEach(function (lv) {
      var j = document.createElement("i");
      j.className = "joist-ends";
      j.style.top = (lv >= ENVELOPE ? 1 : (ENVELOPE - lv) * S - 5) + "px";
      j.style.height = "10px";
      el.appendChild(j);
    });
  }

  function buildHouse() {
    house.innerHTML = "";
    var FRAGS = windowFragments();
    function addWindows(el, key) {
      // stories: the face's own plate height rides along to every window.
      var seg = elevByKey(key);
      var plate = seg && seg.hM != null ? seg.base + seg.hM : ENVELOPE;
      FRAGS.filter(function (f2) { return f2.elev === key; })
        .forEach(function (f2) { el.appendChild(buildWindow(f2.win, f2.x, f2.w, f2.idx, plate)); });
    }

    // Lawn first, shadow on top of it (it sits 1px lower to avoid z-fighting).
    var lawn = document.createElement("div");
    lawn.className = "lawn";
    place(lawn, W + 320, D + 320, "translateY(" + (H / 2 + 1) + "px) rotateX(90deg)");
    house.appendChild(lawn);

    var g = document.createElement("div");
    g.className = "ground";
    place(g, W + 190, D + 190, "translateY(" + (H / 2) + "px) rotateX(90deg)");
    house.appendChild(g);

    if (FOOT) {
      // One wall per polygon edge. Each face is centred on its edge midpoint
      // and yawed to the edge's outward normal; window x-offsets then run
      // from the edge's first vertex exactly as on a box wall.
      ELEVS.forEach(function (e) {
        var el = document.createElement("div");
        el.className = "face f-front";
        el.dataset.elev = e.key;
        // stories: a wall spans ITS story's band, not the whole envelope —
        // face height is the story height, and the face rises so its centre
        // sits at the story's own mid-height above the ground plane.
        var fh = (e.hM != null ? e.hM : ENVELOPE) * S;
        var base = (e.base || 0) * S;
        var ty = H / 2 - base - fh / 2;
        el.dataset.story = e.story || 1;
        var mx = ((e.x1 + e.x2) / 2 - FCX) * S;
        var mz = ((e.z1 + e.z2) / 2 - FCZ) * S;
        place(el, e.len * S, fh,
          "translate3d(" + mx + "px," + ty + "px," + mz + "px) rotateY(" + e.A + "deg)");
        if (FRAMING) {
          el.classList.add("framing");
          el.style.backgroundImage = frameLayers();
        }
        house.appendChild(el);
        addWindows(el, e.key);
        if (FRAMING) addCarpentry(el, e.key, e.len * S);
      });
    } else {
      faceSpec().forEach(function (f) {
        var el = document.createElement("div");
        el.className = "face " + f.cls;
        el.dataset.elev = f.key;
        place(el, f.w, f.h, f.t);
        if (FRAMING) {
          el.classList.add("framing");
          el.style.backgroundImage = frameLayers();
        }
        house.appendChild(el);

        addWindows(el, f.key);

        if (FRAMING) addCarpentry(el, f.key, f.w);
      });
    }

    // Pitched roof, gables and chimney only when there is a pitch to hang
    // them on; a flat-roofed frame gets joisted decks instead.
    if (R > 0.03 * S) {
      // At frame stage the roof is rafters and open gables, not tiles.
      var roofCls = FRAMING ? " framing" : "";

      var rf = document.createElement("div");
      rf.className = "roof roof-a" + roofCls;
      place(rf, W, SLOPE, "translateY(" + (-(H / 2) - R / 2) + "px) translateZ(" + (D / 4) + "px) rotateX(" + TILT + "deg)");
      house.appendChild(rf);

      var rb = document.createElement("div");
      rb.className = "roof roof-b" + roofCls;
      place(rb, W, SLOPE, "translateY(" + (-(H / 2) - R / 2) + "px) translateZ(" + (-D / 4) + "px) rotateX(" + (-TILT) + "deg)");
      house.appendChild(rb);

      [["right", 90], ["left", -90]].forEach(function (p) {
        var gb = document.createElement("div");
        gb.className = "gable" + roofCls;
        place(gb, D, R, "rotateY(" + p[1] + "deg) translateZ(" + (W / 2) + "px) translateY(" + (-(H / 2) - R / 2) + "px)");
        house.appendChild(gb);
      });
    }

    if (!FRAMING && R > 0.03 * S) {
      // Chimney stack straddling the ridge, sunk into the roof so its base is
      // hidden regardless of pitch.
      var chW = 0.55 * S, chD = 0.55 * S, chH = 1.05 * S;
      var ridgeY = -(H / 2) - R;
      var chX = -W * 0.22;
      [[0, chD / 2, chW], [180, chD / 2, chW], [90, chW / 2, chD], [-90, chW / 2, chD]]
        .forEach(function (p) {
          var f = document.createElement("div");
          f.className = "chimney";
          place(f, p[2], chH,
            "translate3d(" + chX + "px," + ridgeY + "px,0) rotateY(" + p[0] + "deg) translateZ(" + p[1] + "px)");
          house.appendChild(f);
        });
      var cap = document.createElement("div");
      cap.className = "chimney-cap";
      place(cap, chW + 5, chD + 5,
        "translate3d(" + chX + "px," + (ridgeY - chH / 2) + "px,0) rotateX(90deg)");
      house.appendChild(cap);
    }

    if (FRAMING) {
      // Joisted deck at each floor level and across the top.
      (LEVELS || []).concat([ENVELOPE]).forEach(function (lv) {
        var d = document.createElement("div");
        d.className = "deck";
        place(d, W, D, "translateY(" + (H / 2 - lv * S) + "px) rotateX(90deg)");
        house.appendChild(d);
      });
    }

    if (!FRAMING && R <= 0.03 * S) {
      // A finished building with no pitch still needs a lid: membrane roof
      // with the fascia reading as the parapet cap.
      var fr = document.createElement("div");
      fr.className = "flatroof";
      place(fr, W + 6, D + 6, "translateY(" + (-(H / 2) - 1) + "px) rotateX(90deg)");
      if (FOOT) {
        // Clip the lid to the plan shapes - one subpath per building, so a
        // detached garage gets its own roof island with a real gap between.
        fr.style.clipPath = "path('" + FOOT.map(function (fp) {
          return "M" + fp.map(function (p) {
            return ((p.x - FMINX) * S + 3).toFixed(1) + " " +
                   ((p.z - FMINZ) * S + 3).toFixed(1);
          }).join(" L") + " Z";
        }).join(" ") + "')";
      }
      house.appendChild(fr);
    }
  }

  var OPEN_SYMBOL = {
    "hinge-l": "100,2 2,50 100,98",
    "hinge-r": "0,2 98,50 0,98",
    "hinge-t": "2,100 50,2 98,100",
    "bipart": null,   /* center-opening pair - drawn as slide arrows, not a hinge apex */
    "fixed": null
  };

  /* Dashed slide-direction arrow, Strata drawing style. dir "l" or "r". */
  function slideArrow(el, leftPx, topPx, wPx, hPx, dir) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 100 100");
    s.setAttribute("preserveAspectRatio", "none");
    s.style.left = leftPx + "px";
    s.style.top = topPx + "px";
    s.style.width = wPx + "px";
    s.style.height = hPx + "px";
    var pts = dir === "l" ? ["70,50 18,50", "34,32 18,50 34,68"]
                          : ["30,50 82,50", "66,32 82,50 66,68"];
    pts.forEach(function (p) {
      var pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("points", p);
      s.appendChild(pl);
    });
    el.appendChild(s);
  }

  // stories: `plate` is the absolute height of the top of the face this
  // window sits on (story datum + story height); the envelope for legacy.
  function buildWindow(win, fx, fw, fragIdx, plate) {
    if (plate == null) plate = ENVELOPE;
    var el = document.createElement("button");
    if (fx === undefined) { fx = win.x; fw = win.w; fragIdx = 0; }
    fragIdx = fragIdx || 0;
    var isMain = fragIdx === 0;
    var wp = fw / 1000 * S, hp = win.h / 1000 * S;

    el.className = "win" + (!FRAMING && win.obscure ? " obscure" : "") +
      (win.door ? " door" : "") + (FRAMING ? " rough" : "");
    el.type = "button";
    el.dataset.id = win.id;
    el.style.setProperty("--wc", "var(" + STATUS[win.status].css + ")");
    el.style.width = wp + "px";
    el.style.height = hp + "px";
    el.style.left = (fx * S) + "px";
    el.style.top = ((plate - win.y - win.h / 1000) * S) + "px";
    el.setAttribute("aria-label",
      win.id + ", " + win.type + ", width " + inches(win.w) + " by length " +
      inches(win.h) + ", " + STATUS[win.status].label +
      (isMain ? "" : ", corner return"));

    if (FRAMING) {
      // Rough opening: jack studs each side; header and sill come from CSS.
      var jl = document.createElement("i");
      jl.className = "jack";
      jl.style.left = "0";
      el.appendChild(jl);
      var jr = document.createElement("i");
      jr.className = "jack";
      jr.style.right = "0";
      el.appendChild(jr);

      // Threshold trimmer where the sole plate is cut away for a door.
      if (win.door) {
        var th = document.createElement("i");
        th.className = "threshold";
        el.appendChild(th);
      }
    }

    // Real pane layout for this piece, straight off the spec sheet:
    // panes = widths in mm, outside view left to right; panesSplit = one such
    // array per leg of a corner unit; vpanes = stacked heights top to bottom
    // (negative = solid spacer, like #1's aluminum tube). Units without pane
    // data fall back to lightsSplit / lights equal divisions.
    var fragPanes = null, hasMM = false;
    if (win.legs && win.panesSplit) { fragPanes = win.panesSplit[fragIdx] || null; hasMM = !!fragPanes; }
    else if (isMain && win.panes) { fragPanes = win.panes; hasMM = true; }
    if (!fragPanes) {
      var eq = (win.lightsSplit && win.legs) ? win.lightsSplit[fragIdx]
             : (isMain ? (win.lights || 1) : 0);
      if (eq) { fragPanes = []; for (var qi = 0; qi < eq; qi++) fragPanes.push(1); }
    }
    var nP = fragPanes ? fragPanes.length : 0;
    var paneOff = 0;      // doorPanes indices count across all legs
    if (win.legs && win.panesSplit) {
      for (var oi = 0; oi < fragIdx; oi++) paneOff += (win.panesSplit[oi] || []).length;
    }
    var edges = [0];      // cumulative pane boundaries in px
    if (nP) {
      var tot = 0, ci;
      for (ci = 0; ci < nP; ci++) tot += fragPanes[ci];
      var acc = 0;
      for (ci = 0; ci < nP; ci++) { acc += fragPanes[ci]; edges.push(wp * acc / tot); }
    }
    function isDoorPane(i2) {
      return !!(win.doorPanes && win.doorPanes.indexOf(paneOff + i2) >= 0);
    }

    if (!FRAMING && nP) {
    for (var i = 1; i < nP; i++) {
      var m = document.createElement("i");
      m.className = "mull";
      m.style.left = (edges[i] - 1) + "px";
      el.appendChild(m);
    }

    // Per-pane width labels, so every piece of glass reads its own size.
    // They sit at the very top, clear of the mid-glass opening marks and
    // the W x L tag below.
    if (hasMM && nP > 1) {
      for (i = 0; i < nP; i++) {
        var paneW = edges[i + 1] - edges[i];
        var pd = document.createElement("i");
        // Horizontal text won't fit a narrow pane, but skipping the label
        // (as the prototype did) left slim side lights and corner returns
        // undimensioned - the one pane a crew is least sure about. Run the
        // label vertically instead, like a dimension on a drawing.
        pd.className = paneW < 26 ? "pdim pdim-v" : "pdim";
        pd.textContent = inches(fragPanes[i]);
        pd.style.left = edges[i] + "px";
        // 3x width to match the 3x-oversampled text, scaled back in CSS
        pd.style.width = (paneW * 3) + "px";
        el.appendChild(pd);
      }
    }

    // Stacked panes (#1: glass over tube over glass) - horizontal breaks,
    // a solid band for the spacer, and a height label per pane.
    if (win.vpanes && isMain) {
      var vtot = 0, vi;
      for (vi = 0; vi < win.vpanes.length; vi++) vtot += Math.abs(win.vpanes[vi]);
      var vacc = 0;
      for (vi = 0; vi < win.vpanes.length; vi++) {
        var vh = Math.abs(win.vpanes[vi]);
        if (win.vpanes[vi] < 0) {
          var tube = document.createElement("i");
          tube.className = "tube";
          tube.style.top = (hp * vacc / vtot) + "px";
          tube.style.height = Math.max(2, hp * vh / vtot) + "px";
          el.appendChild(tube);
        } else if (vi > 0 && win.vpanes[vi - 1] > 0) {
          var vt = document.createElement("i");
          vt.className = "tran";
          vt.style.top = (hp * vacc / vtot - 1) + "px";
          el.appendChild(vt);
        }
        if (win.vpanes[vi] > 0 && hp * vh / vtot > 18) {
          var vl = document.createElement("i");
          vl.className = "pdim";
          vl.style.left = "0";
          vl.style.width = (wp * 3) + "px";
          vl.style.top = (hp * (vacc + vh / 2) / vtot - 4) + "px";
          vl.textContent = inches(vh);
          el.appendChild(vl);
        }
        vacc += vh;
      }
    }

    if (win.tran && isMain) {
      var t = document.createElement("i");
      t.className = "tran";
      t.style.top = (hp * win.tran) + "px";
      el.appendChild(t);
    }

    // Kick plate: only under the actual door leaves when the pane layout
    // says which they are, else across the whole unit as before.
    if (win.door) {
      var kicks = [];
      if (win.doorPanes && hasMM) {
        for (i = 0; i < nP; i++) {
          if (isDoorPane(i)) kicks.push([edges[i], edges[i + 1] - edges[i]]);
        }
      } else {
        kicks.push([0, wp]);
      }
      kicks.forEach(function (kk) {
        var k = document.createElement("i");
        k.className = "kick";
        k.style.left = kk[0] + "px";
        k.style.width = kk[1] + "px";
        k.style.right = "auto";
        k.style.height = (hp * 0.30) + "px";
        el.appendChild(k);
      });
    }

    // Center-opening pair: two handles meet at the middle stile and the
    // middle panels travel outward, away from each other.
    if (win.open === "bipart" && nP >= 2) {
      el.classList.add("bipart");
      var midR = Math.floor(nP / 2), midL = midR - 1;
      var stile = edges[midR];              // the meeting boundary
      var chl = document.createElement("i");
      chl.className = "chandle";
      chl.style.left = (stile - 6) + "px";
      el.appendChild(chl);
      var chr = document.createElement("i");
      chr.className = "chandle";
      chr.style.left = (stile + 3) + "px";
      el.appendChild(chr);

      if (hp > 22) {
        var lw1 = edges[midL + 1] - edges[midL], lw2 = edges[midR + 1] - edges[midR];
        if (lw1 > 20) slideArrow(el, edges[midL] + 4, hp * 0.34, lw1 - 8, hp * 0.16, "l");
        if (lw2 > 20) slideArrow(el, edges[midR] + 4, hp * 0.34, lw2 - 8, hp * 0.16, "r");
      }
    }

    // Corner-meet slider (open: "corner-meet"): the operating panels meet at
    // the 90-degree corner and slide AWAY from it, stacking onto the fixed
    // panel marked F on the spec sheet. One handle sits each side of the
    // corner, so both render pieces get one at their corner edge.
    if (win.open === "corner-meet" && win.wrap && nP) {
      var cornerRight = isMain ? (win.wrap === "end") : (win.wrap === "start");
      el.classList.add(cornerRight ? "cmeet-r" : "cmeet-l");

      var ch = document.createElement("i");
      ch.className = "chandle";
      ch.style.left = (cornerRight ? wp - 7 : 4) + "px";
      el.appendChild(ch);

      // Panes counted outward from the corner: the sliders come first, then
      // the fixed F panel they stack onto. A hinged leaf ends the run.
      var nArrows = Math.min(2, Math.max(1, nP - 1)), placed = 0, ai;
      if (hp > 22) {
        for (ai = 0; ai < nP && placed < nArrows; ai++) {
          var p2 = cornerRight ? nP - 1 - ai : ai;
          if (isDoorPane(p2)) break;
          var px0 = edges[p2], pw2 = edges[p2 + 1] - edges[p2];
          if (pw2 > 20) slideArrow(el, px0 + 4, hp * 0.34, pw2 - 8, hp * 0.16,
            cornerRight ? "l" : "r");
          placed++;
        }
        var fp = cornerRight ? nP - 1 - placed : placed;
        if (fp >= 0 && fp < nP && !isDoorPane(fp)) {
          var fg = document.createElement("i");
          fg.className = "fglyph";
          fg.textContent = "F";
          fg.style.left = ((edges[fp] + edges[fp + 1]) / 2 - 3) + "px";
          fg.style.top = (hp * 0.38) + "px";
          el.appendChild(fg);
        }
      }
    }
    }

    // Opening-direction symbol. Drawing convention: the apex points to the hinge.
    // It is drawn over the light that actually opens, not the whole frame, so a
    // 2-light casement doesn't read as if both lights are openers.
    function drawOpenSymbol(box, symPts) {
      if (box.w <= 26 || box.h <= 22) return;
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.style.left = (box.l + 3) + "px";
      svg.style.top = (box.t + 3) + "px";
      svg.style.width = (box.w - 6) + "px";
      svg.style.height = (box.h - 6) + "px";
      var pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("points", symPts);
      svg.appendChild(pl);
      el.appendChild(svg);
    }

    if (!FRAMING && nP && win.doorPanes && hasMM) {
      // The sheet says exactly which panes are hinged leaves - one diagonal
      // per leaf, apex to the hinge. A pair hinges at its outer stiles; a
      // lone leaf follows the unit's hinge side, else hinges away from the
      // adjoining glass.
      var leaves = [];
      for (var di = 0; di < nP; di++) if (isDoorPane(di)) leaves.push(di);
      leaves.forEach(function (pi, k3) {
        var dir;
        if (leaves.length === 2) dir = k3 === 0 ? "hinge-l" : "hinge-r";
        else if (win.open === "hinge-l" || win.open === "hinge-r") dir = win.open;
        else dir = pi === nP - 1 ? "hinge-r" : "hinge-l";
        drawOpenSymbol({ l: edges[pi], t: 0, w: edges[pi + 1] - edges[pi], h: hp },
          OPEN_SYMBOL[dir]);
      });
    } else {
      var pts = OPEN_SYMBOL[win.open];
      if (pts && !FRAMING && nP && isMain) {
        var box = { l: 0, t: 0, w: wp, h: hp };
        if (win.open === "hinge-l") { box.w = edges[1]; }
        else if (win.open === "hinge-r") { box.l = edges[nP - 1]; box.w = wp - edges[nP - 1]; }
        else if (win.open === "hinge-t" && win.tran) { box.h = hp * win.tran; }
        drawOpenSymbol(box, pts);
      }
    }

    if (isMain) {
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = win.id;
      el.appendChild(chip);
    }

    // Width stacked over height with a hairline between, so the annotation
    // fits inside narrow openings instead of overflowing the frame.
    // A corner unit gets one tag per leg - fw is this piece's own width, so
    // each wall reads its own measurement instead of one combined total.
    if ((isMain || win.legs) && wp > 27 && hp > 30) {
      var dim = document.createElement("span");
      dim.className = "dim";
      dim.innerHTML = "W " + inches(fw) + "<i></i>L " + inches(win.h);
      el.appendChild(dim);
    }

    if (isMine(win)) el.classList.add("mine");

    // Keyboard activation; pointer taps arrive via the stage's capture path.
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      tapWindow(win.id);
    });

    if (fragIdx === 0) winEls[win.id] = el;
    else if (fragIdx === 1) winEls2[win.id] = el;
    else winEls3[win.id] = el;
    return el;
  }

  /* Frame one unit like a hand would: square to its wall, engage Pan, zoom
     in, slide it to centre, open its sheet. Used by the schedule rows. */
  var focusGen = 0;

  function focusUnit(win) {
    var gen = ++focusGen;                 // any newer focus supersedes this one
    var e = elevByKey(win.elev);
    if (!e) { select(win.id); return; }
    setView("plan");
    setPanModes(true, false);
    // Ghost everything except the wall(s) this unit lives on, so a unit
    // facing a courtyard or the gap between buildings is never hidden
    // behind the rest of the model.
    house.classList.add("xray");
    Array.prototype.forEach.call(house.querySelectorAll(".face.keep, .face.gone"), function (f) {
      f.classList.remove("keep");
      f.classList.remove("gone");
    });
    // A different building would only ever be in the way: hide it outright.
    // Walls of the unit's own building just ghost, so courtyard units stay
    // visible through their own house.
    if (FOOT && e.poly !== undefined) {
      Array.prototype.forEach.call(house.querySelectorAll(".face"), function (f) {
        var fe = elevByKey(f.dataset.elev);
        if (fe && fe.poly !== e.poly) f.classList.add("gone");
      });
    }
    eachWinEl(win.id, function (piece) {
      if (piece.parentElement) piece.parentElement.classList.add("keep");
    });
    house.classList.remove("smooth");   // measure real positions, not mid-animation
    state.ax = 0;
    state.ay = e.ay;
    // A corner unit lives on two perpendicular walls; face-on to one leg the
    // other is edge-on and invisible. Split the difference so the 90-degree
    // turn actually reads.
    if (win.legs && win.wrap) {
      var e2 = win.wrap === "end" ? segAfter(e) : segBefore(e);
      if (e2) {
        var r1 = e.ay * Math.PI / 180, r2b = e2.ay * Math.PI / 180;
        state.ay = Math.atan2(
          Math.sin(r1) + Math.sin(r2b),
          Math.cos(r1) + Math.cos(r2b)) * 180 / Math.PI;
      }
    }
    fit(true);
    render();
    // The zoom lives inside a perspective projection, so screen growth is
    // nonlinear in the scale factor: iterate damped zoom-only steps until the
    // unit is the right size, then one exact screen-space pan to centre it.
    var tries = 0, lastFrac = 0, lastZoom = 0;

    // Frame every render piece of the unit, not just the main leg - a corner
    // unit viewed at an angle spans both walls.
    function unionRect(id) {
      var u = null;
      eachWinEl(id, function (p) {
        var b = p.getBoundingClientRect();
        if (!b.width && !b.height) return;
        u = u ? { left: Math.min(u.left, b.left), top: Math.min(u.top, b.top),
                  right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom) }
              : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      });
      return u && { left: u.left, top: u.top,
                    width: u.right - u.left, height: u.bottom - u.top };
    }

    function settle(el, sr) {
      if (gen !== focusGen) return;
      var r = unionRect(win.id) || el.getBoundingClientRect();
      var ux = r.left + r.width / 2 - (sr.left + sr.width / 2);
      var uy = r.top + r.height / 2 - (sr.top + sr.height / 2);
      var ty = sr.height * -0.12;               // nudged up clear of the sheet
      state.panX += -ux;
      state.panY += ty - uy;
      applyPan();
      // pan is exact in screen space, so one residual pass nails the centre
      requestAnimationFrame(function () {
        if (gen !== focusGen) return;
        var r2 = unionRect(win.id) || el.getBoundingClientRect();
        state.panX -= r2.left + r2.width / 2 - (sr.left + sr.width / 2);
        state.panY -= (r2.top + r2.height / 2 - (sr.top + sr.height / 2)) - ty;
        applyPan();
        select(win.id, true);
      });
    }

    function frameStep() {
      if (gen !== focusGen) return;
      var el = winEls[win.id];
      if (!el) { select(win.id); return; }
      var r = unionRect(win.id) || el.getBoundingClientRect();
      var sr = stage.getBoundingClientRect();
      var frac = Math.max(r.width, r.height, 1) / Math.min(sr.width, sr.height);
      // Zooming in must make things bigger; if the rect collapsed or shrank,
      // the wall crossed the camera plane - back off and settle there.
      if ((r.width < 2 && r.height < 2) || (tries > 0 && frac < lastFrac * 0.9)) {
        if (lastZoom) setZoom(lastZoom);
        requestAnimationFrame(function () { settle(el, sr); });
        return;
      }
      if ((frac < 0.36 || frac > 0.56) && tries < 8) {
        lastFrac = frac;
        lastZoom = state.zoom;
        tries++;
        setZoom(state.zoom * Math.pow(0.45 / frac, 0.8));
        requestAnimationFrame(frameStep);
        return;
      }
      settle(el, sr);
    }
    requestAnimationFrame(frameStep);
  }

  /* One front door for every way of tapping a window: spec sheet normally,
     pick/unpick while assigning. */
  function tapWindow(id) {
    if (state.assignMode) togglePick(id);
    else select(id);
  }

  /* ---------- camera ---------- */

  function render() {
    var lodFar = state.zoom < 0.45;
    if (lodFar !== render._lod) {
      render._lod = lodFar;
      house.classList.toggle("lod-far", lodFar);
    }
    // ID chips grow as the model shrinks, so the tags stay readable from afar.
    house.style.setProperty("--chipscale",
      Math.max(1, Math.min(1.8, 0.35 / state.zoom)).toFixed(2));
    house.style.transform =
      "rotateX(" + state.ax + "deg) rotateY(" + state.ay + "deg) " +
      "scale3d(" + state.zoom + "," + state.zoom + "," + state.zoom + ") " +
      "translateY(" + YOFF + "px)";
  }

  // Horizontal extent of the footprint at the current yaw. Fitting to this rather
  // than to the largest dimension means a flat elevation fills the width, which is
  // where the annotations actually need to be readable.
  function fit(reset) {
    var w = stage.clientWidth || 360;
    var h = stage.clientHeight || 380;
    var rad = state.ay * Math.PI / 180;
    var span = Math.abs(W * Math.cos(rad)) + Math.abs(D * Math.sin(rad));
    var tall = H + R + 0.55 * S;      // headroom for the chimney above the ridge
    var f = Math.min((w * 0.92) / span, (h * 0.88) / tall, 1.3);
    // Keep the user's zoom-in ratio across refits unless explicitly reset.
    var ratio = (!reset && state.fitZoom) ? state.zoom / state.fitZoom : 1;
    if (reset) { state.panX = 0; state.panY = 0; applyPan(); }
    state.fitZoom = f;
    state.zoom = f * Math.max(0.4, Math.min(8, ratio));
    render();
  }

  function applyPan() {
    persp.style.transform = "translate(" + state.panX + "px," + state.panY + "px)";
  }

  /* Zoom to a screen point (coordinates relative to the stage centre), so the
     window under your finger or cursor stays put while everything grows. */
  function setZoom(z, cx, cy) {
    var nz = Math.max(state.fitZoom * 0.2, Math.min(state.fitZoom * 40, z));
    if (cx !== undefined) {
      var k = nz / state.zoom;
      state.panX = cx - k * (cx - state.panX);
      state.panY = cy - k * (cy - state.panY);
      applyPan();
    }
    state.zoom = nz;
    render();
  }

  function goTo(key) {
    // Jumping to an elevation is a fresh framing: leave any pan mode first,
    // so the camera and the highlighted button can never disagree.
    if (state.panMode || state.panPlus) setPanModes(false, false);
    var e = ELEVS.filter(function (x) { return x.key === key; })[0];
    if (!e) { state.ax = -16; state.ay = 0; }   // standard view: from the south
    else { state.ax = e.ax || 0; state.ay = e.ay; }
    house.classList.add("smooth");
    clearTimeout(goTo._t);
    goTo._t = setTimeout(function () { house.classList.remove("smooth"); }, 500);
    fit(true);      // snapping to an elevation reframes cleanly
    syncElevChips();
  }

  function normalise(a) { return ((a % 360) + 360) % 360; }

  function activeElev() {
    if (Math.abs(state.ax) > 8) return null;
    var a = normalise(state.ay);
    var hit = null;
    ELEVS.forEach(function (e) {
      var d = Math.abs(normalise(e.ay) - a);
      d = Math.min(d, 360 - d);
      if (d < 6) hit = e.key;
    });
    return hit;
  }

  /* ---------- gestures: orbit, tap, pinch-zoom, pan ---------- */

  var pointers = {};   // active pointerId -> {x, y}
  var drag = null;     // single-finger orbit / tap state
  var pinch = null;    // two-finger zoom + pan state

  function stageCentre() {
    var r = stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  stage.addEventListener("pointerdown", function (e) {
    // Presses on the zoom controls are theirs alone: capturing them would
    // swallow the button clicks entirely.
    if (e.target.closest && e.target.closest(".zoomctl")) return;
    // The stage takes pointer capture for its gestures, which swallows the
    // click a window button would otherwise get - so remember what the tap
    // started on and resolve it ourselves on release.
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);

    if (ids.length === 1) {
      var winEl = e.target && e.target.closest ? e.target.closest(".win") : null;
      drag = { x: e.clientX, y: e.clientY, ax: state.ax, ay: state.ay,
               px: state.panX, py: state.panY, moved: 0,
               win: winEl ? winEl.dataset.id : null, multi: false };
      house.classList.remove("smooth");
    } else if (ids.length === 2) {
      // Second finger down: the gesture becomes pinch-zoom + pan, never a tap.
      if (drag) drag.multi = true;
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var c = stageCentre();
      pinch = {
        d: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)),
        cx: (a.x + b.x) / 2 - c.x, cy: (a.y + b.y) / 2 - c.y,
        zoom: state.zoom, panX: state.panX, panY: state.panY
      };
    }
  });

  stage.addEventListener("pointermove", function (e) {
    if (!pointers[e.pointerId]) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);

    if (ids.length >= 2 && pinch) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var c = stageCentre();
      var d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
      var cx = (a.x + b.x) / 2 - c.x, cy = (a.y + b.y) / 2 - c.y;
      var nz = Math.max(state.fitZoom * 0.2,
                Math.min(state.fitZoom * 40, pinch.zoom * (d / pinch.d)));
      var k = nz / pinch.zoom;
      // Scale around where the pinch began, then follow the fingers to pan.
      state.panX = pinch.cx - k * (pinch.cx - pinch.panX) + (cx - pinch.cx);
      state.panY = pinch.cy - k * (pinch.cy - pinch.panY) + (cy - pinch.cy);
      state.zoom = nz;
      applyPan();
      render();
      return;
    }

    if (drag && !drag.multi) {
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      if (state.panPlus) {
        state.panX = drag.px + dx;
        state.ax = Math.max(-70, Math.min(28, drag.ax + dy * 0.32));
        applyPan();
        render();
      } else if (state.panMode) {
        state.panX = drag.px + dx;
        state.panY = drag.py + dy;
        applyPan();
      } else {
        state.ay = drag.ay + dx * 0.45;
        state.ax = Math.max(-70, Math.min(28, drag.ax + dy * 0.32));
        render();
        syncElevChips();
      }
    }
  });

  ["pointerup", "pointercancel"].forEach(function (ev) {
    stage.addEventListener(ev, function (e) {
      delete pointers[e.pointerId];
      try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
      var left = Object.keys(pointers).length;
      if (left < 2) pinch = null;

      // A release that barely moved, with no second finger ever involved, is a
      // tap: on a window it opens the spec (or picks it in assign mode), on
      // empty wall or sky it closes whatever is open.
      if (drag && !drag.multi && drag.moved < 5 && ev === "pointerup") {
        if (drag.win) tapWindow(drag.win);
        else if (!state.assignMode) select(null);
      }
      if (!left) drag = null;
    });
  });

  // Desktop: scroll (or trackpad pinch) zooms toward the cursor.
  stage.addEventListener("wheel", function (e) {
    e.preventDefault();
    var c = stageCentre();
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.0018),
      e.clientX - c.x, e.clientY - c.y);
  }, { passive: false });

  /* Level the camera and square the yaw to the nearest wall - both pan modes
     start from a flat elevation view with a dead-straight horizon. */
  function squareUp() {
    var bestD = 1e9, bestAy = state.ay;
    ELEVS.forEach(function (e) {
      if (e.ay == null) return;
      var d = state.ay - e.ay;
      d = ((d % 360) + 540) % 360 - 180;   // shortest signed turn
      if (Math.abs(d) < Math.abs(bestD)) { bestD = d; bestAy = state.ay - d; }
    });
    state.ax = 0;
    state.ay = bestAy;
    house.classList.add("smooth");
    setTimeout(function () { house.classList.remove("smooth"); }, 500);
    render();
    syncElevChips();
  }

  var HINT_DEFAULT = "Drag to orbit &middot; pinch or scroll to zoom &middot; tap a window for its spec";

  function setPanModes(pan, plus) {
    state.panMode = pan;
    state.panPlus = plus;
    $("zpan").setAttribute("aria-pressed", String(pan));
    $("zpanp").setAttribute("aria-pressed", String(plus));
    // A flatter projection while panning: squared views read straight-on,
    // and close walls stop blowing past the camera at high zoom.
    persp.style.perspective = (pan || plus) ? "6000px" : "";
    if (pan || plus) {
      squareUp();
      $("hint").innerHTML = plus
        ? "Pan + on: drag down to tilt, sideways to slide - the horizon stays straight. Tap Pan + to finish"
        : "Pan on: drag your door to centre, zoom in &middot; tap Pan again to finish";
    } else {
      house.classList.remove("xray");
      Array.prototype.forEach.call(house.querySelectorAll(".face.keep, .face.gone"), function (f) {
        f.classList.remove("keep");
        f.classList.remove("gone");
      });
      fit(true);
      $("hint").innerHTML = HINT_DEFAULT;
    }
  }

  $("zpan").addEventListener("click", function () {
    setPanModes(!state.panMode, false);
  });

  $("zpanp").addEventListener("click", function () {
    setPanModes(false, !state.panPlus);
  });

  $("zin").addEventListener("click", function () { setZoom(state.zoom * 1.35, 0, 0); });
  $("zout").addEventListener("click", function () { setZoom(state.zoom / 1.35, 0, 0); });
  $("zfit").addEventListener("click", function () { fit(true); });

  stage.addEventListener("keydown", function (e) {
    var step = 8;
    if (e.key === "ArrowLeft") { state.ay -= step; }
    else if (e.key === "ArrowRight") { state.ay += step; }
    else if (e.key === "ArrowUp") { state.ax = Math.max(-70, state.ax - step); }
    else if (e.key === "ArrowDown") { state.ax = Math.min(28, state.ax + step); }
    else if (e.key === "+" || e.key === "=") { setZoom(state.zoom * 1.25, 0, 0); return e.preventDefault(); }
    else if (e.key === "-" || e.key === "_") { setZoom(state.zoom / 1.25, 0, 0); return e.preventDefault(); }
    else if (e.key === "0") { fit(true); return e.preventDefault(); }
    else return;
    e.preventDefault();
    render();
    syncElevChips();
  });
  stage.tabIndex = 0;

  /* ---------- selection + sheet ---------- */

  function select(id, quiet) {
    state.sel = id;

    Object.keys(winEls).forEach(function (k) {
      eachWinEl(k, function (el) { el.classList.toggle("sel", k === id); });
    });
    Array.prototype.forEach.call(ROOT.querySelectorAll(".row"), function (r) {
      r.classList.toggle("sel", r.dataset.id === id);
    });

    if (quiet) {
      // Highlight without covering the model - the sheet is one tap away.
      sheet.classList.remove("open");
      scrim.classList.remove("on");
      return;
    }

    if (!id) {
      sheet.classList.remove("open");
      scrim.classList.remove("on");
      return;
    }

    var win = byId(id);
    if (!win) return;

    sheet.innerHTML = sheetHTML(win);
    sheet.classList.add("open");
    scrim.classList.add("on");

    sheet.querySelector(".sh-close").addEventListener("click", function () { select(null); });

    function change(next) {
      // The host owns persistence; the shim callback applies + queues it.
      if (!SHIM.onStatusChange) return;
      win.status = next;
      SHIM.onStatusChange(win, next);
      refreshWindowStyle(win);
      select(win.id);
      renderCounts();
      renderRows();
      syncElevChips();
    }

    var actBtn = sheet.querySelector("[data-act]");
    if (actBtn) actBtn.addEventListener("click", function () {
      change(win.status === "installed" ? "tofit" : "installed");
    });
    var flagBtn = sheet.querySelector("[data-flag]");
    if (flagBtn) flagBtn.addEventListener("click", function () {
      change(win.status === "issue" ? "tofit" : "issue");
    });
    var openBtn = sheet.querySelector("[data-open]");
    if (openBtn) openBtn.addEventListener("click", function () {
      SHIM.openOpening(win.id, win);
    });

    if (SHIM.photos) renderSheetPhotos(win);
  }

  function renderSheetPhotos(win) {
    var host = $("sh-pgrid");
    if (!host) return;
    host.innerHTML = "";

    (win.photos || []).forEach(function (p) {
      var t = document.createElement("div");
      t.className = "pthumb";
      t.innerHTML = '<span class="pwait">Loading</span>';
      SHIM.photos.photoURL(p.id).then(function (url) {
        if (!url) {
          t.querySelector(".pwait").textContent = "No copy on this device";
          return;
        }
        t.innerHTML = "";
        var img = document.createElement("img");
        img.alt = "Photo of " + win.id + (p.by ? " by " + p.by : "");
        img.src = url;
        img.style.cursor = "zoom-in";
        img.addEventListener("click", function () {
          $("lb-img").src = url;
          $("lb-cap").textContent = win.id +
            (p.by ? " \u00B7 " + p.by : "") +
            (p.at ? " \u00B7 " + new Date(p.at).toLocaleDateString() : "");
          $("lightbox").classList.add("on");
        });
        t.appendChild(img);
      });
      host.appendChild(t);
    });
  }

  function refreshWindowStyle(win) {
    eachWinEl(win.id, function (el) {
      el.style.setProperty("--wc", "var(" + STATUS[win.status].css + ")");
    });
  }

  function byId(id) {
    return JOB.windows.filter(function (w) { return w.id === id; })[0];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function sheetHTML(win) {
    var st = STATUS[win.status];
    var elevRec = ELEVS.filter(function (e) { return e.key === win.elev; })[0];
    var elevName = elevRec ? elevRec.name : "Not on the model";
    var hasScan = !!(win.scan && win.scan.length === 2);
    var dw = hasScan ? Math.abs(win.scan[0] - win.w) : 0;
    var dh = hasScan ? Math.abs(win.scan[1] - win.h) : 0;
    var drift = Math.max(dw, dh);

    return '' +
      '<div class="sh-head">' +
        '<div style="flex:1">' +
          '<div class="sh-id">' + esc(win.id) + '</div>' +
          '<div class="sh-type">' + esc(win.type) + '</div>' +
        '</div>' +
        '<span class="pill" style="background:var(' + st.css + ')">' + esc(st.label) + '</span>' +
        '<button class="sh-close" aria-label="Close">&#10005;</button>' +
      '</div>' +

      '<div class="sh-dim">' +
        '<div class="dim-lab">Survey measured - order size</div>' +
        '<div class="dim-big">W ' + inches(win.w) + '<em>&times;</em>L ' + inches(win.h) + '</div>' +
        '<div class="dim-lab" style="margin-top:6px">' + win.w + ' x ' + win.h + ' mm on the CAD sheet</div>' +
        (hasScan ?
          '<div class="dim-scan">' +
            '<b>Scan est. W ' + inches(win.scan[0]) + ' &times; L ' + inches(win.scan[1]) + '</b>' +
            '<span class="warn">Not for ordering &middot; &plusmn;' + inches(drift) + '</span>' +
          '</div>' : '') +
      '</div>' +

      '<dl class="specs">' +
        '<div class="spec"><dt>Elevation</dt><dd>' + esc(elevName) + ' &middot; ' + esc(win.floor) + '</dd></div>' +
        '<div class="spec"><dt>Room</dt><dd>' + esc(win.room) + '</dd></div>' +
        '<div class="spec"><dt>Opening</dt><dd>' + esc(win.hand) + '</dd></div>' +
        '<div class="spec"><dt>Glazing</dt><dd>' + esc(win.glass) + '</dd></div>' +
        '<div class="spec"><dt>Frame</dt><dd>' + esc(win.frame) + '</dd></div>' +
        '<div class="spec"><dt>Assigned to</dt><dd>' +
          (assignedNames(win) ? esc(assignedNames(win)) : '<span style="color:var(--ink-3)">Unassigned</span>') +
        '</dd></div>' +
      '</dl>' +

      (win.notes ? '<div class="notes"><strong>Site notes</strong>' + esc(win.notes) + '</div>' : '') +

      (SHIM.photos ?
      '<div class="sh-photos">' +
        '<div class="dim-lab">Photos</div>' +
        '<div class="pgrid" id="sh-pgrid"></div>' +
      '</div>' : '') +

      '<div class="sh-act">' +
        (SHIM.onStatusChange ?
          '<button class="btn" data-act>' +
            (win.status === "installed" ? "Mark not fitted" : "Mark installed") +
          '</button>' +
          '<button class="btn danger" data-flag>' +
            (win.status === "issue" ? "Clear flag" : "Flag issue") +
          '</button>' : '') +
        (SHIM.openOpening ?
          '<button class="btn" data-open>Open opening &#8594;</button>' : '') +
      '</div>';
  }

  /* ---------- assignment ---------- */

  function pickedIds() {
    return Object.keys(state.picked).filter(function (k) { return state.picked[k]; });
  }

  function togglePick(id) {
    state.picked[id] = !state.picked[id];
    eachWinEl(id, function (el) { el.classList.toggle("picked", state.picked[id]); });
    var n = pickedIds().length;
    $("assignCount").textContent = n + " picked";
  }

  function enterAssign() {
    // Pan modes and their x-ray leave some walls unpickable - assigning
    // needs the whole model solid and tappable.
    if (state.panMode || state.panPlus) setPanModes(false, false);
    state.assignMode = true;
    state.picked = {};
    select(null);
    $("assignBar").hidden = false;
    $("assignBtn").setAttribute("aria-pressed", "true");
    $("assignCount").textContent = "0 picked";
    $("hint").innerHTML = "Tap openings to pick them &middot; then Assign";
  }

  function exitAssign() {
    state.assignMode = false;
    Object.keys(state.picked).forEach(function (id) {
      eachWinEl(id, function (el) { el.classList.remove("picked"); });
    });
    state.picked = {};
    $("assignBar").hidden = true;
    $("assignBtn").setAttribute("aria-pressed", "false");
    $("hint").innerHTML = "Drag to orbit &middot; pinch or scroll to zoom &middot; tap a window for its spec";
  }

  function openAssignSheet() {
    var ids = pickedIds();
    if (!ids.length) { SHIM.toast("Tap some openings first"); return; }

    sheet.innerHTML =
      '<div class="sh-head">' +
        '<div style="flex:1"><div class="sh-id">' + ids.length +
          (ids.length === 1 ? ' opening' : ' openings') + '</div>' +
        '<div class="sh-type">' + esc(ids.join(", ")) + '</div></div>' +
        '<button class="sh-close" aria-label="Close">&#10005;</button>' +
      '</div>' +
      '<div class="fsec">' +
        '<div class="flab">Assign to</div>' +
        '<div class="checks" id="crew">' +
          (EMPLOYEES.length ? EMPLOYEES.map(function (u) {
            return '<button type="button" class="chk" data-name="' + esc(u.name) +
              '" aria-pressed="false">' + esc(cap(u.name)) +
              ' &middot; ' + esc(u.role) + '</button>';
          }).join("") : '<span class="flab">No crew list on this device yet - go online once.</span>') +
        '</div>' +
      '</div>' +
      '<div class="sh-act">' +
        '<button class="btn" id="assignApply">Assign</button>' +
        '<button class="btn ghost" id="assignNone">Unassign</button>' +
      '</div>';

    sheet.classList.add("open");
    scrim.classList.add("on");
    sheet.querySelector(".sh-close").addEventListener("click", function () {
      sheet.classList.remove("open");
      scrim.classList.remove("on");
    });

    Array.prototype.forEach.call(sheet.querySelectorAll("#crew .chk"), function (b) {
      b.addEventListener("click", function () {
        b.setAttribute("aria-pressed",
          String(b.getAttribute("aria-pressed") !== "true"));
      });
    });

    function apply(names) {
      ids.forEach(function (id) {
        noopPush({ op: "assign", id: id, assigned: names });
        eachWinEl(id, function (el) {
          el.classList.toggle("mine", !!SHIM.auth && names.indexOf(SHIM.auth.user) > -1);
        });
      });
      sheet.classList.remove("open");
      scrim.classList.remove("on");
      renderRows();
      exitAssign();
      SHIM.toast(ids.length + (ids.length === 1 ? " opening" : " openings") +
        (names.length ? " assigned to " + names.map(cap).join(", ") : " unassigned"));
    }

    $("assignApply").addEventListener("click", function () {
      var names = Array.prototype.map.call(
        sheet.querySelectorAll('#crew .chk[aria-pressed="true"]'),
        function (b) { return b.dataset.name; });
      if (!names.length) { SHIM.toast("Pick at least one person, or Unassign"); return; }
      apply(names);
    });
    $("assignNone").addEventListener("click", function () { apply([]); });
  }

  $("assignBtn").addEventListener("click", function () {
    if (state.assignMode) exitAssign(); else enterAssign();
  });
  $("assignCancel").addEventListener("click", exitAssign);
  $("assignGo").addEventListener("click", openAssignSheet);

  $("pickElev").addEventListener("click", function () {
    var elev = activeElev();
    if (!elev) { SHIM.toast("Face an elevation first"); return; }
    JOB.windows.filter(function (w) { return w.elev === elev; })
      .forEach(function (w) {
        if (!state.picked[w.id]) togglePick(w.id);
      });
  });

  $("mineBtn").addEventListener("click", function () {
    var on = $("mineBtn").getAttribute("aria-pressed") !== "true";
    $("mineBtn").setAttribute("aria-pressed", String(on));
    house.classList.toggle("mine-only", on);
  });

  scrim.addEventListener("click", function () { select(null); });

  $("lightbox").addEventListener("click", function () {
    $("lightbox").classList.remove("on");
  });

  onDoc("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("lightbox").classList.contains("on")) {
      $("lightbox").classList.remove("on");
    } else if (state.sel) {
      select(null);
    }
  });

  /* ---------- chrome ---------- */

  function renderCounts() {
    var total = JOB.windows.length;
    var done = JOB.windows.filter(function (w) { return w.status === "installed"; }).length;
    var issues = JOB.windows.filter(function (w) { return w.status === "issue"; }).length;
    $("bar").style.width = (total ? done / total * 100 : 0) + "%";
    $("count").innerHTML = done + "/" + total + " fitted" + (issues ? " &middot; " + issues + " flagged" : "");
  }

  function syncElevChips() {
    var active = activeElev();
    Array.prototype.forEach.call(ROOT.querySelectorAll(".elev"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.elev === active));
    });
  }

  function buildElevStrip() {
    var strip = $("elevStrip");
    strip.innerHTML = "";

    ELEVS.forEach(function (e) {
      var items = JOB.windows.filter(function (w) { return w.elev === e.key; });
      // Complex footprints have plenty of blank walls; no chips for those.
      if (FOOT && !items.length) return;
      var open = items.filter(function (w) { return w.status !== "installed"; }).length;
      var b = document.createElement("button");
      b.className = "elev";
      b.dataset.elev = e.key;
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = esc(e.name) + " <b>" + open + "/" + items.length + "</b>";
      b.addEventListener("click", function () { goTo(e.key); });
      strip.appendChild(b);
    });

    var iso = document.createElement("button");
    iso.className = "elev";
    iso.dataset.elev = "iso";
    iso.textContent = "3D";
    iso.addEventListener("click", function () { goTo(null); });
    strip.appendChild(iso);
  }

  function buildLegend() {
    $("legend").innerHTML = Object.keys(STATUS).map(function (k) {
      return '<span><i style="background:var(' + STATUS[k].css + ')"></i>' + STATUS[k].label + '</span>';
    }).join("");
  }

  function renderRows() {
    var host = $("rows");
    var q = state.q.toLowerCase();
    host.innerHTML = "";

    var any = false;

    function matchesQ(w) {
      if (!q) return true;
      return (w.id + " " + w.type + " " + w.room + " " + w.floor).toLowerCase().indexOf(q) > -1;
    }

    function addRow(w, onModel) {
      var r = document.createElement("button");
      r.className = "row" + (state.sel === w.id ? " sel" : "");
      r.dataset.id = w.id;
      r.innerHTML =
        '<span class="row-id"><i style="background:var(' + STATUS[w.status].css + ')"></i>' + esc(w.id) + '</span>' +
        '<span><span class="row-type">' + esc(w.type) + '</span>' +
          '<span class="row-sub">' + esc(w.room) + ' &middot; ' + esc(w.floor) + ' &middot; ' + esc(STATUS[w.status].label) +
            (assignedNames(w) ? ' &middot; ' + esc(assignedNames(w)) : '') + '</span></span>' +
        '<span class="row-dim">W ' + inches(w.w) + '<s>L ' + inches(w.h) + '</s></span>';
      r.addEventListener("click", function () {
        if (onModel) focusUnit(w);
        else select(w.id);
      });
      host.appendChild(r);
    }

    var known = {};
    ELEVS.forEach(function (e) { known[e.key] = true; });

    ELEVS.forEach(function (e) {
      var items = JOB.windows.filter(function (w) {
        return w.elev === e.key && matchesQ(w);
      });
      if (!items.length) return;
      any = true;

      var g = document.createElement("div");
      g.className = "grp";
      g.innerHTML = esc(e.name) + " elevation &mdash; " + items.length + " opening" + (items.length > 1 ? "s" : "");
      host.appendChild(g);
      items.forEach(function (w) { addRow(w, true); });
    });

    // Units deliberately left off the model still exist as order lines; they
    // live here rather than haunting a wall they were never placed on.
    var off = JOB.windows.filter(function (w) {
      return !known[w.elev] && matchesQ(w);
    });
    if (off.length) {
      any = true;
      var g2 = document.createElement("div");
      g2.className = "grp";
      g2.innerHTML = "Not placed on the model &mdash; " + off.length +
        " opening" + (off.length > 1 ? "s" : "");
      host.appendChild(g2);
      off.forEach(function (w) { addRow(w, false); });
    }

    if (!any) {
      host.innerHTML = '<div class="empty">No openings match &ldquo;' + esc(state.q) + '&rdquo;</div>';
    }
  }

  function setView(v) {
    state.view = v;
    $("v-plan").classList.toggle("on", v === "plan");
    $("v-sched").classList.toggle("on", v === "sched");
    Array.prototype.forEach.call(ROOT.querySelectorAll(".tab"), function (t) {
      t.setAttribute("aria-selected", String(t.dataset.view === v));
    });
    if (v === "plan") fit();
  }

  Array.prototype.forEach.call(ROOT.querySelectorAll(".tab"), function (t) {
    t.addEventListener("click", function () { setView(t.dataset.view); });
  });

  Array.prototype.forEach.call(ROOT.querySelectorAll("[data-labels]"), function (b) {
    b.addEventListener("click", function () {
      state.labels = b.dataset.labels;
      Array.prototype.forEach.call(ROOT.querySelectorAll("[data-labels]"), function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      house.classList.remove("labels-off", "labels-id");
      if (state.labels === "off") house.classList.add("labels-off");
      if (state.labels === "id") house.classList.add("labels-id");
    });
  });

  $("q").addEventListener("input", function (e) {
    state.q = e.target.value;
    renderRows();
  });

  /* ---------- plan-view finder ---------- */

  function pqMatches(qq) {
    qq = qq.toLowerCase();
    var hits = JOB.windows.filter(function (w) {
      return (w.id + " " + w.type + " " + w.room + " " + w.floor)
        .toLowerCase().indexOf(qq) > -1;
    });
    // Exact id first, id-prefix next: Enter must never grab the wrong unit.
    hits.sort(function (a, b) {
      function rank(w) {
        var id = w.id.toLowerCase();
        return id === qq ? 0 : id.indexOf(qq) === 0 ? 1 : 2;
      }
      return rank(a) - rank(b);
    });
    return hits.slice(0, 8);
  }

  function pqRender() {
    var qq = $("pq").value.trim();
    var box = $("pqr");
    if (!qq) { box.hidden = true; return; }
    var hits = pqMatches(qq);
    // A complete ID needs no tap - but wait for the typing to pause, or
    // "3" on the way to "37" would fire its own frame and fight the real one.
    var exact = hits.filter(function (w) {
      return w.id.toLowerCase() === qq.toLowerCase();
    })[0];
    clearTimeout(pqRender._t);
    if (exact && elevByKey(exact.elev)) {
      var qNow = qq.toLowerCase();
      pqRender._t = setTimeout(function () {
        if ($("pq").value.trim().toLowerCase() !== qNow) return;
        $("pqr").hidden = true;
        focusUnit(exact);
      }, 350);
    }
    if (!hits.length) {
      box.innerHTML = '<div class="pq-row" style="cursor:default;color:var(--ink-3)">No match</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = "";
    hits.forEach(function (w) {
      var onModel = !!elevByKey(w.elev);
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pq-row";
      b.innerHTML =
        '<i style="background:var(' + STATUS[w.status].css + ')"></i>' +
        '<b>' + esc(w.id) + '</b> ' + esc(w.room) +
        '<span class="pq-sub">' + (w.door ? "Door" : "Window") +
          (onModel ? "" : " &middot; not placed") + '</span>';
      // Commit on pointerdown: a tap right after typing races the closing
      // keyboard's reflow, and by click-time the row has moved out from
      // under the finger. Pointerdown fires while the layout still holds.
      var go = function (ev) {
        if (b.dataset.done) return;
        b.dataset.done = "1";
        ev.preventDefault();
        box.hidden = true;
        if (onModel) focusUnit(w);
        else select(w.id);
      };
      b.addEventListener("pointerdown", go);
      b.addEventListener("click", go);   // keyboard activation fallback
      box.appendChild(b);
    });
    box.hidden = false;
  }

  $("pq").addEventListener("input", pqRender);
  $("pq").addEventListener("focus", pqRender);
  $("pq").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      var first = $("pqr").querySelector("button.pq-row");
      if (first) first.click();
      $("pq").blur();
    } else if (e.key === "Escape") {
      $("pqr").hidden = true;
    }
  });
  onDoc("pointerdown", function (e) {
    if (!e.target.closest || !e.target.closest(".psearch")) $("pqr").hidden = true;
  });

  onWin("resize", fit);

  /* ---------- boot ---------- */

  function startUI() {
    $("boot").hidden = true;
    ROOT.querySelector(".app").classList.remove("loading");
    $("jobRef").textContent = JOB.ref;
    $("jobAddr").textContent = JOB.addr;
    computeGeometry();
    winEls = {};
    winEls2 = {};
    winEls3 = {};
    buildHouse();
    buildElevStrip();
    buildLegend();
    renderCounts();
    renderRows();
    render();
    fit();
    syncElevChips();
  }


  // ---- host boot: replaces the prototype's Sync.onJob/auth boot ----
  JOB = job;
  startUI();

  return {
    destroy: function () {
      cleanups.forEach(function (f) { f(); });
      cleanups.length = 0;
      host.innerHTML = "";
    },
    /* Select + auto-frame a unit, e.g. from a search result. */
    focus: function (id) {
      var w = byId(id);
      if (!w) return false;
      select(id);
      focusUnit(w);
      return true;
    },
    /* Re-render with fresh data (status changes, refetch). */
    refresh: function (nextJob) {
      JOB = nextJob;
      startUI();
    }
  };
}
