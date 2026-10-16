import type { ReactNode } from "react";

export function VisuallyHidden({ children, id }: { children: ReactNode; id?: string | undefined }) {
  return (
    <span className="sr-only" id={id}>
      {children}
    </span>
  );
}
