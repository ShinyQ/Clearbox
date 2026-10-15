import { createApp } from "./app.ts";
import { CRON_NIGHTLY, CRON_TICK } from "./env.ts";
import { runNightly } from "./nightly/nightly.ts";
import { runTick } from "./scan/tick.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case CRON_TICK:
        ctx.waitUntil(runTick(env, { trigger: "cron", now: controller.scheduledTime }));
        break;
      case CRON_NIGHTLY:
        ctx.waitUntil(runNightly(env, { now: controller.scheduledTime }));
        break;
    }
  },
} satisfies ExportedHandler<Env>;
