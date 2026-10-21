/**
 * 构建前拉取 BiRefNet 高精度模型到 public/models/，使网页版与线上一致同源托管。
 * - 不进 git（避免仓库膨胀 210MB）；由 CI/Netlify 构建时下载，或本地开发自行跑一次。
 * - 文件已存在则跳过（除非设置 FORCE=1）。
 * - 多源兜底：hf-mirror.com（含 huggingface.co 回退）。
 *
 * 用法：node scripts/fetch-model.mjs
 */
import { createWriteStream, existsSync, statSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public/models/birefnet-lite-web.onnx')
const URLS = [
  'https://hf-mirror.com/YheChen/bgremover-onnx/resolve/main/birefnet-lite-web.onnx',
  'https://huggingface.co/YheChen/bgremover-onnx/resolve/main/birefnet-lite-web.onnx',
]

const EXPECTED = 210_363_856 // 已知大小，下载完校验
const force = process.env.FORCE === '1'

mkdirSync(dirname(OUT), { recursive: true })

async function download(url) {
  console.log('[fetch-model] GET', url)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  const tmp = OUT + '.part'
  const ws = createWriteStream(tmp)
  for await (const chunk of res.body) {
    received += chunk.length
    ws.write(chunk)
    if (received % (20 * 1024 * 1024) < 65536)
      console.log(`[fetch-model] ${(received / 1048576).toFixed(0)}MB / ${(total / 1048576).toFixed(0)}MB`)
  }
  await new Promise((r) => ws.end(r))
  // 原子替换
  const { renameSync } = await import('node:fs')
  renameSync(tmp, OUT)
  return received
}

if (existsSync(OUT) && !force) {
  const sz = statSync(OUT).size
  if (sz >= EXPECTED * 0.9) {
    console.log(`[fetch-model] 已存在（${(sz / 1048576).toFixed(0)}MB），跳过。FORCE=1 可强制重下。`)
    process.exit(0)
  }
  console.log(`[fetch-model] 文件异常（${(sz / 1048576).toFixed(0)}MB），重新下载。`)
}

let lastErr
for (const u of URLS) {
  try {
    const sz = await download(u)
    if (sz < EXPECTED * 0.9) throw new Error(`下载不完整 ${sz} bytes`)
    console.log(`[fetch-model] 完成：${(sz / 1048576).toFixed(0)}MB -> ${OUT}`)
    process.exit(0)
  } catch (e) {
    lastErr = e
    console.warn('[fetch-model] 源失败，尝试下一个：', e.message)
  }
}
// 所有源失败时「非致命」退出：保证站点其余功能仍能正常部署；
// 此时 /models 缺模型，BiRefNet 高精度模式会在运行时回退到 huggingface.co（中国网络可能失败）。
console.warn('[fetch-model] ⚠️ 所有下载源失败，跳过模型内嵌。BiRefNet 高精度模式将依赖运行时回退源。')
process.exit(0)
