import * as THREE from 'three'
import { animate } from 'animejs'
import { EventEmitter } from '../core/events'
import { Controller } from './controller'
import { FloorplanThree } from './floorplan'
import { Lights } from './lights'
import { Skybox } from './skybox'
import { Controls } from './controls'
import { HUD } from './hud'
import type { Model } from '../model/model'
import type { Scene } from '../model/scene'
import type { Item } from '../items/item'
import type { HalfEdge } from '../model/half_edge'
import type { Room } from '../model/room'

interface MainOptions {
  resize?: boolean
  pushHref?: boolean
  spin?: boolean
  spinSpeed?: number
  clickPan?: boolean
  canMoveFixedItems?: boolean
  enableWheelZoom?: boolean
  alwaysSpin?: boolean // Keep spinning even after user interaction
}

export class Main {
  public readonly element: HTMLElement
  public controls!: Controls
  public heightMargin!: number
  public widthMargin!: number
  public elementHeight!: number
  public elementWidth!: number

  public itemSelectedCallbacks = new EventEmitter<Item>() // item
  public itemUnselectedCallbacks = new EventEmitter<void>()
  public wallClicked = new EventEmitter<HalfEdge>() // wall
  public floorClicked = new EventEmitter<Room>() // floor
  public nothingClicked = new EventEmitter<void>()

  private readonly options: Required<MainOptions>
  public readonly scene: Scene
  private readonly model: Model
  private domElement!: HTMLElement
  public camera!: THREE.PerspectiveCamera
  public renderer!: THREE.WebGLRenderer
  private controller!: Controller
  // @ts-ignore - floorplan is declared but not used, keeping for future use
  private floorplan!: FloorplanThree
  private _needsUpdate = false
  private lastRender = Date.now()
  private mouseOver = false
  private hasClicked = false
  private hud!: HUD
  private viewMode: '2d' | '3d' = '3d'
  private saved3DPosition: THREE.Vector3 | null = null
  // @ts-ignore - saved3DRotation is declared but not used, keeping for future use
  private saved3DRotation: { theta: number; phi: number } | null = null
  // infinity (Studio 100x #36): dispose()/animate() need the SAME bound
  // function reference addEventListener was given, or removeEventListener
  // silently no-ops on a freshly-bound copy.
  private disposed = false
  private readonly boundUpdateWindowSize = this.updateWindowSize.bind(this)

  constructor(
    model: Model,
    element: HTMLElement | string,
    canvasElement?: HTMLElement,
    opts?: MainOptions
  ) {
    this.model = model
    this.scene = model.scene
    // Convert string selector to DOM element if needed
    this.element =
      typeof element === 'string' ? (document.querySelector(element) as HTMLElement) : element

    const defaultOptions: Required<MainOptions> = {
      resize: true,
      pushHref: false,
      spin: true,
      spinSpeed: 0.00002,
      clickPan: true,
      canMoveFixedItems: false,
      enableWheelZoom: true,
      alwaysSpin: false
    }

    // override with manually set options
    this.options = { ...defaultOptions, ...opts }

    this.init()
  }

  private init(): void {
    this.domElement = this.element // Container
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 50000) // infinity: far plane past the 200m orbit limit
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true // required to support .toDataURL()
    })
    this.renderer.autoClear = false
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap // Optimized: PCFShadowMap is faster than PCFSoftShadowMap
    // Fix color space for proper color saturation (matching legacy behavior)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    // Get skybox colors from CSS variables (if available)
    const { topColor, bottomColor } = this.getSkyboxColors()
    // @ts-ignore - Item is imported but not used, keeping for future use
    const skybox = new Skybox(this.scene.getScene(), topColor, bottomColor)

    this.controls = new Controls(this.camera, this.domElement, this.options.enableWheelZoom)

    this.hud = new HUD(this)

    this.controller = new Controller(
      this,
      this.model,
      this.camera,
      this.element,
      this.controls,
      this.hud
    )

    this.domElement.appendChild(this.renderer.domElement)

    // handle window resizing
    this.updateWindowSize()
    if (this.options.resize) {
      window.addEventListener('resize', this.boundUpdateWindowSize)
    }

    // setup camera nicely
    this.centerCamera()
    // infinity: NO auto-recenter on floorplan updates — every wall edit
    // yanked the camera back to centre and stomped the user's pan/orbit
    // (owner report: "hard focused on center"). The page recenters
    // explicitly (boot, floor switch, Recenter button).

    // @ts-ignore - Item is imported but not used, keeping for future use
    const lights = new Lights(this.scene.getScene(), this.model.floorplan)

    this.floorplan = new FloorplanThree(this.scene.getScene(), this.model.floorplan, this.controls, this.renderer)

    this.animate()

    this.element.addEventListener('mouseenter', () => {
      this.mouseOver = true
    })
    this.element.addEventListener('mouseleave', () => {
      this.mouseOver = false
    })
    this.element.addEventListener('click', () => {
      this.hasClicked = true
    })
  }

  /**
   * infinity (Studio 100x #48): sky colors follow the app THEME instead of a
   * hardcoded daylight blue. index.css defines --studio-sky-top/-bottom
   * (plain hex, so no color-space parsing is needed — the app's other
   * tokens are oklch(), which this scene has no business decoding). The app
   * is presently one always-dark theme (index.css: "Always dark"), so this
   * resolves to the same dusk palette today; reading the token — rather
   * than inlining the color here — is what makes the sky follow the theme
   * automatically if that ever changes, instead of drifting from it.
   *
   * Previously this read --muted and parsed it as a bare "H S% L%" triplet
   * (the Tailwind HSL-var convention) — this app's tokens are oklch(...)
   * strings, which never matched that pattern, so the read silently always
   * fell through to the hardcoded default. Replaced rather than patched.
   */
  private getSkyboxColors(): { topColor: number; bottomColor: number } {
    // Dusk fallback (not the old daylight blue) for when CSS isn't reachable
    // (SSR, tests) or the tokens are missing.
    const defaultTopColor = 0x171a24
    const defaultBottomColor = 0x3a2a22

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return { topColor: defaultTopColor, bottomColor: defaultBottomColor }
    }

    try {
      const rootStyles = getComputedStyle(document.documentElement)
      const top = this.parseHexColor(rootStyles.getPropertyValue('--studio-sky-top'))
      const bottom = this.parseHexColor(rootStyles.getPropertyValue('--studio-sky-bottom'))
      return {
        topColor: top ?? defaultTopColor,
        bottomColor: bottom ?? defaultBottomColor
      }
    } catch (error) {
      console.warn('Failed to read CSS variables for skybox colors, using defaults:', error)
      return { topColor: defaultTopColor, bottomColor: defaultBottomColor }
    }
  }

  /** Parse a "#rgb" or "#rrggbb" CSS color into a 0xRRGGBB number, or null
   * for anything else (an oklch()/hsl()/named color, or an empty token —
   * all left to the caller's default rather than mis-parsed). */
  private parseHexColor(value: string): number | null {
    const hex = value.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16)
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      const r = hex[0], g = hex[1], b = hex[2]
      return parseInt(r + r + g + g + b + b, 16)
    }
    return null
  }

  private spin(): void {
    // If alwaysSpin is enabled, spin continuously regardless of user interaction
    const shouldSpin = this.options.spin && (this.options.alwaysSpin || (!this.mouseOver && !this.hasClicked))

    if (shouldSpin) {
      const theta = 2 * Math.PI * this.options.spinSpeed * (Date.now() - this.lastRender)
      this.controls.rotateLeft(theta)
      this.controls.update()
    }
  }

  public dataUrl(): string {
    const dataUrl = this.renderer.domElement.toDataURL('image/png')
    return dataUrl
  }

  // infinity (Studio 100x #36): stop the animate() loop and free the GPU
  // context. See the `disposed`/`boundUpdateWindowSize` fields above — this
  // is what a throwaway offscreen capture calls when it's done with its one
  // frame; the page's own long-lived instance never calls it.
  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('resize', this.boundUpdateWindowSize)
    this.renderer.dispose()
  }

  public stopSpin(): void {
    this.hasClicked = true
  }

  public getOptions(): Required<MainOptions> {
    return this.options
  }

  public getModel(): Model {
    return this.model
  }

  public getScene(): Scene {
    return this.scene
  }

  public getController(): Controller {
    return this.controller
  }

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  public needsUpdate(): void {
    this._needsUpdate = true
  }

  private shouldRender(): boolean {
    // Do we need to draw a new frame
    if (
      this.controls.needsUpdate ||
      this.controller.needsUpdate ||
      this._needsUpdate ||
      this.model.scene.needsUpdate
    ) {
      this.controls.needsUpdate = false
      this.controller.needsUpdate = false
      this._needsUpdate = false
      this.model.scene.needsUpdate = false
      return true
    } else {
      return false
    }
  }

  private render(): void {
    this.spin()
    if (this.shouldRender()) {
      this.renderer.clear()
      this.renderer.render(this.scene.getScene(), this.camera)
      this.renderer.clearDepth()
      this.renderer.render(this.hud.getScene(), this.camera)
    }
    this.lastRender = Date.now()
  }

  private animate(): void {
    if (this.disposed) return
    requestAnimationFrame(this.animate.bind(this))
    this.render()
  }

  public setCursorStyle(cursorStyle: string): void {
    this.domElement.style.cursor = cursorStyle
  }

  public updateWindowSize(): void {
    const rect = this.element.getBoundingClientRect()
    this.heightMargin = rect.top
    this.widthMargin = rect.left

    this.elementWidth = this.element.clientWidth
    if (this.options.resize) {
      this.elementHeight = window.innerHeight - this.heightMargin
    } else {
      this.elementHeight = this.element.clientHeight
    }

    this.camera.aspect = this.elementWidth / this.elementHeight
    this.camera.updateProjectionMatrix()

    this.renderer.setSize(this.elementWidth, this.elementHeight)
    this._needsUpdate = true
  }

  public centerCamera(): void {
    const yOffset = 150.0

    const pan = this.model.floorplan.getCenter()
    pan.y = yOffset

    this.controls.target = pan

    let distance = this.model.floorplan.getSize().z * 1.5
    // infinity: an EMPTY floorplan (a fresh upper floor) has size 0 — the
    // camera collapsed onto its own target and orbiting locked up (owner
    // report: "a locked in view that i cant do my global rotation on").
    // Never let the orbit radius degenerate.
    if (!(distance > 100)) {
      distance = 900
    }

    const offset = pan.clone().add(new THREE.Vector3(0, distance, distance))
    this.camera.position.copy(offset)

    this.controls.update()
  }

  // projects the object's center point into x,y screen coords
  // x,y are relative to top left corner of viewer
  public projectVector(vec3: THREE.Vector3, ignoreMargin?: boolean): THREE.Vector2 {
    const _ignoreMargin = ignoreMargin ?? false

    const widthHalf = this.elementWidth / 2
    const heightHalf = this.elementHeight / 2

    const vector = new THREE.Vector3()
    vector.copy(vec3)
    vector.project(this.camera)

    const vec2 = new THREE.Vector2()

    vec2.x = vector.x * widthHalf + widthHalf
    vec2.y = -(vector.y * heightHalf) + heightHalf

    if (!_ignoreMargin) {
      vec2.x += this.widthMargin
      vec2.y += this.heightMargin
    }

    return vec2
  }

  public getViewMode(): '2d' | '3d' {
    return this.viewMode
  }

  public setViewMode(mode: '2d' | '3d'): void {
    if (this.viewMode === mode) return

    this.viewMode = mode

    if (mode === '2d') {
      // Save current 3D position
      this.saved3DPosition = this.camera.position.clone()

      // Switch to 2D top-down view
      const center = this.model.floorplan.getCenter()
      const size = this.model.floorplan.getSize()
      const maxDim = Math.max(size.x, size.z)
      // Increase distance to reduce perspective distortion and wall blocking
      const distance = maxDim * 1.5 // Increased from 1.2 to 2.0

      const targetPosition = { x: center.x, y: distance, z: center.z }
      const targetLookAt = { x: center.x, y: 0, z: center.z }

      // Animate camera position and controls target simultaneously
      animate(this.camera.position, {
        x: targetPosition.x,
        y: targetPosition.y,
        z: targetPosition.z,
        duration: 800,
        ease: 'inOut(2)', // easeInOutQuad equivalent
        onUpdate: () => {
          this.controls.update()
          this._needsUpdate = true
        }
      })

      animate(this.controls.target, {
        x: targetLookAt.x,
        y: targetLookAt.y,
        z: targetLookAt.z,
        duration: 800,
        ease: 'inOut(2)'
      })

      // Disable rotation in 2D mode
      this.controls.noRotate = true
      this.controls.maxPolarAngle = 0
      this.controls.minPolarAngle = 0
    } else {
      // Restore 3D view
      let targetPosition: THREE.Vector3
      if (this.saved3DPosition) {
        targetPosition = this.saved3DPosition
      } else {
        // Calculate centered position
        const center = this.model.floorplan.getCenter()
        const size = this.model.floorplan.getSize()
        const maxDim = Math.max(size.x, size.z)
        const distance = maxDim * 1.5
        targetPosition = new THREE.Vector3(
          center.x + distance * 0.7,
          distance * 0.8,
          center.z + distance * 0.7
        )
      }

      // Animate camera position back to 3D view
      animate(this.camera.position, {
        x: targetPosition.x,
        y: targetPosition.y,
        z: targetPosition.z,
        duration: 800,
        ease: 'inOut(2)',
        onUpdate: () => {
          this.controls.update()
          this._needsUpdate = true
        }
      })

      // Re-enable rotation in 3D mode
      this.controls.noRotate = false
      this.controls.maxPolarAngle = Math.PI / 2
      this.controls.minPolarAngle = 0
    }

    this._needsUpdate = true
  }
}
