import type { Policy } from "@clearbox/core";
import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { isApiError } from "../api/client.ts";
import { usePutPolicy } from "../api/mutations.ts";
import { usePolicy } from "../api/queries.ts";
import { RuleSuggestions } from "../components/rules/RuleSuggestions.tsx";
import { RulesForm } from "../components/rules/RulesForm.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button } from "../components/ui/Button.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import type { AppBannerSpec } from "../lib/banners.ts";
import { GENERIC_ERROR } from "../lib/copy-actions.ts";
import { fieldErrors, policiesEqual } from "../lib/rules-draft.ts";
import { useHotkeys } from "../state/HotkeysProvider.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";
import { useToast } from "../state/ToastProvider.tsx";

const FIELD_INPUT: Partial<Record<keyof Policy, string>> = {
  allowlist: "rule-allow-title",
  denylist: "rule-deny-title",
  recordPatterns: "rule-words-title",
};

export function RulesPage() {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const policy = usePolicy();
  const put = usePutPolicy();
  const toast = useToast();
  const [draft, setDraft] = useState<Policy | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Policy, string>>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  const data = policy.data;
  if (data && draft === null) setDraft(data.policy);
  const dirty = !!data && !!draft && !policiesEqual(draft, data.policy);
  const saving = put.isPending;
  useDocumentTitle(dirty ? "Rules (unsaved) · Clearbox" : "Rules · Clearbox");
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  useEffect(() => {
    if (!focusField) return;
    document.querySelector<HTMLInputElement>(`input[aria-labelledby="${focusField}"]`)?.focus();
  }, [focusField]);

  const save = async (): Promise<boolean> => {
    if (!data || !draft || !dirty || saving) return false;
    try {
      const res = await put.mutateAsync({ policy: draft, expectedVersion: data.version });
      setDraft(res.policy);
      setErrors({});
      setFocusField(null);
      toast.show({ kind: "success", message: "Rules saved. They apply to new emails from now on." });
      return true;
    } catch (e) {
      if (isApiError(e) && e.code === "conflict") setConflict(true);
      else if (isApiError(e) && e.code === "validation_failed") {
        const next = fieldErrors(e.details);
        setErrors(next);
        const first = (Object.keys(FIELD_INPUT) as (keyof Policy)[]).find((k) => next[k]);
        setFocusField(first ? (FIELD_INPUT[first] ?? null) : null);
        toast.show({ kind: "error", message: "Some entries are not valid. Fix the highlighted fields." });
      } else toast.show({ kind: "error", message: GENERIC_ERROR });
      return false;
    }
  };

  useHotkeys("rules", [{ combo: "mod+s", handler: () => void save(), allowInInputs: true }]);

  const onMoved = (value: string, note: string) => {
    setNotes((n) => ({ ...n, [value]: note }));
    setTimeout(
      () => setNotes((n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== value))),
      4_000,
    );
  };
  const discard = () => {
    if (data) setDraft(data.policy);
    setErrors({});
  };

  const extra: AppBannerSpec[] = [];
  if (conflict) {
    extra.push({
      id: "rules-conflict",
      tone: "warning",
      title: "Rules changed in another tab.",
      body: "Reload to see the latest rules. Your unsaved changes will be lost.",
      actions: [
        {
          label: "Reload rules",
          kind: "callback",
          onClick: () =>
            void policy.refetch().then((r) => {
              if (r.data) setDraft(r.data.policy);
              setConflict(false);
            }),
        },
      ],
    });
  } else if (blocker.state === "blocked") {
    extra.push({
      id: "rules-leave",
      tone: "warning",
      title: "You have unsaved changes.",
      actions: [
        {
          label: "Save and leave",
          kind: "callback",
          onClick: () => void save().then((ok) => (ok ? blocker.proceed?.() : blocker.reset?.())),
        },
        { label: "Leave without saving", kind: "callback", onClick: () => blocker.proceed?.() },
        { label: "Stay", kind: "callback", onClick: () => blocker.reset?.() },
      ],
    });
  } else if (dirty) {
    extra.push({
      id: "rules-dirty",
      tone: "info",
      title: "You have unsaved changes.",
      actions: [
        { label: "Save changes", kind: "callback", onClick: () => void save(), loading: saving },
        { label: "Discard", kind: "callback", onClick: discard },
      ],
    });
  }

  return (
    <div className="max-w-[880px]">
      <PageHeader
        title="Rules"
        titleRef={titleRef}
        meta="These always override the AI"
        actions={
          <Button
            variant="primary"
            softDisabled={!dirty}
            loading={saving}
            loadingLabel="Saving…"
            aria-keyshortcuts="Control+S Meta+S"
            onClick={() => void save()}
          >
            Save changes
          </Button>
        }
      />
      <AppBanners page="rules" extra={extra} />
      {policy.isError ? (
        <EmptyState
          variant="panel"
          title="Couldn't load your rules."
          body="Check your connection, then try again."
          action={{ label: "Try again", onClick: () => void policy.refetch() }}
        />
      ) : !draft ? (
        <div aria-busy="true" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
          <span className="sr-only">Loading rules</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} aria-hidden="true" className="flex flex-col gap-2">
              <SkeletonLine width={220} />
              <SkeletonLine width={320} height={6} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <RuleSuggestions variant="rules" />
          <RulesForm
            draft={draft}
            disabled={saving}
            errors={errors}
            notes={notes}
            onChange={setDraft}
            onMoved={onMoved}
            autoTrashKillSwitch={data?.autoTrashKillSwitch ?? false}
          />
          <p className="mt-2.5 text-small text-ink-3">
            Rule changes apply to new emails right away. Suggestions already in Review follow: sender lists at
            once, other rules overnight.{" "}
            <Button variant="link" size="sm" onClick={() => data && setDraft(data.defaults)}>
              Reset to defaults
            </Button>
          </p>
        </>
      )}
    </div>
  );
}
