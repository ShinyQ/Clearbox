import { Hono } from "hono";
import type { MeResponse } from "../../shared/api.ts";
import { readSettings } from "../db/settings.ts";
import { toIso } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", async (c) => {
  const config = c.get("config");
  const settings = await readSettings(c.env.DB);
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
