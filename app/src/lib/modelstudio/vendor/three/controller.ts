import * as THREE from 'three'
import { Utils } from '../core/utils'
import type { Main } from './main'
import type { Model } from '../model/model'
import type { Scene } from '../model/scene'
import type { Controls } from './controls'
import type { HUD } from './hud'
import type { Item } from '../items/item'

enum ControllerState {
  UNSELECTED = 0, // no object selected
  SELECTED = 1, // selected but inactive
  DRAGGING = 2, // performing an action while mouse depressed
  ROTATING = 3, // rotating with mouse down
  ROTATING_FREE = 4, // rotating with mouse up
  PANNING = 5
}

export class Controller {
  public enabled = true
  public needsUpdate = true

  private readonly three: Main
  private readonly model: Model
  private readonly scene: Scene
  private readonly element: HTMLElement
  private readonly camera: THREE.Camera
  private readonly controls: Controls
  private readonly hud: HUD

  private plane!: THREE.Mesh // ground plane used for intersection testing
  private mouse!: THREE.Vector2
  private intersectedObject: Item | null = null
  private mouseoverObject: Item | null = null
  private selectedObject: Item | null = null

  private mouseDown = false
  private mouseMoved = false // has mouse moved since down click
  private rotateMouseOver = false
  private state = ControllerState.UNSELECTED

  // Touch support
  private touchActive = false
  private touchIdentifier: number | null = null
  private touchStartPos: THREE.Vector2 | null = null
  private touchMoveThreshold = 10 // pixels to distinguish tap from drag

  // ─── infinity vendored deviation (2026-09-02) ─────────────────────────────
  // FIX: "A tap in Studio selects a unit without dragging it."
  // Owner live-pilot report: tapping a pulled Mad Moose "Add" unit CHANGED it —
  // its face-mounted label rendered mirrored ("Add-1" → "I-bbA") and its panels
  // re-split. Cause: mousedown/touchstart entered ControllerState.DRAGGING
  // immediately, so ANY pointer movement — even a pixel of hand tremor on a tap
  // — drove clickDragged → WallItem.moveToPosition → changeWallEdge, re-seating
  // the unit on whichever wall edge the ray hit and re-facing it (rotation flip
  // + panel-order reversal). PR #503 only made the read-only selectUnit path
  // safe for config-LESS units; units carrying a real panels config (the pulled
  // Adds) still moved. This deviation adds a movement DEAD-ZONE: mousedown/
  // touchstart now ARM a drag; the DRAGGING/move behavior does not begin until
  // the pointer travels past `dragDeadZone` px from the press point. Below it
  // the gesture is a tap (select only). At/above it, dragging/snapping/wall
  // editing behave exactly as before. `dragDeadZone` matches the 6 px still-
  // click threshold ModelStudio.tsx already uses for its pick fallback.
  private pendingDrag = false
  private dragArmPos: THREE.Vector2 | null = null
  private dragDeadZone = 6 // px; matches ModelStudio's still-click threshold

  constructor(
    three: Main,
    model: Model,
    camera: THREE.Camera,
    element: HTMLElement,
    controls: Controls,
    hud: HUD
  ) {
    this.three = three
    this.model = model
    this.scene = model.scene
    this.element = element
    this.camera = camera
    this.controls = controls
    this.hud = hud

    this.init()
  }

  private init(): void {
    // Mouse events
    this.element.addEventListener('mousedown', this.mouseDownEvent.bind(this))
    this.element.addEventListener('mouseup', this.mouseUpEvent.bind(this))
    this.element.addEventListener('mousemove', this.mouseMoveEvent.bind(this))

    // Touch events
    this.element.addEventListener('touchstart', this.touchStartEvent.bind(this), { passive: false })
    this.element.addEventListener('touchmove', this.touchMoveEvent.bind(this), { passive: false })
    this.element.addEventListener('touchend', this.touchEndEvent.bind(this), { passive: false })
    this.element.addEventListener('touchcancel', this.touchCancelEvent.bind(this), { passive: false })

    this.mouse = new THREE.Vector2()

    this.scene.itemRemovedCallbacks.add(this.itemRemoved.bind(this))
    this.scene.itemLoadedCallbacks.add(this.itemLoaded.bind(this))
    this.setGroundPlane()
  }

  // invoked via callback when item is loaded
  private itemLoaded(item: Item): void {
    // Just mark position as set, don't auto-drag the item
    // User needs to manually click to move it
    item.position_set = true
  }

  private clickPressed(): void {
    if (this.selectedObject) {
      const intersection = this.itemIntersection(this.mouse, this.selectedObject)
      if (intersection) {
        this.selectedObject.clickPressed(intersection)
      }
    }
  }

  private clickDragged(): void {
    if (this.selectedObject) {
      const intersection = this.itemIntersection(this.mouse, this.selectedObject)
      if (intersection) {
        if (this.isRotating()) {
          this.selectedObject.rotate(intersection)
        } else {
          this.selectedObject.clickDragged(intersection)
        }
      }
    }
  }

  private itemRemoved(item: Item): void {
    // invoked as a callback to event in Scene
    if (item === this.selectedObject) {
      this.selectedObject.setUnselected()
      this.selectedObject.mouseOff()
      this.setSelectedObject(null)
    }
  }

  private setGroundPlane(): void {
    // ground plane used to find intersections
    const size = 10000
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial())
    this.plane.rotation.x = -Math.PI / 2
    this.plane.visible = false
    this.scene.add(this.plane)
  }

  private checkWallsAndFloors(): void {
    // double click on a wall or floor brings up texture change modal
    if (this.state === ControllerState.UNSELECTED && this.mouseoverObject === null) {
      // check walls
      const wallEdgePlanes = this.model.floorplan.wallEdgePlanes()
      const wallIntersects = this.getIntersections(this.mouse, wallEdgePlanes, true)
      if (wallIntersects.length > 0) {
        const wall = (wallIntersects[0].object as any).edge
        this.three.wallClicked.fire(wall)
        return
      }

      // check floors
      const floorPlanes = (this.model.floorplan as any).floorPlanes()
      const floorIntersects = this.getIntersections(this.mouse, floorPlanes, false)
      if (floorIntersects.length > 0) {
        const room = (floorIntersects[0].object as any).room
        this.three.floorClicked.fire(room)
        return
      }

      this.three.nothingClicked.fire()
    }
  }

  private mouseMoveEvent(event: MouseEvent): void {
    if (this.enabled) {
      event.preventDefault()

      this.mouseMoved = true

      // Get element's bounding rect dynamically for accurate positioning
      const rect = this.element.getBoundingClientRect()
      this.mouse.x = event.clientX - rect.left
      this.mouse.y = event.clientY - rect.top

      if (!this.mouseDown) {
        this.updateIntersections()
      }

      // infinity: a press over a movable item armed a drag but did not start
      // it — begin the DRAGGING/move behavior only once the pointer leaves the
      // dead-zone. Below it this stays a tap (select only), so a pixel of
      // tremor no longer re-seats/re-faces the unit.
      if (this.pendingDrag && this.beyondDeadZone(this.mouse)) {
        this.clearPendingDrag()
        this.switchState(ControllerState.DRAGGING)
      }

      switch (this.state) {
        case ControllerState.UNSELECTED:
          this.updateMouseover()
          break
        case ControllerState.SELECTED:
          this.updateMouseover()
          break
        case ControllerState.DRAGGING:
        case ControllerState.ROTATING:
        case ControllerState.ROTATING_FREE:
          this.clickDragged()
          this.hud.update()
          this.needsUpdate = true
          break
      }
    }
  }

  public isRotating(): boolean {
    return this.state === ControllerState.ROTATING || this.state === ControllerState.ROTATING_FREE
  }

  // ─── infinity dead-zone helpers (see field block above) ───────────────────
  /** Arm a drag WITHOUT starting it; the anchor is the current pointer. */
  private armDrag(): void {
    this.pendingDrag = true
    this.dragArmPos = this.mouse.clone()
  }

  /** True once the pointer has travelled past the tap dead-zone. */
  private beyondDeadZone(pos: THREE.Vector2): boolean {
    if (!this.dragArmPos) return false
    return Math.hypot(pos.x - this.dragArmPos.x, pos.y - this.dragArmPos.y) > this.dragDeadZone
  }

  /** Forget an armed-but-never-started drag (a tap that never moved far). */
  private clearPendingDrag(): void {
    this.pendingDrag = false
    this.dragArmPos = null
  }

  private mouseDownEvent(event: MouseEvent): void {
    if (this.enabled) {
      event.preventDefault()

      this.mouseMoved = false
      this.mouseDown = true

      switch (this.state) {
        case ControllerState.SELECTED:
          if (this.rotateMouseOver) {
            this.switchState(ControllerState.ROTATING)
          } else if (this.intersectedObject !== null) {
            this.setSelectedObject(this.intersectedObject)
            if (!this.intersectedObject.fixed) {
              // infinity: ARM the drag; the move starts only past the dead-zone
              this.armDrag()
            }
          }
          break
        case ControllerState.UNSELECTED:
          if (this.intersectedObject !== null) {
            this.setSelectedObject(this.intersectedObject)
            if (!this.intersectedObject.fixed) {
              // infinity: ARM the drag; the move starts only past the dead-zone
              this.armDrag()
            }
          }
          break
        case ControllerState.DRAGGING:
        case ControllerState.ROTATING:
          break
        case ControllerState.ROTATING_FREE:
          this.switchState(ControllerState.SELECTED)
          break
      }
    }
  }

  private mouseUpEvent(_event: MouseEvent): void {
    if (this.enabled) {
      this.mouseDown = false
      // infinity: a release inside the dead-zone was a tap — drop the arm so
      // it can never start a move (the object stays selected, unmoved).
      this.clearPendingDrag()

      switch (this.state) {
        case ControllerState.DRAGGING:
          if (this.selectedObject) {
            this.selectedObject.clickReleased()
          }
          this.switchState(ControllerState.SELECTED)
          break
        case ControllerState.ROTATING:
          if (!this.mouseMoved) {
            this.switchState(ControllerState.ROTATING_FREE)
          } else {
            this.switchState(ControllerState.SELECTED)
          }
          break
        case ControllerState.UNSELECTED:
          if (!this.mouseMoved) {
            this.checkWallsAndFloors()
          }
          break
        case ControllerState.SELECTED:
          if (this.intersectedObject === null && !this.mouseMoved) {
            this.switchState(ControllerState.UNSELECTED)
            this.checkWallsAndFloors()
          }
          break
        case ControllerState.ROTATING_FREE:
          break
      }
    }
  }

  private switchState(newState: ControllerState): void {
    if (newState !== this.state) {
      this.onExit(this.state)
      this.onEntry(newState)
    }
    this.state = newState
    this.hud.setRotating(this.isRotating())
  }

  private onEntry(state: ControllerState): void {
    switch (state) {
      case ControllerState.UNSELECTED:
        this.setSelectedObject(null)
        this.controls.enabled = true
        break
      case ControllerState.SELECTED:
        this.controls.enabled = true
        break
      case ControllerState.ROTATING:
      case ControllerState.ROTATING_FREE:
        this.controls.enabled = false
        break
      case ControllerState.DRAGGING:
        this.three.setCursorStyle('move')
        this.clickPressed()
        this.controls.enabled = false
        break
    }
  }

  private onExit(state: ControllerState): void {
    switch (state) {
      case ControllerState.UNSELECTED:
      case ControllerState.SELECTED:
        break
      case ControllerState.DRAGGING:
        if (this.mouseoverObject) {
          this.three.setCursorStyle('pointer')
        } else {
          this.three.setCursorStyle('auto')
        }
        break
      case ControllerState.ROTATING:
      case ControllerState.ROTATING_FREE:
        break
    }
  }

  public getSelectedObject(): Item | null {
    return this.selectedObject
  }

  // updates the vector of the intersection with the plane of a given
  // mouse position, and the intersected object
  // both may be set to null if no intersection found
  private updateIntersections(): void {
    // check the rotate arrow
    const hudObject = this.hud.getObject()
    if (hudObject !== null) {
      const hudIntersects = this.getIntersections(this.mouse, hudObject, false, false, true)
      if (hudIntersects.length > 0) {
        this.rotateMouseOver = true
        this.hud.setMouseover(true)
        this.intersectedObject = null
        return
      }
    }
    this.rotateMouseOver = false
    this.hud.setMouseover(false)

    // check objects
    const items = this.model.scene.getItems()
    const intersects = this.getIntersections(
      this.mouse,
      items as any as THREE.Object3D[],
      false,
      true
    )

    if (intersects.length > 0) {
      this.intersectedObject = intersects[0].object as unknown as Item
    } else {
      this.intersectedObject = null
    }
  }

  // sets coords to -1 to 1
  private normalizeVector2(vec2: THREE.Vector2): THREE.Vector2 {
    const retVec = new THREE.Vector2()
    // vec2 now contains coordinates relative to the element (0 to elementWidth/Height)
    retVec.x = (vec2.x / this.three.elementWidth) * 2 - 1
    retVec.y = -(vec2.y / this.three.elementHeight) * 2 + 1
    return retVec
  }

  private mouseToVec3(vec2: THREE.Vector2): THREE.Vector3 {
    const normVec2 = this.normalizeVector2(vec2)
    const vector = new THREE.Vector3(normVec2.x, normVec2.y, 0.5)
    vector.unproject(this.camera)
    return vector
  }

  // returns the first intersection object
  public itemIntersection(vec2: THREE.Vector2, item: Item): THREE.Intersection | null {
    const customIntersections = item.customIntersectionPlanes()
    let intersections: THREE.Intersection[]
    if (customIntersections && customIntersections.length > 0) {
      // infinity: no filterByNormals — with always-visible walls the surface
      // the user hovers is simply the NEAREST hit, whichever way it faces
      // (intersectObjects is distance-sorted). In three r185 the flag was a
      // no-op anyway (intersection.normal is flipped to oppose the ray), but
      // under older three the face-normal path would re-cull the near wall.
      intersections = this.getIntersections(vec2, customIntersections, false)
    } else {
      intersections = this.getIntersections(vec2, this.plane)
    }
    if (intersections.length > 0) {
      return intersections[0]
    } else {
      return null
    }
  }

  // filter by normals will only return objects facing the camera
  // objects can be an array of objects or a single object
  public getIntersections(
    vec2: THREE.Vector2,
    objects: THREE.Object3D | THREE.Object3D[],
    filterByNormals?: boolean,
    onlyVisible?: boolean,
    recursive?: boolean,
    linePrecision?: number
  ): THREE.Intersection[] {
    const vector = this.mouseToVec3(vec2)

    const _onlyVisible = onlyVisible ?? false
    const _filterByNormals = filterByNormals ?? false
    const _recursive = recursive ?? false
    const _linePrecision = linePrecision ?? 20

    const direction = vector.sub(this.camera.position).normalize()
    const raycaster = new THREE.Raycaster(this.camera.position, direction)
    raycaster.params.Line.threshold = _linePrecision

    let intersections: THREE.Intersection[]
    if (objects instanceof Array) {
      intersections = raycaster.intersectObjects(objects, _recursive)
    } else {
      intersections = raycaster.intersectObject(objects, _recursive)
    }

    // filter by visible, if true
    if (_onlyVisible) {
      intersections = Utils.removeIf(intersections, (intersection: THREE.Intersection) => {
        return !intersection.object.visible
      })
    }

    // filter by normals, if true
    if (_filterByNormals) {
      intersections = Utils.removeIf(intersections, (intersection: THREE.Intersection) => {
        // In Three.js r181 with BufferGeometry, use intersection.normal instead of face.normal
        let normal: THREE.Vector3 | null = null
        if (intersection.normal) {
          // For BufferGeometry, raycaster provides the normal directly
          normal = intersection.normal
        } else if (intersection.face && intersection.face.normal) {
          // Legacy support for old Geometry class (shouldn't happen in r181)
          normal = intersection.face.normal
        }

        if (normal) {
          const dot = normal.dot(direction)
          return dot > 0
        }
        return false
      })
    }
    return intersections
  }

  // manage the selected object
  public setSelectedObject(object: Item | null): void {
    if (this.state === ControllerState.UNSELECTED) {
      this.switchState(ControllerState.SELECTED)
    }
    if (this.selectedObject !== null) {
      this.selectedObject.setUnselected()
    }
    if (object !== null) {
      this.selectedObject = object
      this.selectedObject.setSelected()
      this.three.itemSelectedCallbacks.fire(object)
    } else {
      this.selectedObject = null
      this.three.itemUnselectedCallbacks.fire()
    }
    this.needsUpdate = true
  }

  // TODO: there MUST be simpler logic for expressing this
  private updateMouseover(): void {
    if (this.intersectedObject !== null) {
      if (this.mouseoverObject !== null) {
        if (this.mouseoverObject !== this.intersectedObject) {
          this.mouseoverObject.mouseOff()
          this.mouseoverObject = this.intersectedObject
          this.mouseoverObject.mouseOver()
          this.needsUpdate = true
        } else {
          // do nothing, mouseover already set
        }
      } else {
        this.mouseoverObject = this.intersectedObject
        this.mouseoverObject.mouseOver()
        this.three.setCursorStyle('pointer')
        this.needsUpdate = true
      }
    } else if (this.mouseoverObject !== null) {
      this.mouseoverObject.mouseOff()
      this.three.setCursorStyle('auto')
      this.mouseoverObject = null
      this.needsUpdate = true
    }
  }

  // ============ Touch Event Handlers ============

  /**
   * Get touch position relative to element
   */
  private getTouchPosition(touch: Touch): THREE.Vector2 {
    const rect = this.element.getBoundingClientRect()
    return new THREE.Vector2(touch.clientX - rect.left, touch.clientY - rect.top)
  }

  /**
   * Handle touch start - only process single finger touches for object interaction
   * Multi-touch is handled by Controls for camera manipulation
   */
  private touchStartEvent(event: TouchEvent): void {
    if (!this.enabled) return

    // Only handle single touch for object interaction
    // Multi-touch (2+ fingers) is handled by Controls for camera
    if (event.touches.length === 1) {
      const touch = event.touches[0]
      this.touchIdentifier = touch.identifier
      this.touchActive = true
      this.mouseMoved = false

      // Update mouse position from touch
      const touchPos = this.getTouchPosition(touch)
      this.mouse.copy(touchPos)
      this.touchStartPos = touchPos.clone()

      // Update intersections to check what we're touching
      this.updateIntersections()

      // Simulate mouse down behavior
      this.mouseDown = true

      switch (this.state) {
        case ControllerState.SELECTED:
          if (this.rotateMouseOver) {
            this.switchState(ControllerState.ROTATING)
            // Prevent camera controls when rotating object
            event.preventDefault()
            event.stopPropagation()
          } else if (this.intersectedObject !== null) {
            this.setSelectedObject(this.intersectedObject)
            if (!this.intersectedObject.fixed) {
              // infinity: ARM the drag; the move starts only past the dead-zone
              this.armDrag()
              // Claim the gesture from the camera controls up front — a tap on
              // a movable item is ours whether it turns into a drag or not.
              event.preventDefault()
              event.stopPropagation()
            }
          }
          break
        case ControllerState.UNSELECTED:
          if (this.intersectedObject !== null) {
            this.setSelectedObject(this.intersectedObject)
            if (!this.intersectedObject.fixed) {
              // infinity: ARM the drag; the move starts only past the dead-zone
              this.armDrag()
              // Claim the gesture from the camera controls up front — a tap on
              // a movable item is ours whether it turns into a drag or not.
              event.preventDefault()
              event.stopPropagation()
            }
          }
          break
        case ControllerState.DRAGGING:
        case ControllerState.ROTATING:
          event.preventDefault()
          event.stopPropagation()
          break
        case ControllerState.ROTATING_FREE:
          this.switchState(ControllerState.SELECTED)
          break
      }
    } else {
      // Multi-touch detected, release any active touch tracking
      this.touchActive = false
      this.touchIdentifier = null
      this.mouseDown = false
    }
  }

  /**
   * Handle touch move - track movement for dragging/rotating objects
   */
  private touchMoveEvent(event: TouchEvent): void {
    if (!this.enabled || !this.touchActive) return

    // Find the touch we're tracking
    let relevantTouch: Touch | null = null
    for (let i = 0; i < event.touches.length; i++) {
      if (event.touches[i].identifier === this.touchIdentifier) {
        relevantTouch = event.touches[i]
        break
      }
    }

    if (!relevantTouch) {
      // Our touch was lost
      this.touchActive = false
      return
    }

    // Update mouse position
    const touchPos = this.getTouchPosition(relevantTouch)
    this.mouse.copy(touchPos)

    // Check if we've moved beyond threshold
    if (this.touchStartPos) {
      const dx = touchPos.x - this.touchStartPos.x
      const dy = touchPos.y - this.touchStartPos.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > this.touchMoveThreshold) {
        this.mouseMoved = true
      }
    }

    // infinity: a finger-down over a movable item armed a drag but did not
    // start it — begin the move only once the finger leaves the dead-zone.
    // Below it this stays a tap (select only), so tremor no longer re-seats
    // the unit.
    if (this.pendingDrag && this.beyondDeadZone(touchPos)) {
      this.clearPendingDrag()
      this.switchState(ControllerState.DRAGGING)
    }

    // Handle different states
    switch (this.state) {
      case ControllerState.UNSELECTED:
        if (!this.mouseMoved) {
          this.updateIntersections()
          this.updateMouseover()
        }
        break
      case ControllerState.SELECTED:
        if (!this.mouseMoved) {
          this.updateIntersections()
          this.updateMouseover()
        }
        break
      case ControllerState.DRAGGING:
      case ControllerState.ROTATING:
      case ControllerState.ROTATING_FREE:
        // Prevent scrolling when dragging/rotating objects
        event.preventDefault()
        event.stopPropagation()
        this.clickDragged()
        this.hud.update()
        this.needsUpdate = true
        break
    }
  }

  /**
   * Handle touch end - complete the interaction
   */
  private touchEndEvent(event: TouchEvent): void {
    if (!this.enabled) return

    // Check if our tracked touch ended
    let ourTouchEnded = false
    if (this.touchIdentifier !== null) {
      ourTouchEnded = true
      for (let i = 0; i < event.touches.length; i++) {
        if (event.touches[i].identifier === this.touchIdentifier) {
          ourTouchEnded = false
          break
        }
      }
    }

    if (ourTouchEnded) {
      this.touchActive = false
      this.touchIdentifier = null
      this.mouseDown = false
      // infinity: a lift inside the dead-zone was a tap — drop the arm so it
      // can never start a move (the object stays selected, unmoved).
      this.clearPendingDrag()

      // Simulate mouse up behavior
      switch (this.state) {
        case ControllerState.DRAGGING:
          if (this.selectedObject) {
            this.selectedObject.clickReleased()
          }
          this.switchState(ControllerState.SELECTED)
          event.preventDefault()
          break
        case ControllerState.ROTATING:
          if (!this.mouseMoved) {
            this.switchState(ControllerState.ROTATING_FREE)
          } else {
            this.switchState(ControllerState.SELECTED)
          }
          event.preventDefault()
          break
        case ControllerState.UNSELECTED:
          if (!this.mouseMoved) {
            this.checkWallsAndFloors()
          }
          break
        case ControllerState.SELECTED:
          if (this.intersectedObject === null && !this.mouseMoved) {
            this.switchState(ControllerState.UNSELECTED)
            this.checkWallsAndFloors()
          }
          break
        case ControllerState.ROTATING_FREE:
          break
      }

      this.touchStartPos = null
    }
  }

  /**
   * Handle touch cancel - treat as touch end
   */
  private touchCancelEvent(event: TouchEvent): void {
    this.touchEndEvent(event)
  }
}
