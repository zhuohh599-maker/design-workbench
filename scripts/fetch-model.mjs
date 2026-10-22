/**
 * 构建前拉取 BiRefNet 高精度模型到 public/models/，使网页版与线上一致同源托管。
 * - 不进 git（避免仓库膨胀 ~183MB）；由 CI/Netlify 构建时下载，或本地开发自行跑一次。
 * - 文件已存在且大小正常则跳过（除非设置 FORCE=1）。
 * - 多源兜底：huggingface.co（Netlify 构建机在境外可直连）+ hf-mirror.com（中国本地开发兜底）。
 *
 * 用法：node scripts/fetch-model.mjs
 */
import { createWriteStream, existsSync, statSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public/models/birefnet-lite-512.onnx')
// Xet 存储 size 字段为 None，用实测值做完整性闸门（hf-mirror 下载校验一致）。
const EXPECTED = 191_877_254
const MIN = EXPECTED * 0.9
const force = process.env.FORCE === '1'

const URLS = [
  'https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx',
  'https://hf-mirror.com/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx',
]

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
  renameSync(tmp, OUT)
  return received
}

if (existsSync(OUT) && !force) {
  const sz = statSync(OUT).size
  if (sz >= MIN) {
    console.log(`[fetch-model] 已存在（${(sz / 1048576).toFixed(0)}MB），跳过。FORCE=1 可强制重下。`)
    process.exit(0)
  }
  console.log(`[fetch-model] 文件异常（${(sz / 1048576).toFixed(0)}MB），重新下载。`)
}

let lastErr
for (const u of URLS) {
  try {
    const sz = await download(u)
    if (sz < MIN) throw new Error(`下载不完整 ${sz} bytes`)
    console.log(`[fetch-model] 完成：${(sz / 1048576).toFixed(0)}MB -> ${OUT}`)
    process.exit(0)
  } catch (e) {
    lastErr = e
    console.warn('[fetch-model] 源失败，尝试下一个：', e?.message || e)
  }
}
// 所有源失败 → 构建失败，明确报错（避免线上悄无声息缺模型）
console.error('[fetch-model] ❌ 所有下载源失败，无法内嵌 BiRefNet 模型（BiRefNet 高精度模式将不可用）。')
process.exit(1)
