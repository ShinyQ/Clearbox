import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { consumeOAuthReturn } from "../lib/oauth-return.ts";

/** The server redirects OAuth callbacks to /settings/accounts (contracts 7.14); forward with the same query. */
export function OAuthReturn() {
  const navigate = useNavigate();
  const { search } = useLocation();
  useEffect(() => {
    void navigate(`${consumeOAuthReturn()}${search}`, { replace: true });
  }, [navigate, search]);
  return null;
}
