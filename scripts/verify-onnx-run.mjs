import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-web'

const buf = readFileSync('public/models/birefnet-lite-512.onnx')
ort.env.wasm.numThreads = 1
const session = await ort.InferenceSession.create(new Uint8Array(buf), {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
})
const S = 512
const input = new Float32Array(3 * S * S)
const feeds = {}
feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, S, S])
const t0 = Date.now()
const out = await session.run(feeds)
const name = session.outputNames[0]
const dims = out[name].dims
console.log('[run] 推理成功，输出形状 = ' + JSON.stringify(dims) + '，耗时 ' + (Date.now() - t0) + 'ms')
if (dims[2] === S && dims[3] === S) {
  console.log('[run] 确认为 512 模型（非 OOM 的 1024）')
} else {
  console.log('[run] 输出非 512，请检查模型')
}
