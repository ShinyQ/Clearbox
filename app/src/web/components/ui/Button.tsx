import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "./icons.tsx";
import { Kbd, type KbdTone } from "./Kbd.tsx";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant =
  "primary" | "secondary" | "danger" | "ghost" | "on-inverse" | "on-inverse-ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-on-primary border-primary shadow-button-primary hover:bg-primary-hover hover:border-primary-hover motion-safe:active:translate-y-px",
  secondary:
    "bg-surface text-ink border-line hover:bg-surface-hover hover:border-neutral-fill active:bg-surface-sunk",
  danger:
    "bg-trash text-white border-trash hover:bg-trash-hover hover:border-trash-hover motion-safe:active:translate-y-px",
  ghost:
    "bg-transparent text-ink-2 border-transparent hover:bg-[rgba(22,23,27,.05)] hover:text-ink active:bg-[rgba(22,23,27,.08)]",
  "on-inverse": "bg-white text-ink border-white hover:bg-surface-sunk",
  "on-inverse-ghost":
    "bg-transparent text-on-inverse-2 border-transparent hover:text-on-inverse hover:bg-[rgba(255,255,255,.08)]",
  link: "bg-transparent border-transparent text-accent underline-offset-2 hover:text-accent-hover hover:underline",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 py-[5px] text-small rounded-md",
  md: "h-8 px-3 py-[7px] text-body rounded-md",
  lg: "h-9 px-[15px] py-[9px] text-base rounded-lg",
};
const LINK_SIZE: Record<ButtonSize, string> = { sm: "text-small", md: "text-body", lg: "text-base" };
const ICON_SIZE: Record<ButtonSize, number> = { sm: 12, md: 14, lg: 16 };

export function buttonClass(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  const sizing = variant === "link" ? `p-0 rounded-xs ${LINK_SIZE[size]}` : SIZE[size];
  return [
    "inline-flex items-center justify-center gap-[7px] whitespace-nowrap border font-emphasis",
    "transition-colors duration-(--duration-fast)",
    "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
    VARIANT[variant],
    sizing,
    extra ?? "",
  ].join(" ");
}

const isDark = (v: ButtonVariant) => v === "primary" || v === "danger";
const kbdTone = (v: ButtonVariant): KbdTone =>
  isDark(v) ? "on-primary" : v === "on-inverse" || v === "on-inverse-ghost" ? "on-inverse" : "default";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName | undefined;
  kbd?: string[] | undefined;
  loading?: boolean | undefined;
  loadingLabel?: string | undefined;
  softDisabled?: boolean | undefined;
  type?: "button" | "submit";
  ref?: Ref<HTMLButtonElement> | undefined;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  kbd,
  loading = false,
  loadingLabel = "Working…",
  softDisabled = false,
  type = "button",
  className,
  children,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const inactive = loading || softDisabled;
  const handle = (e: MouseEvent<HTMLButtonElement>) => {
    if (inactive) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      aria-busy={loading || undefined}
      aria-disabled={softDisabled || rest["aria-disabled"] || undefined}
      onClick={handle}
    >
      {loading ? (
        <Spinner tone={isDark(variant) ? "on-dark" : "default"} />
      ) : icon ? (
        <Icon name={icon} size={ICON_SIZE[size]} />
      ) : null}
      {loading ? <span>{loadingLabel}</span> : children !== undefined ? <span>{children}</span> : null}
      {kbd && !loading ? <Kbd keys={kbd} tone={kbdTone(variant)} ariaHidden /> : null}
    </button>
  );
}

export interface LinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to?: string | undefined;
  href?: string | undefined;
  external?: boolean | undefined;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName | undefined;
  children: ReactNode;
}

/** Same visuals as Button; renders a router Link (internal) or an anchor (external, new tab). */
export function LinkButton({
  to,
  href,
  external = false,
  variant = "secondary",
  size = "md",
  icon,
  children,
  className,
  ...rest
}: LinkButtonProps) {
  const cls = buttonClass(variant, size, className);
  const inner = (
    <>
      {icon ? <Icon name={icon} size={ICON_SIZE[size]} /> : null}
      <span>{children}</span>
      {external ? <Icon name="external" size={12} /> : null}
    </>
  );
  if (to !== undefined) {
    return (
      <Link {...rest} to={to} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <a
      {...rest}
      href={href}
      className={cls}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {inner}
    </a>
  );
}
