import { useState, type ReactNode } from "react";
import { Banner } from "../../components/ui/Banner.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Checkbox } from "../../components/ui/Checkbox.tsx";
import { ChipInput } from "../../components/ui/ChipInput.tsx";
import { EmptyState } from "../../components/ui/EmptyState.tsx";
import { Select } from "../../components/ui/Select.tsx";
import { SkeletonRows } from "../../components/ui/Skeleton.tsx";
import { TextInput } from "../../components/ui/TextInput.tsx";
import { ToastView } from "../../components/ui/Toast.tsx";
import { Toggle } from "../../components/ui/Toggle.tsx";
import { validateSenderEntry } from "../../lib/rules-draft.ts";
import { usePlatform } from "../../state/use-platform.ts";

export function GalleryCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5">
      <h2 className="text-body font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

const noop = () => undefined;

export function ButtonsCard() {
  return (
    <GalleryCard title="Buttons">
      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" kbd={["Ctrl", "Enter"]}>
          Clean up 1,284
        </Button>
        <Button>Archive</Button>
        <Button variant="danger" icon="trash">
          Trash 248
        </Button>
        <Button variant="ghost">Cancel</Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button className="outline-2 outline-offset-2 outline-focus outline-solid">Focused</Button>
        <Button softDisabled>Disabled</Button>
        <Button loading>Save</Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg">Large</Button>
      </div>
    </GalleryCard>
  );
}

export function FeedbackCard() {
  const platform = usePlatform();
  const toast = (id: string, kind: "success" | "info" | "error", message: string, undo = false) => (
    <ToastView
      platform={platform}
      onDismiss={noop}
      toast={{
        id,
        kind,
        message,
        createdAt: 0,
        durationMs: 3_600_000,
        ...(undo ? { action: { label: "Undo" as const, shortcut: "mod+z" as const, onAction: noop } } : {}),
      }}
    />
  );
  return (
    <GalleryCard title="Banners and toasts">
      <Banner
        tone="warning"
        title="you@example.com needs to reconnect."
        body="Google ended the session (password change or 6 months unused). Sorting is paused for this account."
        actions={[{ label: "Reconnect", onClick: noop }]}
      />
      <Banner
        tone="error"
        title="Clearbox can't use the AI model."
        body="New emails are marked Check until this is fixed."
      />
      <Banner
        tone="info"
        title="The AI model is not responding right now."
        body="Clearbox retries automatically."
      />
      <Banner tone="success" title="Rules saved." />
      <div className="flex flex-col items-start gap-2">
        {toast("g1", "success", "Moved 248 emails from Northwind Deals to Trash.", true)}
        {toast("g2", "info", "Scan finished. 25 new emails sorted.")}
        {toast("g3", "error", "Something went wrong. Nothing was changed.")}
      </div>
    </GalleryCard>
  );
}

export function InputsCard() {
  const [chips, setChips] = useState(["mom@family.example", "@bank.example"]);
  const [on, setOn] = useState(true);
  const [age, setAge] = useState("3");
  return (
    <GalleryCard title="Inputs">
      <TextInput label="Default input" placeholder="Add a word" />
      <TextInput label="Input with error" defaultValue="nope" error="Use name@domain.com or @domain.com." />
      <TextInput label="Disabled input" disabled defaultValue="read only" />
      <span id="gallery-chips" className="text-meta font-emphasis text-ink-3">
        Always keep these senders
      </span>
      <ChipInput
        labelledBy="gallery-chips"
        listName="Always keep"
        values={chips}
        placeholder="Add sender or @domain"
        max={1000}
        validate={validateSenderEntry}
        onAdd={(v) => setChips((c) => [...c, v])}
        onRemove={(v) => setChips((c) => c.filter((x) => x !== v))}
      />
      <Select
        label="Leave recent emails alone"
        showLabel
        value={age}
        onChange={setAge}
        options={[
          { value: "0", label: "Off" },
          { value: "3", label: "3 days" },
          { value: "7", label: "7 days" },
        ]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Toggle checked={on} onChange={setOn} label="Toggle on" />
        <Toggle checked={false} onChange={noop} label="Toggle off" />
        <Toggle checked locked onChange={noop} label="Toggle locked" />
        <Checkbox checked={false} onChange={noop} label="Checkbox off" />
        <Checkbox checked onChange={noop} label="Checkbox on" />
        <Checkbox checked="mixed" onChange={noop} label="Checkbox mixed" />
        <Checkbox checked={false} disabled onChange={noop} label="Checkbox disabled" />
      </div>
    </GalleryCard>
  );
}

export function EmptyCard() {
  return (
    <GalleryCard title="Empty states and skeletons">
      <EmptyState
        variant="panel"
        headingLevel={3}
        title="Inbox cleared"
        body="41 groups are waiting for your call. New mail gets sorted every 30 minutes."
        action={{ label: "Review the 41 groups", onClick: noop }}
      />
      <EmptyState
        variant="inline"
        headingLevel={3}
        title="No trash suggestions"
        body="Nothing here looks safe to trash right now."
      />
      <SkeletonRows count={2} />
    </GalleryCard>
  );
}
