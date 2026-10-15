import type { CSSProperties } from "react";

export type CbVarName = `--cb-${string}`;
export type CbVars = Record<CbVarName, number | string>;

/**
 * The only allowed value of a React `style` prop (UI spec 8.4). React applies it through the CSSOM,
 * which CSP `style-src 'self'` does not block; only `--cb-*` custom properties are accepted.
 */
export function cssVars(vars: CbVars): CSSProperties {
  if (import.meta.env.DEV) {
    for (const key of Object.keys(vars)) {
      if (!key.startsWith("--cb-")) throw new Error(`cssVars only accepts --cb-* properties, got ${key}`);
    }
  }
  return vars as CSSProperties;
}
