import type { ReactNode } from "react";

export interface RuleFieldProps {
  id: string;
  title: string;
  description: string;
  row?: boolean;
  children: ReactNode;
}

export function RuleField({ id, title, description, row = false, children }: RuleFieldProps) {
  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-line-subtle px-4 py-3.5 last:border-b-0 ${row ? "sm:flex-row sm:items-center sm:gap-4" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <p id={`${id}-title`} className="font-emphasis text-ink">
          {title}
        </p>
        <p id={`${id}-desc`} className="text-small text-ink-3">
          {description}
        </p>
      </div>
      {children}
    </div>
  );
}
