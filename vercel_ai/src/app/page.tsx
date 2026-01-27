'use client';

import { useMemo, useState } from 'react';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

/**
 * 首页：用最小 UI 调用 /api/chat，实现“接口对话”演示。
 */
export default function Page() {
  const [input, setInput] = useState('你好');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  /**
   * 发送消息：把历史消息 + 新消息发到服务端，再把模型回复追加到列表里。
   */
  async function handleSend(): Promise<void> {
    if (!canSend) return;

    const userMessage: ChatMessage = { role: 'user', content: input.trim() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages })
      });

      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.text) throw new Error('接口返回缺少 text 字段');

      const text = data.text;
      setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `调用失败：${message}` }
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
            <div key={idx} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {m.role === 'user' ? '你' : '模型'}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
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
