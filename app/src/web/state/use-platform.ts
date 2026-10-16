import { useMemo } from "react";
import { detectPlatform } from "../lib/platform.ts";
import type { Platform } from "../lib/view-types.ts";

export function usePlatform(): Platform {
  return useMemo(() => detectPlatform(), []);
}
