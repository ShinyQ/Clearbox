import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/** Shared MSW server for core tests. Tests add handlers with server.use(...). */
export const server = setupServer();

const unhandled: string[] = [];

beforeAll(() => {
  // MSW 3 renamed onUnhandledRequest to onUnhandledFrame, and its "error" strategy still lets the request reach
  // the network. errorWith() answers it with a 500 instead (no network); recording the message fails the test
  // in afterEach even when the code under test handles that 500.
  server.listen({
    async onUnhandledFrame({ frame }) {
      const message = await frame.getUnhandledMessage();
      unhandled.push(message);
      frame.errorWith(new Error(message));
    },
  });
});

afterEach(() => {
  server.resetHandlers();
  if (unhandled.length > 0) {
    const list = unhandled.splice(0).join("\n");
    throw new Error(`Unhandled request\n${list}`);
  }
});

afterAll(() => {
  server.close();
});
