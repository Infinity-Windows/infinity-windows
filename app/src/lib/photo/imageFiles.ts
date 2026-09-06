// "Is what the picker handed back actually a picture?"
//
// `accept="image/*"` on a file input is a HINT, not a promise. It was a promise
// while these sheets carried `capture="environment"`, because a camera cannot
// hand back anything but a photo — and that is exactly what changed when the
// library door was opened. The library door reaches the Photo Library, the
// Files app, Drive and every share sheet the phone has, and those will return
// the PDF of a packing slip or a spec sheet just as happily as a JPG.
//
// Nothing downstream would notice. Both writers name the stored object `.jpg`
// from a template (`uploadMissedUnitPhoto`, `packagePhotoPath`) and pass the
// file's own content type through, so a picked PDF uploads fine, its path rides
// into the row, and the record ends up permanently pointing at something that
// renders as a broken image on the job feed. No step fails, so nobody is told.
//
// One predicate, in one file, because the package sheet and the missed-unit
// sheet reach this hazard through the same hook and had already started
// disagreeing about it — one filtered, one did not. The capture sheet keeps its
// own, RICHER check (it also asks whether the image can be decoded, and has a
// PDF branch for receipts); this is the plain version for the two sheets that
// take a picture and nothing else.

/** The pictures out of a pick, in the order they were picked. */
export function imageFilesOnly(files: File[]): File[] {
  // `type` is empty string on a file the phone could not identify at all —
  // dropped for the same reason a PDF is: it will not render as a photo.
  return files.filter((f) => f.type.startsWith("image/"));
}
