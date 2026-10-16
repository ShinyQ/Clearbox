import type { ReactNode } from "react";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";
import { Button } from "./Button.tsx";
import { SkeletonLine } from "./Skeleton.tsx";

export interface Column<Row> {
  key: string;
  header: string;
  align?: "left" | "right";
  className?: string;
  srOnlyHeader?: boolean;
  render: (row: Row) => ReactNode;
}

export interface TableProps<Row> {
  caption: string;
  columns: Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string | number;
  state: "loading" | "ready" | "empty" | "error";
  emptyText: string;
  onRetry?: (() => void) | undefined;
  footer?: ReactNode;
  rowHover?: (row: Row) => boolean;
}

const TD = "border-b border-line-subtle px-4 py-2.5 text-ink-2";

export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  state,
  emptyText,
  onRetry,
  footer,
  rowHover,
}: TableProps<Row>) {
  const narrow = !useMediaQuery(BP.sm);
  const span = columns.length;
  const table = (
    <table className="w-full border-collapse text-body">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={`border-b border-line bg-surface px-4 py-2 text-meta font-medium text-ink-3 ${
                c.align === "right" ? "text-right" : "text-left"
              } ${c.className ?? ""}`}
            >
              {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody aria-busy={state === "loading" || undefined}>
        {state === "loading"
          ? Array.from({ length: 5 }, (_, i) => (
              <tr key={i} aria-hidden="true">
                {columns.map((c) => (
                  <td key={c.key} className={TD}>
                    <SkeletonLine width="60%" />
                  </td>
                ))}
              </tr>
            ))
          : null}
        {state === "empty" ? (
          <tr>
            <td colSpan={span} className="px-4 py-6 text-center text-ink-3">
              {emptyText}
            </td>
          </tr>
        ) : null}
        {state === "error" ? (
          <tr>
            <td colSpan={span} className="px-4 py-6 text-center text-ink-3">
              Couldn't load this table.{" "}
              {onRetry ? (
                <Button variant="link" onClick={onRetry}>
                  Try again
                </Button>
              ) : null}
            </td>
          </tr>
        ) : null}
        {state === "ready"
          ? rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={`[&:last-child>td]:border-b-0 ${rowHover?.(row) ? "hover:bg-surface-hover" : ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`${TD} ${c.align === "right" ? "text-right" : ""}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          : null}
      </tbody>
    </table>
  );
  return (
    <>
      {narrow ? (
        <div role="region" aria-label={caption} tabIndex={0} className="overflow-x-auto">
          {table}
        </div>
      ) : (
        table
      )}
      {footer}
    </>
  );
}
