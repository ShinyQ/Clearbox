import { useId, useRef, useState, type KeyboardEvent } from "react";
import { formatCount } from "../../lib/format.ts";
import { Chip } from "./Chip.tsx";
import { Icon } from "./icons.tsx";

export type ChipValidation = { ok: true; value: string } | { ok: false; error: string };

export interface ChipInputProps {
  /** id of the visible field title (UI spec 4.27: the group label). */
  labelledBy: string;
  /** List name used in the list label and remove labels ("Always keep"). */
  listName: string;
  values: readonly string[];
  placeholder: string;
  validate: (raw: string) => ChipValidation;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  max: number;
  notes?: Readonly<Record<string, string>> | undefined;
  serverError?: string | null | undefined;
  describedBy?: string | undefined;
  disabled?: boolean | undefined;
}

export function ChipInput({
  labelledBy,
  listName,
  values,
  placeholder,
  validate,
  onAdd,
  onRemove,
  max,
  notes,
  serverError,
  describedBy,
  disabled = false,
}: ChipInputProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const errorId = useId();
  const shown = error ?? serverError ?? null;

  const commit = () => {
    const raw = draft.trim();
    if (!raw) return;
    if (values.length >= max) return setError(`Lists hold up to ${formatCount(max)} entries.`);
    const result = validate(raw);
    if (!result.ok) return setError(result.error);
    if (values.includes(result.value)) return setError("This entry is already in the list.");
    onAdd(result.value);
    setDraft("");
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "") {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
      buttons?.[buttons.length - 1]?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <ul ref={listRef} aria-label={listName} className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <Chip
              key={v}
              label={v}
              note={notes?.[v]}
              removeLabel={`Remove ${v} from ${listName}`}
              onRemove={disabled ? undefined : () => onRemove(v)}
            />
          ))}
        </ul>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          aria-labelledby={labelledBy}
          aria-invalid={shown ? true : undefined}
          aria-describedby={[describedBy ?? "", shown ? errorId : ""].filter(Boolean).join(" ") || undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          className={`h-[26px] w-[200px] rounded-full border bg-surface px-2.5 py-[3px] text-body text-ink placeholder:text-ink-3 focus-visible:border-focus disabled:opacity-45 ${
            shown ? "border-trash-ink" : "border-line-control hover:border-ink-3"
          }`}
        />
      </div>
      {shown ? (
        <p id={errorId} className="flex items-center gap-1 text-small text-trash-ink">
          <Icon name="alert" size={12} />
          {shown}
        </p>
      ) : null}
    </div>
  );
}
