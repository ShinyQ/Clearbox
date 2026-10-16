import { Icon } from "./icons.tsx";

export interface ChipProps {
  label: string;
  onRemove?: (() => void) | undefined;
  removeLabel: string;
  note?: string | undefined;
}

export function Chip({ label, onRemove, removeLabel, note }: ChipProps) {
  return (
    <li className="cb-chip inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-[3px] pr-1.5 pl-2.5 text-small text-ink-2 motion-safe:animate-[cb-fade-in_200ms_var(--ease-out)]">
      <span>{label}</span>
      {note ? <span className="text-ink-3">{note}</span> : null}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="group -my-1 grid size-6 place-items-center rounded-full"
        >
          <span className="grid size-4 place-items-center rounded-full bg-surface-sunk text-ink-3 group-hover:bg-line group-hover:text-ink">
            <Icon name="close" size={10} strokeWidth={2} />
          </span>
        </button>
      ) : null}
    </li>
  );
}
