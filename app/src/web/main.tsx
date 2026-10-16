import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function Placeholder() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Clearbox</h1>
      <p>The review UI is not built yet.</p>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <Placeholder />
    </StrictMode>,
  );
}
