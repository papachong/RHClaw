import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelTask,
  getTaskStatus,
  startTask,
  type TaskEntry,
  type TaskProgressEvent,
  type TaskType,
} from '../services/tauri-agent';

const POLL_INTERVAL_MS = 1500;

type TauriEventUnlistenFn = () => void;

interface TauriEventPayload<T> {
  payload: T;
}

/**
 * Try to subscribe to Tauri events via the global `__TAURI__` bridge.
 * Returns `null` when running in a plain browser (no Tauri runtime).
 */
function tryListenTauriEvent(
  eventName: string,
  handler: (event: TauriEventPayload<TaskProgressEvent>) => void,
): Promise<TauriEventUnlistenFn> | null {
  const tauriWindow = window as Window & {
    __TAURI__?: {
      event?: {
        listen?: (name: string, cb: unknown) => Promise<TauriEventUnlistenFn>;
      };
    };
  };
  const listen = tauriWindow.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') {
    return null;
  }
  return listen(eventName, handler);
}

export interface UseTaskCenterReturn {
  /** Currently tracked tasks (keyed by taskId). */
  tasks: Map<string, TaskEntry>;
  /** Start a new backend task. Returns the initial TaskEntry. */
  start: (taskType: TaskType, params?: Record<string, unknown>) => Promise<TaskEntry>;
  /** Request cancellation of a running task. */
  cancel: (taskId: string) => Promise<TaskEntry>;
  /** Force-refresh task status from backend. */
  refresh: () => Promise<void>;
}

export function useTaskCenter(): UseTaskCenterReturn {
  const [tasks, setTasks] = useState<Map<string, TaskEntry>>(new Map());
  const unlistenRef = useRef<TauriEventUnlistenFn | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Apply a single progress event into the tasks map
  const applyProgress = useCallback((event: TauriEventPayload<TaskProgressEvent>) => {
    const p = event.payload;
    setTasks((prev) => {
      const next = new Map(prev);
      const existing = next.get(p.taskId);
      const updated: TaskEntry = {
        taskId: p.taskId,
        taskType: p.taskType,
        status: p.status,
        progressPercent: p.progressPercent,
        progressNote: p.note,
        startedAtMs: existing?.startedAtMs ?? p.timestampMs,
        completedAtMs:
          p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled'
            ? p.timestampMs
            : existing?.completedAtMs,
        error: p.error ?? existing?.error,
        logs: [...(existing?.logs ?? []), p.log],
      };
      next.set(p.taskId, updated);
      return next;
    });
  }, []);

  // Fetch all tasks from backend and reconcile
  const refresh = useCallback(async () => {
    try {
      const entries = await getTaskStatus();
      setTasks((prev) => {
        const next = new Map(prev);
        for (const entry of entries) {
          next.set(entry.taskId, entry);
        }
        return next;
      });
    } catch {
      // Silently ignore — backend may not be available in browser mode
    }
  }, []);

  // Setup: try event listener first, fall back to polling
  useEffect(() => {
    let cancelled = false;

    const listenerPromise = tryListenTauriEvent('task-center-progress', applyProgress);
    if (listenerPromise) {
      listenerPromise.then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      });
    }

    // Always poll as well — events may arrive out of order or be missed on reconnect
    const hasActiveTasks = () => {
      for (const t of tasks.values()) {
        if (t.status === 'queued' || t.status === 'running') return true;
      }
      return false;
    };

    pollRef.current = setInterval(() => {
      if (hasActiveTasks()) {
        refresh();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyProgress, refresh]);

  const start = useCallback(
    async (taskType: TaskType, params?: Record<string, unknown>) => {
      const entry = await startTask(taskType, params);
      setTasks((prev) => {
        const next = new Map(prev);
        next.set(entry.taskId, entry);
        return next;
      });
      return entry;
    },
    [],
  );

  const cancel = useCallback(
    async (taskId: string) => {
      const entry = await cancelTask(taskId);
      setTasks((prev) => {
        const next = new Map(prev);
        next.set(entry.taskId, entry);
        return next;
      });
      return entry;
    },
    [],
  );

  return { tasks, start, cancel, refresh };
}
