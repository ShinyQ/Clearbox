import { useHotkeysControl } from "../../state/HotkeysProvider.tsx";

export function GSequenceHint() {
  const { gHint } = useHotkeysControl();
  if (!gHint) return null;
  return (
    <div
      role="status"
      className="fixed bottom-6 left-4 z-(--z-toast) rounded-md bg-inverse px-2 py-1 text-meta text-on-inverse lg:left-[calc(var(--layout-sidebar)+22px)]"
    >
      Go to: R Review · A Activity · I Insights · U Rules · C Accounts
    </div>
  );
}
