import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createTimerScheduler, type TimerCreateInput, type TimerEvent, type TimerInfo, type TimerTask } from './timerScheduler';

type WsHello = { type: 'hello'; now: number; ws: { path: string; port: number } };
type WsPong = { type: 'pong'; id?: string };
type WsError = { type: 'error'; message: string; requestType?: string };
type WsTimerCreated = { type: 'timer.created'; timer: TimerInfo };
type WsTimerCanceled = { type: 'timer.canceled'; id: string; ok: boolean };
type WsTimerFired = { type: 'timer.fired'; timer: TimerInfo; firedAt: number };
type WsTimerList = { type: 'timer.list'; timers: TimerInfo[] };
type WsTimerError = { type: 'timer.error'; id?: string; message: string };

type WsServerToClient =
  | WsHello
  | WsPong
  | WsError
  | WsTimerCreated
  | WsTimerCanceled
  | WsTimerFired
  | WsTimerList
  | WsTimerError;

type WsClientToServer =
  | { type: 'ping'; id?: string }
  | { type: 'timer.list' }
  | { type: 'timer.cancel'; id: string }
  | { type: 'timer.create'; timer: TimerCreateInput };

/**
 * 启动 WebSocket 定时器服务（默认端口 3001，路径 /ws）。
 */
export function startTimerWsServer(input?: {
  port?: number;
  path?: string;
  allowedOrigins?: string[];
}): {
  port: number;
  path: string;
  close: () => Promise<void>;
} {
  const port = input?.port ?? Number(process.env.TIMER_WS_PORT ?? '3001');
  const path = input?.path ?? '/ws';
  const allowedOrigins = input?.allowedOrigins ?? parseAllowedOrigins(process.env.TIMER_WS_ALLOWED_ORIGINS);

  const scheduler = createTimerScheduler();
  const clients = new Set<WebSocket>();

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required');
  });

  const wss = new WebSocketServer({ noServer: true });

  function send(ws: WebSocket, message: WsServerToClient): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  function broadcast(message: WsServerToClient): void {
    for (const ws of clients) send(ws, message);
  }

  function mapTimerEvent(event: TimerEvent): WsServerToClient {
    if (event.type === 'timer.created') return { type: 'timer.created', timer: event.timer };
    if (event.type === 'timer.canceled') return { type: 'timer.canceled', id: event.id, ok: event.ok };
    if (event.type === 'timer.fired') return { type: 'timer.fired', timer: event.timer, firedAt: event.firedAt };
    if (event.type === 'timer.list') return { type: 'timer.list', timers: event.timers };
    return { type: 'timer.error', id: event.id, message: event.message };
  }

  scheduler.onEvent((event) => {
    const mapped = mapTimerEvent(event);
    broadcast(mapped);
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== path) {
      socket.destroy();
      return;
    }

    const origin = String(req.headers.origin ?? '');
    if (!isOriginAllowed({ origin, allowedOrigins })) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    send(ws, { type: 'hello', now: Date.now(), ws: { path, port } });
    send(ws, { type: 'timer.list', timers: scheduler.listTimers() });

    ws.on('message', (data: WebSocket.RawData) => {
      const request = parseClientMessage(data);
      if (!request) {
        send(ws, { type: 'error', message: '无法解析消息（需要 JSON）' });
        return;
      }

      try {
        handleRequest({ ws, request });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send(ws, { type: 'error', message, requestType: request.type });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  function handleRequest(input: { ws: WebSocket; request: WsClientToServer }): void {
    const { ws, request } = input;

    if (request.type === 'ping') {
      send(ws, { type: 'pong', id: request.id });
      return;
    }

    if (request.type === 'timer.list') {
      send(ws, { type: 'timer.list', timers: scheduler.listTimers() });
      return;
    }

    if (request.type === 'timer.cancel') {
      scheduler.cancelTimer(request.id);
      return;
    }

    if (request.type === 'timer.create') {
      const normalized = normalizeTimerCreateInput(request.timer);
      scheduler.createTimer(normalized);
      return;
    }
  }

  server.listen(port);

  return {
    port,
    path,
    close: async () => {
      for (const ws of clients) ws.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/**
 * 独立运行：tsx src/server/timerWsServer.ts
 */
async function main(): Promise<void> {
  const instance = startTimerWsServer();
  console.log(`[timer-ws] ws://localhost:${instance.port}${instance.path}`);

  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

/**
 * 解析允许的 Origin 列表（逗号分隔）。
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length > 0) return items;
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

/**
 * 判断当前连接 Origin 是否在允许列表内。
 */
function isOriginAllowed(input: { origin: string; allowedOrigins: string[] }): boolean {
  const origin = input.origin.trim();
  if (!origin) return true;
  return input.allowedOrigins.includes(origin);
}

/**
 * 解析客户端消息为结构化请求。
 */
function parseClientMessage(data: WebSocket.RawData): WsClientToServer | null {
  const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string') return null;

    if (type === 'ping') {
      const id = (parsed as { id?: unknown }).id;
      return { type: 'ping', id: typeof id === 'string' ? id : undefined };
    }
    if (type === 'timer.list') return { type: 'timer.list' };

    if (type === 'timer.cancel') {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id !== 'string' || !id) return null;
      return { type: 'timer.cancel', id };
    }

    if (type === 'timer.create') {
      const timer = (parsed as { timer?: unknown }).timer;
      if (!timer || typeof timer !== 'object') return null;
      return { type: 'timer.create', timer: timer as TimerCreateInput };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 对创建参数做最小规范化，避免无效值造成极端定时行为。
 */
function normalizeTimerCreateInput(input: TimerCreateInput): TimerCreateInput {
  if (input.mode === 'once') {
    return {
      mode: 'once',
      runAt: Number.isFinite(input.runAt) ? Math.floor(input.runAt) : Date.now(),
      task: normalizeTask(input.task)
    };
  }

  return {
    mode: 'interval',
    everyMs: Number.isFinite(input.everyMs) ? Math.max(50, Math.floor(input.everyMs)) : 1000,
    startAt: input.startAt !== undefined && Number.isFinite(input.startAt) ? Math.floor(input.startAt) : undefined,
    task: normalizeTask(input.task)
  };
}

/**
 * 规范化任务结构，避免 message 为空导致的无意义任务。
 */
function normalizeTask(task: TimerTask): TimerTask {
  if (task.type === 'log') return { type: 'log', message: String(task.message ?? ''), data: task.data };
  return { type: 'notify', message: String(task.message ?? ''), data: task.data };
}
