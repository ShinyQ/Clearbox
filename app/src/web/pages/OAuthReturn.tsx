import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { consumeOAuthReturn } from "../lib/oauth-return.ts";

/** The server redirects OAuth callbacks to /settings/accounts (contracts 7.14); forward with the same query. */
export function OAuthReturn() {
  const navigate = useNavigate();
  const { search } = useLocation();
  // Consuming clears the key; compute once so StrictMode's repeated effects reuse the same target.
  const [target] = useState(() => consumeOAuthReturn());
  useEffect(() => {
    void navigate(`${target}${search}`, { replace: true });
  }, [navigate, search, target]);
  return null;
}
