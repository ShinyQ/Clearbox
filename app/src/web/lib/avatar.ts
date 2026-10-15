export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function avatarColorIndex(domain: string): number {
  return fnv1a32(domain.trim().toLowerCase()) % 12;
}

export function monogram(name: string | null, address: string, domain: string): string {
  const source = (name ?? "").trim() || address.split("@")[0] || domain;
  const m = source.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toLocaleUpperCase() : "?";
}

/** Static list so Tailwind sees every class name. */
export const AVATAR_BG: readonly string[] = [
  "bg-avatar-0",
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
  "bg-avatar-7",
  "bg-avatar-8",
  "bg-avatar-9",
  "bg-avatar-10",
  "bg-avatar-11",
];
