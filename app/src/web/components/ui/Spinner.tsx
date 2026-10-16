export type SpinnerTone = "default" | "on-dark";

/** 12px spinner; with reduced motion a static three-dot glyph replaces it (UI spec 2.7). */
export function Spinner({ tone = "default" }: { tone?: SpinnerTone }) {
  const ring =
    tone === "on-dark" ? "border-[rgba(255,255,255,.3)] border-t-white" : "border-line-control border-t-ink";
  const dot = tone === "on-dark" ? "bg-white" : "bg-ink-3";
  return (
    <span aria-hidden="true" className="inline-flex size-3 shrink-0 items-center justify-center">
      <span
        className={`size-3 rounded-full border-2 motion-safe:animate-spin motion-reduce:hidden ${ring}`}
      />
      <span className="hidden gap-[2px] motion-reduce:inline-flex">
        <i className={`size-[3px] rounded-full ${dot}`} />
        <i className={`size-[3px] rounded-full ${dot}`} />
        <i className={`size-[3px] rounded-full ${dot}`} />
      </span>
    </span>
  );
}
