/**
 * 带字节进度的 fetch。加载页的进度条要显示真实下载进度，但 MediaPipe 的
 * createFromOptions 自己 fetch 模型文件时不吐进度——所以这里手动把模型文件
 * 下载下来，量出真实字节数，再用 modelAssetBuffer 喂给它（不会重复下载）。
 */
export async function fetchWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0

  if (!res.body) {
    const buf = await res.arrayBuffer()
    onProgress(buf.byteLength, total || buf.byteLength)
    return buf
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress(loaded, total)
  }

  const out = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out.buffer
}
