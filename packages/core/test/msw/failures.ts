/** One injected failure: the next `times` requests (default 1) matching method and path get this response. */
export interface FailRule {
  method: string;
  /** Exact path or a RegExp. Gmail: URL pathname ("/gmail/v1/users/me/history"); Graph: path after "/v1.0"; OAuth: "/token". */
  path: string | RegExp;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  times?: number;
}

export class FailureQueue {
  private readonly rules: { rule: FailRule; left: number }[] = [];

  add(rule: FailRule): void {
    this.rules.push({ rule, left: rule.times ?? 1 });
  }

  take(method: string, path: string): FailRule | null {
    for (const entry of this.rules) {
      const { rule } = entry;
      const pathMatches = typeof rule.path === "string" ? rule.path === path : rule.path.test(path);
      if (entry.left > 0 && rule.method.toUpperCase() === method.toUpperCase() && pathMatches) {
        entry.left--;
        return rule;
      }
    }
    return null;
  }
}
