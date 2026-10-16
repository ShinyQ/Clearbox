import type { ProviderKind } from "../../lib/view-types.ts";

export function ProviderTile({
  provider,
  active,
  size = 34,
}: {
  provider: ProviderKind;
  active: boolean;
  size?: 34 | 14;
}) {
  const tone = !active ? "bg-provider-off" : provider === "gmail" ? "bg-provider-gmail" : "bg-provider-outlook";
  const dims = size === 34 ? "size-[34px] rounded-lg text-title-sm" : "size-3.5 rounded-xs text-[9px] leading-none";
  return (
    <span
      aria-hidden="true"
      className={`inline-grid shrink-0 place-items-center font-heavy text-white ${dims} ${tone}`}
    >
      {provider === "gmail" ? "G" : "O"}
    </span>
  );
}
