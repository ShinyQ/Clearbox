const DEFAULT_WIDTH = 1440;
let width = DEFAULT_WIDTH;
let reducedMotion = false;
const listeners = new Set<() => void>();

function toPx(value: string, unit: string): number {
  return unit === "rem" ? Number(value) * 16 : Number(value);
}

function evaluate(query: string): boolean {
  if (query.includes("prefers-reduced-motion")) return reducedMotion && query.includes("reduce");
  const min = /min-width:\s*([\d.]+)(px|rem)/.exec(query);
  if (min?.[1] && min[2]) return width >= toPx(min[1], min[2]);
  const max = /max-width:\s*([\d.]+)(px|rem)/.exec(query);
  if (max?.[1] && max[2]) return width <= toPx(max[1], max[2]);
  return false;
}

export function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const mql = {
      media: query,
      get matches() {
        return evaluate(query);
      },
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
      addListener: (cb: () => void) => listeners.add(cb),
      removeListener: (cb: () => void) => listeners.delete(cb),
      dispatchEvent: () => true,
    };
    return mql as unknown as MediaQueryList;
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function setViewport(next: number): void {
  width = next;
  notify();
}

export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  notify();
}

export function resetViewport(): void {
  width = DEFAULT_WIDTH;
  reducedMotion = false;
}
