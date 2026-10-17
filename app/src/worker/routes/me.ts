import { Hono } from "hono";
import type { MeResponse } from "../../shared/api.ts";
import { appOriginOf, readSettings, setSettingStmt } from "../db/settings.ts";
import { toIso } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", async (c) => {
  const config = c.get("config");
  const settings = await readSettings(c.env.DB);
  // Written only when it changes: one D1 write after a deploy to a new origin, none on later loads.
  const origin = appOriginOf(c.req.url);
  if (origin !== null && origin !== settings.appOrigin) {
    await setSettingStmt(c.env.DB, "app_origin", origin, c.get("deps").now()).run();
  }
  const body: MeResponse = {
    email: c.get("ownerEmail"),
    environment: config.environment,
    freeTier: config.freeTier,
    providers: { gmail: config.google !== null, outlook: config.microsoft !== null },
    issues: settings.issues,
    tauDelete: settings.tauDelete,
    serverTime: toIso(c.get("deps").now()),
  };
  return c.json(body);
});
