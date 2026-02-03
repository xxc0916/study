import fs from 'node:fs/promises';
import path from 'node:path';

export type MemoryItem = {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

type MemorySnapshot = {
  items: MemoryItem[];
  byId: Map<string, MemoryItem>;
};

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.data');
const DEFAULT_FILE_PATH = path.join(DEFAULT_DATA_DIR, 'memory.jsonl');

let snapshot: MemorySnapshot | null = null;
let loading: Promise<MemorySnapshot> | null = null;

function now(): number {
  return Date.now();
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function containsSecretLike(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes('api_key') || t.includes('apikey') || t.includes('secret') || t.includes('token')) return true;
  if (t.includes('bearer ')) return true;
  if (/vck_[a-z0-9]{10,}/i.test(text)) return true;
  if (/sk-[a-z0-9]{10,}/i.test(text)) return true;
  return false;
}

async function ensureLoaded(filePath = DEFAULT_FILE_PATH): Promise<MemorySnapshot> {
  if (snapshot) return snapshot;
  if (loading) return loading;

  loading = (async () => {
    const items: MemoryItem[] = [];
    const byId = new Map<string, MemoryItem>();
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (!parsed || typeof parsed !== 'object') continue;
          const id = (parsed as { id?: unknown }).id;
          const text = (parsed as { text?: unknown }).text;
          const tags = (parsed as { tags?: unknown }).tags;
          const createdAt = (parsed as { createdAt?: unknown }).createdAt;
          const updatedAt = (parsed as { updatedAt?: unknown }).updatedAt;
          if (typeof id !== 'string' || typeof text !== 'string') continue;
          const normalized = normalizeText(text);
          const item: MemoryItem = {
            id,
            text: normalized,
            tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
            createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : now(),
            updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : now()
          };
          if (containsSecretLike(item.text)) continue;
          items.push(item);
          byId.set(item.id, item);
        } catch {
          continue;
        }
      }
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }

    snapshot = { items, byId };
    loading = null;
    return snapshot;
  })();

  return loading;
}

export async function addMemory(input: { text: string; tags?: string[] }, filePath = DEFAULT_FILE_PATH): Promise<MemoryItem | null> {
  const loaded = await ensureLoaded(filePath);
  const text = normalizeText(input.text);
  if (!text) return null;
  if (containsSecretLike(text)) return null;

  const existing = loaded.items.find((m) => m.text === text);
  if (existing) {
    existing.updatedAt = now();
    return existing;
  }

  const item: MemoryItem = {
    id: createId(),
    text,
    tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : [],
    createdAt: now(),
    updatedAt: now()
  };

  loaded.items.push(item);
  loaded.byId.set(item.id, item);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(item)}\n`, 'utf8');

  return item;
}

export async function listMemories(filePath = DEFAULT_FILE_PATH): Promise<MemoryItem[]> {
  const loaded = await ensureLoaded(filePath);
  return loaded.items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

function tokenize(query: string): string[] {
  const q = normalizeText(query);
  if (!q) return [];
  const ascii = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const cjk = q.replace(/\s+/g, '').split('').filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  const merged = [...ascii, ...cjk];
  return Array.from(new Set(merged)).slice(0, 32);
}

export async function searchMemories(
  input: { query: string; limit?: number },
  filePath = DEFAULT_FILE_PATH
): Promise<MemoryItem[]> {
  const loaded = await ensureLoaded(filePath);
  const tokens = tokenize(input.query);
  if (tokens.length === 0) return [];

  const scored = loaded.items
    .map((m) => {
      const hay = m.text.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (!t) continue;
        if (hay.includes(t)) score += 2;
      }
      const ageHours = Math.max(0, (now() - m.updatedAt) / 3600000);
      score += 1 / (1 + ageHours / 24);
      return { m, score };
    })
    .filter((x) => x.score > 1.5)
    .sort((a, b) => b.score - a.score);

  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit)) : 6;
  return scored.slice(0, limit).map((x) => x.m);
}

