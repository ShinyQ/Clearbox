import { AVATAR_BG, avatarColorIndex, monogram } from "../../lib/avatar.ts";

export interface SenderAvatarProps {
  name: string | null;
  address: string;
  domain: string;
  size: 22 | 30;
}

/** Private monogram; never a remote logo (UI spec 4.9). */
export function SenderAvatar({ name, address, domain, size }: SenderAvatarProps) {
  const unknown = !address && !domain;
  const tone = unknown
    ? "bg-neutral-fill text-ink"
    : `${AVATAR_BG[avatarColorIndex(domain || address)] ?? "bg-avatar-0"} text-white`;
  const dims = size === 22 ? "size-[22px] rounded-sm text-micro" : "size-[30px] rounded-md text-base";
  return (
    <span aria-hidden="true" className={`inline-grid shrink-0 place-items-center font-heavy ${dims} ${tone}`}>
      {unknown ? "?" : monogram(name, address, domain)}
    </span>
  );
}
