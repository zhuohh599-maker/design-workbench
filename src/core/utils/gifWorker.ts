// @ts-nocheck
/// <reference lib="webworker" />
// GIF 转码 Worker：先编码真彩色 APNG，再解码还原为帧序列，最后量化成 GIF。
// 在后台线程运行，避免主线程卡顿（"后台运行"）。
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import UPNG from 'upng-js'

interface InFrame {
  rgba: ArrayBuffer
  delay: number
}

// 稳定伪随机噪声抖动：打散颜色 banding，半透明边缘变成散布小点（羽化感）。
// 关闭后则是干净量化（仅轻微色带，无颗粒噪声）。
function noiseDiffuse(src: Uint8Array, w: number, h: number, paletteSize: number): Uint8Array {
  const out = new Uint8ClampedArray(src.length)
  const amp = Math.max(3, 256 / paletteSize)
  const at = (x: number, y: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    return s - Math.floor(s)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const a = src[i + 3] / 255
      const nR = (at(x + 0.5, y) - 0.5) * amp
      const nG = (at(x, y + 0.5) - 0.5) * amp
      const nB = (at(x + 1.7, y + 1.3) - 0.5) * amp
      if (a >= 1) {
        out[i] = src[i] + nR
        out[i + 1] = src[i + 1] + nG
        out[i + 2] = src[i + 2] + nB
        out[i + 3] = 255
      } else if (a <= 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0
      } else if (at(x, y) < a) {
        out[i] = src[i] + nR
        out[i + 1] = src[i + 1] + nG
        out[i + 2] = src[i + 2] + nB
        out[i + 3] = 255
      } else {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0
      }
    }
  }
  return out
}

function buildGif(
  frames: { rgba: Uint8Array; delay: number }[],
  width: number,
  height: number,
  transparent: boolean,
  paletteSize: number,
  dither: boolean,
): Uint8Array {
  const stride = width * height * 4
  // 透明模式下保留 alpha；不透明模式下把透明像素填白，避免黑底空洞
  const works = frames.map((f) => {
    let work = f.rgba
    if (!transparent) {
      const w2 = new Uint8Array(work.length)
      for (let i = 0; i < work.length; i += 4) {
        if (work[i + 3] < 128) {
          w2[i] = w2[i + 1] = w2[i + 2] = 255
          w2[i + 3] = 255
        } else {
          w2[i] = work[i]
          w2[i + 1] = work[i + 1]
          w2[i + 2] = work[i + 2]
          w2[i + 3] = 255
        }
      }
      work = w2
    }
    return dither ? noiseDiffuse(work, width, height, paletteSize) : work
  })

  // 全局调色板：用所有帧合并取样，避免逐帧独立调色板导致颜色"沸腾"闪烁
  const all = new Uint8Array(frames.length * stride)
  works.forEach((wk, i) => all.set(wk.subarray(0, stride), i * stride))

  // 透明 GIF 必须带 alpha 通道量化：rgb565 会完全忽略 alpha，导致透明/内容混在一起。
  // 不透明 GIF 用 rgb565 获得更细腻色彩。
  const format: 'rgb565' | 'rgba4444' = transparent ? 'rgba4444' : 'rgb565'
  const palette = quantize(all, paletteSize, { format, oneBitAlpha: transparent })

  // 找到调色板中 alpha=0 的索引，显式告诉 GIF 哪一个是透明色
  let transparentIndex = 0
  if (transparent) {
    const idx = palette.findIndex((c: number[]) => c[3] === 0)
    if (idx >= 0) transparentIndex = idx
  }

  const enc = GIFEncoder()
  works.forEach((wk, i) => {
    const index = applyPalette(wk, palette, format)
    enc.writeFrame(index, width, height, {
      palette,
      delay: frames[i].delay,
      transparent,
      transparentIndex,
      dispose: transparent ? 2 : 1,
    })
  })
  enc.finish()
  return enc.bytesView()
}

self.onmessage = (e: MessageEvent) => {
  const { width, height, frames, transparent, paletteSize, dither } = e.data as {
    width: number
    height: number
    frames: InFrame[]
    transparent: boolean
    paletteSize: number
    dither: boolean
  }
  try {
    // 1) 先生成真彩色 APNG（中间产物）
    self.postMessage({ type: 'progress', stage: 'apng', percent: 10, text: '生成 APNG 中…' })
    const rgbaArr = frames.map((f) => new Uint8Array(f.rgba))
    const delays = frames.map((f) => f.delay)
    // cnum=256 避免 UPNG 过度压缩成 1-bit 调色板导致内容丢失；0 虽标"无损"，但对简单色块会选错颜色。
    const apng = UPNG.encode(rgbaArr, width, height, 256, delays)

    // 2) 再转码为 GIF（全程后台）
    self.postMessage({ type: 'progress', stage: 'decode', percent: 40, text: '解码 APNG…' })
    const dec = UPNG.decode(apng)
    const rgbaAll = UPNG.toRGBA8(dec) as ArrayBuffer[] // 每帧一个 ArrayBuffer
    if (!rgbaAll.length) throw new Error('APNG 解码后没有帧')
    const stride = width * height * 4
    const conv = []
    for (let i = 0; i < rgbaAll.length; i++) {
      const fr = dec.frames[i]
      conv.push({
        rgba: new Uint8Array(rgbaAll[i]),
        delay: fr?.delay || 100,
      })
    }
    self.postMessage({ type: 'progress', stage: 'gif', percent: 70, text: '量化编码 GIF…' })
    const bytes = buildGif(conv, width, height, transparent, paletteSize, dither)
    self.postMessage({ type: 'progress', stage: 'done', percent: 100, text: 'GIF 转码完成' })
    ;(self as any).postMessage({ ok: true, bytes: bytes.buffer, length: bytes.byteLength }, [bytes.buffer])
  } catch (err) {
    ;(self as any).postMessage({ ok: false, error: String((err as any)?.message ? (err as any).message : err) })
  }
}
