'use client';

import { useEffect, useMemo, useState } from 'react';

type CanvasPayload = {
  title?: string;
  html: string;
  css?: string;
  js?: string;
  height?: number;
  allowNetwork?: boolean;
};

type ChatOutput =
  | { type: 'text'; text: string }
  | { type: 'canvas'; canvas: CanvasPayload };

type ChatMessage =
  | { id: string; role: 'user'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'canvas'; canvas: CanvasPayload };

type TimerFiredMessage = {
  type: 'timer.fired';
  firedAt: number;
  timer: { task?: { type?: unknown; message?: unknown } };
};

/**
 * 生成一个尽量稳定的消息 ID，避免 key 变化导致的闪烁。
 */
function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * 从 WS 事件中解析出 notify 文本（用于在聊天区域显示）。
 */
function extractNotifyTextFromTimerEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const type = (event as { type?: unknown }).type;
  if (type !== 'timer.fired') return null;

  const timer = (event as TimerFiredMessage).timer;
  const task = timer?.task;
  if (!task || typeof task !== 'object') return null;
  if ((task as { type?: unknown }).type !== 'notify') return null;
  const message = (task as { message?: unknown }).message;
  if (typeof message !== 'string' || !message.trim()) return null;
  return message.trim();
}

/**
 * 将 UI 消息列表映射为接口可用的 {role, content} 格式。
 */
function toApiMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map((m) => {
    if (m.kind === 'text') return { role: m.role, content: m.text };
    const title = m.canvas.title ? `《${m.canvas.title}》` : '';
    return { role: m.role, content: `[Canvas${title}]` };
  });
}

/**
 * 把 Canvas 的片段拼成可在 iframe srcDoc 中运行的完整 HTML 文档。
 */
function buildCanvasSrcDoc(input: { canvasId: string; canvas: CanvasPayload }): string {
  const { canvasId, canvas } = input;
  const css = canvas.css ?? '';
  const js = canvas.js ?? '';
  const html = canvas.html ?? '';
  const csp = canvas.allowNetwork
    ? "default-src 'none'; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; connect-src https:; media-src data: https:;"
    : "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:; font-src data: https:;";

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    '<style>',
    'html, body { margin: 0; padding: 0; }',
    'body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }',
    '#root { padding: 12px; }',
    css,
    '</style>',
    '</head>',
    '<body>',
    '<div id="root">',
    html,
    '</div>',
    '<script>',
    '(function(){',
    `  var CANVAS_ID = ${JSON.stringify(canvasId)};`,
    '  function postHeight(){',
    '    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);',
    '    parent.postMessage({ type: "canvas:resize", canvasId: CANVAS_ID, height: h }, "*");',
    '  }',
    '  if (typeof ResizeObserver !== "undefined") {',
    '    var ro = new ResizeObserver(function(){ postHeight(); });',
    '    ro.observe(document.documentElement);',
    '  } else {',
    '    window.addEventListener("resize", postHeight);',
    '  }',
    '  window.addEventListener("load", postHeight);',
    '  setTimeout(postHeight, 0);',
    '})();',
    '</script>',
    '<script>',
    js,
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');
}

/**
 * 将数值限制在给定区间内。
 */
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Canvas 消息渲染：以受限 iframe 的形式承载 HTML/CSS/JS 小应用。
 */
function CanvasCard({ canvas }: { canvas: CanvasPayload }) {
  const canvasId = useMemo(() => createMessageId(), []);
  const srcDoc = useMemo(() => buildCanvasSrcDoc({ canvasId, canvas }), [canvasId, canvas]);
  const [expanded, setExpanded] = useState(true);
  const [height, setHeight] = useState(() => clampNumber(canvas.height ?? 360, 240, 900));

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      if (!event.data || typeof event.data !== 'object') return;
      const data = event.data as { type?: unknown; canvasId?: unknown; height?: unknown };
      if (data.type !== 'canvas:resize') return;
      if (data.canvasId !== canvasId) return;
      const next = typeof data.height === 'number' ? data.height : Number(data.height);
      if (!Number.isFinite(next)) return;
      setHeight((prev) => clampNumber(Math.max(prev, next), 240, 900));
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [canvasId]);

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          background: '#f9fafb',
          borderBottom: expanded ? '1px solid #e5e7eb' : 'none'
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Canvas</div>
          {canvas.title ? <div style={{ fontSize: 13 }}>{canvas.title}</div> : null}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {expanded ? (
            <input
              aria-label="画布高度"
              type="range"
              min={240}
              max={900}
              value={height}
              onChange={(e) => setHeight(clampNumber(Number(e.target.value), 240, 900))}
            />
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid #e5e7eb',
              background: '#fff',
              cursor: 'pointer'
            }}
          >
            {expanded ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {expanded ? (
        <iframe
          title={canvas.title ?? 'Canvas'}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          style={{ width: '100%', height, border: 0, display: 'block', background: '#fff' }}
        />
      ) : null}
    </div>
  );
}

/**
 * 首页：用最小 UI 调用 /api/chat，实现“接口对话”演示。
 */
export default function Page() {
  const [input, setInput] = useState('你好');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  /**
   * 订阅定时器 WS 推送，把 notify 事件追加为 assistant 文本消息。
   */
  useEffect(() => {
    const wsUrl = 'ws://localhost:3001/ws';
    let ws: WebSocket | null = null;
    let stopped = false;
    let retryTimer: number | null = null;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (e) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(e.data));
        } catch {
          return;
        }

        const text = extractNotifyTextFromTimerEvent(parsed);
        if (!text) return;
        setMessages((prev) => [...prev, { id: createMessageId(), role: 'assistant', kind: 'text', text }]);
      };

      ws.onclose = () => {
        if (stopped) return;
        retryTimer = window.setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
      ws = null;
    };
  }, []);

  /**
   * 发送消息：把历史消息 + 新消息发到服务端，再把模型回复追加到列表里。
   */
  async function handleSend(): Promise<void> {
    if (!canSend) return;

    const userMessage: ChatMessage = { id: createMessageId(), role: 'user', kind: 'text', text: input.trim() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: toApiMessages(nextMessages) })
      });

      const data = (await res.json().catch(() => ({}))) as { output?: ChatOutput; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.output) throw new Error('接口返回缺少 output 字段');
      const output = data.output;

      if (output.type === 'canvas') {
        setMessages((prev) => [
          ...prev,
          { id: createMessageId(), role: 'assistant', kind: 'canvas', canvas: output.canvas }
        ]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        { id: createMessageId(), role: 'assistant', kind: 'text', text: output.text }
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [
        ...prev,
        { id: createMessageId(), role: 'assistant', kind: 'text', text: `调用失败：${message}` }
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '32px auto', padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>AI SDK 对话接口 Demo</h1>

      <div
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 12,
          minHeight: 240,
          marginBottom: 12,
          background: '#fff'
        }}
      >
        {messages.length === 0 ? (
          <div style={{ color: '#6b7280' }}>在下方输入内容并发送。</div>
        ) : (
          messages.map((m, idx) => (
            <div key={m.id ?? idx} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {m.role === 'user' ? '你' : '模型'}
              </div>
              {m.kind === 'canvas' ? (
                <div style={{ marginTop: 6 }}>
                  <CanvasCard canvas={m.canvas} />
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              )}
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入消息"
          style={{
            flex: 1,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: '10px 12px'
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSend();
          }}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            background: canSend ? '#111827' : '#9ca3af',
            color: '#fff',
            cursor: canSend ? 'pointer' : 'not-allowed'
          }}
        >
          {loading ? '发送中…' : '发送'}
        </button>
      </div>
    </main>
  );
}
