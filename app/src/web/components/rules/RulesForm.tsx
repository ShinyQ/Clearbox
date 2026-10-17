import type { Policy } from "@clearbox/core";
import {
  AUTO_TRASH_DESCRIPTION,
  AUTO_TRASH_KILLED_NOTE,
  addEntry,
  MIN_AGE_OPTIONS,
  MOVED_NOTE,
  reminderDayOptions,
  reminderLocalTime,
  removeEntry,
  SCAN_HISTORY_OPTIONS,
  scanHistoryDaysOf,
  scanHistoryValue,
  validateRecordWord,
  validateSenderEntry,
  type ListKey,
} from "../../lib/rules-draft.ts";
import { ChipInput } from "../ui/ChipInput.tsx";
import { Select } from "../ui/Select.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { RuleField } from "./RuleField.tsx";

export interface RulesFormProps {
  draft: Policy;
  disabled: boolean;
  errors: Partial<Record<keyof Policy, string>>;
  notes: Readonly<Record<string, string>>;
  onChange: (next: Policy) => void;
  onMoved: (value: string, note: string) => void;
  /** contracts 12.11: the deployment kill switch blocks auto-trash; the owner's choice is kept but inert. */
  autoTrashKillSwitch?: boolean;
}

export function RulesForm({
  draft,
  disabled,
  errors,
  notes,
  onChange,
  onMoved,
  autoTrashKillSwitch = false,
}: RulesFormProps) {
  const add = (list: ListKey) => (value: string) => {
    const out = addEntry(draft, list, value);
    onChange(out.policy);
    if (out.movedFrom) onMoved(value, MOVED_NOTE[list]);
  };
  const lists: { key: ListKey; id: string; title: string; description: string; name: string }[] = [
    {
      key: "allowlist",
      id: "rule-allow",
      title: "Always keep these senders",
      description: "Never suggested for trash or archive.",
      name: "Always keep",
    },
    {
      key: "denylist",
      id: "rule-deny",
      title: "Always OK to trash",
      description: "Skip the confidence check for these.",
      name: "Always OK to trash",
    },
  ];
  return (
    <div className="rounded-xl border border-line bg-surface">
      {lists.map((l) => (
        <RuleField key={l.key} id={l.id} title={l.title} description={l.description}>
          <ChipInput
            labelledBy={`${l.id}-title`}
            describedBy={`${l.id}-desc`}
            listName={l.name}
            values={draft[l.key]}
            placeholder="Add sender or @domain"
            validate={validateSenderEntry}
            onAdd={add(l.key)}
            onRemove={(v) => onChange(removeEntry(draft, l.key, v))}
            max={1000}
            notes={notes}
            serverError={errors[l.key]}
            disabled={disabled}
          />
        </RuleField>
      ))}
      <RuleField
        id="rule-auto-trash"
        title="Auto-trash for Always OK senders"
        description={
          autoTrashKillSwitch ? `${AUTO_TRASH_DESCRIPTION} ${AUTO_TRASH_KILLED_NOTE}` : AUTO_TRASH_DESCRIPTION
        }
        row
      >
        <Toggle
          checked={draft.autoTrash}
          disabled={disabled || autoTrashKillSwitch}
          onChange={(v) => onChange({ ...draft, autoTrash: v })}
          label="Auto-trash for Always OK senders"
          labelledBy="rule-auto-trash-title"
          describedBy="rule-auto-trash-desc"
        />
      </RuleField>
      <RuleField
        id="rule-history"
        title="Scan history"
        description="How far back Clearbox sorts mail already in your inbox. New mail is always scanned. A longer window picks up where the last scan stopped; a shorter one keeps existing suggestions."
        row
      >
        <Select
          label="Scan history"
          value={scanHistoryValue(draft.scanHistoryDays)}
          options={SCAN_HISTORY_OPTIONS}
          disabled={disabled}
          onChange={(v) => onChange({ ...draft, scanHistoryDays: scanHistoryDaysOf(v) })}
        />
      </RuleField>
      <RuleField
        id="rule-age"
        title="Leave recent emails alone"
        description="Don't suggest anything for emails newer than this."
        row
      >
        <Select
          label="Leave recent emails alone"
          value={String(draft.minAgeDays)}
          options={MIN_AGE_OPTIONS}
          disabled={disabled}
          onChange={(v) => onChange({ ...draft, minAgeDays: Number(v) })}
        />
      </RuleField>
      <RuleField
        id="rule-starred"
        title="Protect starred, flagged and replied threads"
        description="Always on. These are never trashed."
        row
      >
        <Toggle
          checked
          locked
          onChange={() => undefined}
          label="Protect starred, flagged and replied threads"
          labelledBy="rule-starred-title"
          describedBy="rule-starred-desc"
        />
      </RuleField>
      <RuleField
        id="rule-records"
        title="Receipts and attachments go to Archive, not Trash"
        description="Always on. Emails with files, and emails whose subject or preview contains one of the words below."
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <span id="rule-words-title" className="text-meta font-emphasis text-ink-3">
              Record words
            </span>
            <ChipInput
              labelledBy="rule-words-title"
              listName="Record words"
              values={draft.recordPatterns}
              placeholder="Add a word"
              validate={validateRecordWord}
              onAdd={(v) => onChange({ ...draft, recordPatterns: [...draft.recordPatterns, v] })}
              onRemove={(v) =>
                onChange({ ...draft, recordPatterns: draft.recordPatterns.filter((x) => x !== v) })
              }
              max={100}
              serverError={errors.recordPatterns}
              disabled={disabled}
            />
          </div>
          <Toggle
            checked
            locked
            onChange={() => undefined}
            label="Receipts and attachments go to Archive, not Trash"
            labelledBy="rule-records-title"
            describedBy="rule-records-desc"
          />
        </div>
      </RuleField>
      <RuleField
        id="rule-snippets"
        title="Store email previews"
        description="Keeps a short snippet for 30 days to show in Review. Turn off to store subjects only."
        row
      >
        <Toggle
          checked={draft.storeSnippets}
          disabled={disabled}
          onChange={(v) => onChange({ ...draft, storeSnippets: v })}
          label="Store email previews"
          labelledBy="rule-snippets-title"
          describedBy="rule-snippets-desc"
        />
      </RuleField>
      <RuleField
        id="rule-subjects"
        title="Remember subjects of emails you decide"
        description="Keeps the first 60 characters of the subject with each decision to improve suggestions. Turn off to keep only the sender."
        row
      >
        <Toggle
          checked={draft.labelSubjects}
          disabled={disabled}
          onChange={(v) => onChange({ ...draft, labelSubjects: v })}
          label="Remember subjects of emails you decide"
          labelledBy="rule-subjects-title"
          describedBy="rule-subjects-desc"
        />
      </RuleField>
      <RuleField
        id="rule-reminder"
        title="Weekly reminder"
        description={`A short note in your inbox when emails are ready to review, with counts and a link to Review. Clearbox adds it to your inbox directly, so nothing is sent, and it is never sorted. Arrives around ${reminderLocalTime()} your time.`}
        row
      >
        <div className="flex items-center gap-3">
          <Select
            label="Reminder day"
            value={String(draft.weeklyReminder.weekday)}
            options={reminderDayOptions()}
            disabled={disabled || !draft.weeklyReminder.enabled}
            onChange={(v) =>
              onChange({ ...draft, weeklyReminder: { ...draft.weeklyReminder, weekday: Number(v) } })
            }
          />
          <Toggle
            checked={draft.weeklyReminder.enabled}
            disabled={disabled}
            onChange={(v) => onChange({ ...draft, weeklyReminder: { ...draft.weeklyReminder, enabled: v } })}
            label="Weekly reminder"
            labelledBy="rule-reminder-title"
            describedBy="rule-reminder-desc"
          />
        </div>
      </RuleField>
    </div>
  );
}
