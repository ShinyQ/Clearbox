import { matchesSenderList } from "@clearbox/core";
import { Hono } from "hono";
import { DismissRuleSuggestionBodySchema } from "../../shared/api.ts";
import type { RuleSuggestion, RuleSuggestionsResponse } from "../../shared/api.ts";
import {
  RULE_DISMISSALS_MAX,
  RULE_LABEL_CHECK_MAX,
  RULE_MIN_AGREEMENT,
  RULE_MIN_DECISIONS,
  RULE_QUIET_MS,
  RULE_SUGGESTIONS_MAX,
  ruleCandidatesQuery,
  ruleLabelsQuery,
} from "../db/rules.ts";
import type { RuleCandidateRow, RuleLabelRow } from "../db/rules.ts";
import { readSettings, setSettingStmt } from "../db/settings.ts";
import type { RuleDismissal, Settings } from "../db/settings.ts";
import { bindQuery, toIso } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";
import { parseWith, readJsonBody } from "../middleware/errors.ts";
import { scopeAccounts } from "./queue.ts";

export const rulesRoutes = new Hono<AppEnv>();

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * Pure: drops senders already covered by a list, and senders whose likely offer was dismissed, before the labels
 * check, so accepted or dismissed high-volume senders never crowd out the rest.
 */
export function openRuleCandidates(
  rows: readonly RuleCandidateRow[],
  settings: Pick<Settings, "policy" | "ruleDismissals">,
): string[] {
  const dismissed = new Set(settings.ruleDismissals.map((d) => `${d.list}\u001f${d.entry}`));
  const { allowlist, denylist } = settings.policy;
  return rows
    .filter((r) => {
      const domain = domainOf(r.sender);
      if (matchesSenderList(r.sender, domain, allowlist) || matchesSenderList(r.sender, domain, denylist))
        return false;
      const likely = r.deletes >= r.keeps ? "deny" : "allow";
      return !dismissed.has(`${likely}\u001f${r.sender}`);
    })
    .map((r) => r.sender)
    .slice(0, RULE_LABEL_CHECK_MAX);
}

/**
 * contracts 12.10, pure: a rule is offered after RULE_MIN_DECISIONS decisions on one sender with at least
 * RULE_MIN_AGREEMENT agreement and no contrary decision in the last RULE_QUIET_MS. "Always keep" needs keeps (not
 * archives). Senders already covered by a list, or dismissed for that rule, are skipped. Never applied automatically.
 */
export function pickRuleSuggestions(
  rows: readonly RuleLabelRow[],
  settings: Pick<Settings, "policy" | "ruleDismissals">,
  now: number,
): RuleSuggestion[] {
  const dismissed = new Set(settings.ruleDismissals.map((d) => `${d.list}\u001f${d.entry}`));
  const quietSince = now - RULE_QUIET_MS;
  const out: RuleSuggestion[] = [];
  for (const r of rows) {
    const total = r.deletes + r.keeps + r.archives;
    if (total < RULE_MIN_DECISIONS) continue;
    const domain = domainOf(r.sender);
    const { allowlist, denylist } = settings.policy;
    if (matchesSenderList(r.sender, domain, allowlist) || matchesSenderList(r.sender, domain, denylist))
      continue;
    let list: "allow" | "deny" | null = null;
    let agreeing = 0;
    if (
      r.deletes >= RULE_MIN_DECISIONS &&
      r.deletes / total >= RULE_MIN_AGREEMENT &&
      (r.last_not_delete === null || r.last_not_delete < quietSince)
    ) {
      list = "deny";
      agreeing = r.deletes;
    } else if (
      r.keeps >= RULE_MIN_DECISIONS &&
      r.keeps / total >= RULE_MIN_AGREEMENT &&
      (r.last_not_keep === null || r.last_not_keep < quietSince)
    ) {
      list = "allow";
      agreeing = r.keeps;
    }
    if (list === null || dismissed.has(`${list}\u001f${r.sender}`)) continue;
    out.push({ entry: r.sender, list, decisions: total, agreeing, lastDecidedAt: toIso(r.last_at) });
  }
  out.sort((x, y) => y.agreeing - x.agreeing || x.entry.localeCompare(y.entry));
  return out.slice(0, RULE_SUGGESTIONS_MAX);
}

rulesRoutes.get("/suggestions", async (c) => {
  const db = c.env.DB;
  const now = c.get("deps").now();
  const [settings, accounts] = await Promise.all([readSettings(db), scopeAccounts(db)]);
  const ids = accounts.map((a) => a.id);
  let suggestions: RuleSuggestion[] = [];
  if (ids.length > 0) {
    const candidates = await bindQuery(db, ruleCandidatesQuery(ids, RULE_MIN_DECISIONS)).run<{
      sender: string;
    }>();
    const senders = candidates.results.map((r) => r.sender);
    if (senders.length > 0) {
      const labels = await bindQuery(db, ruleLabelsQuery(ids, senders)).run<RuleLabelRow>();
      suggestions = pickRuleSuggestions(labels.results, settings, now);
    }
  }
  const body: RuleSuggestionsResponse = { suggestions };
  return c.json(body);
});

/** Remembers a dismissed suggestion (newest RULE_DISMISSALS_MAX kept); the rule lists are untouched. */
rulesRoutes.post("/suggestions/dismiss", async (c) => {
  const body = parseWith(DismissRuleSuggestionBodySchema, await readJsonBody(c));
  const db = c.env.DB;
  const now = c.get("deps").now();
  const settings = await readSettings(db);
  const next: RuleDismissal[] = [
    ...settings.ruleDismissals.filter((d) => !(d.entry === body.entry && d.list === body.list)),
    { entry: body.entry, list: body.list, at: now },
  ].slice(-RULE_DISMISSALS_MAX);
  await setSettingStmt(db, "rule_dismissals", next, now).run();
  return c.body(null, 204);
});
