import type { SenderGroup } from "../../../shared/api.ts";
import { formatCount, truncateName } from "../../lib/format.ts";
import type { ActionKind } from "../../lib/view-types.ts";
import { Button, type ButtonVariant } from "../ui/Button.tsx";
import type { IconName } from "../ui/icons.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";

export interface DetailActionsProps {
  group: SenderGroup;
  name: string;
  busyAction: ActionKind | null;
  disabled: boolean;
  onAction: (action: ActionKind) => void;
  onAlwaysKeep: (entry: string) => void;
  onAlwaysTrash: (entry: string) => void;
  onCopyAddress: () => void;
}

interface Spec {
  action: ActionKind;
  label: string;
  variant: ButtonVariant;
  icon?: IconName;
}

const KEY: Record<ActionKind, string> = { delete: "T", archive: "A", keep: "E" };

function specs(g: SenderGroup): Spec[] {
  const n = formatCount(g.count);
  switch (g.action) {
    case "delete":
      return [
        { action: "delete", label: `Trash ${n}`, variant: "danger", icon: "trash" },
        { action: "archive", label: "Archive", variant: "secondary" },
        { action: "keep", label: "Keep", variant: "secondary" },
      ];
    case "archive":
      return [
        { action: "archive", label: `Archive ${n}`, variant: "primary", icon: "archive" },
        { action: "delete", label: "Trash", variant: "secondary", icon: "trash" },
        { action: "keep", label: "Keep", variant: "secondary" },
      ];
    case "keep":
      return [
        { action: "keep", label: `Keep ${n}`, variant: "primary", icon: "keep" },
        { action: "archive", label: "Archive", variant: "secondary" },
        { action: "delete", label: "Trash", variant: "secondary", icon: "trash" },
      ];
    default:
      return [
        { action: "delete", label: "Trash", variant: "secondary", icon: "trash" },
        { action: "archive", label: "Archive", variant: "secondary" },
        { action: "keep", label: "Keep", variant: "secondary" },
      ];
  }
}

export function DetailActions(p: DetailActionsProps) {
  const known = p.group.sender !== "";
  const short = truncateName(p.name);
  const locked = p.disabled || p.busyAction !== null;
  const items: MenuItem[] = [
    ...(known
      ? [
          {
            id: "deny",
            label: `Always OK to trash ${short}`,
            icon: "trash" as const,
            disabled: locked,
            onSelect: () => p.onAlwaysTrash(p.group.sender),
          },
          {
            id: "allow-domain",
            label: `Always keep everything from @${p.group.domain}`,
            icon: "shield" as const,
            disabled: locked,
            onSelect: () => p.onAlwaysKeep(`@${p.group.domain}`),
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy sender address",
      icon: "copy" as const,
      disabled: !known,
      onSelect: p.onCopyAddress,
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {specs(p.group).map((s) => (
        <Button
          key={s.action}
          variant={s.variant}
          icon={s.icon}
          aria-keyshortcuts={KEY[s.action]}
          loading={p.busyAction === s.action}
          softDisabled={p.disabled || (p.busyAction !== null && p.busyAction !== s.action)}
          onClick={() => p.onAction(s.action)}
        >
          {s.label}
        </Button>
      ))}
      {known && p.group.action !== "keep" ? (
        <Button
          variant="ghost"
          softDisabled={p.disabled || p.busyAction !== null}
          onClick={() => p.onAlwaysKeep(p.group.sender)}
        >
          {`Always keep ${short}`}
        </Button>
      ) : null}
      <Menu
        label="More actions"
        align="end"
        items={items}
        renderTrigger={(t) => <Button {...t} variant="ghost" icon="more" aria-label="More actions" />}
      />
    </div>
  );
}
