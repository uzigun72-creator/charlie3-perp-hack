/**
 * Loaded before `main.tsx` (see index.html). Crypto / Lucid paths expect Node's `Buffer` on the global object.
 */
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}
