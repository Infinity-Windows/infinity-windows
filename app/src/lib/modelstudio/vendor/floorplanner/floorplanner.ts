import { Floorplan } from '../model/floorplan'
import { Wall } from '../model/wall'
import { Corner } from '../model/corner'
import { FloorplannerView, floorplannerModes } from './floorplanner_view'
import { snapWallAngle } from '../../wallAngleSnap'

type FloorplannerMode = (typeof floorplannerModes)[keyof typeof floorplannerModes]

/** how much will we move a corner to make a wall axis aligned (cm) */
const snapTolerance = 25

/**
 * The Floorplanner implements an interactive tool for creation of floorplans.
 */
export class Floorplanner {
  /** */
  public mode: FloorplannerMode = floorplannerModes.MOVE

  /** */
  public activeWall: Wall | null = null

  /** */
  public activeCorner: Corner | null = null

  /** */
  public originX = 0

  /** */
  public originY = 0

  /** drawing state */
  public targetX = 0

  /** drawing state */
  public targetY = 0

  /** drawing state */
  public lastNode: Corner | null = null

  /** */
  // @ts-ignore - wallWidth is declared but not used, keeping for future use
  private wallWidth: number

  /** */
  private modeResetCallbacks: Array<(mode: FloorplannerMode) => void> = []

  /** */
  private canvasElement: HTMLCanvasElement

  /** */
  // infinity: public — the page sets view.underlayWalls (floor ghost).
  public view: FloorplannerView

  /** */
  private mouseDown = false

  /** */
  private mouseMoved = false

  /** in ThreeJS coords */
  private mouseX = 0

  /** in ThreeJS coords */
  private mouseY = 0

  /** in ThreeJS coords */
  private rawMouseX = 0

  /** in ThreeJS coords */
  private rawMouseY = 0

  /** mouse position at last click */
  private lastX = 0

  /** mouse position at last click */
  private lastY = 0

  // infinity: W1 drag-to-draw (w-walls-spec.md, 2026-08-31) — which button is
  // currently down, so DRAW mode can tell a left-press-drag (draws a wall)
  // from a right-press-drag (pans, since left now draws). event.button/
  // event.buttons aren't otherwise tracked here.
  private mouseButton = 0

  // infinity: W1 — the press point of an in-progress DRAW-mode left-drag, in
  // plan cm. Null outside such a drag. Lets mouseup draw press-point→
  // release-point in one gesture, and lets the view preview that line even
  // when there's no lastNode yet (a fresh, disconnected first wall).
  public dragOrigin: { x: number; y: number } | null = null

  /** */
  private cmPerPixel: number

  /** */
  private pixelsPerCm: number

  /** Add a callback for mode reset */
  public addModeResetCallback(callback: (mode: FloorplannerMode) => void): void {
    this.modeResetCallbacks.push(callback)
  }

  /** Provides jQuery-style Callbacks API for backward compatibility */
  public get modeResetCallbacksAPI(): {
    add: (callback: (mode: FloorplannerMode) => void) => void
  } {
    return {
      add: (callback: (mode: FloorplannerMode) => void) => this.addModeResetCallback(callback)
    }
  }

  /** */
  constructor(
    canvas: string,
    private floorplan: Floorplan
  ) {
    this.canvasElement = document.getElementById(canvas) as HTMLCanvasElement

    this.view = new FloorplannerView(this.floorplan, this, canvas)

    const cmPerFoot = 30.48
    const pixelsPerFoot = 15.0
    this.cmPerPixel = cmPerFoot * (1.0 / pixelsPerFoot)
    this.pixelsPerCm = 1.0 / this.cmPerPixel

    this.wallWidth = 10.0 * this.pixelsPerCm

    // Initialization:

    this.setMode(floorplannerModes.MOVE)

    this.canvasElement.addEventListener('mousedown', (event: MouseEvent) => {
      this.mousedown(event)
    })
    this.canvasElement.addEventListener('mousemove', (event: MouseEvent) => {
      this.mousemove(event)
    })
    this.canvasElement.addEventListener('mouseup', () => {
      this.mouseup()
    })
    this.canvasElement.addEventListener('mouseleave', () => {
      this.mouseleave()
    })
    // infinity: W1 drag-to-draw (w-walls-spec.md, 2026-08-31) — panning in
    // DRAW mode moves to a right-drag (left now draws), so a right press must
    // not pop the browser's context menu on release. Scoped to DRAW mode only
    // — every other mode's right-click is untouched.
    this.canvasElement.addEventListener('contextmenu', (event: MouseEvent) => {
      if (this.mode === floorplannerModes.DRAW) event.preventDefault()
    })
    // infinity: W1 — two-finger trackpad pan in DRAW mode. Browsers report
    // that as a plain wheel event (deltaX/deltaY, no ctrlKey); a pinch-zoom
    // gesture also arrives as wheel but WITH ctrlKey, so it's left alone here
    // rather than double-handled.
    this.canvasElement.addEventListener(
      'wheel',
      (event: WheelEvent) => {
        if (this.mode !== floorplannerModes.DRAW || event.ctrlKey) return
        event.preventDefault()
        this.originX += event.deltaX * this.cmPerPixel
        this.originY += event.deltaY * this.cmPerPixel
        this.view.draw()
      },
      { passive: false }
    )

    document.addEventListener('keyup', (e: KeyboardEvent) => {
      if (e.keyCode == 27) {
        this.escapeKey()
      }
    })

    floorplan.roomLoadedCallbacks.add(() => {
      this.reset()
    })
  }

  /** */
  private escapeKey(): void {
    this.setMode(floorplannerModes.MOVE)
  }

  // infinity: 6-inch drawing grid (owner pick, 2026-08-13) — drawn walls
  // land on clean tape-measure numbers instead of 28'5 7/8". Axis-snap to
  // the last node still wins so straight runs stay straight. 0 disables.
  public gridSnapCm = 15.24

  /** infinity: W2 angle-snap (w-walls-spec.md, 2026-08-31) — the wall a
   * lastNode is currently reached BY: its one attached corner, so drawing
   * the NEXT segment can measure square/straight against it. A lastNode
   * with no attached wall yet (the first corner of a fresh chain) has none,
   * which is exactly the "first/disconnected wall" case snapWallAngle
   * handles by falling back to the global axes. A branch point (2+ walls)
   * picks the first — plain chains are the case this wave targets. */
  private angleSnapReference(): Corner | null {
    if (!this.lastNode) return null
    const adjacent = this.lastNode.adjacentCorners()
    return adjacent.length > 0 ? adjacent[0] : null
  }

  /** infinity: W2 angle-snap — true only for an endpoint corner (exactly
   * one attached wall): returns that wall's OTHER corner (the pivot, which
   * doesn't move) and, if the pivot itself continues into another wall,
   * that wall's far corner as the angle reference — the same two-corner
   * shape angleSnapReference uses for drawing. */
  private singleWallPivot(corner: Corner): { pivot: Corner; reference: Corner | null } | null {
    const neighbors = corner.adjacentCorners()
    if (neighbors.length !== 1) return null
    const pivot = neighbors[0]
    const pivotNeighbors = pivot.adjacentCorners().filter((c) => c !== corner)
    return { pivot, reference: pivotNeighbors.length > 0 ? pivotNeighbors[0] : null }
  }

  /** */
  private updateTarget(): void {
    if (this.mode == floorplannerModes.DRAW) {
      // infinity: W1/W2 (w-walls-spec.md, 2026-08-31) — the pivot for the
      // segment being placed right now. A drag creates BOTH its corners in
      // one gesture, only at release (mouseup), so lastNode still reflects
      // the PREVIOUS wall for the entire drag — dragOrigin is what a
      // continuing gesture pivots on until then. Click-click has no
      // dragOrigin, so it pivots on lastNode exactly as before.
      const pivot =
        this.dragOrigin ?? (this.lastNode ? { x: this.lastNode.x, y: this.lastNode.y } : null)
      if (pivot) {
        // Angle-snap only knows the wall a REAL lastNode connects to; a
        // dragOrigin that isn't (yet) lastNode is a fresh/disconnected
        // start, which is exactly snapWallAngle's null-reference case —
        // global axes, same as a session's first wall ever.
        const continuesChain =
          this.lastNode != null &&
          Math.abs(this.lastNode.x - pivot.x) < 1e-6 &&
          Math.abs(this.lastNode.y - pivot.y) < 1e-6
        const reference = continuesChain ? this.angleSnapReference() : null
        // infinity: W2 angle-snap — square/straight wins outright over the
        // lastNode-axis/grid snap below; fall through to that ONLY when
        // angle-snap doesn't apply, so the two snaps are mutually exclusive
        // per point and can never fight.
        const angleSnapped = snapWallAngle(pivot, reference, {
          x: this.mouseX,
          y: this.mouseY
        })
        if (angleSnapped.x !== this.mouseX || angleSnapped.y !== this.mouseY) {
          this.targetX = angleSnapped.x
          this.targetY = angleSnapped.y
          this.view.draw()
          return
        }
      }

      if (this.lastNode) {
        if (Math.abs(this.mouseX - this.lastNode.x) < snapTolerance) {
          this.targetX = this.lastNode.x
        } else {
          this.targetX = this.snapToGrid(this.mouseX)
        }
        if (Math.abs(this.mouseY - this.lastNode.y) < snapTolerance) {
          this.targetY = this.lastNode.y
        } else {
          this.targetY = this.snapToGrid(this.mouseY)
        }
      } else {
        this.targetX = this.snapToGrid(this.mouseX)
        this.targetY = this.snapToGrid(this.mouseY)
      }
    } else {
      this.targetX = this.mouseX
      this.targetY = this.mouseY
    }

    this.view.draw()
  }

  // infinity: see gridSnapCm above.
  private snapToGrid(cm: number): number {
    if (!(this.gridSnapCm > 0)) return cm
    return Math.round(cm / this.gridSnapCm) * this.gridSnapCm
  }

  /** */
  private mousedown(event: MouseEvent): void {
    this.mouseDown = true
    this.mouseMoved = false
    this.lastX = this.rawMouseX
    this.lastY = this.rawMouseY

    // infinity: W1 drag-to-draw (w-walls-spec.md, 2026-08-31) — remember the
    // press point (this.targetX/Y already hold the last snapped position, a
    // mousemove having put the cursor here) so mouseup can draw press→
    // release in one gesture on a left button.
    this.mouseButton = event.button
    if (this.mode == floorplannerModes.DRAW && this.mouseButton === 0) {
      this.dragOrigin = { x: this.targetX, y: this.targetY }
    }

    // delete
    if (this.mode == floorplannerModes.DELETE) {
      if (this.activeCorner) {
        this.activeCorner.removeAll()
      } else if (this.activeWall) {
        this.activeWall.remove()
      } else {
        this.setMode(floorplannerModes.MOVE)
      }
    }
  }

  /** */
  private mousemove(event: MouseEvent): void {
    this.mouseMoved = true

    // update mouse
    this.rawMouseX = event.clientX
    this.rawMouseY = event.clientY

    const rect = this.canvasElement.getBoundingClientRect()
    this.mouseX = (event.clientX - rect.left) * this.cmPerPixel + this.originX * this.cmPerPixel
    this.mouseY = (event.clientY - rect.top) * this.cmPerPixel + this.originY * this.cmPerPixel

    // update target (snapped position of actual mouse)
    if (
      this.mode == floorplannerModes.DRAW ||
      (this.mode == floorplannerModes.MOVE && this.mouseDown)
    ) {
      this.updateTarget()
    }

    // update object target
    if (this.mode != floorplannerModes.DRAW && !this.mouseDown) {
      // infinity: tolerance in SCREEN pixels, not cm — at a fitted-out zoom
      // the 10cm default is under one pixel and nothing is selectable.
      const hitTol = 12 * this.cmPerPixel
      const hoverCorner: Corner | null = this.floorplan.overlappedCorner(this.mouseX, this.mouseY, hitTol)
      const hoverWall: Wall | null = this.floorplan.overlappedWall(this.mouseX, this.mouseY, hitTol)
      let draw = false
      if (hoverCorner != this.activeCorner) {
        this.activeCorner = hoverCorner
        draw = true
      }
      // corner takes precendence
      if (this.activeCorner == null) {
        if (hoverWall != this.activeWall) {
          this.activeWall = hoverWall
          draw = true
        }
      } else {
        this.activeWall = null
      }
      if (draw) {
        this.view.draw()
      }
    }

    // panning
    // infinity: W1 drag-to-draw — a left-drag in DRAW mode now draws
    // instead of panning (see mouseup); panning there moves to a right-drag,
    // which this same condition already reaches since it isn't button-gated.
    const drawModeLeftDrag = this.mode == floorplannerModes.DRAW && this.mouseButton === 0
    if (this.mouseDown && !this.activeCorner && !this.activeWall && !drawModeLeftDrag) {
      this.originX += this.lastX - this.rawMouseX
      this.originY += this.lastY - this.rawMouseY
      this.lastX = this.rawMouseX
      this.lastY = this.rawMouseY
      this.view.draw()
    }

    // dragging
    if (this.mode == floorplannerModes.MOVE && this.mouseDown) {
      if (this.activeCorner) {
        this.activeCorner.move(this.mouseX, this.mouseY)
        // infinity: W2 angle-snap — an endpoint corner (exactly one attached
        // wall) snaps square/straight relative to that wall while dragging,
        // same rule as drawing. A joint corner (2+ walls) has no single
        // reference wall to measure against, so it keeps the plain
        // positional snap below — scoped this way on purpose, not a bug.
        const pivot = this.singleWallPivot(this.activeCorner)
        const angleSnapped = pivot
          ? snapWallAngle(pivot.pivot, pivot.reference, this.activeCorner)
          : null
        if (
          angleSnapped &&
          (angleSnapped.x !== this.activeCorner.x || angleSnapped.y !== this.activeCorner.y)
        ) {
          this.activeCorner.x = angleSnapped.x
          this.activeCorner.y = angleSnapped.y
        } else {
          this.activeCorner.snapToAxis(snapTolerance)
        }
      } else if (this.activeWall) {
        this.activeWall.relativeMove(
          (this.rawMouseX - this.lastX) * this.cmPerPixel,
          (this.rawMouseY - this.lastY) * this.cmPerPixel
        )
        this.activeWall.snapToAxis(snapTolerance)
        this.lastX = this.rawMouseX
        this.lastY = this.rawMouseY
      }
      this.view.draw()
    }
  }

  /** */
  private mouseup(): void {
    this.mouseDown = false

    // drawing — click-click (no movement): unchanged.
    if (this.mode == floorplannerModes.DRAW && !this.mouseMoved) {
      const corner = this.floorplan.newCorner(this.targetX, this.targetY)
      if (this.lastNode != null) {
        this.floorplan.newWall(this.lastNode, corner)
      }
      if (corner.mergeWithIntersected() && this.lastNode != null) {
        this.setMode(floorplannerModes.MOVE)
      }
      this.lastNode = corner
    } else if (
      // infinity: W1 drag-to-draw (w-walls-spec.md, 2026-08-31) — a left-
      // button drag in DRAW mode draws ONE wall from the press point to the
      // release point, collapsing the vendor's two-click bootstrap into one
      // gesture. A press near the current chain tip reuses lastNode as the
      // start (continuing the chain exactly like click-click does); a press
      // elsewhere creates a fresh start corner, merged onto anything it
      // lands on/near — mechanically the same merge check click-click
      // already runs on ITS new corner, just also run on this one's start.
      this.mode == floorplannerModes.DRAW &&
      this.mouseMoved &&
      this.mouseButton === 0 &&
      this.dragOrigin
    ) {
      const origin = this.dragOrigin
      const continuesChain =
        this.lastNode != null &&
        Math.abs(this.lastNode.x - origin.x) < 1e-6 &&
        Math.abs(this.lastNode.y - origin.y) < 1e-6
      const startCorner = continuesChain
        ? this.lastNode!
        : this.floorplan.newCorner(origin.x, origin.y)
      if (!continuesChain) startCorner.mergeWithIntersected()

      const endCorner = this.floorplan.newCorner(this.targetX, this.targetY)
      this.floorplan.newWall(startCorner, endCorner)
      if (endCorner.mergeWithIntersected()) {
        this.setMode(floorplannerModes.MOVE)
      }
      this.lastNode = endCorner
    }

    this.dragOrigin = null
  }

  /** */
  private mouseleave(): void {
    this.mouseDown = false
    //scope.setMode(scope.modes.MOVE);
  }

  /** Resets the view - centers and resizes the floorplan */
  public reset(): void {
    this.resizeView()
    this.setMode(floorplannerModes.MOVE)
    this.resetOrigin()
    this.view.draw()
  }

  /** Resizes the view to fit the container */
  public resizeView(): void {
    this.view.handleWindowResize()
  }

  /** Sets the interaction mode */
  public setMode(mode: FloorplannerMode): void {
    this.lastNode = null
    // infinity: W1 drag-to-draw — a mode change abandons any in-progress
    // drag-to-draw press.
    this.dragOrigin = null
    this.mode = mode
    this.modeResetCallbacks.forEach((callback) => callback(mode))
    this.updateTarget()
  }

  /** Sets the origin so that floorplan is centered */
  public resetOrigin(): void {
    const centerX = this.canvasElement.clientWidth / 2.0
    const centerY = this.canvasElement.clientHeight / 2.0
    const centerFloorplan = this.floorplan.getCenter()
    this.originX = centerFloorplan.x * this.pixelsPerCm - centerX
    this.originY = centerFloorplan.z * this.pixelsPerCm - centerY
  }

  /** Convert from THREEjs coords to canvas coords. */
  public convertX(x: number): number {
    return (x - this.originX * this.cmPerPixel) * this.pixelsPerCm
  }

  /** Convert from THREEjs coords to canvas coords. */
  public convertY(y: number): number {
    return (y - this.originY * this.cmPerPixel) * this.pixelsPerCm
  }
}
