import { setupNetwork } from "@msw/cloudflare";
import { http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

/** Last-resort handler: any unmocked outbound request fails the test. */
const catchAll = http.all("*", ({ request }) => {
  const url = new URL(request.url);
  throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
});

export const network = setupNetwork();

beforeAll(() => network.enable());
beforeEach(() => network.use(catchAll));
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
