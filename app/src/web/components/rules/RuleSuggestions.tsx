import { useState } from "react";
import type { RuleSuggestion } from "../../../shared/api.ts";
import { useDismissRuleSuggestion, usePatchSender } from "../../api/mutations.ts";
import { useRuleSuggestions } from "../../api/queries.ts";
import { GENERIC_ERROR } from "../../lib/copy-actions.ts";
import { formatCount } from "../../lib/format.ts";
import { useToast } from "../../state/ToastProvider.tsx";
import { Button, LinkButton } from "../ui/Button.tsx";

/** "You trashed 24 of 24 emails from news@shop.example.com." (contracts 12.10, UI spec Rules) */
export function ruleSuggestionText(s: RuleSuggestion): string {
  const verb = s.list === "deny" ? "trashed" : "kept";
  return `You ${verb} ${formatCount(s.agreeing)} of ${formatCount(s.decisions)} emails from ${s.entry}.`;
}

export const ruleActionLabel = (s: RuleSuggestion): string =>
  s.list === "deny" ? "Always OK to trash" : "Always keep";

/** Accept (PATCH the existing allow or deny list) and dismiss, with toasts. Nothing changes without a click. */
export function useRuleSuggestionActions() {
  const patch = usePatchSender();
  const dismiss = useDismissRuleSuggestion();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const accept = async (s: RuleSuggestion) => {
    setBusy(s.entry);
    try {
      await patch.mutateAsync({ entry: s.entry, list: s.list });
      toast.show({
        kind: "success",
        message:
          s.list === "deny"
            ? `${s.entry} is on your Always OK to trash list. Its emails skip the confidence check.`
            : `${s.entry} is on your Always keep list.`,
      });
    } catch {
      toast.show({ kind: "error", message: GENERIC_ERROR });
    } finally {
      setBusy(null);
    }
  };
  const skip = async (s: RuleSuggestion) => {
    setBusy(s.entry);
    try {
      await dismiss.mutateAsync({ entry: s.entry, list: s.list });
    } catch {
      toast.show({ kind: "error", message: GENERIC_ERROR });
    } finally {
      setBusy(null);
    }
  };
  return { accept, skip, busy };
}

function SuggestionRow({
  s,
  busy,
  onAccept,
  onSkip,
}: {
  s: RuleSuggestion;
  busy: boolean;
  onAccept: () => void;
  onSkip: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2.5 px-4 py-3">
      <p className="min-w-0 flex-1 text-body text-ink">{ruleSuggestionText(s)}</p>
      <Button
        size="sm"
        variant={s.list === "deny" ? "danger" : "secondary"}
        loading={busy}
        onClick={onAccept}
      >
        {ruleActionLabel(s)}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        softDisabled={busy}
        onClick={onSkip}
        aria-label={`Not now: ${s.entry}`}
      >
        Not now
      </Button>
    </li>
  );
}

/**
 * Suggested rules from your own decisions. Rules page: every offer. Review: the first offer only, with a link to
 * Rules for the rest. Renders nothing when there is no offer.
 */
export function RuleSuggestions({ variant }: { variant: "rules" | "review" }) {
  const q = useRuleSuggestions();
  const { accept, skip, busy } = useRuleSuggestionActions();
  const all = q.data?.suggestions ?? [];
  if (all.length === 0) return null;
  const shown = variant === "review" ? all.slice(0, 1) : all;
  const more = all.length - shown.length;
  return (
    <section
      aria-labelledby={`rule-suggestions-${variant}`}
      className="mb-4 rounded-xl border border-line bg-surface"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <h2 id={`rule-suggestions-${variant}`} className="font-semibold text-ink">
          Suggested rules
        </h2>
        <span className="ml-auto text-small text-ink-3">
          {more > 0 ? (
            <LinkButton to="/rules" variant="link" size="sm">
              {`${formatCount(more)} more in Rules`}
            </LinkButton>
          ) : (
            "From your recent choices. Nothing changes until you pick one."
          )}
        </span>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((s) => (
          <SuggestionRow
            key={`${s.list}:${s.entry}`}
            s={s}
            busy={busy === s.entry}
            onAccept={() => void accept(s)}
            onSkip={() => void skip(s)}
          />
        ))}
      </ul>
    </section>
  );
}
