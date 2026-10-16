import { useId } from "react";
import { enterKey, modKey, shiftKey } from "../../lib/platform.ts";
import { useHotkeysControl } from "../../state/HotkeysProvider.tsx";
import { usePlatform } from "../../state/use-platform.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Toggle } from "../ui/Toggle.tsx";

type Row = [string[], string];

function Column({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section>
      <h3 className="mb-2 text-meta font-emphasis text-ink-3">{title}</h3>
      <dl className="flex flex-col gap-1.5 text-body text-ink-2">
        {rows.map(([keys, label]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="order-2">
              <Kbd keys={keys} />
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutHelpDialog() {
  const { helpOpen, setHelpOpen, singleKeys, setSingleKeys } = useHotkeysControl();
  const p = usePlatform();
  const toggleLabel = useId();
  const mod = modKey(p);
  return (
    <Dialog
      open={helpOpen}
      onClose={() => setHelpOpen(false)}
      title="Keyboard shortcuts"
      className="w-[640px]"
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Column
          title="Review"
          rows={[
            [["J", "K"], "move"],
            [["X"], "select"],
            [[shiftKey(p), "X"], "select range"],
            [["T"], "trash"],
            [["A"], "archive"],
            [["E"], "keep"],
            [[enterKey(p)], "open"],
            [["1", "5"], "tabs"],
          ]}
        />
        <Column
          title="Clean up"
          rows={[
            [[mod, enterKey(p)], "clean up"],
            [[enterKey(p)], "confirm"],
            [["Esc"], "cancel"],
            [[mod, "Z"], "undo"],
          ]}
        />
        <Column
          title="Go to"
          rows={[
            [["G", "R"], "Review"],
            [["G", "A"], "Activity"],
            [["G", "I"], "Insights"],
            [["G", "U"], "Rules"],
            [["G", "C"], "Accounts"],
            [["?"], "this help"],
          ]}
        />
      </div>
      <p className="mt-4 text-small text-ink-3">Shortcuts are off while you type in a field.</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span id={toggleLabel} className="text-body text-ink">
          Use single-key shortcuts
        </span>
        <Toggle
          checked={singleKeys}
          onChange={setSingleKeys}
          label="Use single-key shortcuts"
          labelledBy={toggleLabel}
        />
      </div>
    </Dialog>
  );
}
