'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';

type CanvasPayload = {
  title?: string;
  html: string;
  css?: string;
  js?: string;
  height?: number;
  allowNetwork?: boolean;
};

type A2UIComponent = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
};

type A2UISurface = {
  rootId: string;
  components: A2UIComponent[];
};

type A2UIPayload = {
  surface: A2UISurface;
  model?: Record<string, unknown>;
};

type A2UIEvent = {
  type: 'a2ui.event';
  name: 'submit' | 'click';
  messageId: string;
  componentId?: string;
  model?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

type ChatMeta = {
  usedCalls?: string[];
};

type ChatOutput =
  | { type: 'text'; text: string }
  | { type: 'canvas'; canvas: CanvasPayload }
  | { type: 'a2ui'; a2ui: A2UIPayload };

type ChatMessage =
  | { id: string; role: 'user'; kind: 'text'; text: string }
  | { id: string; role: 'user'; kind: 'a2ui_event'; label: string; event: A2UIEvent }
  | { id: string; role: 'assistant'; kind: 'text'; text: string; meta?: ChatMeta }
  | { id: string; role: 'assistant'; kind: 'canvas'; canvas: CanvasPayload; meta?: ChatMeta }
  | { id: string; role: 'assistant'; kind: 'a2ui'; a2ui: A2UIPayload; meta?: ChatMeta };

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
    if (m.kind === 'a2ui_event') return { role: m.role, content: JSON.stringify(m.event) };
    if (m.kind === 'canvas') {
      const title = m.canvas.title ? `《${m.canvas.title}》` : '';
      return { role: m.role, content: `[Canvas${title}]` };
    }
    return { role: m.role, content: JSON.stringify({ type: 'a2ui', a2ui: m.a2ui }) };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length === value.length ? strings : null;
}

function readSelectOptions(
  value: unknown
): Array<{ label: string; value: string }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ label: string; value: string }> = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const label = readString(item.label);
    const v = readString(item.value);
    if (!label || !v) return null;
    out.push({ label, value: v });
  }
  return out;
}

function coerceModelToStringMap(model: unknown): Record<string, string> {
  if (!isRecord(model)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(model)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
    else if (typeof v === 'boolean') out[k] = v ? 'true' : 'false';
  }
  return out;
}

/**
 * 渲染 A2UI payload：仅允许渲染本地白名单组件（安全像数据、表达像组件）。
 */
function A2UICard(input: {
  a2ui: A2UIPayload;
  model: Record<string, string>;
  onModelChange: (key: string, value: string) => void;
  onEvent: (event: Omit<A2UIEvent, 'type' | 'messageId' | 'model'>) => void;
}) {
  const { a2ui, model, onModelChange, onEvent } = input;
  const componentById = useMemo(() => {
    const map = new Map<string, A2UIComponent>();
    for (const c of a2ui.surface.components) map.set(c.id, c);
    return map;
  }, [a2ui.surface.components]);

  const rendered = new Set<string>();

  function renderNode(nodeId: string): ReactNode {
    if (rendered.has(nodeId)) return null;
    rendered.add(nodeId);

    const node = componentById.get(nodeId);
    if (!node) return null;

    const props = isRecord(node.props) ? node.props : {};

    if (node.type === 'card') {
      const title = readString(props.title);
      const children = readStringArray(props.children) ?? [];
      return (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              background: '#f9fafb',
              borderBottom: children.length ? '1px solid #e5e7eb' : 'none'
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>A2UI</div>
              {title ? <div style={{ fontSize: 13 }}>{title}</div> : null}
            </div>
          </div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {children.map((cid) => (
              <div key={cid}>{renderNode(cid)}</div>
            ))}
          </div>
        </div>
      );
    }

    if (node.type === 'column') {
      const children = readStringArray(props.children) ?? [];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {children.map((cid) => (
            <div key={cid}>{renderNode(cid)}</div>
          ))}
        </div>
      );
    }

    if (node.type === 'row') {
      const children = readStringArray(props.children) ?? [];
      return (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {children.map((cid) => (
            <div key={cid}>{renderNode(cid)}</div>
          ))}
        </div>
      );
    }

    if (node.type === 'divider') {
      return <hr style={{ border: 0, borderTop: '1px solid #e5e7eb' }} />;
    }

    if (node.type === 'text') {
      const text = readString(props.text) ?? '';
      return <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>;
    }

    if (node.type === 'text-field') {
      const label = readString(props.label) ?? '';
      const key = readString(props.key) ?? '';
      const placeholder = readString(props.placeholder) ?? undefined;
      if (!key) return null;

      return (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {label ? <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div> : null}
          <input
            value={model[key] ?? ''}
            onChange={(e) => onModelChange(key, e.target.value)}
            placeholder={placeholder}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: '10px 12px'
            }}
          />
        </label>
      );
    }

    if (node.type === 'select') {
      const label = readString(props.label) ?? '';
      const key = readString(props.key) ?? '';
      const options = readSelectOptions(props.options) ?? [];
      if (!key || options.length === 0) return null;
      const value = model[key] ?? options[0]?.value ?? '';

      return (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {label ? <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div> : null}
          <select
            value={value}
            onChange={(e) => onModelChange(key, e.target.value)}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: '10px 12px',
              background: '#fff'
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (node.type === 'button') {
      const label = readString(props.label) ?? '按钮';
      const action = readString(props.action) ?? 'click';
      return (
        <button
          type="button"
          onClick={() => onEvent({ name: action === 'submit' ? 'submit' : 'click', componentId: node.id })}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            background: '#111827',
            color: '#fff',
            cursor: 'pointer'
          }}
        >
          {label}
        </button>
      );
    }

    return (
      <div style={{ padding: 10, border: '1px dashed #d1d5db', borderRadius: 10, color: '#6b7280' }}>
        未支持的组件：{node.type}
      </div>
    );
  }

  const rootId = a2ui.surface.rootId;
  const root = renderNode(rootId);
  if (!root) {
    return (
      <div style={{ padding: 10, border: '1px dashed #d1d5db', borderRadius: 10, color: '#6b7280' }}>
        A2UI 渲染失败：找不到 rootId={rootId}
      </div>
    );
  }

  return (
    <div>
      {root}
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => onEvent({ name: 'submit' })}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            background: '#fff',
            cursor: 'pointer'
          }}
        >
          提交当前表单
        </button>
        <button
          type="button"
          onClick={() => onEvent({ name: 'click' })}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            background: '#fff',
            cursor: 'pointer'
          }}
        >
          发送点击事件
        </button>
      </div>
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
  const [a2uiModels, setA2uiModels] = useState<Record<string, Record<string, string>>>({});
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
  async function sendMessage(userMessage: ChatMessage): Promise<void> {
    if (loading) return;

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    if (userMessage.kind === 'text') setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: toApiMessages(nextMessages) })
      });

      const data = (await res.json().catch(() => ({}))) as { output?: ChatOutput; meta?: ChatMeta; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.output) throw new Error('接口返回缺少 output 字段');
      const output = data.output;
      const meta = data.meta;

      if (output.type === 'canvas') {
        setMessages((prev) => [
          ...prev,
          { id: createMessageId(), role: 'assistant', kind: 'canvas', canvas: output.canvas, meta }
        ]);
        return;
      }

      if (output.type === 'a2ui') {
        const id = createMessageId();
        setA2uiModels((prev) => ({ ...prev, [id]: coerceModelToStringMap(output.a2ui.model) }));
        setMessages((prev) => [...prev, { id, role: 'assistant', kind: 'a2ui', a2ui: output.a2ui, meta }]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        { id: createMessageId(), role: 'assistant', kind: 'text', text: output.text, meta }
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

  /**
   * 由输入框触发的“发送”动作。
   */
  async function handleSend(): Promise<void> {
    if (!canSend) return;
    const text = input.trim();
    if (!text) return;
    await sendMessage({ id: createMessageId(), role: 'user', kind: 'text', text });
  }

  /**
   * 由 A2UI 卡片触发的事件回传：以结构化 JSON 发送到后端。
   */
  async function handleA2uiEvent(input: { messageId: string; event: Omit<A2UIEvent, 'type' | 'messageId' | 'model'> }) {
    if (loading) return;
    const model = a2uiModels[input.messageId] ?? {};
    const event: A2UIEvent = { type: 'a2ui.event', messageId: input.messageId, model, ...input.event };
    const label = event.name === 'submit' ? '（通过 A2UI 提交）' : '（通过 A2UI 点击）';
    await sendMessage({ id: createMessageId(), role: 'user', kind: 'a2ui_event', label, event });
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
              ) : m.kind === 'a2ui' ? (
                <div style={{ marginTop: 6 }}>
                  <A2UICard
                    a2ui={m.a2ui}
                    model={a2uiModels[m.id] ?? coerceModelToStringMap(m.a2ui.model)}
                    onModelChange={(key, value) =>
                      setA2uiModels((prev) => ({ ...prev, [m.id]: { ...(prev[m.id] ?? {}), [key]: value } }))
                    }
                    onEvent={(event) => void handleA2uiEvent({ messageId: m.id, event })}
                  />
                </div>
              ) : m.kind === 'a2ui_event' ? (
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.label}</div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              )}
              {m.role === 'assistant' && m.meta?.usedCalls?.length ? (
                <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
                  调用：{m.meta.usedCalls.join(', ')}
                </div>
              ) : null}
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
