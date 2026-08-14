import { decodeGif, encodeGif } from './gif'
import { loadImageFromBlob, canvasToBlob } from './image'
import UPNG from 'upng-js'

/**
 * 将「压缩质量」(10~100) 映射为 GIF 调色板颜色数（256 色上限）。
 * 质量越低 → 调色板越小 → 体积越小、画质越糙。
 */
export function qualityToPalette(q: number): number {
  const c = Math.max(10, Math.min(100, q))
  const p = Math.round((c / 100) * 240) + 16
  return Math.max(16, Math.min(256, p))
}

/** 静态位图重编码：jpg 填白后压 JPG；其余（含透明）转 WebP 有损以最大化压缩并保留透明 */
async function compressRaster(blob: Blob, quality: number): Promise<Blob> {
  const img = await loadImageFromBlob(blob)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const cx = cv.getContext('2d')!
  const target = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
  if (target === 'image/jpeg') {
    cx.fillStyle = '#ffffff'
    cx.fillRect(0, 0, w, h)
  }
  cx.drawImage(img, 0, 0, w, h)
  const q = Math.max(0.1, Math.min(1, quality / 100))
  return canvasToBlob(cv, target, q)
}

/** APNG（多帧）重编码缩小：逐帧缩放后重新 UPNG 编码，保留透明与动画 */
function compressApng(dec: any, quality: number): Blob {
  const w = dec.width
  const h = dec.height
  // 质量越低 → cnum 越高（UPNG 有损级别 0~4）→ 体积越小
  const cnum = Math.max(0, Math.min(4, Math.round(((100 - quality) / 90) * 4)))
  const frames = dec.frames.map((f: Uint8Array) => {
    const pc = document.createElement('canvas')
    pc.width = w
    pc.height = h
    pc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f), w, h), 0, 0)
    return pc.getContext('2d')!.getImageData(0, 0, w, h).data.buffer
  })
  const out = UPNG.encode(frames, w, h, cnum)
  return new Blob([out], { type: 'image/png' })
}

/**
 * 通用智能压缩入口：根据输入 Blob 的 MIME 自动选择策略。
 * - image/gif        → 重新量化调色板（quality 越低颜色越少）
 * - image/png/apng    → 多帧则 UPNG 重编码缩小；静态则转 WebP（保留透明）压缩
 * - image/webp/avif  → 重编码 WebP
 * - image/jpeg        → 重编码 JPG
 * 返回的 Blob 已压缩，调用方据此调整下载文件名扩展名。
 */
export async function smartCompress(blob: Blob, quality = 80): Promise<Blob> {
  const type = blob.type
  if (type === 'image/gif') {
    const file = new File([blob], 'x.gif', { type: 'image/gif' })
    const d = await decodeGif(file)
    return encodeGif({
      width: d.width,
      height: d.height,
      frames: d.frames,
      paletteSize: qualityToPalette(quality),
      dither: true,
      transparent: true,
    })
  }
  if (type === 'image/png' || type === 'image/apng') {
    try {
      const buf = new Uint8Array(await blob.arrayBuffer())
      const dec = UPNG.decode(buf)
      if (dec && dec.frames && dec.frames.length > 1) {
        return compressApng(dec, quality)
      }
    } catch {
      // 非 APNG / 解码失败，落到静态图分支
    }
    return compressRaster(blob, quality)
  }
  return compressRaster(blob, quality)
}
