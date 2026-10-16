import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { navigatorOfflineStore, useOffline } from "../../state/offline.ts";
import { useToast } from "../../state/ToastProvider.tsx";

/** Tracks navigator online state and announces recovery (UI spec 5.9). */
export function OfflineWatcher() {
  const offline = useOffline();
  const was = useRef(offline);
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    const on = () => navigatorOfflineStore.set(false);
    const off = () => navigatorOfflineStore.set(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    if (was.current && !offline) {
      toast.show({ kind: "info", message: "Back online.", dedupeKey: "online" });
      void qc.invalidateQueries();
    }
    was.current = offline;
  }, [offline, qc, toast]);
  return null;
}
