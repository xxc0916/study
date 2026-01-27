import { generateText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

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
 */
function coerceMessages(input: unknown): ModelMessage[] {
  if (!Array.isArray(input)) return [{ role: 'user', content: '你好' }];

  const messages: ModelMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (typeof role !== 'string' || typeof content !== 'string') continue;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    messages.push({ role, content });
  }

  return messages.length ? messages : [{ role: 'user', content: '你好' }];
}

/**
 * 对话接口：POST /api/chat
 * 请求体：{ "messages": [{ "role": "user", "content": "你好" }, ...] }
 * 响应体：{ "text": "模型回复" }
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
      messages
    });

    return NextResponse.json({ text: result.text });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

