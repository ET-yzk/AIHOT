// opentype.js ships no types. `scripts/nameplates.ts` is the only thing that reads a font, and it reads
// exactly this much of one, so this declaration covers exactly that much. The font files are not a
// dependency either: the script is pointed at an unpacked `@fontsource/noto-sans-sc`.
declare module "opentype.js" {
  namespace opentype {
    interface BoundingBox {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
    interface Path {
      getBoundingBox(): BoundingBox;
      toPathData(decimalPlaces?: number): string;
    }
    interface Font {
      getPath(text: string, x: number, y: number, fontSize: number): Path;
    }
    function parse(buffer: ArrayBuffer): Font;
  }
  export = opentype;
}
