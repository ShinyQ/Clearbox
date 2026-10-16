import type { Platform } from "./view-types.ts";

export function detectPlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): Platform {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent) ? "mac" : "other";
}

export const modKey = (p: Platform): string => (p === "mac" ? "⌘" : "Ctrl");
export const enterKey = (p: Platform): string => (p === "mac" ? "↵" : "Enter");
export const shiftKey = (p: Platform): string => (p === "mac" ? "⇧" : "Shift");
/** Value prefix for aria-keyshortcuts ("Meta+Enter" on mac, "Control+Enter" elsewhere). */
export const ariaMod = (p: Platform): "Meta" | "Control" => (p === "mac" ? "Meta" : "Control");
