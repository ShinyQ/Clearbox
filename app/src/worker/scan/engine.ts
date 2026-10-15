import { MaiDecisionEngine } from "@clearbox/core";
import type { DecisionEngine, FetchLike } from "@clearbox/core";

/** Null when any Decision-1 secret is empty; the tick then raises issue decision_not_configured. */
export function makeDecisionEngine(env: Env, fetch: FetchLike): DecisionEngine | null {
  const endpoint = env.AZURE_DECISION_ENDPOINT;
  const apiKey = env.AZURE_DECISION_KEY;
  const deployment = env.AZURE_DECISION_DEPLOYMENT;
  if (!endpoint || !apiKey || !deployment) return null;
  return new MaiDecisionEngine({ endpoint: endpoint.replace(/\/+$/, ""), deployment, apiKey, fetch });
}
