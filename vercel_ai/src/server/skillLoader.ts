import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export type SkillManifest = {
  name: string;
  description: string;
  entry?: string;
};

export type SkillListItem = {
  name: string;
  description: string;
};

export type SkillRunResult = {
  name: string;
  description: string;
  markdown: string;
  result?: unknown;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.join(moduleDir, '..', 'skills');
const runnerPath = path.join(moduleDir, 'skillRunner.mjs');

async function readTextFile(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(dir: string): Promise<SkillManifest> {
  const manifestPath = path.join(dir, 'skill.json');
  const raw = await readTextFile(manifestPath);
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('skill.json 无效');

  const name = (parsed as { name?: unknown }).name;
  const description = (parsed as { description?: unknown }).description;
  const entry = (parsed as { entry?: unknown }).entry;

  if (typeof name !== 'string' || !name.trim()) throw new Error('skill.json 缺少 name');
  if (typeof description !== 'string' || !description.trim()) throw new Error('skill.json 缺少 description');
  if (entry !== undefined && (typeof entry !== 'string' || !entry.trim())) throw new Error('skill.json entry 无效');

  return { name: name.trim(), description: description.trim(), entry: typeof entry === 'string' ? entry.trim() : undefined };
}

async function readSkillMarkdown(dir: string): Promise<string> {
  const mdPath = path.join(dir, 'SKILL.md');
  return await readTextFile(mdPath);
}

async function listSkillDirs(): Promise<string[]> {
  const exists = await fileExists(skillsRoot);
  if (!exists) return [];
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(skillsRoot, e.name));
}

export async function listSkills(): Promise<SkillListItem[]> {
  const dirs = await listSkillDirs();
  const items: SkillListItem[] = [];
  for (const dir of dirs) {
    try {
      const manifest = await readManifest(dir);
      items.push({ name: manifest.name, description: manifest.description });
    } catch {
      continue;
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkillMarkdownByName(name: string): Promise<{ name: string; description: string; markdown: string }> {
  const target = name.trim();
  if (!target) throw new Error('skill name 不能为空');
  const dir = path.join(skillsRoot, target);
  const manifest = await readManifest(dir);
  const markdown = await readSkillMarkdown(dir);
  return { name: manifest.name, description: manifest.description, markdown };
}

export async function runSkillByName(input: { name: string; input?: unknown }): Promise<SkillRunResult> {
  const target = input.name.trim();
  if (!target) throw new Error('skill name 不能为空');

  const dir = path.join(skillsRoot, target);
  const manifest = await readManifest(dir);
  const markdown = await readSkillMarkdown(dir);

  if (!manifest.entry) return { name: manifest.name, description: manifest.description, markdown };

  const entryPath = path.join(dir, manifest.entry);
  const result = await runEntryInSubprocess({ entryPath, input: input.input });
  return { name: manifest.name, description: manifest.description, markdown, result };
}

async function runEntryInSubprocess(input: { entryPath: string; input: unknown }): Promise<unknown> {
  const child = spawn(process.execPath, [runnerPath, input.entryPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const payload = JSON.stringify({ input: input.input });
  child.stdin.write(payload);
  child.stdin.end();

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });

  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

  let parsed: unknown = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    const hint = stderr ? `; stderr=${stderr.slice(0, 300)}` : '';
    throw new Error(`skill 运行输出不是 JSON${hint}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    const hint = stderr ? `; stderr=${stderr.slice(0, 300)}` : '';
    throw new Error(`skill 运行输出格式错误${hint}`);
  }

  if (exitCode === 0 && (parsed as { ok?: unknown }).ok === true) {
    return (parsed as { result?: unknown }).result;
  }

  const message = (parsed as { error?: unknown }).error;
  const errText = typeof message === 'string' && message.trim() ? message.trim() : 'skill 执行失败';
  const hint = stderr ? `; stderr=${stderr.slice(0, 300)}` : '';
  throw new Error(`${errText}${hint}`);
}
