import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { startTimerWsServer } from './timerWsServer';

/**
 * 启动开发环境：Next.js dev server + 定时器 WebSocket 服务。
 */
async function main(): Promise<void> {
  const ws = startTimerWsServer();

  const require = createRequire(import.meta.url);
  const nextBin = require.resolve('next/dist/bin/next');

  const child = spawn(process.execPath, [nextBin, 'dev'], {
    stdio: 'inherit',
    env: process.env
  });

  const shutdown = async (code = 0) => {
    try {
      child.kill('SIGTERM');
    } finally {
      await ws.close();
      process.exit(code);
    }
  };

  child.on('exit', (code) => void shutdown(code ?? 0));
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

void main();

