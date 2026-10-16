import type { KeyboardEvent } from "react";
import type { SuggestionItem } from "../../../shared/api.ts";
import { bandFor, toPercent } from "../../lib/confidence.ts";
import { formatCount, formatWeekdayDateTime, shortAge } from "../../lib/format.ts";
import { providerName } from "../../lib/account-status.ts";
import { BAND_LABEL, type ActionKind, type ProviderKind } from "../../lib/view-types.ts";
import { Button, LinkButton } from "../ui/Button.tsx";

const OUTLOOK_HOST = /^outlook\.(live|office|office365)\.com$/;

/** UI spec 8.5: only Gmail and Outlook web links, https only. */
export function safeDeepLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "mail.google.com" || OUTLOOK_HOST.test(url.hostname)) return link;
  } catch {
    return null;
  }
  return null;
}

export interface EmailPreviewListProps {
  items: readonly SuggestionItem[];
  total: number;
  provider: ProviderKind;
  senderLabel: string;
  expandedId: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  tau: number;
  now: number;
  busyIds: ReadonlySet<number>;
  onToggleExpand: (id: number) => void;
  onItemAction: (id: number, action: ActionKind) => void;
  onLoadMore: () => void;
}

const ACTIONS: [ActionKind, string][] = [
  ["delete", "Trash"],
  ["archive", "Archive"],
  ["keep", "Keep"],
];

export function EmailPreviewList(p: EmailPreviewListProps) {
  const provider = providerName(p.provider);
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, item: SuggestionItem) => {
    if (e.key.toLowerCase() !== "o" || p.expandedId !== item.id || e.metaKey || e.ctrlKey || e.altKey) return;
    const link = safeDeepLink(item.deepLink);
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      window.open(link, "_blank", "noopener,noreferrer");
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <ul aria-label={`Latest emails from ${p.senderLabel}`}>
        {p.items.map((item) => {
          const expanded = p.expandedId === item.id;
          const regionId = `email-${item.id}`;
          const link = safeDeepLink(item.deepLink);
          const band = bandFor(item.confidence, p.tau, item.action);
          return (
            <li
              key={item.id}
              onKeyDown={(e) => onKeyDown(e, item)}
              className={`border-b border-line-subtle last:border-b-0 ${expanded ? "bg-surface-hover" : ""} ${p.busyIds.has(item.id) ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={regionId}
                onClick={() => p.onToggleExpand(item.id)}
                className="flex w-full items-center justify-between gap-2.5 px-2.5 py-[7px] text-left text-small outline-offset-[-2px] hover:bg-surface-hover"
              >
                <span
                  className={`truncate ${item.subject ? (item.isRead ? "text-ink-2" : "font-emphasis text-ink") : "text-ink-3"}`}
                >
                  {item.subject || "(no subject)"}
                </span>
                <span className="shrink-0 text-ink-3">{shortAge(item.receivedAt, p.now)}</span>
              </button>
              {expanded ? (
                <div id={regionId} className="flex flex-col gap-1.5 px-2.5 pb-2.5">
                  <p className="line-clamp-3 text-small whitespace-pre-line text-ink-3">
                    {item.snippet ?? "Preview not stored (turned off in Rules)."}
                  </p>
                  <p className="text-meta text-ink-3">
                    {`Received ${formatWeekdayDateTime(item.receivedAt)} · ${toPercent(item.confidence)}% ${BAND_LABEL[band]}`}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ACTIONS.map(([action, label]) => (
                      <Button
                        key={action}
                        size="sm"
                        aria-label={`${label} this email`}
                        softDisabled={p.busyIds.has(item.id)}
                        onClick={() => p.onItemAction(item.id, action)}
                      >
                        {label}
                      </Button>
                    ))}
                    {link ? (
                      <LinkButton
                        href={link}
                        external
                        variant="ghost"
                        size="sm"
                        aria-label={`Open this email in ${provider} (new tab)`}
                      >
                        {`Open in ${provider}`}
                      </LinkButton>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {p.hasMore ? (
        <div className="flex items-center justify-between border-t border-line-subtle px-2.5 py-[7px] text-small">
          <span className="text-ink-3">{`+ ${formatCount(Math.max(0, p.total - p.items.length))} more`}</span>
          <Button
            variant="link"
            size="sm"
            loading={p.loadingMore}
            loadingLabel="Loading…"
            onClick={p.onLoadMore}
          >
            Show 20 more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
