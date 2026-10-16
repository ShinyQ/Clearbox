export function StatLine({ value, text, sub }: { value: string; text: string; sub?: string | undefined }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line-subtle px-4 py-3.5 last:border-b-0">
      <span className="min-w-[90px] text-stat font-heading text-ink">{value}</span>
      <span className="text-ink-3">
        {text}
        {sub ? <span className="block text-small">{sub}</span> : null}
      </span>
    </div>
  );
}
