export type TimerTask =
  | { type: 'notify'; message: string; data?: unknown }
  | { type: 'log'; message: string; data?: unknown };

export type TimerMode = 'once' | 'interval';

export type TimerCreateInput =
  | { mode: 'once'; runAt: number; task: TimerTask }
  | { mode: 'interval'; everyMs: number; startAt?: number; task: TimerTask };

export type TimerInfo = {
  id: string;
  mode: TimerMode;
  createdAt: number;
  nextRunAt: number;
  everyMs?: number;
  lastRunAt?: number;
  task: TimerTask;
};

export type TimerEvent =
  | { type: 'timer.created'; timer: TimerInfo }
  | { type: 'timer.canceled'; id: string; ok: boolean }
  | { type: 'timer.fired'; timer: TimerInfo; firedAt: number }
  | { type: 'timer.error'; id?: string; message: string }
  | { type: 'timer.list'; timers: TimerInfo[] };

type InternalTimer = {
  info: TimerInfo;
  handle: NodeJS.Timeout;
};

type TimerEventListener = (event: TimerEvent) => void;

/**
 * 创建一个进程内定时器调度器（基于 setTimeout / setInterval）。
 */
export function createTimerScheduler(): {
  createTimer: (input: TimerCreateInput) => TimerInfo;
  cancelTimer: (id: string) => boolean;
  listTimers: () => TimerInfo[];
  onEvent: (listener: TimerEventListener) => () => void;
} {
  const timers = new Map<string, InternalTimer>();
  const listeners = new Set<TimerEventListener>();

  /**
   * 向所有订阅者广播定时器事件。
   */
  function emit(event: TimerEvent): void {
    for (const listener of listeners) listener(event);
  }

  /**
   * 订阅定时器事件；返回一个取消订阅函数。
   */
  function onEvent(listener: TimerEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * 生成定时器 ID。
   */
  function createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `timer_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  /**
   * 获取当前时间戳（毫秒）。
   */
  function safeNow(): number {
    return Date.now();
  }

  /**
   * 将 value 下限限制为 min。
   */
  function clampMin(value: number, min: number): number {
    return value < min ? min : value;
  }

  /**
   * 执行任务（当前仅实现 log；notify 由外层事件推送完成）。
   */
  function runTask(task: TimerTask): void {
    if (task.type === 'log') {
      const data = task.data !== undefined ? ` data=${JSON.stringify(task.data)}` : '';
      console.log(`[timer] ${task.message}${data}`);
      return;
    }

    if (task.type === 'notify') {
      return;
    }
  }

  /**
   * 创建一次性任务。
   */
  function createOnceTimer(input: { runAt: number; task: TimerTask }): TimerInfo {
    const id = createId();
    const createdAt = safeNow();
    const nextRunAt = clampMin(input.runAt, createdAt);

    const info: TimerInfo = {
      id,
      mode: 'once',
      createdAt,
      nextRunAt,
      task: input.task
    };

    const delay = clampMin(nextRunAt - safeNow(), 0);
    const handle = setTimeout(() => {
      const existing = timers.get(id);
      if (!existing) return;

      const firedAt = safeNow();
      existing.info.lastRunAt = firedAt;
      existing.info.nextRunAt = firedAt;

      try {
        runTask(existing.info.task);
        emit({ type: 'timer.fired', timer: { ...existing.info }, firedAt });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit({ type: 'timer.error', id, message });
      } finally {
        timers.delete(id);
      }
    }, delay);

    timers.set(id, { info, handle });
    emit({ type: 'timer.created', timer: { ...info } });
    return { ...info };
  }

  /**
   * 创建周期性任务。
   */
  function createIntervalTimer(input: { everyMs: number; startAt?: number; task: TimerTask }): TimerInfo {
    const id = createId();
    const createdAt = safeNow();
    const everyMs = clampMin(Math.floor(input.everyMs), 50);
    const startAt = input.startAt ?? createdAt;

    const info: TimerInfo = {
      id,
      mode: 'interval',
      createdAt,
      nextRunAt: clampMin(startAt, createdAt),
      everyMs,
      task: input.task
    };

    const firstDelay = clampMin(info.nextRunAt - safeNow(), 0);
    const handle = setTimeout(() => {
      const existing = timers.get(id);
      if (!existing) return;

      const intervalHandle = setInterval(() => {
        const current = timers.get(id);
        if (!current) return;

        const firedAt = safeNow();
        current.info.lastRunAt = firedAt;
        current.info.nextRunAt = firedAt + everyMs;

        try {
          runTask(current.info.task);
          emit({ type: 'timer.fired', timer: { ...current.info }, firedAt });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          emit({ type: 'timer.error', id, message });
        }
      }, everyMs);

      timers.set(id, { info: existing.info, handle: intervalHandle });

      const firedAt = safeNow();
      existing.info.lastRunAt = firedAt;
      existing.info.nextRunAt = firedAt + everyMs;

      try {
        runTask(existing.info.task);
        emit({ type: 'timer.fired', timer: { ...existing.info }, firedAt });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit({ type: 'timer.error', id, message });
      }
    }, firstDelay);

    timers.set(id, { info, handle });
    emit({ type: 'timer.created', timer: { ...info } });
    return { ...info };
  }

  /**
   * 创建定时器（once / interval）。
   */
  function createTimer(input: TimerCreateInput): TimerInfo {
    if (input.mode === 'once') return createOnceTimer({ runAt: input.runAt, task: input.task });
    return createIntervalTimer({ everyMs: input.everyMs, startAt: input.startAt, task: input.task });
  }

  /**
   * 取消并清理指定 ID 的定时器。
   */
  function cancelTimer(id: string): boolean {
    const existing = timers.get(id);
    if (!existing) {
      emit({ type: 'timer.canceled', id, ok: false });
      return false;
    }

    clearTimeout(existing.handle);
    clearInterval(existing.handle);
    timers.delete(id);
    emit({ type: 'timer.canceled', id, ok: true });
    return true;
  }

  /**
   * 获取当前所有定时器快照。
   */
  function listTimers(): TimerInfo[] {
    return Array.from(timers.values()).map((t) => ({ ...t.info }));
  }

  return { createTimer, cancelTimer, listTimers, onEvent };
}
