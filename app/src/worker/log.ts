export type LogEventName =
  | "tick.idle"
  | "tick.claimed"
  | "tick.done"
  | "tick.failed"
  | "decision.error"
  | "provider.error"
  | "account.status"
  | "oauth.connect"
  | "action.executed"
  | "undo.done"
  | "nightly.done"
  | "reminder.done"
  | "access.denied"
  | "config.invalid"
  | "budget.gate"
  | "issue.raised"
  | "issue.cleared"
  | "request.error"
  | "unsubscribe.done";

export interface LogBase {
  app: "clearbox";
  ts: string;
  evt: LogEventName;
}

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** The only console.log call site in the Worker. Fields must be ids, counts, codes or statuses (contracts 9). */
export function logEvent(name: LogEventName, fields: LogFields): void {
  const base: LogBase = { app: "clearbox", ts: new Date().toISOString(), evt: name };
  console.log(JSON.stringify({ ...fields, ...base }));
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "acc_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
