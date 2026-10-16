import type { AccountView, AppIssueCode, MeResponse } from "../../shared/api.ts";
import type { BannerTone } from "../components/ui/Banner.tsx";
import { docsUrl } from "./links.ts";
import { formatCount } from "./format.ts";

export type BannerPage = "review" | "activity" | "insights" | "rules" | "accounts" | "setup";

export type BannerActionSpec =
  | { label: string; kind: "reconnect"; account: AccountView }
  | { label: string; kind: "link"; href: string }
  | { label: string; kind: "route"; to: string }
  | { label: string; kind: "callback"; onClick: () => void; loading?: boolean };

export interface AppBannerSpec {
  id: string;
  tone: BannerTone;
  title: string;
  body?: string | undefined;
  actions?: BannerActionSpec[] | undefined;
  dismissible?: boolean | undefined;
}

export interface BannerInput {
  page: BannerPage;
  me: MeResponse | undefined;
  accounts: readonly AccountView[];
  offline: boolean;
  awaitingModel: number;
  modelUnavailableShare: number;
  resetTime: string;
  dismissed: ReadonlySet<string>;
}

export const bannerDismissKey = (id: string): string => `clearbox.banner.${id}`;

/**
 * decision_not_configured clears as soon as the engine is configured. The other two clear only
 * after the next successful decision, so their copy says so instead of promising an instant fix.
 */
export const MODEL_BODY: Partial<Record<AppIssueCode, string>> = {
  decision_not_configured:
    "AZURE_DECISION_ENDPOINT, AZURE_DECISION_KEY or AZURE_DECISION_DEPLOYMENT is missing or invalid. The endpoint must be an https URL and the deployment name cannot be Microsoft-Decision-1.",
  decision_auth_failed:
    "Azure rejected the API key. Update AZURE_DECISION_KEY and redeploy. This clears after the next successful sort.",
  decision_deployment_not_found:
    "The deployment name was not found. Check AZURE_DECISION_DEPLOYMENT. This clears after the next successful sort.",
};

const SETUP_ERROR = {
  gmail: {
    title: "Google sign-in is misconfigured.",
    body: "Google rejected the client ID or secret. Update GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, redeploy, then reconnect.",
    doc: "setup-google.md",
  },
  outlook: {
    title: "Microsoft sign-in is misconfigured.",
    body: "Microsoft rejected the client secret (it may have expired). Create a new secret, update MS_CLIENT_SECRET, redeploy, then reconnect.",
    doc: "setup-microsoft.md",
  },
} as const;

export const setupErrorBanner = (provider: "gmail" | "outlook"): AppBannerSpec => ({
  id: `setup-${provider}`,
  tone: "error",
  title: SETUP_ERROR[provider].title,
  body: SETUP_ERROR[provider].body,
  actions: [{ label: "Open setup guide", kind: "link", href: docsUrl(SETUP_ERROR[provider].doc) }],
});

const ON: Record<string, readonly BannerPage[]> = {
  reconnect: ["review", "accounts"],
  setup: ["review", "accounts", "setup"],
  model: ["review", "insights"],
  modelDown: ["review", "insights"],
  budget: ["review", "insights"],
  storage: ["review", "insights"],
};
const TONE_ORDER: Record<BannerTone, number> = { error: 0, warning: 1, info: 2, success: 3 };
const MODEL_CODES = [
  "decision_not_configured",
  "decision_auth_failed",
  "decision_deployment_not_found",
] as const;

export function buildAppBanners(i: BannerInput): AppBannerSpec[] {
  const out: AppBannerSpec[] = [];
  const issues = new Set((i.me?.issues ?? []).map((x) => x.code));
  const on = (k: string) => ON[k]?.includes(i.page) ?? false;
  if (i.offline) {
    out.push({
      id: "offline",
      tone: "warning",
      title: "You're offline.",
      body: "Clearbox will refresh when you're back online. Actions are paused.",
    });
  }
  if (on("reconnect")) {
    for (const a of i.accounts.filter((x) => x.status === "needs_reauth")) {
      out.push({
        id: `reauth-${a.id}`,
        tone: "warning",
        title: `${a.email} needs to reconnect.`,
        body:
          a.provider === "gmail"
            ? "Google ended the session (password change or 6 months unused). Sorting is paused for this account."
            : "Microsoft ended the session. Sorting is paused for this account.",
        actions: [{ label: "Reconnect", kind: "reconnect", account: a }],
      });
    }
  }
  if (on("setup")) {
    const configError = (p: "gmail" | "outlook") =>
      i.accounts.some((a) => a.status === "config_error" && a.provider === p);
    if (issues.has("google_client_invalid") || configError("gmail")) out.push(setupErrorBanner("gmail"));
    if (issues.has("microsoft_client_invalid") || configError("outlook"))
      out.push(setupErrorBanner("outlook"));
  }
  const modelCode = MODEL_CODES.find((c) => issues.has(c));
  if (on("model") && modelCode) {
    out.push({
      id: "model",
      tone: "error",
      title: "Clearbox can't use the AI model.",
      body: `${MODEL_BODY[modelCode] ?? ""} New emails are marked Check until this is fixed.`,
      actions: [{ label: "Open setup guide", kind: "link", href: docsUrl("setup-azure.md") }],
    });
  }
  if (on("modelDown") && !modelCode && (i.awaitingModel > 0 || i.modelUnavailableShare > 0.5)) {
    const waiting =
      i.awaitingModel > 0
        ? `${formatCount(i.awaitingModel)} ${i.awaitingModel === 1 ? "email is" : "emails are"} waiting and Clearbox retries automatically.`
        : "Clearbox retries automatically.";
    out.push({
      id: "model-down",
      tone: "info",
      title: "The AI model is not responding right now.",
      body: `${waiting} Emails it could not score are marked Check with the reason "Model unavailable".`,
    });
  }
  if (on("budget") && issues.has("budget_exhausted_today")) {
    out.push({
      id: "budget",
      tone: "warning",
      dismissible: true,
      title: "Today's free-tier limit is reached.",
      body: `New mail is sorted again after ${i.resetTime}. Clean up and other actions keep working until the action limit is reached.`,
    });
  }
  if (on("storage") && issues.has("storage_near_limit")) {
    out.push({
      id: "storage",
      tone: "warning",
      dismissible: true,
      title: "Storage is almost full.",
      body: "Clearbox paused reading older mail at 450 MB of 500 MB. Old data is removed nightly, then sorting resumes.",
    });
  }
  return out.filter((b) => !i.dismissed.has(b.id)).sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

/** UI spec 3.4: at most 3 banners; extras collapse into a final info line. */
export function collapseBanners(list: readonly AppBannerSpec[]): AppBannerSpec[] {
  if (list.length <= 3) return [...list];
  const extra = list.length - 2;
  return [
    ...list.slice(0, 2),
    {
      id: "more",
      tone: "info",
      title: `${formatCount(extra)} more issues. See Accounts.`,
      actions: [{ label: "Open Accounts", kind: "route", to: "/accounts" }],
    },
  ];
}
