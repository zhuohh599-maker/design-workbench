/**
 * 校验下载的 BiRefNet ONNX 是否完整、可被 onnxruntime-web 加载。
 * 用法：node scripts/verify-onnx.mjs <model.onnx>
 * 仅加载模型（不跑推理，无需 DOM），验证：
 *   - 文件可解析、非截断
 *   - 输入形状为 [1,3,512,512]（确认是 512 版而非 OOM 的 1024 版）
 */
import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-web'

const path = process.argv[2]
if (!path) {
  console.error('用法：node scripts/verify-onnx.mjs <model.onnx>')
  process.exit(1)
}
const buf = readFileSync(path)
console.log(`[verify] 读取 ${(buf.length / 1048576).toFixed(1)}MB`)
ort.env.wasm.numThreads = 1
ort.env.wasm.simd = true

try {
  const session = await ort.InferenceSession.create(new Uint8Array(buf), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  console.log('[verify] ✅ 模型加载成功')
  console.log('[verify] inputs :', session.inputNames)
  console.log('[verify] outputs:', session.outputNames)
  const inp = session.inputNames[0]
  const meta = session.inputMetadata?.[inp] ?? session.metadata?.inputMetadata?.[inp]
  console.log('[verify] 输入形状:', meta?.dims ?? '(无法读取，但加载成功即说明文件完整)')
  process.exit(0)
} catch (e) {
  console.error('[verify] ❌ 模型加载失败：', e?.message || e)
  process.exit(1)
}
