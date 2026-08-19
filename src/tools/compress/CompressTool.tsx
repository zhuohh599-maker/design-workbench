import { useRef, useState, useEffect } from 'react'
import { ToolLayout, DropZone, Section, Slider } from '../../core/components'
import { loadImageFromFile, loadImageFromBlob, canvasToBlob, downloadBlob, formatBytes, MIME_EXT } from '../../core/utils/image'
import { decodeGif, encodeGif, type DecodedGif } from '../../core/utils/gif'
import { qualityToPalette } from '../../core/utils/compress'
import JSZip from 'jszip'
import * as UPNG from 'upng-js'
import { ACCEPT_IMAGES } from '../../core/types'

type BatchItem = { id: number; name: string; orig: number; blob: Blob; size: number; url: string }

export default function CompressTool() {
  const [mode, setMode] = useState<'single' | 'batch'>('single')

  // 单张
  const [file, setFile] = useState<File | null>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [isGif, setIsGif] = useState(false)
  const [gif, setGif] = useState<DecodedGif | null>(null)
  const [quality, setQuality] = useState(80)
  const [maxW, setMaxW] = useState(0)
  const [palette, setPalette] = useState(128)
  const [scale, setScale] = useState(100)
  const [origBytes, setOrigBytes] = useState(0)
  const [outBytes, setOutBytes] = useState(0)
  const [outName, setOutName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const previewRef = useRef<HTMLCanvasElement>(null)

  // 批量（PNG 序列）
  const [sourceFiles, setSourceFiles] = useState<File[]>([])
  const [batch, setBatch] = useState<BatchItem[]>([])
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ i: 0, total: 0, name: '' })

  // 批量：预览 / APNG
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)
  const [apngDelay, setApngDelay] = useState(100)
  const [apngColors, setApngColors] = useState(256)
  const [apngBusy, setApngBusy] = useState(false)
  const [apngOutSize, setApngOutSize] = useState(0)
  const [pngColors, setPngColors] = useState(256)

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  useEffect(() => {
    return () => {
      batch.forEach((b) => URL.revokeObjectURL(b.url))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function clearBatchUrls() {
    batch.forEach((b) => URL.revokeObjectURL(b.url))
  }

  // ===== 单张逻辑 =====
  async function onFile(f: File) {
    setErr('')
    setFile(f)
    setOrigBytes(f.size)
    setOutName(f.name)
    const g = f.type === 'image/gif' || f.name.toLowerCase().endsWith('.gif')
    setIsGif(g)
    if (g) {
      setImg(null)
      setBusy(true)
      try {
        const d = await decodeGif(f)
        setGif(d)
        drawFrame(d, 0)
      } catch (e) {
        setErr('GIF 解析失败：' + (e as Error).message)
      } finally {
        setBusy(false)
      }
    } else {
      setGif(null)
      const image = await loadImageFromFile(f)
      setImg(image)
    }
  }

  function drawFrame(d: DecodedGif, idx: number) {
    const cv = previewRef.current
    if (!cv) return
    cv.width = d.width
    cv.height = d.height
    const cx = cv.getContext('2d')!
    cx.putImageData(new ImageData(new Uint8ClampedArray(d.frames[idx].rgba), d.width, d.height), 0, 0)
  }

  // 普通图片（JPG/PNG/WEBP）绘制到主预览 canvas，否则预览区空白
  useEffect(() => {
    const cv = previewRef.current
    if (!cv || !img || isGif) return
    const w = maxW > 0 && maxW < img.naturalWidth ? maxW : img.naturalWidth
    const ratio = w / img.naturalWidth
    const h = Math.round(img.naturalHeight * ratio)
    cv.width = w
    cv.height = h
    cv.getContext('2d')!.drawImage(img, 0, 0, w, h)
  }, [img, isGif, maxW])

  // 位图（JPG/PNG/WEBP）压缩
  useEffect(() => {
    if (!img || isGif || !file) return
    let alive = true
    ;(async () => {
      const w = maxW > 0 && maxW < img.naturalWidth ? maxW : img.naturalWidth
      const ratio = w / img.naturalWidth
      const h = Math.round(img.naturalHeight * ratio)
      const cv = document.createElement('canvas')
      cv.width = w
      cv.height = h
      const cx = cv.getContext('2d')!
      cx.drawImage(img, 0, 0, w, h)
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      const blob = await canvasToBlob(cv, type, type === 'image/png' ? undefined : quality / 100)
      if (alive) setOutBytes(blob.size)
    })()
    return () => {
      alive = false
    }
  }, [img, isGif, file, quality, maxW])

  // GIF 压缩
  useEffect(() => {
    if (!isGif || !gif) return
    setBusy(true)
    const t = setTimeout(() => {
      try {
        const blob = encodeGif({ width: gif.width, height: gif.height, frames: gif.frames, paletteSize: palette, scale: scale / 100 })
        setOutBytes(blob.size)
      } catch (e) {
        setErr('GIF 编码失败：' + (e as Error).message)
      } finally {
        setBusy(false)
      }
    }, 50)
    return () => clearTimeout(t)
  }, [isGif, gif, palette, scale])

  async function download() {
    if (!file) return
    if (isGif && gif) {
      const blob = encodeGif({ width: gif.width, height: gif.height, frames: gif.frames, paletteSize: palette, scale: scale / 100 })
      downloadBlob(blob, outName.replace(/\.[^.]+$/, '') + '-min.gif')
      return
    }
    if (img) {
      const w = maxW > 0 && maxW < img.naturalWidth ? maxW : img.naturalWidth
      const ratio = w / img.naturalWidth
      const h = Math.round(img.naturalHeight * ratio)
      const cv = document.createElement('canvas')
      cv.width = w
      cv.height = h
      cv.getContext('2d')!.drawImage(img, 0, 0, w, h)
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      const blob = await canvasToBlob(cv, type, type === 'image/png' ? undefined : quality / 100)
      downloadBlob(blob, `${outName.replace(/\.[^.]+$/, '')}-min.${MIME_EXT[type]}`)
    }
  }

  // ===== 批量逻辑（PNG 序列） =====
  async function onFiles(files: File[]) {
    setErr('')
    if (files.length === 0) return
    setSourceFiles(files)
    clearBatchUrls()
    setBatch([])
    setApngOutSize(0)
    // 首次上传按默认参数自动压缩一次
    compressBatch(files)
  }

  async function compressBatch(files: File[] = sourceFiles) {
    if (files.length === 0) return
    setBatchBusy(true)
    setErr('')
    try {
      const out: BatchItem[] = []
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        setBatchProgress({ i: i + 1, total: files.length, name: f.name })
        const blob = await compressOne(f)
        out.push({ id: i + 1, name: f.name, orig: f.size, blob, size: blob.size, url: URL.createObjectURL(blob) })
      }
      setBatch(out)
    } catch (e) {
      setErr('批量压缩失败：' + (e as Error).message)
    } finally {
      setBatchBusy(false)
    }
  }

  async function compressOne(f: File): Promise<Blob> {
    if (f.type === 'image/gif' || f.name.toLowerCase().endsWith('.gif')) {
      const d = await decodeGif(f)
      return encodeGif({ width: d.width, height: d.height, frames: d.frames, paletteSize: qualityToPalette(quality), scale: 1 })
    }
    const image = await loadImageFromFile(f)
    const w = maxW > 0 && maxW < image.naturalWidth ? maxW : image.naturalWidth
    const ratio = w / image.naturalWidth
    const h = Math.round(image.naturalHeight * ratio)
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    cv.getContext('2d')!.drawImage(image, 0, 0, w, h)
    const isPng = f.type === 'image/png' || f.name.toLowerCase().endsWith('.png')
    if (isPng) {
      // PNG：浏览器 canvas 默认导出的是 32-bit RGBA，往往比原 PNG 大。
      // 用 upng-js 按指定颜色数量重新编码（palette 量化），若仍比原图大则回退原图。
      const data = cv.getContext('2d')!.getImageData(0, 0, w, h)
      const cnum = pngColors > 0 ? pngColors : 0
      const buf = UPNG.encode([data.data.buffer], w, h, cnum)
      const blob = new Blob([buf], { type: 'image/png' })
      return blob.size < f.size ? blob : f
    }
    const t = f.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
    const blob = await canvasToBlob(cv, t, Math.max(0.1, quality / 100))
    return blob.size < f.size ? blob : f
  }

  const batchOrig = batch.reduce((s, b) => s + b.orig, 0)
  const batchOut = batch.reduce((s, b) => s + b.size, 0)
  const batchSave = batchOrig > 0 ? Math.round((1 - batchOut / batchOrig) * 100) : 0

  function batchExt(b: Blob): string {
    if (b.type === 'image/webp') return 'webp'
    if (b.type === 'image/png') return 'png'
    if (b.type === 'image/jpeg') return 'jpg'
    return 'png'
  }

  async function downloadBatch() {
    if (batch.length === 0) return
    setBusy(true)
    try {
      const zip = new JSZip()
      for (const it of batch) {
        const base = it.name.replace(/\.[^.]+$/, '')
        zip.file(`${base}-min.${batchExt(it.blob)}`, it.blob)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `compressed-sequence-${batch.length}.zip`)
    } finally {
      setBusy(false)
    }
  }

  async function buildApng() {
    if (batch.length < 2) {
      setErr('APNG 至少需要 2 帧才能合成')
      return
    }
    setApngBusy(true)
    setErr('')
    try {
      const first = await loadImageFromBlob(batch[0].blob)
      const w = first.naturalWidth
      const h = first.naturalHeight
      const frames: ArrayBuffer[] = []
      const delays: number[] = []
      for (const it of batch) {
        const img = await loadImageFromBlob(it.blob)
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = h
        const cx = cv.getContext('2d')!
        cx.drawImage(img, 0, 0, w, h)
        const data = cx.getImageData(0, 0, w, h)
        frames.push(data.data.buffer)
        delays.push(Math.max(10, apngDelay))
      }
      const cnum = apngColors > 0 ? apngColors : 0
      const buf = UPNG.encode(frames, w, h, cnum, delays)
      const blob = new Blob([buf], { type: 'image/apng' })
      setApngOutSize(blob.size)
      const name = batch[0].name.replace(/\.[^.]+$/, '') + '-animated.apng'
      downloadBlob(blob, name)
    } catch (e) {
      setErr('APNG 合成失败：' + (e as Error).message)
    } finally {
      setApngBusy(false)
    }
  }

  const saving = origBytes > 0 && outBytes > 0 ? Math.round((1 - outBytes / origBytes) * 100) : 0

  return (
    <ToolLayout
      title="智能压缩"
      description="压缩 JPG / PNG / WEBP 体积，重新量化 GIF，或批量压缩一组 PNG 序列为更小的文件。"
    >
      <div className="card">
        <div className="seg" style={{ marginBottom: 12 }}>
          <button className={`seg-btn ${mode === 'single' ? 'on' : ''}`} onClick={() => setMode('single')}>
            单张
          </button>
          <button className={`seg-btn ${mode === 'batch' ? 'on' : ''}`} onClick={() => setMode('batch')}>
            PNG 序列（批量）
          </button>
        </div>
        {mode === 'single' ? (
          !file ? (
            <DropZone onFile={onFile} accept={ACCEPT_IMAGES} label="拖入或选择一张图片 / GIF" />
          ) : (
            <div className="preview">
              <canvas ref={previewRef} style={{ display: img || isGif ? 'block' : 'none' }} />
              {!img && !isGif && <span className="muted">预览生成中…</span>}
            </div>
          )
        ) : (
          <>
            <DropZone
              multiple
              onFiles={onFiles}
              accept={ACCEPT_IMAGES}
              label="拖入或选择多张图片（PNG 序列）"
              hint="支持一次选择 / 拖入多张，批量压缩后打包为 ZIP / APNG"
            />
            {sourceFiles.length > 0 && (
              <div className="upload-hint">
                已选择 {sourceFiles.length} 个文件
                {batchBusy && '，正在按当前参数压缩…'}
                {!batchBusy && batch.length === 0 && '，调好参数后点击右侧「⚡ 应用压缩」可重新压缩'}
                {!batchBusy && batch.length > 0 && `，已压缩（共 ${batch.length} 张），调整右侧滑块后点「⚡ 应用压缩」重算`}
              </div>
            )}
            {batch.length > 0 && (
              <div className="batch-grid">
                {batch.map((b, idx) => {
                  const save = b.orig > 0 ? Math.round((1 - b.size / b.orig) * 100) : 0
                  return (
                    <div className="batch-card" key={b.id}>
                      <div className="batch-thumb" onClick={() => setPreview({ url: b.url, name: b.name })}>
                        <img src={b.url} alt={b.name} loading="lazy" />
                        <span className="batch-index">{idx + 1}</span>
                      </div>
                      <div className="batch-info">
                        <div className="batch-name" title={b.name}>
                          {b.name}
                        </div>
                        <div className="batch-meta">
                          {formatBytes(b.orig)} → {formatBytes(b.size)} ·{' '}
                          <span style={{ color: save > 0 ? '#16a34a' : '#b91c1c' }}>
                            {save > 0 ? `↓${save}%` : save < 0 ? `↑${Math.abs(save)}%` : '0%'}
                          </span>
                        </div>
                        <button
                          className="btn tiny block"
                          onClick={() => downloadBlob(b.blob, `${b.name.replace(/\.[^.]+$/, '')}-min.${batchExt(b.blob)}`)}
                        >
                          下载
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="panel">
        {mode === 'single' && file && (
          <Section title="体积对比">
            <div className="stat">
              <span>原文件</span>
              <span className="v">{formatBytes(origBytes)}</span>
            </div>
            <div className="stat">
              <span>压缩后</span>
              <span className="v">{formatBytes(outBytes)}</span>
            </div>
            <div className="stat">
              <span>节省</span>
              <span className="v" style={{ color: saving > 0 ? '#16a34a' : '#b91c1c' }}>
                {saving > 0 ? `↓ ${saving}%` : saving < 0 ? `↑ ${Math.abs(saving)}%` : '0%'}
              </span>
            </div>
          </Section>
        )}

        {mode === 'single' &&
          (!isGif ? (
            <Section title="压缩参数">
              <Slider label="质量" min={10} max={100} value={quality} onChange={setQuality} suffix="%" />
              <Slider label="最大宽度(0=不限制)" min={0} max={4000} step={50} value={maxW} onChange={setMaxW} suffix="px" />
              <div className="hint">PNG 为无损，主要靠「最大宽度」缩小；JPG 靠质量滑块。</div>
            </Section>
          ) : (
            <Section title="GIF 参数">
              <Slider label="调色板颜色" min={16} max={256} step={8} value={palette} onChange={setPalette} />
              <Slider label="缩放比例" min={10} max={100} value={scale} onChange={setScale} suffix="%" />
              <div className="hint">颜色越少、尺寸越小，体积越小但画质越糙。共 {gif?.frames.length ?? 0} 帧。</div>
            </Section>
          ))}

        {mode === 'batch' && (
          <>
            <Section title="压缩参数">
              <Slider label="质量" min={10} max={100} value={quality} onChange={setQuality} suffix="%" />
              <Slider label="最大宽度(0=不限制)" min={0} max={4000} step={50} value={maxW} onChange={setMaxW} suffix="px" />
              <Slider
                label="PNG 颜色数"
                min={0}
                max={256}
                step={1}
                value={pngColors}
                onChange={setPngColors}
                suffix={pngColors === 0 ? '原图' : '色'}
              />
              <div className="hint">
                质量只影响 JPG/WEBP；PNG 靠「最大宽度」和「颜色数」减小体积。颜色数 0=保持原图，256=保留最多颜色。若压缩后比原图大，会自动回退到原文件。
              </div>
              <button
                className="btn primary block"
                style={{ marginTop: 12 }}
                disabled={batchBusy || sourceFiles.length === 0}
                onClick={() => compressBatch()}
              >
                {batchBusy ? '压缩中…' : '⚡ 应用压缩'}
              </button>
            </Section>

            {batchBusy && (
              <div className="hint">
                压缩中… {batchProgress.i}/{batchProgress.total} {batchProgress.name}
              </div>
            )}

            {batch.length > 0 && (
              <Section title={`序列结果（${batch.length}）`}>
                <div className="stat">
                  <span>原总大小</span>
                  <span className="v">{formatBytes(batchOrig)}</span>
                </div>
                <div className="stat">
                  <span>压缩后总大小</span>
                  <span className="v">{formatBytes(batchOut)}</span>
                </div>
                <div className="stat">
                  <span>总节省</span>
                  <span className="v" style={{ color: batchSave > 0 ? '#16a34a' : '#b91c1c' }}>
                    {batchSave > 0 ? `↓ ${batchSave}%` : batchSave < 0 ? `↑ ${Math.abs(batchSave)}%` : '0%'}
                  </span>
                </div>
                <button className="btn primary block" style={{ marginTop: 12 }} disabled={batchBusy} onClick={downloadBatch}>
                  ⬇ 全部下载（ZIP）
                </button>
              </Section>
            )}

            {batch.length > 0 && (
              <Section title="合成 APNG">
                <Slider label="每帧间隔" min={20} max={2000} step={10} value={apngDelay} onChange={setApngDelay} suffix="ms" />
                <Slider
                  label="颜色数（0=无损）"
                  min={0}
                  max={256}
                  step={1}
                  value={apngColors}
                  onChange={setApngColors}
                  suffix={apngColors === 0 ? '无损' : '色'}
                />
                <div className="hint">
                  颜色数越少 APNG 体积越小。图标/文字序列建议 128–256；复杂照片可保持 0 无损。upng-js 已自动做帧间差异裁剪与 dispose/blend 优化。
                </div>
                {apngOutSize > 0 && (
                  <div className="stat" style={{ marginTop: 8 }}>
                    <span>上次 APNG</span>
                    <span className="v">{formatBytes(apngOutSize)}</span>
                  </div>
                )}
                <button
                  className="btn primary block"
                  style={{ marginTop: 10 }}
                  disabled={batchBusy || apngBusy}
                  onClick={buildApng}
                >
                  {apngBusy ? '合成中…' : '🎞 合成 APNG'}
                </button>
              </Section>
            )}
          </>
        )}

        {mode === 'single' && (
          <button className="btn primary block" disabled={!file || busy} onClick={download} style={{ marginTop: 12 }}>
            ⬇ 下载压缩结果
          </button>
        )}
        {err && (
          <div className="hint" style={{ color: '#b91c1c' }}>
            {err}
          </div>
        )}
      </div>

      {preview && (
        <div
          className="preview-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreview(null)
          }}
        >
          <button className="preview-modal-close" onClick={() => setPreview(null)}>
            ×
          </button>
          <img src={preview.url} alt={preview.name} />
          <div className="preview-modal-name">{preview.name}</div>
        </div>
      )}
    </ToolLayout>
  )
}
