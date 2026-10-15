/** The single console sink of the SPA (contracts 3.8 bans console elsewhere; decision W5). */
export function reportBug(message: string, detail?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[clearbox] ${message}`, detail);
}

/** Makes CSP violations obvious in every build (UI spec 8.4 item 7). */
export function installCspListener(target: Document = document): () => void {
  const onViolation = (e: SecurityPolicyViolationEvent) =>
    reportBug(`CSP blocked ${e.effectiveDirective || e.violatedDirective}`, e.blockedURI);
  target.addEventListener("securitypolicyviolation", onViolation);
  return () => target.removeEventListener("securitypolicyviolation", onViolation);
}
