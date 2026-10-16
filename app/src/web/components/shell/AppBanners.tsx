import { useState } from "react";
import { useNavigate } from "react-router";
import { useAccounts, useMe } from "../../api/queries.ts";
import {
  bannerDismissKey,
  buildAppBanners,
  collapseBanners,
  type AppBannerSpec,
  type BannerPage,
} from "../../lib/banners.ts";
import { localResetTime } from "../../lib/format.ts";
import { startOAuth } from "../../lib/oauth-return.ts";
import { useNow } from "../../state/use-now.ts";
import { useOffline } from "../../state/offline.ts";
import { Banner, type BannerAction } from "../ui/Banner.tsx";

export interface AppBannersProps {
  page: BannerPage;
  extra?: readonly AppBannerSpec[] | undefined;
  awaitingModel?: number | undefined;
  modelUnavailableShare?: number | undefined;
}

const PREFIX = "clearbox.banner.";

function readDismissed(): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key?.startsWith(PREFIX)) out.add(key.slice(PREFIX.length));
  }
  return out;
}

export function AppBanners({
  page,
  extra = [],
  awaitingModel = 0,
  modelUnavailableShare = 0,
}: AppBannersProps) {
  const me = useMe();
  const accounts = useAccounts();
  const offline = useOffline();
  const now = useNow();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [initialIds, setInitialIds] = useState<ReadonlySet<string> | null>(null);
  const ready = me.isSuccess && accounts.isSuccess;
  const list = collapseBanners([
    ...extra,
    ...buildAppBanners({
      page,
      me: me.data,
      accounts: accounts.data?.accounts ?? [],
      offline,
      awaitingModel,
      modelUnavailableShare,
      resetTime: localResetTime(now),
      dismissed,
    }),
  ]);
  // Banners present when data first arrives are plain regions; later ones are announced (UI spec 4.19).
  if (ready && initialIds === null) setInitialIds(new Set(list.map((b) => b.id)));
  if (list.length === 0) return null;

  const toAction = (a: NonNullable<AppBannerSpec["actions"]>[number]): BannerAction => {
    switch (a.kind) {
      case "reconnect":
        return {
          label: a.label,
          onClick: () =>
            startOAuth(a.account.provider, { returnTo: "/accounts", loginHint: a.account.email }),
        };
      case "link":
        return { label: a.label, href: a.href, external: true };
      case "route":
        return { label: a.label, onClick: () => void navigate(a.to) };
      case "callback":
        return { label: a.label, onClick: a.onClick, loading: a.loading };
    }
  };
  const dismiss = (id: string) => {
    window.sessionStorage.setItem(bannerDismissKey(id), "1");
    setDismissed((d) => new Set([...d, id]));
  };
  return (
    <div className="mb-3.5 flex flex-col gap-2">
      {list.map((b) => (
        <Banner
          key={b.id}
          tone={b.tone}
          title={b.title}
          body={b.body}
          actions={b.actions?.map(toAction)}
          dismissible={b.dismissible}
          onDismiss={() => dismiss(b.id)}
          announce={initialIds !== null && !initialIds.has(b.id)}
        />
      ))}
    </div>
  );
}
