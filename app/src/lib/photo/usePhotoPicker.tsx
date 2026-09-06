// The ONE place in the app that writes an `<input type="file">` for a picture.
//
// THE INCIDENT this exists to make unrepeatable: the capture sheet's "Upload
// files" input carried `capture="environment"`. That attribute tells iOS and
// Android to open the camera and offer nothing else — no Photo Library, no
// Files app, no Google Drive — so the button labelled "Upload files" could only
// ever take a NEW photo, and everything already on the phone was unreachable
// from the app. It was one word in one JSX attribute, it looked deliberate, and
// it survived review.
//
// The rule, stated once and enforced by usePhotoPicker.test.ts: the CAMERA
// input always carries `capture`, the LIBRARY input never does, and no other
// file input in the app may offer images. Two inputs, two jobs, one file to
// read when somebody wonders which is which.
//
// Horizon reaches the same shape from the other end (`usePhotoCapture`, a hook
// holding both refs) — ported here in this app's idiom rather than copied.

import { useCallback, useRef, type ReactNode } from "react";

export interface PhotoPickerOptions {
  /**
   * What the LIBRARY input accepts. Defaults to pictures only; the receipt
   * picker widens it to "image/*,application/pdf" because a receipt genuinely
   * does arrive as an emailed PDF.
   *
   * The camera input is not configurable and is always "image/*": a camera
   * cannot hand back a PDF, and offering one there would be a lie.
   */
  accept?: string;
  /** May the library pick be several files at once? The camera never is. */
  multiple?: boolean;
  /**
   * Render the camera-app hand-off input at all.
   *
   * False for every caller that drives a live `getUserMedia` preview itself —
   * the before/after slots, the phase camera — so the sheet holds exactly the
   * inputs it can actually use, and a screen with one picker keeps one input in
   * its DOM.
   */
  camera?: boolean;
  /** Called with the pick. Never called with an empty list. */
  onFiles: (files: File[]) => void | Promise<void>;
}

export interface PhotoPicker {
  /** Open the phone's camera app (the `capture` input). */
  openCamera: () => void;
  /** Open the library / Files / Drive picker. */
  openLibrary: () => void;
  /**
   * The hidden inputs. Render them somewhere inside the surface that uses
   * them — either beside a `<button>` that calls openCamera/openLibrary, or
   * inside a `<label>`, which opens the library input with no JavaScript at
   * all and is why some callers never touch the two functions above.
   */
  inputs: ReactNode;
}

export function usePhotoPicker({
  accept = "image/*",
  multiple = false,
  camera = false,
  onFiles,
}: PhotoPickerOptions): PhotoPicker {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const libraryRef = useRef<HTMLInputElement | null>(null);

  const handle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      // Cleared BEFORE the handler runs, and always: picking the same file
      // twice in a row is otherwise silent, because the value never changed.
      e.target.value = "";
      if (files.length > 0) void onFiles(files);
    },
    [onFiles],
  );

  const openCamera = useCallback(() => cameraRef.current?.click(), []);
  const openLibrary = useCallback(() => libraryRef.current?.click(), []);

  const inputs = (
    <>
      {camera && (
        /* The camera hand-off, and the ONLY input in the app that asks for
           `capture`. It exists for a browser with no getUserMedia to drive (an
           in-app webview, an old machine) or a permission already refused —
           there the phone's own camera app is the last shutter left, and
           `capture="environment"` is what opens it straight to the rear lens. */
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={handle}
        />
      )}
      {/* The library. NEVER `capture` — see this file's header. */}
      <input
        ref={libraryRef}
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ display: "none" }}
        onChange={handle}
      />
    </>
  );

  return { openCamera, openLibrary, inputs };
}
