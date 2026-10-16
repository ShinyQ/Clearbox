import { http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";
import { beforeEach } from "vitest";
import { jwksHandler } from "./access.ts";
import { network } from "../setup/network.ts";
import { DAY, MINUTE, NOW, OWNER, graphDeltaLink } from "./tick-db.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

export interface FakeMail {
  id: string;
  conversationId: string;
  receivedAt: number;
  from: string;
  fromName?: string;
  to?: string[];
  subject?: string;
  preview?: string;
  isRead?: boolean;
  listUnsubscribe?: boolean;
  hasAttachments?: boolean;
  flagged?: boolean;
}

export interface FakeSent {
  conversationId: string;
  to: string[];
  sentAt: number;
}

export interface DeltaPage {
  added: FakeMail[];
  removed: string[];
  next: string;
}

export interface SentDeltaPage {
  items: FakeSent[];
  next: string;
}

export interface InjectedFailure {
  method: string;
  pathIncludes: string;
  status: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  times: number;
}

export interface TokenReply {
  status: number;
  body: Record<string, string | number>;
}

/** Message i: newest first by ascending i, five days old or more, four senders on two domains. */
export function mail(i: number, overrides: Partial<FakeMail> = {}): FakeMail {
  return {
    id: `msg-${String(i).padStart(3, "0")}`,
    conversationId: `conv-${i}`,
    receivedAt: NOW - 5 * DAY - i * MINUTE,
    from: `sender${i % 4}@shop${i % 2}.example`,
    fromName: `Shop ${i % 4}`,
    subject: `Weekly deals ${i}`,
    preview: `Deals of the week number ${i}`,
    ...overrides,
  };
}

function headersOf(m: FakeMail): { name: string; value: string }[] {
  const domain = m.from.split("@")[1] ?? "example.net";
  const list = [
    {
      name: "Authentication-Results",
      value: `spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
    },
  ];
  if (m.listUnsubscribe) {
    list.push(
      { name: "List-Unsubscribe", value: `<https://${domain}/unsubscribe>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    );
  }
  return list;
}

function graphMessage(m: FakeMail, withHeaders: boolean): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: m.conversationId,
    internetMessageId: `<${m.id}@example.net>`,
    receivedDateTime: new Date(m.receivedAt).toISOString(),
    subject: m.subject ?? "Hello",
    bodyPreview: m.preview ?? "Preview text",
    isRead: m.isRead ?? false,
    importance: "normal",
    hasAttachments: m.hasAttachments ?? false,
    inferenceClassification: "other",
    flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
    from: { emailAddress: { name: m.fromName ?? "Sender", address: m.from } },
    toRecipients: (m.to ?? [OWNER]).map((address) => ({ emailAddress: { address } })),
    ccRecipients: [],
    webLink: `https://outlook.example.test/owa/?ItemID=${m.id}`,
    ...(withHeaders ? { internetMessageHeaders: headersOf(m) } : {}),
  };
}

function sentMessage(s: FakeSent, index: number): Record<string, unknown> {
  return {
    id: `sent-${index}`,
    conversationId: s.conversationId,
    toRecipients: s.to.map((address) => ({ emailAddress: { address } })),
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: new Date(s.sentAt).toISOString(),
    receivedDateTime: new Date(s.sentAt).toISOString(),
  };
}

export class ProviderMock {
  inbox: FakeMail[] = [];
  sent: FakeSent[] = [];
  readonly inboxDelta = new Map<string, DeltaPage>();
  readonly sentDelta = new Map<string, SentDeltaPage>();
  readonly expiredTokens = new Set<string>();
  /** $filter of every delta request without $deltatoken (the first round after a resync), per folder. */
  readonly resyncFilters: { inbox: string[]; sent: string[] } = { inbox: [], sent: [] };
  /** Inbox total reported by the provider (amendment A4); null = number of fake inbox messages. */
  inboxTotal: number | null = null;
  microsoftToken: TokenReply = {
    status: 200,
    body: {
      token_type: "Bearer",
      scope:
        "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read offline_access",
      expires_in: 3599,
      access_token: "ms-access-2",
      refresh_token: "ms-refresh-2",
    },
  };
  googleToken: TokenReply = {
    status: 200,
    body: {
      access_token: "g-access-2",
      expires_in: 3599,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    },
  };
  readonly calls: string[] = [];
  readonly failures: InjectedFailure[] = [];

  failNext(f: Omit<InjectedFailure, "times"> & { times?: number }): void {
    this.failures.push({ times: 1, ...f });
  }

  handlers(): HttpHandler[] {
    return [
      http.all("*", ({ request }) => {
        const url = new URL(request.url);
        this.calls.push(`${request.method} ${url.origin}${url.pathname}`);
        const failure = this.failures.find(
          (f) => f.times > 0 && f.method === request.method && url.pathname.includes(f.pathIncludes),
        );
        if (failure === undefined) return undefined;
        failure.times -= 1;
        return HttpResponse.json(failure.body ?? { error: { code: "Injected", message: "injected" } }, {
          status: failure.status,
          headers: failure.headers ?? {},
        });
      }),
      http.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", () =>
        HttpResponse.json(this.microsoftToken.body, { status: this.microsoftToken.status }),
      ),
      http.post("https://oauth2.googleapis.com/token", () =>
        HttpResponse.json(this.googleToken.body, { status: this.googleToken.status }),
      ),
      http.get(`${GRAPH}/me/mailFolders/inbox`, () =>
        HttpResponse.json({
          id: "inbox-folder",
          displayName: "Inbox",
          totalItemCount: this.inboxTotal ?? this.inbox.length,
        }),
      ),
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX", () =>
        HttpResponse.json({
          id: "INBOX",
          name: "INBOX",
          messagesTotal: this.inboxTotal ?? this.inbox.length,
        }),
      ),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages/delta`, ({ request }) =>
        this.inboxDeltaReply(new URL(request.url)),
      ),
      http.get(`${GRAPH}/me/mailFolders/sentitems/messages/delta`, ({ request }) =>
        this.sentDeltaReply(new URL(request.url)),
      ),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages`, ({ request }) =>
        this.inboxListReply(new URL(request.url)),
      ),
      http.get(`${GRAPH}/me/mailFolders/sentitems/messages`, ({ request }) =>
        this.sentListReply(new URL(request.url)),
      ),
      http.post(/^https:\/\/graph\.microsoft\.com\/v1\.0\/\$batch$/, async ({ request }) =>
        this.batchReply(
          (await request.json()) as { requests: { id: string; method: string; url: string }[] },
        ),
      ),
    ];
  }

  private inboxListReply(url: URL): Response {
    const top = Number(url.searchParams.get("$top") ?? "10");
    const filter = url.searchParams.get("$filter") ?? "";
    // The Graph provider pages with "receivedDateTime lt <next second>" (keysetUpperBound).
    const bound = /receivedDateTime lt '?([0-9T:.\-Z]+)'?/.exec(filter);
    const before = bound?.[1] === undefined ? Number.POSITIVE_INFINITY : Date.parse(bound[1]);
    const sorted = [...this.inbox]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .filter((m) => m.receivedAt < before);
    const page = sorted.slice(0, top);
    return HttpResponse.json({
      value: page.map((m) => graphMessage(m, true)),
      ...(sorted.length > top
        ? { "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages?$skip=${top}` }
        : {}),
    });
  }

  private sentListReply(url: URL): Response {
    const top = Number(url.searchParams.get("$top") ?? "10");
    const skip = Number(url.searchParams.get("$skip") ?? "0");
    const sorted = [...this.sent].sort((a, b) => b.sentAt - a.sentAt);
    const page = sorted.slice(skip, skip + top);
    const more = skip + top < sorted.length;
    return HttpResponse.json({
      value: page.map((s, i) => sentMessage(s, skip + i)),
      ...(more
        ? { "@odata.nextLink": `${GRAPH}/me/mailFolders/sentitems/messages?$top=${top}&$skip=${skip + top}` }
        : {}),
    });
  }

  /**
   * A request without $deltatoken is the first round after a resync (filtered from the watermark). Real Graph
   * returns the mail since the watermark in that round, so it serves the page registered as "resync-inbox"
   * (default: empty, delta link "resync-inbox").
   */
  private inboxDeltaReply(url: URL): Response {
    const token = url.searchParams.get("$deltatoken") ?? "resync-inbox";
    if (!url.searchParams.has("$deltatoken"))
      this.resyncFilters.inbox.push(url.searchParams.get("$filter") ?? "");
    if (this.expiredTokens.has(token)) {
      return HttpResponse.json(
        { error: { code: "syncStateNotFound", message: "The sync state is not found." } },
        { status: 410 },
      );
    }
    const page = this.inboxDelta.get(token) ?? { added: [], removed: [], next: token };
    return HttpResponse.json({
      value: [
        ...page.added.map((m) => graphMessage(m, false)),
        ...page.removed.map((id) => ({ id, "@removed": { reason: "deleted" } })),
      ],
      "@odata.deltaLink": graphDeltaLink("inbox", page.next),
    });
  }

  /** Same as inboxDeltaReply: the first round after a resync serves the page registered as "resync-sent". */
  private sentDeltaReply(url: URL): Response {
    const token = url.searchParams.get("$deltatoken") ?? "resync-sent";
    if (!url.searchParams.has("$deltatoken"))
      this.resyncFilters.sent.push(url.searchParams.get("$filter") ?? "");
    if (this.expiredTokens.has(token)) {
      return HttpResponse.json(
        { error: { code: "syncStateNotFound", message: "The sync state is not found." } },
        { status: 410 },
      );
    }
    const page = this.sentDelta.get(token) ?? { items: [], next: token };
    return HttpResponse.json({
      value: page.items.map((s, i) => sentMessage(s, i)),
      "@odata.deltaLink": graphDeltaLink("sentitems", page.next),
    });
  }

  private batchReply(body: { requests: { id: string; method: string; url: string }[] }): Response {
    const known = [...this.inbox, ...[...this.inboxDelta.values()].flatMap((p) => p.added)];
    const responses = body.requests.map((r) => {
      const match = /\/me\/messages\/([^?/]+)/.exec(r.url);
      const id = match?.[1] === undefined ? "" : decodeURIComponent(match[1]);
      const found = known.find((m) => m.id === id);
      return found === undefined || r.method !== "GET"
        ? { id: r.id, status: 404, body: { error: { code: "ErrorItemNotFound", message: "Not found" } } }
        : {
            id: r.id,
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { id: found.id, internetMessageHeaders: headersOf(found) },
          };
    });
    return HttpResponse.json({ responses });
  }
}

const unhandledRequests: string[] = [];

beforeEach(() => {
  unhandledRequests.length = 0;
});

const unhandled = http.all("*", ({ request }) => {
  const url = new URL(request.url);
  const entry = `${request.method} ${url.origin}${url.pathname}`;
  unhandledRequests.push(entry);
  throw new Error(`Unhandled request ${entry}`);
});

/** Unmocked requests only surface to callers as HTTP 500s; tests call this in afterEach to fail on them. */
export function expectNoUnhandled(): void {
  if (unhandledRequests.length === 0) return;
  throw new Error(`Unhandled network requests:\n${unhandledRequests.join("\n")}`);
}

/** Installs handler groups in order, followed by a catch-all that fails unmocked requests. */
export function useNetwork(...groups: HttpHandler[][]): void {
  network.use(...groups.flat(), unhandled);
}

/** Like useNetwork, but the Access JWKS handler answers before the recording catch-all, for route tests. */
export function useNetworkOpen(...groups: HttpHandler[][]): void {
  network.use(...groups.flat(), jwksHandler(), unhandled);
}
