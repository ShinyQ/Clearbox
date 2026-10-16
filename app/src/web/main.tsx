import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { createQueryClient } from "./api/query-client.ts";
import { installCspListener } from "./lib/report.ts";
import { createAppRouter } from "./routes.tsx";
import "./styles.css";

installCspListener();

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

const queryClient = createQueryClient();
const router = createAppRouter();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
