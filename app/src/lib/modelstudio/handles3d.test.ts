// @vitest-environment happy-dom
// The bug this pins: a handle sphere's WORLD matrix is only refreshed when
// the scene renders, and the studio renders on demand. A mousedown that
// arrived before the next frame ray-tested the sphere at the origin, missed,
// and the drag orbited the camera instead of stretching the unit. Seen as
// the flaky "pulling the top handle makes the unit taller" browser test and,
// on a phone, as a fast tap-then-drag that did nothing.
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { StudioHandles3d } from "./handles3d";

function host() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 10000);
  camera.position.set(0, 300, 900);
  camera.lookAt(0, 100, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const onGrab = vi.fn();
  const h = new StudioHandles3d({
    scene,
    camera,
    element,
    controls: { enabled: true },
    onGrab,
    onUnitDrag: vi.fn(),
    onWallDrag: vi.fn(),
  } as never);
  return { scene, camera, element, onGrab, h };
}

/** Screen pixel of a world point, the way the pane's ndc() reads it back. */
function px(camera: THREE.Camera, v: THREE.Vector3) {
  const p = v.clone().project(camera);
  return { clientX: ((p.x + 1) / 2) * 400, clientY: ((1 - p.y) / 2) * 400 };
}

describe("3D handles are grabbable before the next frame renders", () => {
  it("a mousedown on the top handle right after attachUnit starts a drag", () => {
    const { scene, camera, element, onGrab, h } = host();
    h.attachUnit({ center: new THREE.Vector3(0, 100, 0), rotationY: 0, widthCm: 240, heightCm: 150 });
    // No render has happened: the scene's matrices are whatever add() left.
    const group = scene.children.find((g) => (g as THREE.Group).isGroup) as THREE.Group;
    const top = [...group.children].sort((a, b) => b.position.y - a.position.y)[0];
    const at = px(camera, top.position);
    element.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, ...at }));
    expect(onGrab).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("a mousedown off every handle starts nothing", () => {
    const { element, onGrab, h } = host();
    h.attachUnit({ center: new THREE.Vector3(0, 100, 0), rotationY: 0, widthCm: 240, heightCm: 150 });
    element.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, clientX: 2, clientY: 2 }));
    expect(onGrab).not.toHaveBeenCalled();
    h.dispose();
  });
});
