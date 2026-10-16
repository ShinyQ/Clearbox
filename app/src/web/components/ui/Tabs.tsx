import { useRef, type KeyboardEvent } from "react";
import { formatCount } from "../../lib/format.ts";

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number | null | undefined;
  ariaLabel?: string | undefined;
}

export interface TabsProps<K extends string> {
  label: string;
  value: K;
  items: readonly TabItem<K>[];
  onChange: (key: K) => void;
  controls: string;
  idPrefix: string;
}

/** WAI-ARIA tabs with roving tabindex and automatic activation (UI spec 4.6, 4.26). */
export function Tabs<K extends string>({ label, value, items, onChange, controls, idPrefix }: TabsProps<K>) {
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const go = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onChange(item.key);
    refs.current.get(item.key)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    go(next);
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-0.5">
      {items.map((item, i) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            ref={(el) => {
              if (el) refs.current.set(item.key, el);
              else refs.current.delete(item.key);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.key}`}
            aria-selected={selected}
            aria-controls={controls}
            aria-label={item.ariaLabel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`relative px-2.5 py-2 text-body outline-offset-[-2px] transition-colors duration-(--duration-fast) ${
              selected
                ? "font-emphasis text-ink after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-xs after:bg-ink"
                : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {item.label}
            {item.count !== null && item.count !== undefined ? (
              <b className={`ml-1 font-emphasis ${item.count === 0 ? "text-ink-3" : "text-ink-2"}`}>
                {formatCount(item.count)}
              </b>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
