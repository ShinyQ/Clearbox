import { useId, type InputHTMLAttributes, type Ref } from "react";
import { Icon } from "./icons.tsx";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  hideLabel?: boolean;
  helper?: string | undefined;
  error?: string | null | undefined;
  size?: "sm" | "md";
  ref?: Ref<HTMLInputElement> | undefined;
}

export function TextInput({
  label,
  hideLabel = false,
  helper,
  error,
  size = "md",
  id,
  className,
  ref,
  ...rest
}: TextInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const helpId = `${inputId}-help`;
  const errId = `${inputId}-err`;
  const describedBy = [helper ? helpId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined;
  const sizing = size === "sm" ? "h-[26px] px-2.5 py-[3px]" : "h-8 px-2.5 py-[7px]";
  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : "text-meta font-emphasis text-ink-3"}>
        {label}
      </label>
      <input
        {...rest}
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`rounded-md border bg-surface text-body text-ink placeholder:text-ink-3 focus-visible:border-focus disabled:bg-surface-sunk disabled:text-ink/45 ${sizing} ${
          error ? "border-trash-ink" : "border-line-control hover:border-ink-3"
        }`}
      />
      {helper ? (
        <p id={helpId} className="text-small text-ink-3">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="flex items-center gap-1 text-small text-trash-ink">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
