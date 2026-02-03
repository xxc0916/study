import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ path?: string[] }> };

function joinUrlPath(basePath: string, extraPath: string): string {
  const a = basePath.replace(/\/+$/, '');
  const b = extraPath.replace(/^\/+/, '');
  if (!a) return `/${b}`;
  if (!b) return a.startsWith('/') ? a : `/${a}`;
  return `${a.startsWith('/') ? a : `/${a}`}/${b}`;
}

function buildUpstreamUrl(req: Request, pathSegments: string[]): URL {
  const upstreamBase = (process.env.AI_GATEWAY_BASE_URL ?? '').trim();
  if (!upstreamBase) {
    throw new Error('缺少环境变量：AI_GATEWAY_BASE_URL');
  }

  const base = new URL(upstreamBase);
  const extra = pathSegments.join('/');
  base.pathname = joinUrlPath(base.pathname, extra);
  base.search = new URL(req.url).search;
  return base;
}

function buildUpstreamHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');

  const upstreamKey = (process.env.AI_GATEWAY_API_KEY ?? '').trim();
  if (upstreamKey) {
    headers.set('authorization', `Bearer ${upstreamKey}`);
  }

  return headers;
}

async function proxy(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { path = [] } = await ctx.params;
    const upstreamUrl = buildUpstreamUrl(req, path);
    const headers = buildUpstreamHeaders(req);

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'manual'
    });

    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('content-encoding');
    resHeaders.delete('content-length');

    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  return proxy(req, ctx);
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  return proxy(req, ctx);
}

export async function PUT(req: Request, ctx: RouteContext): Promise<Response> {
  return proxy(req, ctx);
}

export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
  return proxy(req, ctx);
}

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  return proxy(req, ctx);
}
