import { useEffect, useRef } from "react";
import { Button } from "../ui/Button.tsx";

export interface DisconnectConfirmProps {
  email: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Inline confirm, no modal (UI spec 5.5); focus starts on Cancel. */
export function DisconnectConfirm({ email, busy, onCancel, onConfirm }: DisconnectConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="col-span-full mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-trash-line bg-trash-soft px-3 py-2.5 text-body text-trash-ink">
      <p className="min-w-0 flex-1">
        {`Disconnect ${email}? Clearbox stops sorting it and deletes its stored data tonight. Your mailbox is not changed.`}
      </p>
      <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="danger" loading={busy} onClick={onConfirm}>
        Disconnect
      </Button>
    </div>
  );
}
