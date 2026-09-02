import { Floorplan } from '../model/floorplan'
import { Wall } from '../model/wall'
import { Corner } from '../model/corner'
import { Room } from '../model/room'
import { HalfEdge } from '../model/half_edge'
import { Dimensioning } from '../core/dimensioning'
import { Utils } from '../core/utils'
import type { Floorplanner } from './floorplanner'
// infinity (studio-plans-through-floor, 2026-09-01): the same exterior-loop
// test Publish uses (toFitview.ts), reused rather than re-walked here, so
// the 2D view's wall coloring and what actually ships to the crew map can
// never disagree about which wall is which. A deliberate, surgical reach
// outside vendor/ — see this file's own draw()-only deviations below.
import { classifyWalls } from '../../toFitview'

/** */
export const floorplannerModes = {
  MOVE: 0,
  DRAW: 1,
  DELETE: 2
}

// grid parameters
const gridSpacing = 20 // pixels
const gridWidth = 1
const gridColor = '#f1f1f1'

// room config
const roomColor = '#f9f9f9'
// infinity (studio-plans-through-floor, 2026-09-01, owner: "let the plans
// show through the floor"): the opaque roomColor fill above blanked out
// the sheet everywhere INSIDE the building — exactly where interior walls
// get drawn. Used instead of roomColor whenever the plan underlay is
// active (see draw()'s underlayIsActive() check); same hue, low alpha,
// so a room still reads as a room without hiding what's under it.
const roomColorOverPlan = 'rgba(249, 249, 249, 0.15)'

// wall config
const wallWidthHover = 7
const wallColorHover = '#008cba'
const edgeColor = '#888888'
const edgeColorHover = '#008cba'
const edgeWidth = 1
// infinity (studio-plans-through-floor, 2026-09-01, owner: "highlight the
// walls we have exterior and interior when we make them so we can
// distinguish them"): exterior walls heavy and dark (the silhouette
// Publish ships); interior walls in the app's accent — index.css's
// `.active-pill` (the same pill class the "Plans: on" toggle wears) reads
// `background: var(--accent)`, and `--accent` is `--primary`, documented
// in index.css's own comment as "coral / sunset orange ≈ #f15b00". Hex
// literal on purpose, same call vendor/three/main.ts's sky colors made —
// canvas fillStyle needs a resolved color, and the oklch() token isn't
// something this plain vendor file should have to parse.
const wallWidthExterior = 7
const wallColorExterior = '#242424'
const wallWidthInterior = 4
const wallColorInterior = '#f15b00'

const deleteColor = '#ff0000'

// corner config
const cornerRadius = 0
const cornerRadiusHover = 7
const cornerColor = '#cccccc'
const cornerColorHover = '#008cba'

/**
 * The View to be used by a Floorplanner to render in/interact with.
 */
export class FloorplannerView {
  /** The canvas element. */
  private canvasElement: HTMLCanvasElement

  /** The 2D context. */
  private context: CanvasRenderingContext2D

  /** Resize handler reference for cleanup */
  private resizeHandler: () => void

  /** */
  constructor(
    private floorplan: Floorplan,
    private viewmodel: Floorplanner,
    private canvas: string
  ) {
    this.canvasElement = document.getElementById(canvas) as HTMLCanvasElement
    this.context = this.canvasElement.getContext('2d') as CanvasRenderingContext2D

    // Bind resize handler for later cleanup
    this.resizeHandler = () => {
      this.handleWindowResize()
    }
    window.addEventListener('resize', this.resizeHandler)
    this.handleWindowResize()
  }

  /** Cleanup method to remove event listeners */
  public destroy() {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler)
    }
  }

  /** */
  public handleWindowResize() {
    const canvasElement = document.getElementById(this.canvas) as HTMLCanvasElement
    // Check if canvas element exists before accessing parentElement
    if (!canvasElement) {
      console.warn('Canvas element not found:', this.canvas)
      return
    }
    const parent = canvasElement.parentElement
    if (parent) {
      const parentHeight = parent.clientHeight
      const parentWidth = parent.clientWidth
      canvasElement.style.height = parentHeight + 'px'
      canvasElement.style.width = parentWidth + 'px'
      this.canvasElement.height = parentHeight
      this.canvasElement.width = parentWidth
    }
    this.draw()
  }

  // infinity: the floor BELOW the one being edited, drawn as a light ghost
  // so upper floors can be traced against it (owner floors spec). Set by
  // the page; cm plan coordinates, same space as walls.
  public underlayWalls: Array<{ x1: number; y1: number; x2: number; y2: number }> | null = null

  // infinity (studio-plan-underlay, 2026-09-01): the real plan sheet,
  // faintly, behind the walls being drawn — "a better version of trace
  // walls" (owner). `image` is a rendered planset page; `transform` maps
  // its PIXEL space into plan CENTIMETRES (fit by planUnderlay.ts from the
  // trace's own footprint corners — the image and the wall grid don't
  // share a coordinate system on their own). Set by the page; draw()-only,
  // so it never affects hit-testing or wall snapping.
  public planUnderlay: {
    image: HTMLImageElement
    transform: { a: number; b: number; c: number; d: number; tx: number; ty: number }
    opacity: number
  } | null = null

  // infinity (studio-plans-through-floor, 2026-09-01): a thin, serializable
  // read of the same classification draw() uses internally — exposed for
  // the e2e suite (window.__studio.floorplanner.view.wallStyleCounts()) and
  // anyone else who wants "how many exterior/interior walls does this floor
  // have" without re-deriving it.
  public wallStyleCounts(): { exterior: number; interior: number } {
    const classes = classifyWalls(this.floorplan.getWalls())
    let exterior = 0
    let interior = 0
    for (const cls of classes.values()) {
      if (cls === 'exterior') exterior++
      else interior++
    }
    return { exterior, interior }
  }

  /** */
  public draw() {
    this.context.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height)

    this.drawPlanUnderlay()

    this.drawGrid()

    // infinity: ghost of the floor below, under everything editable.
    if (this.underlayWalls && this.underlayWalls.length > 0) {
      for (const w of this.underlayWalls) {
        this.drawLine(
          this.viewmodel.convertX(w.x1),
          this.viewmodel.convertY(w.y1),
          this.viewmodel.convertX(w.x2),
          this.viewmodel.convertY(w.y2),
          8,
          'rgba(120, 120, 120, 0.25)'
        )
      }
    }

    // infinity (studio-plans-through-floor, 2026-09-01): the plan sheet is
    // the bottom layer (drawPlanUnderlay above); the room fill used to be
    // opaque and blanked it out everywhere inside the building. When the
    // sheet is actually on screen, fill low-alpha instead so it reads
    // through — see roomColorOverPlan's own comment.
    const overPlan = this.activeUnderlay() !== null
    this.floorplan.getRooms().forEach((room) => {
      this.drawRoom(room, overPlan)
    })

    // infinity (studio-plans-through-floor, 2026-09-01): classified once per
    // frame — see classifyWalls' own comment (toFitview.ts) for why this is
    // the same test Publish uses, not a re-walk of its own.
    const wallStyles = classifyWalls(this.floorplan.getWalls())
    this.floorplan.getWalls().forEach((wall) => {
      this.drawWall(wall, wallStyles.get(wall) ?? 'exterior')
    })

    this.floorplan.getCorners().forEach((corner) => {
      this.drawCorner(corner)
    })

    if (this.viewmodel.mode == floorplannerModes.DRAW) {
      // infinity: W1 drag-to-draw (w-walls-spec.md, 2026-08-31) — dragOrigin
      // rides along so a fresh, disconnected drag (no lastNode yet) still
      // previews its line, same as continuing a chain already does.
      this.drawTarget(
        this.viewmodel.targetX,
        this.viewmodel.targetY,
        this.viewmodel.lastNode,
        this.viewmodel.dragOrigin,
        this.previewWallStyle()
      )
    }

    this.floorplan.getWalls().forEach((wall) => {
      this.drawWallLabels(wall)
    })
  }

  // infinity (studio-plans-through-floor, 2026-09-01): the resolved
  // planUnderlay only when it's actually ready to paint — same guard
  // drawPlanUnderlay always used inline, now shared with draw()'s room-fill
  // decision so the two can never disagree about whether there's a sheet
  // to show through.
  private activeUnderlay(): FloorplannerView['planUnderlay'] {
    const u = this.planUnderlay
    return u && u.image.complete && u.image.naturalWidth !== 0 ? u : null
  }

  // infinity (studio-plan-underlay): draw the plan image via ONE composed
  // canvas transform (image pixels -> plan cm -> screen pixels) rather than
  // computing a destination rect, so an affine with rotation/shear still
  // lands right, not just a pure scale. convertX/convertY are each a
  // one-axis scale+offset (no rotation — confirmed in floorplanner.ts), so
  // two probe points recover today's pan/zoom without reaching into the
  // viewmodel's private fields.
  private drawPlanUnderlay() {
    const u = this.activeUnderlay()
    if (!u) return
    const originX = this.viewmodel.convertX(0)
    const pxPerCmX = this.viewmodel.convertX(1) - originX
    const originY = this.viewmodel.convertY(0)
    const pxPerCmY = this.viewmodel.convertY(1) - originY
    const t = u.transform
    this.context.save()
    this.context.globalAlpha = u.opacity
    // infinity (2026-09-01, Mad Moose real-plan fix): a real architectural
    // sheet is near-white paper with black/gray linework — plain
    // source-over at low alpha barely tints the cream grid background
    // ("not even a faint sheet" was the exact complaint on a REAL plan; the
    // #488 e2e never caught this because its stub PDF page had no content
    // stream at all). 'multiply' leaves white paper untouched (white * cream
    // = cream) and darkens proportionally wherever the sheet actually drew
    // something, so the linework reads without the page itself dimming the
    // grid underneath it.
    this.context.globalCompositeOperation = 'multiply'
    this.context.setTransform(
      pxPerCmX * t.a,
      pxPerCmY * t.c,
      pxPerCmX * t.b,
      pxPerCmY * t.d,
      pxPerCmX * t.tx + originX,
      pxPerCmY * t.ty + originY
    )
    this.context.drawImage(u.image, 0, 0)
    this.context.restore()
  }

  /** */
  private drawWallLabels(wall: Wall) {
    // we'll just draw the shorter label... idk
    if (wall.backEdge && wall.frontEdge) {
      if (wall.backEdge.interiorDistance < wall.frontEdge.interiorDistance) {
        this.drawEdgeLabel(wall.backEdge)
      } else {
        this.drawEdgeLabel(wall.frontEdge)
      }
    } else if (wall.backEdge) {
      this.drawEdgeLabel(wall.backEdge)
    } else if (wall.frontEdge) {
      this.drawEdgeLabel(wall.frontEdge)
    }
  }

  /** */
  // infinity (studio-plans-through-floor, 2026-09-01): style now takes the
  // wall's exterior/interior classification (computed once per draw() —
  // see classifyWalls) so hover/delete highlighting can still override it,
  // but the base color/weight tells exterior from interior at a glance.
  private drawWall(wall: Wall, wallClass: 'exterior' | 'interior') {
    const hover = wall === this.viewmodel.activeWall
    let color: string
    let width: number
    if (hover && this.viewmodel.mode == floorplannerModes.DELETE) {
      color = deleteColor
      width = wallWidthHover
    } else if (hover) {
      color = wallColorHover
      width = wallWidthHover
    } else if (wallClass === 'exterior') {
      color = wallColorExterior
      width = wallWidthExterior
    } else {
      color = wallColorInterior
      width = wallWidthInterior
    }
    this.drawLine(
      this.viewmodel.convertX(wall.getStartX()),
      this.viewmodel.convertY(wall.getStartY()),
      this.viewmodel.convertX(wall.getEndX()),
      this.viewmodel.convertY(wall.getEndY()),
      width,
      color
    )
    if (!hover && wall.frontEdge) {
      this.drawEdge(wall.frontEdge, hover)
    }
    if (!hover && wall.backEdge) {
      this.drawEdge(wall.backEdge, hover)
    }
  }

  /** */
  private drawEdgeLabel(edge: HalfEdge) {
    const pos = edge.interiorCenter()
    const length = edge.interiorDistance()
    if (length < 60) {
      // dont draw labels on walls this short
      return
    }
    this.context.font = 'normal 12px Arial'
    this.context.fillStyle = '#000000'
    this.context.textBaseline = 'middle'
    this.context.textAlign = 'center'
    this.context.strokeStyle = '#ffffff'
    this.context.lineWidth = 4

    this.context.strokeText(
      Dimensioning.cmToMeasure(length),
      this.viewmodel.convertX(pos.x),
      this.viewmodel.convertY(pos.y)
    )
    this.context.fillText(
      Dimensioning.cmToMeasure(length),
      this.viewmodel.convertX(pos.x),
      this.viewmodel.convertY(pos.y)
    )
  }

  /** */
  private drawEdge(edge: HalfEdge, hover: boolean) {
    let color = edgeColor
    if (hover && this.viewmodel.mode == floorplannerModes.DELETE) {
      color = deleteColor
    } else if (hover) {
      color = edgeColorHover
    }
    const corners = edge.corners()

    this.drawPolygon(
      Utils.map(corners, (corner) => {
        return this.viewmodel.convertX(corner.x)
      }),
      Utils.map(corners, (corner) => {
        return this.viewmodel.convertY(corner.y)
      }),
      false,
      null,
      true,
      color,
      edgeWidth
    )
  }

  // infinity (studio-plans-through-floor, 2026-09-01): overPlan swaps in
  // roomColorOverPlan (low alpha) — see draw()'s underlayIsActive() call
  // and roomColorOverPlan's own comment.
  private drawRoom(room: Room, overPlan: boolean) {
    this.drawPolygon(
      Utils.map(room.corners, (corner: Corner) => {
        return this.viewmodel.convertX(corner.x)
      }),
      Utils.map(room.corners, (corner: Corner) => {
        return this.viewmodel.convertY(corner.y)
      }),
      true,
      overPlan ? roomColorOverPlan : roomColor
    )
  }

  /** */
  private drawCorner(corner: Corner) {
    const hover = corner === this.viewmodel.activeCorner
    let color = cornerColor
    if (hover && this.viewmodel.mode == floorplannerModes.DELETE) {
      color = deleteColor
    } else if (hover) {
      color = cornerColorHover
    }
    this.drawCircle(
      this.viewmodel.convertX(corner.x),
      this.viewmodel.convertY(corner.y),
      hover ? cornerRadiusHover : cornerRadius,
      color
    )
  }

  // infinity (studio-plans-through-floor, 2026-09-01): what the wall being
  // drawn right now would classify as if released this instant — the same
  // classifyWalls test real walls get, run against the current floor's
  // walls PLUS a synthetic candidate for the in-progress segment (lastNode/
  // dragOrigin -> targetX/targetY). A candidate's own height never affects
  // classifyWalls' outer-loop walk (only start/end points do), so `1` is
  // fine here. No lastNode/dragOrigin yet (mode just switched to DRAW,
  // nothing pressed) means no segment exists to classify — 'interior' is
  // as good a default as any since nothing draws from it either way.
  private previewWallStyle(): 'exterior' | 'interior' {
    const from = this.viewmodel.lastNode ?? this.viewmodel.dragOrigin
    if (!from) return 'interior'
    const candidate = {
      height: 1,
      getStartX: () => from.x,
      getStartY: () => from.y,
      getEndX: () => this.viewmodel.targetX,
      getEndY: () => this.viewmodel.targetY
    }
    const classified = classifyWalls([...this.floorplan.getWalls(), candidate])
    return classified.get(candidate) ?? 'interior'
  }

  /** */
  private drawTarget(
    x: number,
    y: number,
    lastNode: Corner | null,
    dragOrigin: { x: number; y: number } | null | undefined,
    previewStyle: 'exterior' | 'interior'
  ) {
    this.drawCircle(
      this.viewmodel.convertX(x),
      this.viewmodel.convertY(y),
      cornerRadiusHover,
      cornerColorHover
    )
    // infinity: W1 drag-to-draw — prefer lastNode (an in-progress chain);
    // dragOrigin is the fallback so a fresh drag with no chain yet still
    // shows its press-to-cursor preview line.
    const from = lastNode ?? dragOrigin
    if (from) {
      // infinity (studio-plans-through-floor, 2026-09-01): the preview now
      // wears the style the finished wall would get (previewWallStyle),
      // not a flat hover-blue — "distinguish them... when we make them"
      // means while drawing, too.
      const [width, color] =
        previewStyle === 'exterior'
          ? [wallWidthExterior, wallColorExterior]
          : [wallWidthInterior, wallColorInterior]
      this.drawLine(
        this.viewmodel.convertX(from.x),
        this.viewmodel.convertY(from.y),
        this.viewmodel.convertX(x),
        this.viewmodel.convertY(y),
        width,
        color
      )
      // infinity (studio-trace-mode-obvious, 2026-09-01): the owner asked to
      // "see the dimensions in 2d" while dragging — drag-to-draw (#466) had
      // no live readout. Same label a finished wall gets (drawEdgeLabel),
      // just measured from the two raw plan points instead of a HalfEdge,
      // since the wall doesn't exist yet.
      this.drawLiveLengthLabel(from, { x, y })
    }
  }

  /** infinity (studio-trace-mode-obvious, 2026-09-01): live length while
   * drag-drawing, in the same feet-inches style drawEdgeLabel gives a
   * finished wall (Dimensioning.cmToMeasure) — the readout shouldn't look
   * like a different feature. draw()-only, called from drawTarget; no
   * hit-testing implications. */
  private drawLiveLengthLabel(from: { x: number; y: number }, to: { x: number; y: number }) {
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    if (length < 60) {
      // dont draw labels on walls this short — same floor drawEdgeLabel uses
      return
    }
    const midX = this.viewmodel.convertX((from.x + to.x) / 2)
    const midY = this.viewmodel.convertY((from.y + to.y) / 2)
    this.context.font = 'normal 12px Arial'
    this.context.fillStyle = '#000000'
    this.context.textBaseline = 'middle'
    this.context.textAlign = 'center'
    this.context.strokeStyle = '#ffffff'
    this.context.lineWidth = 4

    this.context.strokeText(Dimensioning.cmToMeasure(length), midX, midY)
    this.context.fillText(Dimensioning.cmToMeasure(length), midX, midY)
  }

  /** */
  private drawLine(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    width: number,
    color: string
  ) {
    // width is an integer
    // color is a hex string, i.e. #ff0000
    this.context.beginPath()
    this.context.moveTo(startX, startY)
    this.context.lineTo(endX, endY)
    this.context.lineWidth = width
    this.context.strokeStyle = color
    this.context.stroke()
  }

  /** */
  private drawPolygon(
    xArr: number[],
    yArr: number[],
    fill?: boolean,
    fillColor?: string | null,
    stroke?: boolean,
    strokeColor?: string,
    strokeWidth?: number
  ) {
    // fillColor is a hex string, i.e. #ff0000
    fill = fill || false
    stroke = stroke || false
    this.context.beginPath()
    this.context.moveTo(xArr[0], yArr[0])
    for (let i = 1; i < xArr.length; i++) {
      this.context.lineTo(xArr[i], yArr[i])
    }
    this.context.closePath()
    if (fill && fillColor) {
      this.context.fillStyle = fillColor
      this.context.fill()
    }
    if (stroke && strokeColor) {
      this.context.lineWidth = strokeWidth!
      this.context.strokeStyle = strokeColor
      this.context.stroke()
    }
  }

  /** */
  private drawCircle(centerX: number, centerY: number, radius: number, fillColor: string) {
    this.context.beginPath()
    this.context.arc(centerX, centerY, radius, 0, 2 * Math.PI, false)
    this.context.fillStyle = fillColor
    this.context.fill()
  }

  /** returns n where -gridSize/2 < n <= gridSize/2  */
  private calculateGridOffset(n: number): number {
    if (n >= 0) {
      return ((n + gridSpacing / 2.0) % gridSpacing) - gridSpacing / 2.0
    } else {
      return ((n - gridSpacing / 2.0) % gridSpacing) + gridSpacing / 2.0
    }
  }

  /** */
  private drawGrid() {
    const offsetX = this.calculateGridOffset(-this.viewmodel.originX)
    const offsetY = this.calculateGridOffset(-this.viewmodel.originY)
    const width = this.canvasElement.width
    const height = this.canvasElement.height
    for (let x = 0; x <= width / gridSpacing; x++) {
      this.drawLine(
        gridSpacing * x + offsetX,
        0,
        gridSpacing * x + offsetX,
        height,
        gridWidth,
        gridColor
      )
    }
    for (let y = 0; y <= height / gridSpacing; y++) {
      this.drawLine(
        0,
        gridSpacing * y + offsetY,
        width,
        gridSpacing * y + offsetY,
        gridWidth,
        gridColor
      )
    }
  }
}
