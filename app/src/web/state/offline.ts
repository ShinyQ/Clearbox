import { useSyncExternalStore } from "react";
import {
  createStore,
  networkFailureStore,
  sessionErrorStore,
  type SessionError,
  type Store,
} from "../api/client.ts";

export const navigatorOfflineStore = createStore<boolean>(
  typeof navigator === "undefined" ? false : !navigator.onLine,
);

export function useStoreValue<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** UI spec 5.9: navigator offline, or two consecutive network failures. */
export function useOffline(): boolean {
  const nav = useStoreValue(navigatorOfflineStore);
  const failures = useStoreValue(networkFailureStore);
  return nav || failures >= 2;
}

export const isOfflineNow = (): boolean => navigatorOfflineStore.get() || networkFailureStore.get() >= 2;

export const useSessionError = (): SessionError | null => useStoreValue(sessionErrorStore);
