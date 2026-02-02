import { generateText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { NextResponse } from 'next/server';

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

/**
 * 从环境变量读取 OpenAI-compatible 网关配置。
 */
function getOpenAICompatibleConfig(): { baseURL: string; apiKey: string; model: string } {
  const baseURL = (process.env.OPENAI_COMPATIBLE_BASE_URL ?? '').trim();
  const apiKey = (process.env.OPENAI_COMPATIBLE_API_KEY ?? '').trim();
  const model = (process.env.OPENAI_COMPATIBLE_MODEL ?? 'gemini-2.5-pro').trim();

  return { baseURL, apiKey, model };
}

/**
 * 将任意输入尽量标准化为 ModelMessage[]，避免接口参数不符合预期。
 * 为避免客户端注入 system 指令，这里仅接受 user/assistant 两类角色。
 */
function coerceMessages(input: unknown): ModelMessage[] {
  if (!Array.isArray(input)) return [{ role: 'user', content: '你好' }];

  const messages: ModelMessage[] = [];
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
function parseChatOutput(raw: string): ChatOutput {
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

    return { type: 'text', text: raw };
  } catch {
    return { type: 'text', text: raw };
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

    const { baseURL, apiKey, model } = getOpenAICompatibleConfig();
    if (!baseURL || !apiKey) {
      return NextResponse.json(
        {
          error:
            '缺少环境变量：OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY（服务端运行时读取）'
        },
        { status: 500 }
      );
    }

    const provider = createOpenAICompatible({
      name: 'openai-compatible-gateway',
      baseURL,
      apiKey
    });

    const result = await generateText({
      model: provider(model),
      messages: [{ role: 'system', content: buildCanvasSystemPrompt() }, ...messages]
    });

    const output = parseChatOutput(result.text);
    return NextResponse.json({ output });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
