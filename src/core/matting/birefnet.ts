/**
 * BiRefNet-lite 本地推理（浏览器 / 扩展沙箱通用）。
 *
 * 模型：YheChen/bgremover-onnx —— BiRefNet_lite（Swin-Tiny）的 ONNX 导出，
 *       MIT 协议（继承自 ZhengPeng7/BiRefNet），作者明确「cleared for commercial use」。
 *       已重写 DeformConv 为 GridSample 等价实现，可在 onnxruntime-web 的 wasm EP 跑通，
 *       无需 WebGPU。约 210MB fp32，首次从本站自托管域名下载（/models 同源，或线上域名跨域），
 *       之后走 Cache Storage 本地缓存，离线也能用。huggingface.co 仅作最后兜底。
 *
 * 推理引擎：onnxruntime-web（与 @imgly 同源，扩展沙箱构建里已别名到 ort.min.mjs）。
 *       wasm 从 jsDelivr CDN 加载（CORS *）。
 *
 * I/O（与上游 README 一致）：
 *   input  : [1,3,1024,1024] float32，RGB，ImageNet 归一化，拉伸(非等比)到 1024²
 *   output : [1,1,1024,1024] float32 logits，需自行 sigmoid 得到 [0,1] alpha
 */

// 模型下载源（按优先级）。hf-mirror.com 实测会 308 跳回 huggingface.co，jsDelivr 未托管该模型，
// 故改为本站自托管：网页版同源 /models/，扩展沙箱走线上域名。huggingface.co 仅作最后兜底。
const MODEL_LOCAL = '/models/birefnet-lite-web.onnx' // 网页版同源（本地预览与线上均可）
const MODEL_NETLIFY = 'https://design-workbench.netlify.app/models/birefnet-lite-web.onnx' // 扩展沙箱跨域
const MODEL_HF = 'https://huggingface.co/YheChen/bgremover-onnx/resolve/main/birefnet-lite-web.onnx'
const ORT_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/'
const SIZE = 1024

// 扩展环境（chrome-extension://）无法用同源相对路径，走线上域名；网页版优先同源路径。
function getModelSources(): string[] {
  if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
    return [MODEL_NETLIFY, MODEL_HF]
  }
  return [MODEL_LOCAL, MODEL_NETLIFY, MODEL_HF]
}
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

type ProgressCb = (key: string, current: number, total: number) => void

/** 给各阶段抛出的错误加上阶段前缀，便于远程定位问题 */
function phase<T>(name: string, p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    const detail =
      e instanceof Error
        ? e.message
        : typeof e === 'string'
          ? e
          : (() => {
              try {
                return JSON.stringify(e)
              } catch {
                return String(e)
              }
            })()
    throw new Error(`[${name}] ${detail}`)
  })
}

async function fetchWithProgress(url: string, onProgress: ProgressCb): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`模型下载失败（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length') || 0)
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.length
      onProgress('fetch:model', received, total || received)
    }
  }
  const buf = new Uint8Array(received)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.length
  }
  return buf
}

function decodeToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  return createImageBitmap(file).then((bmp) => {
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close?.()
    return c
  })
}

// 模型 210MB，HTTP 缓存对大文件不可靠（实测 Chrome 不缓存），用 Cache Storage 显式缓存
const CACHE_NAME = 'birefnet-model-v1'

async function getModelData(onProgress: ProgressCb): Promise<Uint8Array> {
  // 1) 先查 Cache Storage（HTTP 缓存对 210MB 大文件不可靠，自己存一份）
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME)
      for (const url of getModelSources()) {
        const hit = await cache.match(url)
        if (hit) {
          onProgress('fetch:model', 1, 1)
          console.info('[birefnet] 命中本地缓存，跳过下载')
          return new Uint8Array(await hit.arrayBuffer())
        }
      }
    } catch {
      /* 隐私模式 / 沙箱 opaque origin 下可能不可用，降级为直接下载 */
    }
  }
  // 2) 逐个源尝试下载，命中即止
  let lastErr: unknown
  for (const url of getModelSources()) {
    try {
      console.info('[birefnet] 尝试从下载模型：', url)
      const data = await fetchWithProgress(url, onProgress)
      if (typeof caches !== 'undefined') {
        try {
          const cache = await caches.open(CACHE_NAME)
          await cache.put(url, new Response(data as unknown as BodyInit))
        } catch {
          /* 写缓存失败不影响本次使用 */
        }
      }
      return data
    } catch (e) {
      lastErr = e
      console.warn('[birefnet] 该下载源失败，尝试下一个：', e)
    }
  }
  throw new Error('所有模型下载源均不可用，请检查网络或代理设置后重试')
}

export async function runBiRefNet(file: Blob, onProgress: ProgressCb): Promise<Blob> {
  onProgress('fetch:model', 0, 0)
  const modelData = await phase('下载模型', getModelData(onProgress))

  const ortMod = (await import('onnxruntime-web')) as unknown as { default?: any }
  const ort: any = ortMod.default ?? ortMod
  if (!ort?.InferenceSession) throw new Error('[初始化] onnxruntime-web 加载失败')
  // 单线程，避免依赖 SharedArrayBuffer（网页版与扩展沙箱均未开启跨源隔离）
  ort.env.wasm.wasmPaths = ORT_WASM_PATH
  ort.env.wasm.numThreads = 1

  onProgress('compute', 0, 1)
  const session: any = await phase(
    '创建推理会话',
    ort.InferenceSession.create(modelData as Uint8Array, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }),
  )

  const src = await decodeToCanvas(file)
  const W = src.width
  const H = src.height
  const srcData = src.getContext('2d')!.getImageData(0, 0, W, H).data

  // 预处理：拉伸到 1024² + ImageNet 归一化，HWC -> CHW
  const prep = document.createElement('canvas')
  prep.width = SIZE
  prep.height = SIZE
  const pctx = prep.getContext('2d')!
  pctx.drawImage(src, 0, 0, SIZE, SIZE)
  const pdata = pctx.getImageData(0, 0, SIZE, SIZE).data
  const input = new Float32Array(3 * SIZE * SIZE)
  for (let i = 0, j = 0; i < pdata.length; i += 4, j++) {
    input[j] = (pdata[i] / 255 - MEAN[0]) / STD[0]
    input[j + SIZE * SIZE] = (pdata[i + 1] / 255 - MEAN[1]) / STD[1]
    input[j + 2 * SIZE * SIZE] = (pdata[i + 2] / 255 - MEAN[2]) / STD[2]
  }

  const feeds: Record<string, any> = {}
  feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE])
  const out: any = await phase('AI 推理', session.run(feeds))
  const logits = (out[session.outputNames[0]].data as Float32Array)

  // 后处理：sigmoid -> alpha，拉伸回原图尺寸
  const alpha = document.createElement('canvas')
  alpha.width = SIZE
  alpha.height = SIZE
  const actx = alpha.getContext('2d')!
  const aimg = actx.createImageData(SIZE, SIZE)
  const n = SIZE * SIZE
  for (let k = 0; k < n; k++) {
    const s = 1 / (1 + Math.exp(-logits[k]))
    const v = Math.round(s * 255)
    aimg.data[k * 4] = v
    aimg.data[k * 4 + 1] = v
    aimg.data[k * 4 + 2] = v
    aimg.data[k * 4 + 3] = 255
  }
  actx.putImageData(aimg, 0, 0)

  const alphaUp = document.createElement('canvas')
  alphaUp.width = W
  alphaUp.height = H
  alphaUp.getContext('2d')!.drawImage(alpha, 0, 0, W, H)
  const amask = alphaUp.getContext('2d')!.getImageData(0, 0, W, H).data

  // 合成：原图 RGB + 模型 alpha
  const out_c = document.createElement('canvas')
  out_c.width = W
  out_c.height = H
  const octx = out_c.getContext('2d')!
  const oimg = octx.createImageData(W, H)
  const px = W * H
  for (let p = 0; p < px; p++) {
    oimg.data[p * 4] = srcData[p * 4]
    oimg.data[p * 4 + 1] = srcData[p * 4 + 1]
    oimg.data[p * 4 + 2] = srcData[p * 4 + 2]
    oimg.data[p * 4 + 3] = amask[p * 4] // 用红通道作 alpha
  }
  octx.putImageData(oimg, 0, 0)

  onProgress('pack', 1, 1)
  return await new Promise<Blob>((resolve, reject) =>
    out_c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('合成透明 PNG 失败'))),
      'image/png',
    ),
  )
}
