import { useId, type ReactNode } from "react";

export function Panel({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`rounded-xl border border-line bg-surface ${className ?? ""}`}>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <h2 id={id} className="font-semibold text-ink">
          {title}
        </h2>
        {meta ? <span className="ml-auto text-small text-ink-3">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
