import { useRef, useState, useEffect } from 'react'
import { ToolLayout, DropZone, Section, Slider, CompressControls, useSmartCompress } from '../../core/components'
import { loadImageFromFile, canvasToBlob, downloadBlob, blobExt, formatBytes, drawCover, drawContain } from '../../core/utils/image'
import { ACCEPT_IMAGES } from '../../core/types'

type Fit = 'stretch' | 'cover' | 'contain'

export default function ResizeTool() {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [name, setName] = useState('')
  const [ow, setOw] = useState(0)
  const [oh, setOh] = useState(0)
  const [w, setW] = useState(0)
  const [h, setH] = useState(0)
  const [lock, setLock] = useState(true)
  const [fit, setFit] = useState<Fit>('cover')
  const [tip, setTip] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const c = useSmartCompress()

  async function onFile(file: File) {
    const image = await loadImageFromFile(file)
    setImg(image)
    setName(file.name)
    setOw(image.naturalWidth)
    setOh(image.naturalHeight)
    setW(image.naturalWidth)
    setH(image.naturalHeight)
  }

  function setWidth(v: number) {
    setW(v)
    if (lock && ow && oh) setH(Math.round((v * oh) / ow))
  }
  function setHeight(v: number) {
    setH(v)
    if (lock && ow && oh) setW(Math.round((v * ow) / oh))
  }

  function removeImage() {
    setImg(null)
    setName('')
    setOw(0)
    setOh(0)
    setW(0)
    setH(0)
  }

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !img) return
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (fit === 'stretch') {
      ctx.drawImage(img, 0, 0, w, h)
    } else if (fit === 'cover') {
      drawCover(ctx, img, w, h)
    } else {
      drawContain(ctx, img, w, h)
    }
  }, [img, w, h, fit, ow, oh])

  async function download() {
    if (!canvasRef.current) return
    let blob = await canvasToBlob(canvasRef.current, 'image/png')
    const orig = blob.size
    blob = await c.run(blob)
    const ext = blobExt(blob)
    downloadBlob(blob, `${name.replace(/\.[^.]+$/, '')}-${w}x${h}.${ext}`)
    setTip(`导出 ${formatBytes(orig)}${c.compress ? ` → 智能压缩 ${formatBytes(blob.size)}` : ''}`)
  }

  return (
    <ToolLayout title="尺寸缩放" description="把图片缩放或裁剪到指定尺寸，支持锁定比例与三种适配模式。">
      <div className="card">
        {!img ? (
          <DropZone onFile={onFile} accept={ACCEPT_IMAGES} label="拖入或选择一张图片" />
        ) : (
          <>
            <div className="preview">
              <canvas ref={canvasRef} />
            </div>
            <div className="hint">
              原图 {ow}×{oh} · 输出 {w}×{h}
            </div>
            <button className="btn block" style={{ marginTop: 12 }} onClick={removeImage}>
              ❌ 移除图片
            </button>
          </>
        )}
      </div>

      <div className="panel">
        <Section title="输出尺寸">
          <div className="row">
            <div className="field">
              <label>宽 (px)</label>
              <input type="number" value={w} min={1} disabled={!img} onChange={(e) => setWidth(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>高 (px)</label>
              <input type="number" value={h} min={1} disabled={!img} onChange={(e) => setHeight(Number(e.target.value))} />
            </div>
          </div>
          <label className="slider" style={{ marginBottom: 12 }}>
            <span className="slider-label">
              锁定比例 <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
            </span>
          </label>
          <div className="field">
            <label>适配模式（原图比例≠目标比例时）</label>
            <select value={fit} disabled={!img} onChange={(e) => setFit(e.target.value as Fit)}>
              <option value="cover">裁剪填满（cover）</option>
              <option value="contain">留白完整（contain）</option>
              <option value="stretch">直接拉伸（可能变形）</option>
            </select>
          </div>
        </Section>

        <button className="btn primary block" disabled={!img} onClick={download}>
          ⬇ 导出图片
        </button>
        <CompressControls compress={c.compress} setCompress={c.setCompress} quality={c.quality} setQuality={c.setQuality} />
        {tip && <div className="hint">{tip}</div>}
        <div className="hint">默认以 PNG 输出保留透明通道；如需 JPG 请在「格式转换」中另存。</div>
      </div>
    </ToolLayout>
  )
}
