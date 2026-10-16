import type { ActionKind } from "./view-types.ts";

/**
 * A keep decision changes nothing in the mailbox, so the server skips keeps on undo (contracts 7.8).
 * A batch with no trash or archive part therefore has nothing to undo and shows no Undo (UI spec 5.2.6, 5.4).
 */
export const isKeepOnly = (counts: { delete?: number; archive?: number }): boolean =>
  (counts.delete ?? 0) + (counts.archive ?? 0) === 0;

export const isKeepAction = (action: ActionKind): boolean => action === "keep";
