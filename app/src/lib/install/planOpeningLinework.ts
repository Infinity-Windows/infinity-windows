import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfRectToNormalized } from "./pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";

type Point = { x: number; y: number };
type Transform = [number, number, number, number, number, number];
type Span = { alongMin: number; alongMax: number; cross: number; horizontal: boolean };

function compose([a,b,c,d,e,f]: Transform, [g,h,i,j,k,l]: Transform): Transform {
  return [a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f];
}

/** Thin rectangular strokes are opening linework candidates. Exclude sheets'
 * long rules and tiny text paths. Work in the same normalized space as marks. */
export async function readOpeningSpans(page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>) {
  const viewport = page.getViewport({ scale: 1 });
  const { fnArray, argsArray } = await page.getOperatorList();
  const stack: Transform[] = [];
  let transform: Transform = [1,0,0,1,0,0];
  const spans: Span[] = [];
  for (let index = 0; index < fnArray.length; index++) {
    const op = fnArray[index];
    const args = argsArray[index];
    if (op === OPS.save) stack.push(transform);
    else if (op === OPS.restore) transform = stack.pop() ?? transform;
    else if (op === OPS.transform) transform = compose(transform, args as Transform);
    else if (op === OPS.constructPath && args?.[2]?.length === 4 && args[0] !== OPS.endPath) {
      const [left, bottom, right, top] = args[2] as ArrayLike<number> & Iterable<number>;
      const [a,b,c,d,e,f] = transform;
      if (Math.abs(a*b+c*d) > .000001) continue;
      const box = pdfRectToNormalized([a*left+c*bottom+e,b*left+d*bottom+f,a*right+c*top+e,b*right+d*top+f], viewport);
      const width = box.x2 - box.x1;
      const height = box.y2 - box.y1;
      const long = Math.max(width,height), short = Math.min(width,height);
      if (long < .007 || long > .045 || short > .006 || long < short * 3) continue;
      const horizontal = width > height;
      spans.push(horizontal
        ? {horizontal, alongMin:box.x1, alongMax:box.x2, cross:(box.y1+box.y2)/2}
        : {horizontal, alongMin:box.y1, alongMax:box.y2, cross:(box.x1+box.x2)/2});
    }
  }
  return spans;
}

export function sharesOpeningSpan(first: Point, second: Point, spans: readonly Span[]) {
  return spans.some(({horizontal, alongMin, alongMax, cross}) => {
    const along = (p: Point) => horizontal ? p.x : p.y;
    const across = (p: Point) => horizontal ? p.y : p.x;
    return [first, second].every(point => along(point) >= alongMin && along(point) <= alongMax &&
      Math.abs(across(point) - cross) <= .018) && Math.abs(along(first) - along(second)) <= .009 &&
      (across(first)-cross)*(across(second)-cross) <= 0;
  });
}
