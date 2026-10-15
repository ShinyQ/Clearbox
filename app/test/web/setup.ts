import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { installMatchMedia, resetViewport } from "./helpers/viewport.ts";
import { server } from "./msw/server.ts";

installMatchMedia();
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetViewport();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => server.close());
