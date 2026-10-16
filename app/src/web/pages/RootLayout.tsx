import { Outlet } from "react-router";
import { GSequenceHint } from "../components/shell/GSequenceHint.tsx";
import { OfflineWatcher } from "../components/shell/OfflineWatcher.tsx";
import { ShortcutHelpDialog } from "../components/shell/ShortcutHelpDialog.tsx";
import { ToastRegion } from "../components/ui/Toast.tsx";
import { CleanupProvider, useCleanup } from "../state/CleanupProvider.tsx";
import { HotkeysProvider } from "../state/HotkeysProvider.tsx";
import { LiveAnnouncerProvider } from "../state/LiveAnnouncer.tsx";
import { useSessionError } from "../state/offline.ts";
import { ToastProvider } from "../state/ToastProvider.tsx";
import { UndoStackProvider } from "../state/UndoStackProvider.tsx";
import { FullPageError } from "./FullPageError.tsx";

function SessionGate() {
  const error = useSessionError();
  return error ? <FullPageError kind={error} /> : <Outlet />;
}

function RaisedToasts() {
  return <ToastRegion raised={useCleanup().barVisible} />;
}

/** Cross-page providers mounted once (decision W10), so a Clean up run survives navigation. */
export function RootLayout() {
  return (
    <LiveAnnouncerProvider>
      <ToastProvider>
        <UndoStackProvider>
          <CleanupProvider>
            <HotkeysProvider>
              <SessionGate />
              <OfflineWatcher />
              <RaisedToasts />
              <ShortcutHelpDialog />
              <GSequenceHint />
            </HotkeysProvider>
          </CleanupProvider>
        </UndoStackProvider>
      </ToastProvider>
    </LiveAnnouncerProvider>
  );
}
