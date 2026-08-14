import { useRef, useState, useEffect } from 'react'
import { ToolLayout, DropZone, Section, Slider } from '../../core/components'
import { loadImageFromFile, canvasToBlob, downloadBlob, formatBytes } from '../../core/utils/image'
import { ACCEPT_IMAGES } from '../../core/types'

type Corners = { tl: number; tr: number; br: number; bl: number }

/** 在透明画布上画出圆角矩形裁剪路径；半径会被钳制到不超出图片半宽/半高，避免拐角重叠 */
function roundRectPath(ctx: CanvasRenderingContext2D, w: number, h: number, r: Corners) {
  const tl = Math.max(0, Math.min(r.tl, w / 2, h / 2))
  const tr = Math.max(0, Math.min(r.tr, w / 2, h / 2))
  const br = Math.max(0, Math.min(r.br, w / 2, h / 2))
  const bl = Math.max(0, Math.min(r.bl, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(tl, 0)
  ctx.lineTo(w - tr, 0)
  ctx.arcTo(w, 0, w, tr, tr)
  ctx.lineTo(w, h - br)
  ctx.arcTo(w, h, w - br, h, br)
  ctx.lineTo(bl, h)
  ctx.arcTo(0, h, 0, h - bl, bl)
  ctx.lineTo(0, tl)
  ctx.arcTo(0, 0, tl, 0, tl)
  ctx.closePath()
}

export default function RoundedTool() {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [name, setName] = useState('')
  const [ow, setOw] = useState(0)
  const [oh, setOh] = useState(0)
  const [linked, setLinked] = useState(true) // true = 四角一致
  const [r, setR] = useState(24) // 联动主值
  const [corners, setCorners] = useState<Corners>({ tl: 24, tr: 24, br: 24, bl: 24 })
  const [tip, setTip] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  async function onFile(file: File) {
    const image = await loadImageFromFile(file)
    setImg(image)
    setName(file.name)
    setOw(image.naturalWidth)
    setOh(image.naturalHeight)
  }

  function removeImage() {
    setImg(null)
    setName('')
    setOw(0)
    setOh(0)
  }

  // 联动：主滑块改一处即改四角
  function setMaster(v: number) {
    setR(v)
    setCorners({ tl: v, tr: v, br: v, bl: v })
  }
  function setCorner(k: keyof Corners, v: number) {
    setCorners((c) => ({ ...c, [k]: v }))
  }
  function toggleLink(next: boolean) {
    setLinked(next)
    if (next) {
      // 重新关联：以左上角为准，四角统一
      setR(corners.tl)
      setCorners({ tl: corners.tl, tr: corners.tl, br: corners.tl, bl: corners.tl })
    }
  }

  const maxR = img ? Math.max(1, Math.floor(Math.min(ow, oh) / 2)) : 200

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !img) return
    cv.width = ow
    cv.height = oh
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, ow, oh)
    roundRectPath(ctx, ow, oh, corners)
    ctx.clip()
    ctx.drawImage(img, 0, 0, ow, oh)
  }, [img, ow, oh, corners])

  async function download() {
    if (!canvasRef.current) return
    const raw = await canvasToBlob(canvasRef.current, 'image/png')
    downloadBlob(raw, `${name.replace(/\.[^.]+$/, '')}-rounded.png`)
    setTip(`已导出 PNG ${formatBytes(raw.size)}（圆角外为透明）`)
  }

  return (
    <ToolLayout title="图片圆角" description="把上传图片的四个角裁成圆角，可单独设置每个角，导出透明 PNG。">
      <div className="card">
        {!img ? (
          <DropZone onFile={onFile} accept={ACCEPT_IMAGES} label="拖入或选择一张图片" />
        ) : (
          <>
            <div className="preview">
              <canvas ref={canvasRef} />
            </div>
            <div className="hint">
              原图 {ow}×{oh} · 圆角外缘为透明
            </div>
            <button className="btn block" style={{ marginTop: 12 }} onClick={removeImage}>
              ❌ 移除图片
            </button>
          </>
        )}
      </div>

      <div className="panel">
        {img && (
          <Section title="圆角设置">
            <label className="slider" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={linked} onChange={(e) => toggleLink(e.target.checked)} />
              <span style={{ margin: 0 }}>四个角数值一致（关联）</span>
            </label>

            {linked ? (
              <Slider
                label="圆角半径"
                min={0}
                max={maxR}
                value={r}
                onChange={setMaster}
                suffix="px"
              />
            ) : (
              <div className="corner-grid">
                <div className="corner-cell">
                  <label>左上</label>
                  <input type="number" min={0} max={maxR} value={corners.tl} onChange={(e) => setCorner('tl', Number(e.target.value))} />
                </div>
                <div className="corner-cell">
                  <label>右上</label>
                  <input type="number" min={0} max={maxR} value={corners.tr} onChange={(e) => setCorner('tr', Number(e.target.value))} />
                </div>
                <div className="corner-cell">
                  <label>左下</label>
                  <input type="number" min={0} max={maxR} value={corners.bl} onChange={(e) => setCorner('bl', Number(e.target.value))} />
                </div>
                <div className="corner-cell">
                  <label>右下</label>
                  <input type="number" min={0} max={maxR} value={corners.br} onChange={(e) => setCorner('br', Number(e.target.value))} />
                </div>
              </div>
            )}
          </Section>
        )}

        <button className="btn primary block" disabled={!img} onClick={download}>
          ⬇ 导出 PNG
        </button>
        {tip && <div className="hint">{tip}</div>}
        <div className="hint">默认导出 PNG 保留透明通道；若想再压体积，可在「智能压缩」工具中处理。</div>
      </div>
    </ToolLayout>
  )
}
