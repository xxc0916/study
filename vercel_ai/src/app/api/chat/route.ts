import { generateText, jsonSchema, stepCountIs, tool, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { NextResponse } from 'next/server';
import { addMemory, searchMemories, type MemoryItem } from '../../../server/memoryStore';
import { listSkills, loadSkillMarkdownByName, runSkillByName } from '../../../server/skillLoader';

export const runtime = 'nodejs';

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

type TimerTask =
  | { type: 'notify'; message: string; data?: unknown }
  | { type: 'log'; message: string; data?: unknown };

type TimerCreateInput =
  | { mode: 'once'; runAt: number; task: TimerTask }
  | { mode: 'interval'; everyMs: number; startAt?: number; task: TimerTask };

type TimerAction =
  | { name: 'timer.create'; timer: TimerCreateInput }
  | { name: 'timer.cancel'; id: string }
  | { name: 'timer.list' };

type ActionOutput = { type: 'action'; action: TimerAction; replyText?: string };

type ParsedOutput = ChatOutput | ActionOutput;

/**
 * 从环境变量读取 OpenAI-compatible 网关配置。
 */
function getOpenAICompatibleConfig(req: Request): { baseURL: string; apiKey: string; model: string } {
  const model = (process.env.OPENAI_COMPATIBLE_MODEL ?? 'gemini-2.5-pro').trim();

  const envBaseURL = (process.env.OPENAI_COMPATIBLE_BASE_URL ?? '').trim();
  const envApiKey = (process.env.OPENAI_COMPATIBLE_API_KEY ?? '').trim();
  if (envBaseURL && envApiKey) return { baseURL: envBaseURL, apiKey: envApiKey, model };

  const upstreamBaseURL = (process.env.AI_GATEWAY_BASE_URL ?? '').trim();
  const upstreamApiKey = (process.env.AI_GATEWAY_API_KEY ?? '').trim();
  if (!upstreamBaseURL || !upstreamApiKey) return { baseURL: '', apiKey: '', model };

  const origin = new URL(req.url).origin;
  const baseURL = `${origin}/api/gateway`;
  const apiKey = (process.env.LOCAL_GATEWAY_API_KEY ?? 'local').trim() || 'local';
  return { baseURL, apiKey, model };
}

/**
 * 将任意输入尽量标准化为 ModelMessage[]，避免接口参数不符合预期。
 * 为避免客户端注入 system 指令，这里仅接受 user/assistant 两类角色。
 */
type SimpleMessage = { role: 'user' | 'assistant'; content: string };

function coerceMessages(input: unknown): SimpleMessage[] {
  if (!Array.isArray(input)) return [{ role: 'user', content: '你好' }];

  const messages: SimpleMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (typeof role !== 'string' || typeof content !== 'string') continue;
    if (role !== 'user' && role !== 'assistant') continue;
    messages.push({ role, content });
  }

  return messages.length ? messages : [{ role: 'user', content: '你好' }];
}

/**
 * 从环境变量读取 Timer WS 配置。
 */
function getTimerWsConfig(): { url: string; timeoutMs: number } {
  const url = (process.env.TIMER_WS_URL ?? 'ws://localhost:3001/ws').trim();
  const timeoutMs = Number(process.env.TIMER_WS_TIMEOUT_MS ?? '2000');
  return { url, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 2000 };
}

function buildMemoryContextPrompt(memories: MemoryItem[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `- ${m.text}`);
  return ['已知用户长期记忆（可被更新；如冲突请向用户确认）：', ...lines].join('\n');
}

type MemoryCandidate = { text: string; tags?: string[] };

function parseMemoryCandidates(raw: string): MemoryCandidate[] {
  const candidate = extractJsonObjectText(raw);
  if (!candidate) return [];
  try {
    const parsed: unknown = JSON.parse(candidate);
    const memories = (parsed as { memories?: unknown }).memories;
    if (!Array.isArray(memories)) return [];
    return memories
      .map((m): MemoryCandidate | null => {
        if (!m || typeof m !== 'object') return null;
        const text = (m as { text?: unknown }).text;
        const tags = (m as { tags?: unknown }).tags;
        if (typeof text !== 'string' || !text.trim()) return null;
        return {
          text: text.trim(),
          tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : undefined
        };
      })
      .filter((x): x is MemoryCandidate => Boolean(x));
  } catch {
    return [];
  }
}

async function autoRememberFromUserText(input: {
  model: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  userText: string;
}): Promise<void> {
  const text = input.userText.trim();
  if (!text) return;

  const result = await generateText({
    model: input.model,
    system: [
      '你是一个“长期记忆提取器”。',
      '根据用户本轮输入，提取最多 5 条值得长期记住的信息。',
      '只记：稳定偏好、长期目标、固定事实、环境约束、明确的规则/禁忌。',
      '不要记：一次性任务、临时数字、会过期的链接、敏感信息（API Key/Token/密码）。',
      '只输出一个 JSON 对象：{"memories":[{"text":"...","tags":["preference|profile|constraint|goal|workflow"]}]}',
      '如果没有值得记住的内容，输出：{"memories":[]}'
    ].join('\n'),
    prompt: text
  });

  const memories = parseMemoryCandidates(result.text);
  for (const m of memories) {
    await addMemory({ text: m.text, tags: m.tags });
  }
}

/**
 * 构建一段 system 指令，让模型在 “纯文本” 与 “Canvas 小应用” 之间自适配输出。
 */
function buildCanvasSystemPrompt(): string {
  return [
    '你是一个可在聊天界面中生成「Canvas（画布）」的 AI Agent。',
    '',
    '你必须只输出一个 JSON 对象（不要 Markdown，不要代码块，不要额外文本）。',
    '',
    '输出格式二选一：',
    '1) 纯文本：{"type":"text","text":"..."}',
    '2) Canvas：{"type":"canvas","canvas":{"title":"可选标题","html":"...","css":"可选","js":"可选","height":360,"allowNetwork":false}}',
    '',
    '何时使用 Canvas：当用户需要数据可视化、筛选/排序、表单提交、缩放/切换视图等交互时，优先用 Canvas；否则用 text。',
    '',
    '当用户明确提出“定时/每隔/到点提醒/周期执行/取消定时器/查看定时器”等需求时，优先通过工具调用完成：timer_create / timer_cancel / timer_list。',
    '工具返回的结果视为事实；不要重复调用同一个工具来“确认”。',
    '当用户明确要求“列出/加载/运行 skill”或请求你执行 calc/http_get/echo 等能力时，优先通过工具调用完成：skill_list / skill_load / skill_run。',
    '当用户提出数学表达式计算（加减乘除/括号/小数）时，优先调用 skill_run 执行 calc，然后基于结果回复。',
    '除非用户明确要求“查询/写入长期记忆”，否则不要调用 memory_search / memory_add。',
    '',
    'Canvas 约束：',
    '- 生成的 html/css/js 必须自包含，尽量不要依赖外部 CDN/网络请求。',
    '- 只有当用户明确要求第三方库/外部数据源时，才把 allowNetwork 设为 true，并说明依赖外网。',
    '- 不要读取/写入 cookies、localStorage、indexedDB；不要尝试访问父窗口 DOM。',
    '- 默认宽度自适应容器；高度建议 320~520（可通过 height 字段给出初始高度）。',
    '- 交互通过原生 HTML 表单/按钮/事件即可。',
    '',
    '如果你无法生成 Canvas（例如缺少数据），请退回输出 type="text" 并说明需要什么输入。'
  ].join('\n');
}

/**
 * 从模型输出中提取 JSON 字符串（支持裸 JSON、或被 ```json 包裹的情况）。
 */
function extractJsonObjectText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) return trimmed.slice(first, last + 1).trim();

  return null;
}

/**
 * 尝试把模型输出解析成 ChatOutput；失败则回退为纯文本。
 */
function parseChatOutput(raw: string): ParsedOutput {
  const candidate = extractJsonObjectText(raw);
  if (!candidate) return { type: 'text', text: raw };

  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') return { type: 'text', text: raw };

    const type = (parsed as { type?: unknown }).type;
    if (type === 'text') {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === 'string') return { type: 'text', text };
      return { type: 'text', text: raw };
    }

    if (type === 'canvas') {
      const canvas = (parsed as { canvas?: unknown }).canvas;
      if (!canvas || typeof canvas !== 'object') return { type: 'text', text: raw };

      const html = (canvas as { html?: unknown }).html;
      const css = (canvas as { css?: unknown }).css;
      const js = (canvas as { js?: unknown }).js;
      const title = (canvas as { title?: unknown }).title;
      const height = (canvas as { height?: unknown }).height;
      const allowNetwork = (canvas as { allowNetwork?: unknown }).allowNetwork;

      if (typeof html !== 'string' || !html.trim()) return { type: 'text', text: raw };

      return {
        type: 'canvas',
        canvas: {
          html,
          css: typeof css === 'string' ? css : undefined,
          js: typeof js === 'string' ? js : undefined,
          title: typeof title === 'string' ? title : undefined,
          height: typeof height === 'number' && Number.isFinite(height) ? height : undefined,
          allowNetwork: typeof allowNetwork === 'boolean' ? allowNetwork : undefined
        }
      };
    }

    if (type === 'action') {
      const action = (parsed as { action?: unknown }).action;
      const replyText = (parsed as { replyText?: unknown }).replyText;
      const normalized = normalizeTimerAction(action);
      if (!normalized) return { type: 'text', text: raw };
      return { type: 'action', action: normalized, replyText: typeof replyText === 'string' ? replyText : undefined };
    }

    return { type: 'text', text: raw };
  } catch {
    return { type: 'text', text: raw };
  }
}

function extractUsedSkillNames(result: unknown): string[] {
  const steps = (result as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];

  const names: string[] = [];
  for (const step of steps) {
    const toolCalls = (step as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      const toolName = (call as { toolName?: unknown }).toolName;
      if (toolName !== 'skill_run') continue;
      const args = (call as { args?: unknown }).args;
      const name = (args as { name?: unknown } | undefined)?.name;
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  }

  return [...new Set(names)];
}

function appendUsedSkills(text: string, usedSkills: string[]): string {
  if (!usedSkills.length) return text;
  const footer = `（调用技能：${usedSkills.join(', ')}）`;
  if (!text.trim()) return footer;
  return `${text}\n\n${footer}`;
}

function extractPureCalcExpression(text: string): string | null {
  const s = text.trim();
  if (!s) return null;

  const stripped = s
    .replace(/^请\s*/g, '')
    .replace(/^帮我\s*/g, '')
    .replace(/^你\s*/g, '')
    .replace(/^计算\s*/g, '')
    .replace(/^算\s*/g, '')
    .trim();

  const candidate = stripped || s;
  if (!/^[0-9+\-*/().\s]+$/.test(candidate)) return null;
  if (!/[0-9]/.test(candidate)) return null;
  if (!/[+\-*/]/.test(candidate)) return null;
  return candidate.replace(/\s+/g, '');
}

/**
 * 将未知输入尽量规范化为 TimerAction。
 */
function normalizeTimerAction(input: unknown): TimerAction | null {
  if (!input || typeof input !== 'object') return null;
  const name = (input as { name?: unknown }).name;
  if (name === 'timer.list') return { name: 'timer.list' };

  if (name === 'timer.cancel') {
    const id = (input as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) return null;
    return { name: 'timer.cancel', id };
  }

  if (name === 'timer.create') {
    const timer = (input as { timer?: unknown }).timer;
    const normalized = normalizeTimerCreateInput(timer);
    if (!normalized) return null;
    return { name: 'timer.create', timer: normalized };
  }

  return null;
}

/**
 * 将未知输入尽量规范化为 TimerCreateInput。
 */
function normalizeTimerCreateInput(input: unknown): TimerCreateInput | null {
  if (!input || typeof input !== 'object') return null;
  const mode = (input as { mode?: unknown }).mode;
  const task = normalizeTimerTask((input as { task?: unknown }).task);
  if (!task) return null;

  if (mode === 'once') {
    const runAt = (input as { runAt?: unknown }).runAt;
    const ts = typeof runAt === 'number' && Number.isFinite(runAt) ? Math.floor(runAt) : null;
    if (ts === null) return null;
    return { mode: 'once', runAt: ts, task };
  }

  if (mode === 'interval') {
    const everyMs = (input as { everyMs?: unknown }).everyMs;
    const ms = typeof everyMs === 'number' && Number.isFinite(everyMs) ? Math.max(50, Math.floor(everyMs)) : null;
    if (ms === null) return null;
    const startAt = (input as { startAt?: unknown }).startAt;
    const start =
      typeof startAt === 'number' && Number.isFinite(startAt) ? Math.floor(startAt) : undefined;
    return { mode: 'interval', everyMs: ms, startAt: start, task };
  }

  return null;
}

/**
 * 将未知输入尽量规范化为 TimerTask。
 */
function normalizeTimerTask(input: unknown): TimerTask | null {
  if (!input || typeof input !== 'object') return null;
  const type = (input as { type?: unknown }).type;
  const message = (input as { message?: unknown }).message;
  const data = (input as { data?: unknown }).data;
  if (typeof message !== 'string') return null;
  if (type === 'log') return { type: 'log', message, data };
  if (type === 'notify') return { type: 'notify', message, data };
  return null;
}

/**
 * 生成用于关联请求的 requestId。
 */
function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * 把 requestId 注入到 task.data，便于在 WS 事件流里定位对应创建结果。
 */
function withRequestId(task: TimerTask, requestId: string): TimerTask {
  const original = task.data;
  if (original && typeof original === 'object' && !Array.isArray(original)) {
    return { ...task, data: { ...(original as Record<string, unknown>), __requestId: requestId } };
  }
  if (original === undefined) return { ...task, data: { __requestId: requestId } };
  return { ...task, data: { value: original, __requestId: requestId } };
}

/**
 * 通过 WS 与定时器服务交互，执行动作并返回可读结果。
 */
async function executeTimerAction(action: TimerAction): Promise<{ ok: boolean; text: string }> {
  const { url, timeoutMs } = getTimerWsConfig();
  const requestId = createRequestId();

  if (typeof globalThis.WebSocket !== 'function') {
    return { ok: false, text: '当前服务端运行时不支持 WebSocket 客户端' };
  }

  const ws = new globalThis.WebSocket(url);
  const startedAt = Date.now();

  const waitFor = <T>(predicate: (message: unknown) => T | null): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`定时器服务超时（${timeoutMs}ms）`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };

      const onMessage = (event: MessageEvent<unknown>) => {
        const data = (event as MessageEvent<unknown>).data;
        const text =
          typeof data === 'string'
            ? data
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString('utf8')
              : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer).toString('utf8')
                : String(data);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }

        const match = predicate(parsed);
        if (match) {
          cleanup();
          resolve(match);
        }
      };

      const onError = () => {
        cleanup();
        reject(new Error('定时器服务连接错误'));
      };

      const onClose = () => {
        cleanup();
        reject(new Error('定时器服务连接已关闭'));
      };

      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`连接定时器服务超时（${timeoutMs}ms）`)), timeoutMs);
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };

    const onOpen = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };

    const onError = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('连接定时器服务失败'));
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });

  try {
    if (action.name === 'timer.list') {
      ws.send(JSON.stringify({ type: 'timer.list' }));
      const list = await waitFor<{ timers: unknown[] }>((msg) => {
        if (!msg || typeof msg !== 'object') return null;
        if ((msg as { type?: unknown }).type !== 'timer.list') return null;
        const timers = (msg as { timers?: unknown }).timers;
        return Array.isArray(timers) ? { timers } : null;
      });
      return { ok: true, text: `当前定时器数量：${list.timers.length}` };
    }

    if (action.name === 'timer.cancel') {
      ws.send(JSON.stringify({ type: 'timer.cancel', id: action.id }));
      const canceled = await waitFor<{ ok: boolean }>((msg) => {
        if (!msg || typeof msg !== 'object') return null;
        if ((msg as { type?: unknown }).type !== 'timer.canceled') return null;
        if ((msg as { id?: unknown }).id !== action.id) return null;
        const ok = (msg as { ok?: unknown }).ok;
        return typeof ok === 'boolean' ? { ok } : null;
      });
      return { ok: canceled.ok, text: canceled.ok ? `已取消定时器：${action.id}` : `取消失败：${action.id}` };
    }

    const timer = action.timer.mode === 'once'
      ? { ...action.timer, task: withRequestId(action.timer.task, requestId) }
      : { ...action.timer, task: withRequestId(action.timer.task, requestId) };

    ws.send(JSON.stringify({ type: 'timer.create', timer }));

    const created = await waitFor<{ id: string; message: string; mode: string; everyMs?: number }>((msg) => {
      if (!msg || typeof msg !== 'object') return null;
      if ((msg as { type?: unknown }).type !== 'timer.created') return null;
      const t = (msg as { timer?: unknown }).timer;
      if (!t || typeof t !== 'object') return null;
      const task = (t as { task?: unknown }).task;
      if (!task || typeof task !== 'object') return null;
      const data = (task as { data?: unknown }).data;
      const rid = data && typeof data === 'object' ? (data as { __requestId?: unknown }).__requestId : undefined;
      if (rid !== requestId) return null;

      const id = (t as { id?: unknown }).id;
      const mode = (t as { mode?: unknown }).mode;
      const message = (task as { message?: unknown }).message;
      const everyMs = (t as { everyMs?: unknown }).everyMs;
      if (typeof id !== 'string' || typeof mode !== 'string' || typeof message !== 'string') return null;
      return { id, mode, message, everyMs: typeof everyMs === 'number' ? everyMs : undefined };
    });

    const cost = Date.now() - startedAt;
    if (created.mode === 'interval') {
      const ms = created.everyMs ?? (action.timer.mode === 'interval' ? action.timer.everyMs : undefined);
      return { ok: true, text: `已创建定时器（每隔 ${ms ?? '?'}ms）：${created.message}（id=${created.id}，${cost}ms）` };
    }
    return { ok: true, text: `已创建一次性定时器：${created.message}（id=${created.id}，${cost}ms）` };
  } finally {
    ws.close();
  }
}

/**
 * 对话接口：POST /api/chat
 * 请求体：{ "messages": [{ "role": "user", "content": "你好" }, ...] }
 * 响应体：{ "output": { ... } }
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { messages?: unknown };
    const messages = coerceMessages(body.messages);
    const latestUser = [...messages].reverse().find((m) => m.role === 'user');
    const relevantMemories = latestUser ? await searchMemories({ query: latestUser.content, limit: 6 }) : [];

    const tools = {
      skill_list: tool({
        description: '列出当前可用 skills（来自本地 src/skills 目录）。',
        inputSchema: jsonSchema(() => ({ type: 'object', additionalProperties: false, properties: {} })),
        execute: async () => ({ skills: await listSkills() })
      }),
      skill_load: tool({
        description: '加载指定 skill 的 SKILL.md 内容（不执行）。',
        inputSchema: jsonSchema<{ name: string }>(
          () => ({
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' } },
            required: ['name']
          }),
          {
            validate: (value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { success: false, error: new Error('skill_load 参数必须是对象') };
              }
              const name = (value as { name?: unknown }).name;
              if (typeof name !== 'string' || !name.trim()) {
                return { success: false, error: new Error('skill_load.name 必须是非空字符串') };
              }
              return { success: true, value: { name: name.trim() } };
            }
          }
        ),
        execute: async (input: { name: string }) => await loadSkillMarkdownByName(input.name)
      }),
      skill_run: tool({
        description: '执行指定 skill（会返回 markdown + 执行结果）。',
        inputSchema: jsonSchema<{ name: string; input?: unknown }>(
          () => ({
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              input: {}
            },
            required: ['name']
          }),
          {
            validate: (value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { success: false, error: new Error('skill_run 参数必须是对象') };
              }
              const v = value as { name?: unknown; input?: unknown };
              if (typeof v.name !== 'string' || !v.name.trim()) {
                return { success: false, error: new Error('skill_run.name 必须是非空字符串') };
              }
              return { success: true, value: { name: v.name.trim(), input: v.input } };
            }
          }
        ),
        execute: async (input: { name: string; input?: unknown }) => await runSkillByName({ name: input.name, input: input.input })
      }),
      timer_create: tool({
        description: '创建一次性或周期性定时器（notify/log）。',
        inputSchema: jsonSchema<TimerCreateInput>(
          () => ({
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['once', 'interval'] },
              runAt: { type: 'number' },
              everyMs: { type: 'number' },
              startAt: { type: 'number' },
              task: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: ['notify', 'log'] },
                  message: { type: 'string' },
                  data: {}
                },
                required: ['type', 'message']
              }
            },
            required: ['mode', 'task']
          }),
          {
            validate: (value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { success: false, error: new Error('timer_create 参数必须是对象') };
              }
              const v = value as Record<string, unknown>;
              const mode = v.mode;
              if (mode !== 'once' && mode !== 'interval') {
                return { success: false, error: new Error('timer_create.mode 必须是 once 或 interval') };
              }

              const task = v.task;
              if (!task || typeof task !== 'object' || Array.isArray(task)) {
                return { success: false, error: new Error('timer_create.task 必须是对象') };
              }
              const taskObj = task as Record<string, unknown>;
              const taskType = taskObj.type;
              const message = taskObj.message;
              if (taskType !== 'notify' && taskType !== 'log') {
                return { success: false, error: new Error('timer_create.task.type 必须是 notify 或 log') };
              }
              if (typeof message !== 'string' || !message.trim()) {
                return { success: false, error: new Error('timer_create.task.message 必须是非空字符串') };
              }

              const normalizedTask: TimerTask = taskObj.data === undefined
                ? { type: taskType, message: message.trim() }
                : { type: taskType, message: message.trim(), data: taskObj.data };

              if (mode === 'once') {
                const runAt = v.runAt;
                if (typeof runAt !== 'number' || !Number.isFinite(runAt)) {
                  return { success: false, error: new Error('timer_create.runAt 必须是有限数字') };
                }
                return { success: true, value: { mode: 'once', runAt, task: normalizedTask } };
              }

              const everyMs = v.everyMs;
              if (typeof everyMs !== 'number' || !Number.isFinite(everyMs)) {
                return { success: false, error: new Error('timer_create.everyMs 必须是有限数字') };
              }
              const startAt = v.startAt;
              if (startAt !== undefined && (typeof startAt !== 'number' || !Number.isFinite(startAt))) {
                return { success: false, error: new Error('timer_create.startAt 必须是有限数字') };
              }
              return {
                success: true,
                value: startAt === undefined
                  ? { mode: 'interval', everyMs, task: normalizedTask }
                  : { mode: 'interval', everyMs, startAt, task: normalizedTask }
              };
            }
          }
        ),
        execute: async (input: TimerCreateInput) => executeTimerAction({ name: 'timer.create', timer: input })
      }),
      timer_cancel: tool({
        description: '按 id 取消定时器。',
        inputSchema: jsonSchema<{ id: string }>(
          () => ({
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string' } },
            required: ['id']
          }),
          {
            validate: (value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { success: false, error: new Error('timer_cancel 参数必须是对象') };
              }
              const id = (value as { id?: unknown }).id;
              if (typeof id !== 'string' || !id.trim()) {
                return { success: false, error: new Error('timer_cancel.id 必须是非空字符串') };
              }
              return { success: true, value: { id: id.trim() } };
            }
          }
        ),
        execute: async (input: { id: string }) => executeTimerAction({ name: 'timer.cancel', id: input.id })
      }),
      timer_list: tool({
        description: '列出当前定时器数量（用于确认是否存在）。',
        inputSchema: jsonSchema(() => ({ type: 'object', additionalProperties: false, properties: {} })),
        execute: async () => executeTimerAction({ name: 'timer.list' })
      }),
      memory_search: tool({
        description: '按 query 检索相关长期记忆条目。',
        inputSchema: jsonSchema<{ query: string; limit?: number }>(
          () => ({
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' }
            },
            required: ['query']
          }),
          {
            validate: (value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { success: false, error: new Error('memory_search 参数必须是对象') };
              }
              const v = value as { query?: unknown; limit?: unknown };
              if (typeof v.query !== 'string' || !v.query.trim()) {
                return { success: false, error: new Error('memory_search.query 必须是非空字符串') };
              }
              const limit = v.limit;
              if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) {
                return { success: false, error: new Error('memory_search.limit 必须是有限数字') };
              }
              return {
                success: true,
                value: limit === undefined ? { query: v.query.trim() } : { query: v.query.trim(), limit }
              };
            }
          }
        ),
        execute: async (input: { query: string; limit?: number }) => ({
          memories: await searchMemories({ query: input.query, limit: input.limit })
        })
      }),
      memory_add: tool({
        description: '写入一条长期记忆（仅限稳定偏好/长期目标/固定事实/约束）。',
        inputSchema: jsonSchema<{ text: string; tags?: string[] }>(
          () => ({
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['text']
          }),
          {
            validate: (value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { success: false, error: new Error('memory_add 参数必须是对象') };
              }
              const v = value as { text?: unknown; tags?: unknown };
              if (typeof v.text !== 'string' || !v.text.trim()) {
                return { success: false, error: new Error('memory_add.text 必须是非空字符串') };
              }
              if (v.tags !== undefined) {
                if (!Array.isArray(v.tags) || !v.tags.every((t) => typeof t === 'string' && t.trim())) {
                  return { success: false, error: new Error('memory_add.tags 必须是字符串数组') };
                }
              }
              const tags = Array.isArray(v.tags) ? v.tags.map((t) => t.trim()).filter(Boolean) : undefined;
              return { success: true, value: tags?.length ? { text: v.text.trim(), tags } : { text: v.text.trim() } };
            }
          }
        ),
        execute: async (input: { text: string; tags?: string[] }) => ({
          memory: await addMemory({ text: input.text, tags: input.tags })
        })
      })
    };

    const { baseURL, apiKey, model } = getOpenAICompatibleConfig(req);
    if (!baseURL || !apiKey) {
      return NextResponse.json(
        {
          error:
            '缺少环境变量：OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY，或 AI_GATEWAY_BASE_URL / AI_GATEWAY_API_KEY（服务端运行时读取）'
        },
        { status: 500 }
      );
    }

    const provider = createOpenAICompatible({
      name: 'openai-compatible-gateway',
      baseURL,
      apiKey
    });

    const chatModel = provider(model);

    const result = await generateText({
      model: chatModel,
      tools,
      stopWhen: stepCountIs(8),
      messages: [
        { role: 'system', content: buildCanvasSystemPrompt() } as ModelMessage,
        ...(relevantMemories.length
          ? ([{ role: 'system', content: buildMemoryContextPrompt(relevantMemories) }] as ModelMessage[])
          : []),
        ...messages
      ] as ModelMessage[]
    });

    const usedSkills = extractUsedSkillNames(result);
    const parsed = parseChatOutput(result.text);
    if (parsed.type === 'action') {
      const executed = await executeTimerAction(parsed.action);
      const text = appendUsedSkills(
        parsed.replyText?.trim()
        ? `${parsed.replyText.trim()}\n${executed.text}`
        : executed.text,
        usedSkills
      );
      if (latestUser) await autoRememberFromUserText({ model: chatModel, userText: latestUser.content });
      return NextResponse.json({ output: { type: 'text', text } satisfies ChatOutput });
    }

    const autoExpr = latestUser ? extractPureCalcExpression(latestUser.content) : null;
    if (!usedSkills.length && parsed.type === 'text' && autoExpr) {
      const ran = await runSkillByName({ name: 'calc', input: { expr: autoExpr } });
      const value = (ran.result as { value?: unknown } | undefined)?.value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (latestUser) await autoRememberFromUserText({ model: chatModel, userText: latestUser.content });
        return NextResponse.json({
          output: { type: 'text', text: appendUsedSkills(String(value), ['calc']) } satisfies ChatOutput
        });
      }
    }

    if (latestUser) await autoRememberFromUserText({ model: chatModel, userText: latestUser.content });
    if (parsed.type === 'text') {
      return NextResponse.json({ output: { type: 'text', text: appendUsedSkills(parsed.text, usedSkills) } satisfies ChatOutput });
    }
    return NextResponse.json({ output: parsed satisfies ChatOutput });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
