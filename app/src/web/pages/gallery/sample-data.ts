import type { SenderGroup } from "../../../shared/api.ts";

/** Synthetic data for the dev gallery only (reserved .example domains). */
export function galleryGroup(overrides: Partial<SenderGroup>): SenderGroup {
  return {
    key: "gallery-1",
    accountId: "acc_0000000000000001",
    provider: "gmail",
    sender: "promo@northwind.example",
    senderName: "Northwind Deals",
    domain: "northwind.example",
    action: "delete",
    count: 248,
    confidence: { min: 0.91, avg: 0.97, max: 0.99 },
    topReasons: [{ code: "prior_sender_deleted", text: "You trashed 41 of 44 from this sender" }],
    ceilingApplied: false,
    newestReceivedAt: "2026-10-15T09:00:00.000Z",
    oldestReceivedAt: "2026-10-01T09:00:00.000Z",
    latestSubject: "Flash sale ends tonight",
    ...overrides,
  };
}

export const GALLERY_GROUPS: {
  label: string;
  group: SenderGroup;
  active?: boolean;
  selected?: boolean;
  busy?: boolean;
}[] = [
  { label: "default", group: galleryGroup({ key: "g-default" }) },
  {
    label: "active",
    group: galleryGroup({
      key: "g-active",
      senderName: "Daily Digest",
      sender: "digest@news.example",
      domain: "news.example",
      confidence: { min: 0.88, avg: 0.9, max: 0.93 },
    }),
    active: true,
  },
  {
    label: "selected",
    group: galleryGroup({
      key: "g-selected",
      senderName: "Fabrikam Updates",
      sender: "updates@fabrikam.example",
      domain: "fabrikam.example",
      action: "archive",
      confidence: { min: 0.74, avg: 0.79, max: 0.84 },
    }),
    selected: true,
  },
  {
    label: "busy",
    group: galleryGroup({
      key: "g-busy",
      senderName: "Tailspin Travel",
      sender: "deals@tailspin.example",
      domain: "tailspin.example",
    }),
    busy: true,
  },
  {
    label: "protected",
    group: galleryGroup({
      key: "g-protected",
      senderName: "Contoso Orders",
      sender: "orders@contoso.example",
      domain: "contoso.example",
      action: "archive",
      ceilingApplied: true,
    }),
  },
  {
    label: "model unavailable",
    group: galleryGroup({
      key: "g-model",
      senderName: "Build Bot",
      sender: "builds@ci.example",
      domain: "ci.example",
      action: "unsure",
      confidence: { min: 0.4, avg: 0.5, max: 0.55 },
      topReasons: [{ code: "model_unavailable", text: "Model unavailable, needs your review" }],
    }),
  },
];
