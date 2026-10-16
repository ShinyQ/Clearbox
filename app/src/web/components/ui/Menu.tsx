import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
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

/** WAI-ARIA menu button (UI spec 4.25). Keys are handled here and never reach the global hotkeys. */
export function Menu({ label, items, align = "start", placement = "below", renderTrigger }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

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
          className={`absolute z-(--z-popover) min-w-[200px] rounded-lg border border-line bg-surface p-1 shadow-overlay motion-safe:animate-[cb-fade-in_200ms_var(--ease-out)] ${
            align === "end" ? "right-0" : "left-0"
          } ${placement === "above" ? "bottom-full mb-1" : "top-full mt-1"}`}
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
              className={`flex h-[30px] w-full items-center gap-2 rounded-sm px-2 text-left text-body outline-offset-[-2px] hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-45 ${
                item.destructive ? "text-trash-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
