import { useRef, useState, useEffect } from 'react'
import { ToolLayout, DropZone, Section, Slider } from '../../core/components'
import { loadImageFromFile, canvasToBlob, downloadBlob, formatBytes, MIME_EXT } from '../../core/utils/image'
import { decodeGif, encodeGif, type DecodedGif } from '../../core/utils/gif'
import { ACCEPT_IMAGES } from '../../core/types'

export default function CompressTool() {
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

  const saving = origBytes > 0 && outBytes > 0 ? Math.round((1 - outBytes / origBytes) * 100) : 0

  return (
    <ToolLayout title="智能压缩" description="压缩 JPG / PNG / WEBP 体积，或重新量化 GIF（调色板 + 缩放）。">
      <div className="card">
        {!file ? (
          <DropZone onFile={onFile} accept={ACCEPT_IMAGES} label="拖入或选择一张图片 / GIF" />
        ) : (
          <div className="preview">
            <canvas ref={previewRef} style={{ display: img || isGif ? 'block' : 'none' }} />
            {!img && !isGif && <span className="muted">预览生成中…</span>}
          </div>
        )}
      </div>

      <div className="panel">
        {file && (
          <Section title="体积对比">
            <div className="stat"><span>原文件</span><span className="v">{formatBytes(origBytes)}</span></div>
            <div className="stat"><span>压缩后</span><span className="v">{formatBytes(outBytes)}</span></div>
            <div className="stat"><span>节省</span><span className="v" style={{ color: saving > 0 ? '#16a34a' : '#b91c1c' }}>{saving > 0 ? `↓ ${saving}%` : saving < 0 ? `↑ ${Math.abs(saving)}%` : '0%'}</span></div>
          </Section>
        )}

        {!isGif ? (
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
        )}

        {busy && <div className="progress"><i style={{ width: '60%' }} /></div>}
        <button className="btn primary block" disabled={!file || busy} onClick={download} style={{ marginTop: 12 }}>
          ⬇ 下载压缩结果
        </button>
        {err && <div className="hint" style={{ color: '#b91c1c' }}>{err}</div>}
      </div>
    </ToolLayout>
  )
}
