import { Button, LinkButton } from "./Button.tsx";
import { Icon, type IconName } from "./icons.tsx";

export type BannerTone = "warning" | "error" | "info" | "success";

export interface BannerAction {
  label: string;
  onClick?: (() => void) | undefined;
  href?: string | undefined;
  external?: boolean | undefined;
  loading?: boolean | undefined;
}

export interface BannerProps {
  tone: BannerTone;
  title: string;
  body?: string | undefined;
  actions?: BannerAction[] | undefined;
  dismissible?: boolean | undefined;
  onDismiss?: (() => void) | undefined;
  /** True for banners that appear after the page loaded (UI spec 4.19). */
  announce?: boolean | undefined;
}

// Every tone uses the same 1px border on all four sides; never an edge stripe.
const TONE: Record<BannerTone, string> = {
  warning: "bg-check-soft border-check-line text-check-ink-strong",
  error: "bg-trash-soft border-trash-line text-trash-ink",
  info: "bg-archive-soft border-archive-line text-archive-ink",
  success: "bg-keep-soft border-keep-line text-keep-ink",
};
const ICON: Record<BannerTone, IconName> = {
  warning: "warning",
  error: "error",
  info: "info",
  success: "success",
};

export function Banner({
  tone,
  title,
  body,
  actions = [],
  dismissible = false,
  onDismiss,
  announce = false,
}: BannerProps) {
  const role = announce ? (tone === "error" ? "alert" : "status") : undefined;
  return (
    <div
      role={role}
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-body ${TONE[tone]}`}
    >
      <Icon name={ICON[tone]} size={16} />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{title}</span>
        {body ? ` ${body}` : null}
      </p>
      {actions.map((a) =>
        a.href ? (
          <LinkButton key={a.label} href={a.href} external={a.external} size="sm" variant="secondary">
            {a.label}
          </LinkButton>
        ) : (
          <Button key={a.label} size="sm" variant="secondary" loading={a.loading} onClick={a.onClick}>
            {a.label}
          </Button>
        ),
      )}
      {dismissible ? (
        <Button variant="ghost" size="sm" icon="close" aria-label={`Dismiss: ${title}`} onClick={onDismiss} />
      ) : null}
    </div>
  );
}
