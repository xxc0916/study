function clampMaxChars(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 4000;
  return Math.max(1, Math.min(20000, Math.floor(n)));
}

export async function run(input) {
  const url = input?.url;
  if (typeof url !== 'string' || !url.trim()) throw new Error('http_get 需要输入 { url: string }');

  const parsed = new globalThis.URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅允许 http/https URL');
  }

  const maxChars = clampMaxChars(input?.maxChars);

  const res = await globalThis.fetch(parsed, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': 'vercel_ai-skill-loader/1.0' }
  });

  const contentType = res.headers.get('content-type') ?? undefined;
  const text = await res.text();
  const textPreview = text.length > maxChars ? text.slice(0, maxChars) : text;

  return { status: res.status, contentType, textPreview };
}
