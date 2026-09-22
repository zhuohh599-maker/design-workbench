/**
 * ImageMagick (WASM) 封装 —— 用于 PSD / PDF / SVG / HEIC 等「通用格式」读取与压缩导出。
 *
 * - wasm 体积约 26MB，故按需懒加载：仅在用户首次真正处理文件时才初始化。
 * - PSD 多图层会被 ImageMagick 自动合并为一张（符合「导出合并版」需求）。
 * - 不同格式依赖编解码器：PSD 支持最好；PDF/SVG/HEIC 取决于 magick-wasm 内置委托，
 *   不受支持时会抛出可读错误，由上层 UI 提示。
 */

export type MagickOutFormat = 'webp' | 'avif' | 'jpg'

let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const [mod, wasmMod] = await Promise.all([
        import('@imagemagick/magick-wasm'),
        import('@imagemagick/magick-wasm/x64/magick.wasm?url'),
      ])
      // 官方仅支持三种入参：URL 实例（http/https）/ Uint8Array / WebAssembly.Module。
      // 传 fetch() 的 Promise 会被当作 wasmBinary 处理，导致
      // 「WebAssembly.instantiate(): BufferSource argument is empty」。
      const url = (wasmMod as { default: string }).default
      await mod.initializeImageMagick(new URL(url, window.location.href))
    })()
  }
  return initPromise
}

const MIME: Record<MagickOutFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpg: 'image/jpeg',
}

export async function convertWithMagick(
  file: File,
  format: MagickOutFormat,
  quality: number,
): Promise<Blob> {
  await ensureInit()
  const { ImageMagick, MagickFormat } = await import('@imagemagick/magick-wasm')
  const bytes = new Uint8Array(await file.arrayBuffer())

  const outFormat =
    format === 'jpg' ? MagickFormat.Jpeg : format === 'avif' ? MagickFormat.Avif : MagickFormat.WebP
  const q = Math.max(1, Math.min(100, Math.round(quality)))

  const result: { data?: Uint8Array } = {}
  try {
    ImageMagick.read(bytes, (image) => {
      image.quality = q
      image.format = outFormat
      image.write(outFormat, (data) => {
        result.data = data
      })
    })
  } catch (e) {
    throw new Error(`该格式无法被 ImageMagick 处理（可能编解码器未内置）：${(e as Error).message}`)
  }

  if (!result.data || result.data.length === 0) {
    throw new Error('转换失败：未产出有效数据，可能该格式不被当前编解码器支持')
  }
  return new Blob([result.data as BlobPart], { type: MIME[format] })
}
