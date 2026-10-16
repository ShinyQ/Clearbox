import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type { Insights } from "../../shared/api.ts";
import { qk } from "../api/keys.ts";
import { useDisconnectAccount, usePatchAccount } from "../api/mutations.ts";
import { useAccounts, useMe } from "../api/queries.ts";
import { AccountCard } from "../components/accounts/AccountCard.tsx";
import { ProviderTile } from "../components/accounts/ProviderTile.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button } from "../components/ui/Button.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import { dailyRateFrom } from "../lib/account-status.ts";
import type { AppBannerSpec } from "../lib/banners.ts";
import { GENERIC_ERROR } from "../lib/copy-actions.ts";
import { NOT_CONFIGURED, oauthErrorBanner } from "../lib/oauth-errors.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import type { ProviderKind } from "../lib/view-types.ts";
import { useToast } from "../state/ToastProvider.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useNow } from "../state/use-now.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";

export function AccountsPage() {
  useDocumentTitle("Accounts · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const [oauth] = useState(() => ({
    connected: params.get("connected"),
    error: params.get("error"),
    provider: params.get("provider"),
    add: params.get("add") === "1",
  }));
  const me = useMe();
  const accounts = useAccounts();
  const patch = usePatchAccount();
  const disconnect = useDisconnectAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const now = useNow();
  const [opening, setOpening] = useState<ProviderKind | null>(null);
  const [consentBanner, setConsentBanner] = useState<AppBannerSpec | null>(null);
  const gmailRef = useRef<HTMLButtonElement>(null);
  const toasted = useRef(false);
  const list = accounts.data?.accounts ?? [];
  const insights = qc.getQueryData<Insights>(qk.insights);
  const dailyRate = insights ? dailyRateFrom(insights.history) : 6_800;

  useEffect(() => {
    if (oauth.connected || oauth.error || oauth.provider || oauth.add) setParams({}, { replace: true });
  }, [oauth, setParams]);
  useEffect(() => {
    if (oauth.add) gmailRef.current?.focus();
  }, [oauth.add]);
  useEffect(() => {
    if (!accounts.data || toasted.current) return;
    const focusId = oauth.connected ? `acc_${oauth.connected}` : hash.startsWith("#acc_") ? hash.slice(1) : null;
    if (oauth.connected) {
      const a = accounts.data.accounts.find((x) => x.id === oauth.connected);
      if (a) toast.show({ kind: "success", message: `Connected ${a.email}. Sorting starts within a minute.` });
    }
    toasted.current = true;
    const el = focusId ? document.getElementById(focusId) : null;
    el?.scrollIntoView({ block: "nearest" });
    el?.focus();
  }, [accounts.data, hash, oauth.connected, toast]);

  const connect = (provider: ProviderKind) => {
    setOpening(provider);
    startOAuth(provider, { returnTo: "/accounts" });
  };
  const provider: ProviderKind | null =
    oauth.provider === "outlook" ? "outlook" : oauth.provider === "gmail" ? "gmail" : null;
  const oauthBanner = oauth.error
    ? oauthErrorBanner(oauth.error, provider, () => connect(provider ?? "gmail"))
    : null;
  const extra = [oauthBanner, consentBanner].filter((b): b is AppBannerSpec => b !== null);
  const providers = me.data?.providers;

  const onPause = (id: string, email: string, paused: boolean) =>
    patch.mutate(
      { id, paused },
      {
        onSuccess: () =>
          toast.show({
            kind: "info",
            message: paused ? `Paused sorting for ${email}.` : `Resumed sorting for ${email}.`,
          }),
        onError: () =>
          toast.show({ kind: "error", message: `Couldn't ${paused ? "pause" : "resume"} ${email}. Try again.` }),
      },
    );

  const onDisconnect = (id: string, email: string) =>
    disconnect.mutate(id, {
      onSuccess: (res) => {
        if (res.revocation === "revoked") {
          toast.show({ kind: "success", message: `Disconnected ${email}. Google access was revoked.` });
        } else if (res.revocation === "failed") {
          toast.show({
            kind: "success",
            message: `Disconnected ${email}. Google did not confirm the revoke; you can remove access at myaccount.google.com/permissions.`,
          });
        } else {
          setConsentBanner({
            id: "consent",
            tone: "info",
            title: `Disconnected ${email}.`,
            body: "Microsoft has no revoke button for apps, so remove Clearbox's access yourself.",
            actions: res.consentUrls
              ? [
                  { label: "Personal account", kind: "link", href: res.consentUrls.personal },
                  { label: "Work or school account", kind: "link", href: res.consentUrls.work },
                ]
              : [],
          });
        }
      },
      onError: () => toast.show({ kind: "error", message: GENERIC_ERROR }),
    });

  const connectButtons = (
    <>
      <Button
        ref={gmailRef}
        softDisabled={providers?.gmail === false}
        loading={opening === "gmail"}
        loadingLabel="Opening Google…"
        onClick={() => connect("gmail")}
      >
        <span className="inline-flex items-center gap-[7px]">
          <ProviderTile provider="gmail" active size={14} />
          Connect Gmail
        </span>
      </Button>
      <Button
        softDisabled={providers?.outlook === false}
        loading={opening === "outlook"}
        loadingLabel="Opening Microsoft…"
        onClick={() => connect("outlook")}
      >
        <span className="inline-flex items-center gap-[7px]">
          <ProviderTile provider="outlook" active size={14} />
          Connect Outlook
        </span>
      </Button>
    </>
  );

  return (
    <div className="max-w-[1040px]">
      <PageHeader title="Accounts" titleRef={titleRef} actions={connectButtons} />
      {providers && (!providers.gmail || !providers.outlook) ? (
        <div className="-mt-2 mb-3.5 flex flex-col gap-1 text-small text-ink-3">
          {!providers.gmail ? <p>{NOT_CONFIGURED.gmail}</p> : null}
          {!providers.outlook ? <p>{NOT_CONFIGURED.outlook}</p> : null}
        </div>
      ) : null}
      <AppBanners page="accounts" extra={extra} />
      {accounts.isError ? (
        <EmptyState
          variant="panel"
          title="Couldn't load accounts."
          body="Check your connection, then try again."
          action={{ label: "Try again", onClick: () => void accounts.refetch() }}
        />
      ) : accounts.isPending ? (
        <div aria-busy="true" className="rounded-xl border border-line bg-surface">
          <span className="sr-only">Loading accounts</span>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="flex flex-col gap-2 border-b border-line-subtle px-4 py-3.5 last:border-b-0"
            >
              <SkeletonLine width={180} />
              <SkeletonLine width={320} height={6} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          variant="panel"
          title="No accounts yet"
          body="Connect Gmail or Outlook to start sorting."
          action={{ label: "Connect Gmail", onClick: () => connect("gmail") }}
          secondaryAction={{ label: "Connect Outlook", onClick: () => connect("outlook") }}
        />
      ) : (
        <div className="rounded-xl border border-line bg-surface">
          {list.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              now={now}
              dailyRate={dailyRate}
              disconnecting={disconnect.isPending && disconnect.variables === a.id}
              onPause={(paused) => onPause(a.id, a.email, paused)}
              onDisconnect={() => onDisconnect(a.id, a.email)}
              onReconnect={() => startOAuth(a.provider, { returnTo: "/accounts", loginHint: a.email })}
            />
          ))}
        </div>
      )}
      <p className="mt-2.5 text-small text-ink-3">
        Clearbox can only move mail to Trash or Archive. It can never permanently delete or send email.
      </p>
    </div>
  );
}
