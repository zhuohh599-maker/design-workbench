import { parseGIF, decompressFrames } from 'gifuct-js'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import UPNG from 'upng-js'

export interface GifFrame {
  rgba: Uint8ClampedArray
  delay: number // ms
}

export interface DecodedGif {
  width: number
  height: number
  frames: GifFrame[]
}

/**
 * 解析 GIF 为按帧合成的 RGBA 序列（处理 disposal，得到完整帧）。
 */
export async function decodeGif(file: File): Promise<DecodedGif> {
  const buffer = await file.arrayBuffer()
  const gif = parseGIF(buffer)
  const raw = decompressFrames(gif, true)
  const W = gif.lsd.width
  const H = gif.lsd.height

  const acc = document.createElement('canvas')
  acc.width = W
  acc.height = H
  const actx = acc.getContext('2d')!

  const frames: GifFrame[] = []
  let saved: ImageData | null = null

  for (const fr of raw) {
    const { dims, patch, disposalType } = fr
    if (disposalType === 3) saved = actx.getImageData(0, 0, W, H)

    const pc = document.createElement('canvas')
    pc.width = dims.width
    pc.height = dims.height
    const pctx = pc.getContext('2d')!
    pctx.putImageData(
      new ImageData(new Uint8ClampedArray(patch), dims.width, dims.height),
      0,
      0,
    )
    actx.drawImage(pc, dims.left, dims.top)

    const out = actx.getImageData(0, 0, W, H)
    frames.push({ rgba: new Uint8ClampedArray(out.data), delay: fr.delay || 100 })

    if (disposalType === 2) {
      actx.clearRect(dims.left, dims.top, dims.width, dims.height)
    } else if (disposalType === 3 && saved) {
      actx.putImageData(saved, 0, 0)
    }
  }

  return { width: W, height: H, frames }
}

/**
 * 杂色扩散（噪声抖动）：把真彩色 RGBA 转成适合 GIF 的「二值透明 + 噪声扩散」版本。
 * - 颜色：逐像素叠加基于像素坐标的稳定伪随机噪声（不随帧变化，避免动画逐帧“沸腾”），
 *   再交给调色板量化，把颜色渐变的 banding 打散成杂色。
 * - 半透明边缘：用稳定伪随机阈值做随机透明度抖动（alpha<1 的像素以概率=alpha 设为不透明），
 *   形成散布的小点而非 1px 硬切；不透明小点保留原色（不预混合到特定背景，
 *   因此在任意背景上都是与覆盖度一致的羽化边缘）。
 */
function noiseDiffuse(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  paletteSize: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  // 噪声幅度随调色板减小而增大：色数越少，打散 banding 越明显
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
        // 覆盖度概率内的小点：保留（并叠加噪声）
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

export interface EncodeGifOptions {
  width: number
  height: number
  frames: GifFrame[]
  /** 调色板颜色数（2~256），越小体积越小 */
  paletteSize?: number
  /** 缩放比例 0.1~1 */
  scale?: number
  /** 是否保留透明通道（动图导出用） */
  transparent?: boolean
  /** 是否启用杂色扩散（噪声抖动）：打散颜色 banding，并把半透明边缘变成散布小点（默认开启） */
  dither?: boolean
}

/**
 * 将帧序列编码为 GIF。透明模式用于动图；不透明模式用于压缩（透明像素填白）。
 *
 * 注：GIF 格式上限为 256 色，且透明为 1-bit alpha。开启 dither（杂色扩散）后，
 * 颜色渐变用稳定伪随机噪声打散 banding，半透明边缘用随机阈值变成散布小点（羽化感），
 * 比过去的有序误差扩散更自然、且不会让逐帧动画“沸腾”。
 * 仍受 256 色调色板限制；需要“与预览一致”的真彩色平滑透明，请用 encodeApng。
 */
export function encodeGif(opts: EncodeGifOptions): Blob {
  const { width, height, frames } = opts
  const paletteSize = Math.min(256, Math.max(2, opts.paletteSize ?? 256))
  const scale = Math.min(1, Math.max(0.1, opts.scale ?? 1))
  const transparent = opts.transparent ?? false
  const dither = opts.dither ?? true

  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))

  const enc = GIFEncoder()

  for (const fr of frames) {
    let data: Uint8ClampedArray
    if (scale === 1) {
      data = fr.rgba
    } else {
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const cx = c.getContext('2d')!
      cx.putImageData(new ImageData(new Uint8ClampedArray(fr.rgba), width, height), 0, 0)
      const c2 = document.createElement('canvas')
      c2.width = w
      c2.height = h
      const cx2 = c2.getContext('2d')!
      cx2.drawImage(c, 0, 0, w, h)
      data = cx2.getImageData(0, 0, w, h).data
    }

    let work = data
    if (!transparent) {
      // 不透明模式：把透明像素填白，避免黑底空洞
      work = new Uint8ClampedArray(data.length)
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) {
          work[i] = 255
          work[i + 1] = 255
          work[i + 2] = 255
          work[i + 3] = 255
        } else {
          work[i] = data[i]
          work[i + 1] = data[i + 1]
          work[i + 2] = data[i + 2]
          work[i + 3] = 255
        }
      }
    }

    const format = transparent ? 'rgba4444' : 'rgb565'
    const workData = dither ? noiseDiffuse(work, w, h, paletteSize) : work
    const palette = quantize(workData, paletteSize, { format, oneBitAlpha: transparent })
    const index = applyPalette(workData, palette, format)
    enc.writeFrame(index, w, h, {
      palette,
      delay: fr.delay,
      transparent,
      dispose: transparent ? 2 : 1,
    })
  }

  enc.finish()
  return new Blob([enc.bytes()], { type: 'image/gif' })
}

export interface EncodeApngOptions {
  width: number
  height: number
  frames: GifFrame[]
  /** 有损压缩级别 0~2（0 无损最大，2 体积最小）。默认 0，质量最好。 */
  cnum?: number
}

/**
 * 将帧序列编码为 APNG（Animated PNG）。
 * 保留真彩色与完整 alpha 通道，可完美还原 Canvas 预览效果，无 GIF 色带与硬边。
 */
export function encodeApng(opts: EncodeApngOptions): Blob {
  const { width, height, frames } = opts
  const cnum = opts.cnum ?? 0
  const delays = frames.map((f) => f.delay)
  const imgs = frames.map((f) => {
    if (f.rgba.length === width * height * 4) {
      return f.rgba.buffer.slice(f.rgba.byteOffset, f.rgba.byteOffset + f.rgba.byteLength)
    }
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const cx = c.getContext('2d')!
    const srcW = Math.sqrt(f.rgba.length / 4)
    cx.putImageData(new ImageData(f.rgba, Math.round(srcW), Math.round(f.rgba.length / 4 / srcW)), 0, 0)
    return cx.getImageData(0, 0, width, height).data.buffer
  })
  const out = UPNG.encode(imgs, width, height, cnum, delays)
  return new Blob([out], { type: 'image/apng' })
}
