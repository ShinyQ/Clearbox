import { useNavigate } from "react-router";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";

export function NotFoundPage() {
  useDocumentTitle("Page not found · Clearbox");
  const navigate = useNavigate();
  return (
    <EmptyState
      variant="page"
      headingLevel={1}
      title="Page not found"
      body="This page does not exist in Clearbox."
      action={{ label: "Go to Review", onClick: () => void navigate("/review") }}
    />
  );
}
