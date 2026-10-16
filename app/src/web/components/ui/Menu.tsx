import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cssVars } from "./css-vars.ts";
import { Icon, type IconName } from "./icons.tsx";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName | undefined;
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export interface MenuProps {
  label: string;
  items: readonly MenuItem[];
  align?: "start" | "end";
  placement?: "below" | "above";
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
}

const GAP = 4;
const EDGE = 8;

/**
 * WAI-ARIA menu button (UI spec 4.25). Keys are handled here and never reach the global hotkeys.
 * The list is `position: fixed` at the trigger, so scrolling panels never clip it; it flips to the
 * other side of the trigger when the preferred side has no room and stays inside the viewport.
 */
export function Menu({ label, items, align = "start", placement = "below", renderTrigger }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    const list = listRef.current;
    if (!t || !list) return;
    const w = list.offsetWidth;
    const h = list.offsetHeight;
    const below = t.bottom + GAP;
    const above = t.top - GAP - h;
    const fitsBelow = below + h <= window.innerHeight - EDGE;
    const fitsAbove = above >= EDGE;
    const up = placement === "above" ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
    const x = align === "end" ? t.right - w : t.left;
    setPos({
      x: Math.round(Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE))),
      y: Math.round(up ? above : below),
    });
  }, [align, placement]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!listRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const step = (dir: 1 | -1) => {
    const pos = enabled.indexOf(active);
    const next = enabled[(pos + dir + enabled.length) % enabled.length];
    if (next !== undefined) setActive(next);
  };

  const onListKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") setActive(enabled[0] ?? 0);
    else if (e.key === "End") setActive(enabled[enabled.length - 1] ?? 0);
    else if (e.key === "Escape" || e.key === "Tab") close(e.key === "Escape");
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const match =
        enabled.find((i) => i > active && items[i]?.label.toLowerCase().startsWith(e.key.toLowerCase())) ??
        enabled.find((i) => items[i]?.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (match !== undefined) setActive(match);
    } else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  return (
    <div className="relative inline-flex">
      {renderTrigger({
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
        onClick: () => (open ? close(false) : openAt(enabled[0] ?? 0)),
        onKeyDown: (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            openAt(e.key === "ArrowDown" ? (enabled[0] ?? 0) : (enabled[enabled.length - 1] ?? 0));
          }
        },
      })}
      {open ? (
        <div
          id={menuId}
          ref={listRef}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          style={cssVars({ "--cb-menu-x": `${pos.x}px`, "--cb-menu-y": `${pos.y}px` })}
          className="fixed top-(--cb-menu-y) left-(--cb-menu-x) z-(--z-popover) max-h-[calc(100dvh-16px)] w-max max-w-[min(320px,calc(100vw-16px))] min-w-[200px] overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-overlay motion-safe:animate-[cb-fade-in_200ms_var(--ease-out)]"
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-index={i}
              tabIndex={i === active ? 0 : -1}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className={`flex min-h-[30px] w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body outline-offset-[-2px] hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-45 ${
                item.destructive ? "text-trash-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
              <span className="min-w-0">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
