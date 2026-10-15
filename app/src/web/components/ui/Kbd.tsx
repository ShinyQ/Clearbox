export type KbdTone = "default" | "on-primary" | "on-inverse";

const TONE: Record<KbdTone, string> = {
  default: "bg-surface border-line text-ink-3",
  "on-primary": "bg-[rgba(255,255,255,.12)] border-[rgba(255,255,255,.18)] text-[#D6D7DD]",
  "on-inverse": "bg-transparent border-inverse-line text-on-inverse-3",
};

/** Hidden below 640px (no physical keyboard expected there). */
export function Kbd({
  keys,
  tone = "default",
  ariaHidden = false,
}: {
  keys: string[];
  tone?: KbdTone;
  ariaHidden?: boolean;
}) {
  return (
    <span className="hidden items-center gap-[3px] sm:inline-flex" aria-hidden={ariaHidden || undefined}>
      {keys.map((key, i) => (
        <kbd
          key={`${key}-${i}`}
          className={`rounded-xs border border-b-2 px-[5px] font-mono text-micro ${TONE[tone]}`}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
