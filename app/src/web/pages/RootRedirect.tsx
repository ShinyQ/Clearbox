import { Navigate } from "react-router";
import { useAccounts } from "../api/queries.ts";
import { Spinner } from "../components/ui/Spinner.tsx";

/** "/" goes to Setup when no account exists, otherwise to Review (UI spec 3.5). */
export function RootRedirect() {
  const accounts = useAccounts();
  if (accounts.isPending) {
    return (
      <div role="status" className="flex items-center gap-2 p-6">
        <Spinner />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  return (
    <Navigate to={accounts.data && accounts.data.accounts.length === 0 ? "/setup" : "/review"} replace />
  );
}
