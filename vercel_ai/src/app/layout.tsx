import type { ReactNode } from 'react';

export const metadata = {
  title: 'AI SDK Chat Demo'
};

/**
 * Next.js App Router 根布局。
 */
export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="zh-CN">
      <body style={{ fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' }}>
        {children}
      </body>
    </html>
  );
}

