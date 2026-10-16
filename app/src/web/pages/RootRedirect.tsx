import { Navigate } from "react-router";
import { useAccounts } from "../api/queries.ts";

/** "/" goes to Setup when no account exists, otherwise to Review (UI spec 3.5). */
export function RootRedirect() {
  const accounts = useAccounts();
  if (accounts.isPending) return null;
  return (
    <Navigate to={accounts.data && accounts.data.accounts.length === 0 ? "/setup" : "/review"} replace />
  );
}
