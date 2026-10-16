import type {
  ActionResponse,
  ApproveBody,
  GroupDetail,
  ItemErrorCode,
  OverrideBody,
  SenderGroup,
} from "../../shared/api.ts";
import type { ActionKind } from "../lib/view-types.ts";
import { reportBug } from "../lib/report.ts";
import { ApiError, isApiError } from "./client.ts";

export interface GroupActionResult {
  executed: number;
  failed: number;
  skipped: number;
  retryLater: number;
  batchIds: number[];
  /** Error codes of failed and retry_later items (account_inactive, rate_limited, ...). */
  codes: Partial<Record<ItemErrorCode, number>>;
  error: ApiError | null;
}

export interface GroupActionDeps {
  approve: (body: ApproveBody) => Promise<ActionResponse>;
  override: (body: OverrideBody) => Promise<ActionResponse>;
  groupDetail: (key: string, q: { limit: number }) => Promise<GroupDetail>;
}

export function emptyGroupResult(): GroupActionResult {
  return { executed: 0, failed: 0, skipped: 0, retryLater: 0, batchIds: [], codes: {}, error: null };
}

/** UI spec 6.4. Approve when the target equals the suggestion; otherwise override page by page. */
export async function actOnGroup(
  group: SenderGroup,
  target: ActionKind,
  asOf: string,
  deps: GroupActionDeps,
): Promise<GroupActionResult> {
  const out = emptyGroupResult();
  const collect = (r: ActionResponse) => {
    out.executed += r.executed;
    out.failed += r.failed;
    out.skipped += r.skipped;
    out.retryLater += r.retryLater;
    if (r.batchId !== null) out.batchIds.push(r.batchId);
    for (const item of r.results) {
      if (item.error && (item.outcome === "failed" || item.outcome === "retry_later"))
        out.codes[item.error] = (out.codes[item.error] ?? 0) + 1;
    }
  };
  const maxCalls = Math.ceil(group.count / 100) + 3;
  try {
    if (group.action === target) {
      for (let i = 0; i < maxCalls; i++) {
        const r = await deps.approve({ groupKey: group.key, asOf });
        collect(r);
        if (r.remaining === 0 || r.executed + r.failed + r.skipped === 0) break;
      }
    } else {
      for (let i = 0; i < maxCalls; i++) {
        let page: GroupDetail;
        try {
          page = await deps.groupDetail(group.key, { limit: 100 });
        } catch (e) {
          // The group disappears (404) once it has no pending items left.
          if (isApiError(e) && e.status === 404) break;
          throw e;
        }
        const ids = page.items.items.map((it) => it.id);
        if (ids.length === 0) break;
        const r = await deps.override({ ids, action: target });
        collect(r);
        if (r.executed + r.failed + r.skipped === 0) break;
      }
    }
  } catch (e) {
    if (isApiError(e)) out.error = e;
    else {
      reportBug("Group action stopped on an unexpected error", e);
      out.error = new ApiError(
        500,
        "internal",
        e instanceof Error ? e.message : "Unexpected error",
        undefined,
        e,
      );
    }
  }
  return out;
}
