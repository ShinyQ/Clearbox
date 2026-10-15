import { cleanup } from "@testing-library/react";
import nativeConsole from "node:console";
import { afterAll, afterEach, beforeAll } from "vitest";
import { configureFormat } from "../../src/web/lib/format.ts";
import { installMatchMedia, resetViewport } from "./helpers/viewport.ts";
import { server } from "./msw/server.ts";

// happy-dom logs "<METHOD> <url> <status> (<statusText>)" for every non-ok fetch response, which
// is expected noise when tests exercise error paths. It writes through the native console that
// vitest captured before replacing the global one, so that is the object patched here.
// Everything else passes through unchanged.
const HAPPY_DOM_FETCH_ERROR = /^[A-Z]+ \S+ \d{3} \([^)]*\)$/;
const nativeConsoleError = nativeConsole.error.bind(nativeConsole);
nativeConsole.error = (...args: unknown[]): void => {
  if (args.length === 1 && typeof args[0] === "string" && HAPPY_DOM_FETCH_ERROR.test(args[0])) return;
  nativeConsoleError(...args);
};

installMatchMedia();
configureFormat({ locale: "en-GB", timeZone: "UTC" });
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
