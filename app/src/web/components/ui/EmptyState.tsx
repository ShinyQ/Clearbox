import type { ReactNode, Ref } from "react";
import { Button } from "./Button.tsx";
import { Icon, type IconName } from "./icons.tsx";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: "secondary" | "primary";
}

export interface EmptyStateProps {
  variant: "panel" | "page" | "inline";
  title: string;
  body: string;
  action?: EmptyStateAction | undefined;
  secondaryAction?: EmptyStateAction | undefined;
  icon?: IconName | undefined;
  headingLevel?: 1 | 2 | 3;
  actionRef?: Ref<HTMLButtonElement> | undefined;
  children?: ReactNode;
}

const FRAME = {
  panel: "rounded-xl border border-line bg-surface p-[26px] text-center",
  page: "mx-auto max-w-[480px] pt-8 text-center",
  inline: "px-4 py-10 text-center",
};

export function EmptyState({
  variant,
  title,
  body,
  action,
  secondaryAction,
  icon,
  headingLevel = 2,
  actionRef,
  children,
}: EmptyStateProps) {
  const Heading = headingLevel === 1 ? "h1" : headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={FRAME[variant]}>
      {icon && variant === "page" ? <Icon name={icon} size={32} className="mx-auto mb-3 text-ink-3" /> : null}
      <Heading className="text-title font-semibold text-ink">{title}</Heading>
      <p className="mx-auto mt-1 mb-3 max-w-[420px] text-ink-3">{body}</p>
      {children}
      {action || secondaryAction ? (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {action ? (
            <Button ref={actionRef} variant={action.variant ?? "secondary"} onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button variant={secondaryAction.variant ?? "secondary"} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
