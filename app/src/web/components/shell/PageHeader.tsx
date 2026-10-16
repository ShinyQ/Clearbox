import type { ReactNode, Ref } from "react";

export interface PageHeaderProps {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement> | undefined;
}

export function PageHeader({ title, meta, actions, titleRef }: PageHeaderProps) {
  return (
    <div className="mb-3.5 flex min-h-8 flex-wrap items-center gap-2.5">
      <h1 ref={titleRef} tabIndex={-1} className="text-h1 font-heading text-ink focus:outline-none">
        {title}
      </h1>
      {meta ? <span className="text-small text-ink-3">{meta}</span> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
