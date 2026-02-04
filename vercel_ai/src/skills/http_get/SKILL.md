# http_get

用途：从一个 http/https URL 获取内容，返回文本预览（用于快速查看网页/接口响应）。

输入：
- url: string（仅允许 http/https）
- maxChars?: number（默认 4000，最大 20000）

输出：
- { status: number, contentType?: string, textPreview: string }
