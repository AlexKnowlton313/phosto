/**
 * Minimal typings for libheif-js. The package is supplied by the Lambda layer
 * rather than installed locally, so it has no types available at build time — this
 * declares just the surface `derive/decode.ts` uses.
 */
declare module 'libheif-js/wasm-bundle.js' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { data: Uint8Array; width: number; height: number },
      callback: (result: unknown) => void,
    ): void;
  }

  export class HeifDecoder {
    decode(buffer: Uint8Array): HeifImage[];
  }

  const libheif: { HeifDecoder: typeof HeifDecoder };
  export default libheif;
}
