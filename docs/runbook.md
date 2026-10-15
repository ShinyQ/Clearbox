# Clearbox runbook

## Checking tick CPU time after deploy

Workers Free allows 10 ms of CPU per cron invocation. Locally, `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-cpu.test.ts` guards the compute of one 25-message tick (pure stages under 8 ms). After a deploy, check the real numbers:

1. Cloudflare dashboard, Workers & Pages, `clearbox`, Observability, Query builder (Workers Logs must be enabled; `cloudflare.config.ts` enables invocation logs).
2. Filter invocation logs to the tick cron: `$metadata.message` equals `* * * * *` (cron invocations use the cron schedule as their message).
3. Visualize `$workers.cpuTimeMs` with P50, P99 and Max over the last 24 hours. P99 should stay well below 10; anything above 8 needs attention.
4. Find the slow ticks: filter `$workers.cpuTimeMs` greater than `8` and match them by time to the `tick.done` events (`evt = "tick.done"`), which carry `kind`, `fetched`, `decided` and `durationMs`.
5. Signs of CPU kills: `tick.claimed` without a matching `tick.done` or `tick.failed`, and accounts whose `page_size` dropped below 25 (each killed tick halves it on the next claim, minimum 5; successful ticks grow it back by 5).

If ticks are being killed, the adaptive page size recovers on its own. If it stays low for days, lower the work per page (see the benchmark notes in `docs/superpowers/plans/2026-10-15-clearbox-04-scan-pipeline.md`, Task 12) or move to Workers Paid and set `FREE_TIER=false`.
