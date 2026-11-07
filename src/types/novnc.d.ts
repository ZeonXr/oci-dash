// noVNC 1.7 exports the ESM RFB entry at the package root. The maintained
// @types package still names the pre-1.7 path; reuse its complete API contract.
declare module "@novnc/novnc" {
  export { default } from "@novnc/novnc/lib/rfb";
}
