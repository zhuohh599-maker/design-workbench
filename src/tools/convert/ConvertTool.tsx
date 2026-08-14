import { useRef, useState, useEffect } from 'react'
import { ToolLayout, DropZone, Section, Slider, CompressControls, useSmartCompress } from '../../core/components'
import { loadImageFromFile, canvasToBlob, downloadBlob, MIME_EXT, blobExt, formatBytes } from '../../core/utils/image'
import { ACCEPT_IMAGES } from '../../core/types'

const FORMATS: { value: string; label: string; lossy: boolean }[] = [
  { value: 'image/jpeg', label: 'JPG', lossy: true },
  { value: 'image/png', label: 'PNG', lossy: false },
  { value: 'image/webp', label: 'WEBP', lossy: true },
  { value: 'image/avif', label: 'AVIF', lossy: true },
]

export default function ConvertTool() {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [name, setName] = useState('')
  const [fmt, setFmt] = useState('image/png')
  const [quality, setQuality] = useState(90)
  const [warn, setWarn] = useState('')
  const [tip, setTip] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const c = useSmartCompress()

  async function onFile(file: File) {
    setWarn('')
    const image = await loadImageFromFile(file)
    setImg(image)
    setName(file.name)
  }

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !img) return
    cv.width = img.naturalWidth
    cv.height = img.naturalHeight
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.drawImage(img, 0, 0)
  }, [img])

  const lossy = FORMATS.find((f) => f.value === fmt)?.lossy

  async function download() {
    if (!canvasRef.current) return
    setTip('')
    try {
      let blob = await canvasToBlob(canvasRef.current, fmt, lossy ? quality / 100 : undefined)
      const orig = blob.size
      blob = await c.run(blob)
      const ext = blobExt(blob)
      downloadBlob(blob, `${name.replace(/\.[^.]+$/, '')}.${ext}`)
      setTip(`导出 ${formatBytes(orig)}${c.compress ? ` → 智能压缩 ${formatBytes(blob.size)}` : ''}`)
    } catch (e) {
      setWarn(`当前浏览器不支持导出 ${fmt.split('/')[1].toUpperCase()} 格式（多见于 Safari）。建议改用 Chrome，或选择 PNG/WEBP。`)
    }
  }

  return (
    <ToolLayout title="格式转换" description="在 JPG / PNG / WEBP / AVIF 之间互转，有损格式可调质量。">
      <div className="card">
        {!img ? (
          <DropZone onFile={onFile} accept={ACCEPT_IMAGES} label="拖入或选择一张图片" />
        ) : (
          <div className="preview">
            <canvas ref={canvasRef} />
          </div>
        )}
      </div>

      <div className="panel">
        <Section title="目标格式">
          <div className="field">
            <label>格式</label>
            <select value={fmt} disabled={!img} onChange={(e) => setFmt(e.target.value)}>
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {lossy && (
            <Slider
              label="质量"
              min={10}
              max={100}
              value={quality}
              onChange={setQuality}
              suffix="%"
            />
          )}
          {fmt === 'image/png' && <div className="hint">PNG 为无损格式，无质量调节；透明通道会保留。</div>}
          {fmt === 'image/jpeg' && <div className="hint">JPG 不支持透明，透明区域将以白色填充。</div>}
        </Section>

        <button className="btn primary block" disabled={!img} onClick={download}>
          ⬇ 导出 {fmt.split('/')[1].toUpperCase()}
        </button>
        <CompressControls compress={c.compress} setCompress={c.setCompress} quality={c.quality} setQuality={c.setQuality} />
        {tip && <div className="hint">{tip}</div>}
        {warn && <div className="hint" style={{ color: '#b91c1c' }}>{warn}</div>}
      </div>
    </ToolLayout>
  )
}
