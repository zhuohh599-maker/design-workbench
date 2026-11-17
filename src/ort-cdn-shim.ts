/**
 * 绿幕测试单文件构建专用 shim：运行时直接从 jsDelivr 加载 onnxruntime-web，
 * 避免 ORT 的 wasm/.mjs 被 Vite 打成外部资源（单文件 HTML 在 file:// 下引用不到）。
 * birefnet.ts 的 wasmPaths 本来就指向同一 CDN 版本，保持一致。
 */
const mod: any = await import(
  /* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.bundle.min.mjs'
)
export default mod.default ?? mod
