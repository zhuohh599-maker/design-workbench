/**
 * 沙箱页推理脚本（配合 extension/sandbox.html 使用）。
 * - removeBackground 走 @imgly 默认 CDN publicPath：首次联网下载模型，
 *   之后由浏览器 HTTP 缓存命中，无需重复下载。
 * - 本页 CSP（manifest sandbox 字段）允许 unsafe-eval / blob: / CDN 脚本，
 *   因此 imgly 的 ort 加载器动态 import 与 ndarray 的 new Function 都能正常执行。
 * - CDN 返回 access-control-allow-origin: *，null origin 亦可直接 fetch。
 * 与侧边栏的通信协议：
 *   收到 { type:'matting-run', id, file }
 *   回传 { id, type:'matting-progress', key, current, total }
 *        { id, type:'matting-result', blob }
 *        { id, type:'matting-error', message }
 */
import { removeBackground } from '@imgly/background-removal'
import { runBiRefNet } from '../src/core/matting/birefnet'

window.addEventListener('message', (ev: MessageEvent) => {
  const d = ev.data as { type?: string; id?: number; file?: Blob; model?: string } | null
  if (!d || d.type !== 'matting-run' || !d.file || typeof d.id !== 'number') return
  const id = d.id
  const model = d.model || 'standard'
  const reply = (msg: Record<string, unknown>, transfer?: Transferable[]) => {
    ;(ev.source as Window | null)?.postMessage({ ...msg, id }, '*', transfer ?? [])
  }
  const onProgress = (key: string, current: number, total: number) =>
    reply({ type: 'matting-progress', key, current, total })
  const job =
    model === 'birefnet'
      ? runBiRefNet(d.file, onProgress)
      : removeBackground(d.file, {
          // 固定 wasm 设备：避免引入 65MB 的 webgpu bundle 分支；wasm 在沙箱内从 CDN 加载。
          device: 'wasm',
          output: { format: 'image/png' },
          progress: onProgress,
        })
  try {
    job
      .then((blob: Blob) => reply({ type: 'matting-result', blob }, [blob]))
      .catch((e: unknown) =>
        reply({ type: 'matting-error', message: (e as Error)?.message ?? String(e) }),
      )
  } catch (e) {
    reply({ type: 'matting-error', message: (e as Error)?.message ?? String(e) })
  }
})
