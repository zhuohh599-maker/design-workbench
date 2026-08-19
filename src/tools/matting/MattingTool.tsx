import { useState, useRef, useEffect } from 'react'
import { removeBackground } from '@imgly/background-removal'
import JSZip from 'jszip'
import { ToolLayout, DropZone, Section, CompressControls, useSmartCompress } from '../../core/components'
import { formatBytes, downloadBlob, blobExt } from '../../core/utils/image'
import { ACCEPT_IMAGES } from '../../core/types'

type EditMode = 'brush' | 'wand' | 'lasso'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = reject
    i.src = src
  })
}

export default function MattingTool() {
  const [src, setSrc] = useState<string>('') // 原图预览
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [step, setStep] = useState('')
  const [err, setErr] = useState('')
  const [origName, setOrigName] = useState('')
  const [origBytes, setOrigBytes] = useState(0)
  const [tip, setTip] = useState('')
  const [hasResult, setHasResult] = useState(false)
  const [mode, setMode] = useState<EditMode>('brush')
  const [brush, setBrush] = useState(30)
  const [showMask, setShowMask] = useState(false)
  const [showOrig, setShowOrig] = useState(false) // 叠加原图参考，便于定位被扣内容
  const [wandTol, setWandTol] = useState(32)
  const [wandKeep, setWandKeep] = useState(true)
  const [lassoKeep, setLassoKeep] = useState(true)
  const [canUndo, setCanUndo] = useState(false)
  const [slices, setSlices] = useState<{ id: number; url: string; blob: Blob; w: number; h: number }[]>([])
  const [splitting, setSplitting] = useState(false)
  const [sliceMin, setSliceMin] = useState(100)

  // 离屏画布：原图 / alpha 蒙版（白=保留，透明=删除）
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const srcImgRef = useRef<HTMLImageElement | null>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef<HTMLCanvasElement | null>(null)
  const historyRef = useRef<ImageData[]>([])
  const drawingRef = useRef(false)
  const lastPtRef = useRef<{ x: number; y: number } | null>(null)
  const lassoPtsRef = useRef<{ x: number; y: number }[]>([])
  const lassoCursorRef = useRef<{ x: number; y: number } | null>(null)
  const origDataRef = useRef<ImageData | null>(null) // 原图像素缓存，供魔棒取样
  const c = useSmartCompress()

  // 把原图与蒙版合成到显示画布（可选叠加原图参考 / 蒙版预览 / 套索预览）
  function compose(overlayMask = showMask) {
    const view = viewRef.current
    const srcC = srcCanvasRef.current
    const mask = maskCanvasRef.current
    if (!view || !srcC || !mask) return
    const ctx = view.getContext('2d')!
    view.width = srcC.width
    view.height = srcC.height
    ctx.clearRect(0, 0, view.width, view.height)
    // 结果 = 原图 ∩ 蒙版
    ctx.drawImage(srcC, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(mask, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    // 叠加原图参考（半透明），便于在被扣区域定位要保留的内容
    if (showOrig) {
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.drawImage(srcC, 0, 0)
      ctx.restore()
    }
    if (overlayMask) {
      ctx.save()
      ctx.globalAlpha = 0.45
      ctx.drawImage(mask, 0, 0)
      ctx.restore()
    }
    // 套索预览
    const pts = lassoPtsRef.current
    const cur = lassoCursorRef.current
    if (pts.length > 0) {
      ctx.save()
      ctx.strokeStyle = '#3b82f6'
      ctx.fillStyle = 'rgba(59,130,246,0.15)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      if (cur) ctx.lineTo(cur.x, cur.y)
      if (pts.length > 2 && !cur) ctx.closePath()
      if (cur) ctx.stroke()
      else ctx.fill()
      ctx.restore()
      // 顶点
      ctx.save()
      ctx.fillStyle = '#3b82f6'
      for (const p of pts) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
  }

  function pushHistory() {
    const mask = maskCanvasRef.current
    if (!mask) return
    const d = mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height)
    historyRef.current.push(d)
    if (historyRef.current.length > 25) historyRef.current.shift()
    setCanUndo(true)
  }

  function undo() {
    const mask = maskCanvasRef.current
    if (!mask || historyRef.current.length === 0) return
    const d = historyRef.current.pop()!
    mask.getContext('2d')!.putImageData(d, 0, 0)
    setCanUndo(historyRef.current.length > 0)
    compose()
  }

  function toImg(e: React.PointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current!
    const r = view.getBoundingClientRect()
    return {
      x: (e.clientX - r.left) * (view.width / r.width),
      y: (e.clientY - r.top) * (view.height / r.height),
    }
  }

  // 画笔精修：擦除/恢复用独立标记
  const brushEraseRef = useRef(true)
  function paintErase(x: number, y: number) {
    const mask = maskCanvasRef.current
    if (!mask) return
    const ctx = mask.getContext('2d')!
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalCompositeOperation = brushEraseRef.current ? 'destination-out' : 'source-over'
    if (!brushEraseRef.current) {
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#fff'
    }
    if (lastPtRef.current) {
      ctx.beginPath()
      ctx.moveTo(lastPtRef.current.x, lastPtRef.current.y)
      ctx.lineTo(x, y)
      ctx.lineWidth = brush
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(x, y, brush / 2, 0, Math.PI * 2)
    ctx.fill()
    lastPtRef.current = { x, y }
  }

  // 将选区画布（白=选区）应用到蒙版：keep=保留(叠加白)，remove=删除(擦除)
  function applySelection(sel: HTMLCanvasElement, keep: boolean) {
    const mask = maskCanvasRef.current
    if (!mask) return
    const mctx = mask.getContext('2d')!
    pushHistory()
    mctx.globalCompositeOperation = keep ? 'source-over' : 'destination-out'
    mctx.drawImage(sel, 0, 0)
    mctx.globalCompositeOperation = 'source-over'
    compose()
  }

  // 魔棒：以原图像素为基准，从点击点做颜色连通域洪泛，生成选区
  function magicWand(sx: number, sy: number) {
    const srcC = srcCanvasRef.current
    const mask = maskCanvasRef.current
    if (!srcC || !mask) return
    const w = srcC.width
    const h = srcC.height
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return
    if (!origDataRef.current) {
      origDataRef.current = srcC.getContext('2d')!.getImageData(0, 0, w, h)
    }
    const data = origDataRef.current.data
    const ti = (sy * w + sx) * 4
    const tr = data[ti]
    const tg = data[ti + 1]
    const tb = data[ti + 2]
    const thr = wandTol * wandTol
    const sel = new Uint8Array(w * h)
    const stack: number[] = [sy * w + sx]
    while (stack.length) {
      const p = stack.pop()!
      if (sel[p]) continue
      const i = p * 4
      const dr = data[i] - tr
      const dg = data[i + 1] - tg
      const db = data[i + 2] - tb
      if (dr * dr + dg * dg + db * db > thr) continue
      sel[p] = 1
      const x = p % w
      const y = (p / w) | 0
      if (x > 0) stack.push(p - 1)
      if (x < w - 1) stack.push(p + 1)
      if (y > 0) stack.push(p - w)
      if (y < h - 1) stack.push(p + w)
    }
    const sc = document.createElement('canvas')
    sc.width = w
    sc.height = h
    const sctx = sc.getContext('2d')!
    const id = sctx.createImageData(w, h)
    for (let p = 0; p < w * h; p++) {
      if (sel[p]) {
        id.data[p * 4] = 255
        id.data[p * 4 + 1] = 255
        id.data[p * 4 + 2] = 255
        id.data[p * 4 + 3] = 255
      }
    }
    sctx.putImageData(id, 0, 0)
    applySelection(sc, wandKeep)
  }

  // 套索：用当前顶点闭合多边形，填充为选区
  function finishLasso() {
    const pts = lassoPtsRef.current
    if (pts.length < 3) {
      lassoPtsRef.current = []
      lassoCursorRef.current = null
      compose()
      return
    }
    const w = srcCanvasRef.current!.width
    const h = srcCanvasRef.current!.height
    const sc = document.createElement('canvas')
    sc.width = w
    sc.height = h
    const sctx = sc.getContext('2d')!
    sctx.fillStyle = '#fff'
    sctx.beginPath()
    sctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) sctx.lineTo(pts[i].x, pts[i].y)
    sctx.closePath()
    sctx.fill()
    lassoPtsRef.current = []
    lassoCursorRef.current = null
    applySelection(sc, lassoKeep)
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!hasResult) return
    e.preventDefault()
    const p = toImg(e)
    if (mode === 'brush') {
      pushHistory()
      drawingRef.current = true
      lastPtRef.current = null
      ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
      paintErase(p.x, p.y)
      compose()
    } else if (mode === 'wand') {
      magicWand(Math.round(p.x), Math.round(p.y))
    } else {
      // 套索：每次点击添加一个顶点
      lassoPtsRef.current.push(p)
      compose()
    }
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode === 'brush' && drawingRef.current) {
      const p = toImg(e)
      paintErase(p.x, p.y)
      compose()
    } else if (mode === 'lasso') {
      lassoCursorRef.current = toImg(e)
      compose()
    }
  }
  function onUp() {
    if (mode === 'brush' && drawingRef.current) {
      drawingRef.current = false
      lastPtRef.current = null
    }
  }
  function onDouble() {
    if (mode === 'lasso') finishLasso()
  }

  // 首张图上传：hasResult 变 true 后 canvas 才挂载，等提交后再绘制，避免 viewRef 未就绪导致空白
  useEffect(() => {
    if (hasResult) requestAnimationFrame(() => compose())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasResult])

  // 支持 Cmd/Ctrl+Z 撤销（历史栈由画笔/魔棒/套索共用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onFile(file: File) {
    setErr('')
    setHasResult(false)
    setProgress(0)
    setStep('准备模型…')
    setOrigName(file.name)
    setOrigBytes(file.size)
    const srcUrl = URL.createObjectURL(file)
    setSrc(srcUrl)

    let srcImg: HTMLImageElement
    try {
      srcImg = await loadImage(srcUrl)
      srcImgRef.current = srcImg
    } catch {
      setErr('图片读取失败')
      return
    }

    setBusy(true)
    try {
      const blob = await removeBackground(file, {
        output: { format: 'image/png' },
        progress: (key: string, current: number, total: number) => {
          const p = total ? Math.round((current / total) * 100) : 0
          setProgress(p)
          const map: Record<string, string> = {
            fetch: '下载模型',
            compute: 'AI 推理去背景',
            pack: '生成透明图',
          }
          setStep(map[key] ?? key)
        },
      })
      const resImg = await loadImage(URL.createObjectURL(blob))
      // 始终使用原图真实像素尺寸，避免被 display width/height 或 EXIF 方向影响比例
      const sc = document.createElement('canvas')
      sc.width = srcImg.naturalWidth
      sc.height = srcImg.naturalHeight
      sc.getContext('2d')!.drawImage(srcImg, 0, 0)
      srcCanvasRef.current = sc
      const mask = document.createElement('canvas')
      mask.width = resImg.naturalWidth
      mask.height = resImg.naturalHeight
      const mctx = mask.getContext('2d')!
      mctx.drawImage(resImg, 0, 0)
      const d = mctx.getImageData(0, 0, mask.width, mask.height)
      for (let i = 0; i < d.data.length; i += 4) {
        d.data[i] = 255
        d.data[i + 1] = 255
        d.data[i + 2] = 255
      }
      mctx.putImageData(d, 0, 0)
      maskCanvasRef.current = mask
      origDataRef.current = null
      historyRef.current = []
      lassoPtsRef.current = []
      lassoCursorRef.current = null
      setHasResult(true)
      requestAnimationFrame(() => compose())
    } catch (e) {
      setErr('抠图失败：' + (e as Error).message + '\n（首次使用需联网下载 AI 模型，请确认网络畅通）')
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  async function download() {
    const view = viewRef.current
    if (!view || !hasResult) return
    setTip('')
    compose(false)
    const blob = await new Promise<Blob | null>((res) => view.toBlob(res, 'image/png'))
    if (!blob) return
    let out = blob
    const orig = out.size
    out = await c.run(out)
    const ext = blobExt(out)
    downloadBlob(out, `${origName.replace(/\.[^.]+$/, '')}-nocutout.${ext}`)
    setTip(
      `${c.compress ? `智能压缩 ${formatBytes(orig)} → ${formatBytes(out.size)}` : `已导出 ${formatBytes(out.size)}`}`,
    )
  }

  // 拆分元素：基于当前结果图的透明区域，做 4-连通区域检测，为每个独立元素裁剪为单张透明 PNG
  async function splitElements() {
    const srcC = srcCanvasRef.current
    const mask = maskCanvasRef.current
    if (!srcC || !mask) return
    const w = srcC.width
    const h = srcC.height
    if (w === 0 || h === 0) return
    setSplitting(true)
    slices.forEach((s) => URL.revokeObjectURL(s.url))
    setSlices([])
    try {
      // 合成纯前景（原图 ∩ 蒙版），与显示叠加无关
      const fg = document.createElement('canvas')
      fg.width = w
      fg.height = h
      const fctx = fg.getContext('2d')!
      fctx.drawImage(srcC, 0, 0)
      fctx.globalCompositeOperation = 'destination-in'
      fctx.drawImage(mask, 0, 0)
      fctx.globalCompositeOperation = 'source-over'
      const data = fctx.getImageData(0, 0, w, h).data
      const visited = new Uint8Array(w * h)
      const minArea = Math.max(1, sliceMin)
      const boxes: { minX: number; minY: number; maxX: number; maxY: number; count: number }[] = []
      const stack: number[] = []
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x
          if (visited[idx]) continue
          if (data[idx * 4 + 3] < 16) {
            visited[idx] = 1
            continue
          }
          // 新区域：BFS 收集边界盒
          let minX = x
          let minY = y
          let maxX = x
          let maxY = y
          let count = 0
          stack.length = 0
          stack.push(idx)
          visited[idx] = 1
          while (stack.length) {
            const p = stack.pop()!
            count++
            const px = p % w
            const py = (p / w) | 0
            if (px < minX) minX = px
            if (px > maxX) maxX = px
            if (py < minY) minY = py
            if (py > maxY) maxY = py
            if (px > 0) {
              const n = p - 1
              if (!visited[n] && data[n * 4 + 3] >= 16) {
                visited[n] = 1
                stack.push(n)
              }
            }
            if (px < w - 1) {
              const n = p + 1
              if (!visited[n] && data[n * 4 + 3] >= 16) {
                visited[n] = 1
                stack.push(n)
              }
            }
            if (py > 0) {
              const n = p - w
              if (!visited[n] && data[n * 4 + 3] >= 16) {
                visited[n] = 1
                stack.push(n)
              }
            }
            if (py < h - 1) {
              const n = p + w
              if (!visited[n] && data[n * 4 + 3] >= 16) {
                visited[n] = 1
                stack.push(n)
              }
            }
          }
          if (count >= minArea) boxes.push({ minX, minY, maxX, maxY, count })
        }
      }
      // 行优先排序，结果顺序更直观
      boxes.sort((a, b) => a.minY - b.minY || a.minX - b.minX)
      const pad = 2
      const out: { id: number; url: string; blob: Blob; w: number; h: number }[] = []
      for (let k = 0; k < boxes.length; k++) {
        const it = boxes[k]
        const cx = Math.max(0, it.minX - pad)
        const cy = Math.max(0, it.minY - pad)
        const cw = Math.min(w, it.maxX + 1 + pad) - cx
        const ch = Math.min(h, it.maxY + 1 + pad) - cy
        const sc = document.createElement('canvas')
        sc.width = cw
        sc.height = ch
        const sctx = sc.getContext('2d')!
        sctx.drawImage(fg, cx, cy, cw, ch, 0, 0, cw, ch)
        const blob = await new Promise<Blob | null>((res) => sc.toBlob(res, 'image/png'))
        if (!blob) continue
        out.push({ id: k + 1, url: URL.createObjectURL(blob), blob, w: cw, h: ch })
      }
      setSlices(out)
    } finally {
      setSplitting(false)
    }
  }

  // 全部下载为 ZIP
  async function downloadAllSlices() {
    if (slices.length === 0) return
    const zip = new JSZip()
    const base = origName.replace(/\.[^.]+$/, '')
    for (const s of slices) {
      zip.file(`${base}-element_${String(s.id).padStart(3, '0')}.png`, s.blob)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${base}-elements.zip`)
  }

  // 画笔擦除/恢复（仅 brush 模式用 sub-toggle）
  const [brushErase, setBrushErase] = useState(true)
  useEffect(() => {
    brushEraseRef.current = brushErase
  }, [brushErase])

  return (
    <ToolLayout
      title="AI 抠图"
      description="AI 去背景，输出透明 PNG。结果可画笔精修、魔棒或套索选区调整。"
    >
      <div className="card">
        <DropZone
          onFile={onFile}
          accept={ACCEPT_IMAGES}
          label="拖入或选择一张图片（人像/物体均可）"
        />
        {src && (
          <div className="row" style={{ marginTop: 14, alignItems: 'stretch' }}>
            <div className="preview" style={{ flex: 1 }}>
              <img src={src} alt="原图" />
            </div>
            <div className="preview" style={{ flex: 1 }}>
              {hasResult ? (
                <canvas
                  ref={viewRef}
                  className="matting-canvas"
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerLeave={onUp}
                  onDoubleClick={onDouble}
                />
              ) : (
                <span className="muted">{busy ? '处理中…' : '结果将显示在这里'}</span>
              )}
            </div>
          </div>
        )}
        {busy && (
          <div className="progress" style={{ marginTop: 12 }}>
            <i style={{ width: `${progress}%` }} />
          </div>
        )}
        {busy && <div className="hint">{step} · {progress}%</div>}
        {err && (
          <div className="hint" style={{ color: '#b91c1c', whiteSpace: 'pre-wrap' }}>
            {err}
          </div>
        )}
      </div>

      <div className="panel">
        <Section title="编辑方式">
          {hasResult ? (
            <div className="seg">
              <button
                className={`seg-btn ${mode === 'brush' ? 'on' : ''}`}
                onClick={() => setMode('brush')}
              >
                画笔精修
              </button>
              <button
                className={`seg-btn ${mode === 'wand' ? 'on' : ''}`}
                onClick={() => setMode('wand')}
              >
                魔棒
              </button>
              <button
                className={`seg-btn ${mode === 'lasso' ? 'on' : ''}`}
                onClick={() => setMode('lasso')}
              >
                套索
              </button>
            </div>
          ) : (
            <div className="hint">上传图片、AI 去背景后，可在此精修或选区调整。</div>
          )}
        </Section>

        {hasResult && (
          <Section title="操作">
            <button className="btn block" disabled={!canUndo} onClick={undo}>
              ↶ 撤销（Cmd/Ctrl+Z）
            </button>
            <button
              className="btn block"
              style={{ marginTop: 10 }}
              onClick={splitElements}
              disabled={splitting}
            >
              {splitting ? '拆分中…' : '✂ 拆分元素（按连通区域）'}
            </button>
            <div className="field" style={{ marginTop: 10 }}>
              <label>最小元素面积 {sliceMin}px²</label>
              <input
                type="range"
                min={10}
                max={2000}
                value={sliceMin}
                onChange={(e) => setSliceMin(Number(e.target.value))}
              />
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              基于当前结果图的透明区域自动检测独立元素，拆分为单张透明 PNG。调大面积可滤除噪点。
            </div>
          </Section>
        )}

        {hasResult && mode === 'brush' && (
          <Section title="画笔">
            <div className="seg">
              <button
                className={`seg-btn ${brushErase ? 'on' : ''}`}
                onClick={() => setBrushErase(true)}
              >
                擦除
              </button>
              <button
                className={`seg-btn ${!brushErase ? 'on' : ''}`}
                onClick={() => setBrushErase(false)}
              >
                恢复
              </button>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>笔刷大小 {brush}px</label>
              <input
                type="range"
                min={4}
                max={120}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
              />
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              在结果上拖动：擦除=去掉多余部分，恢复=补回被误删的主体。
            </div>
          </Section>
        )}

        {hasResult && mode === 'wand' && (
          <Section title="魔棒">
            <div className="seg">
              <button
                className={`seg-btn ${wandKeep ? 'on' : ''}`}
                onClick={() => setWandKeep(true)}
              >
                保留所选
              </button>
              <button
                className={`seg-btn ${!wandKeep ? 'on' : ''}`}
                onClick={() => setWandKeep(false)}
              >
                删除所选
              </button>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>容差 {wandTol}</label>
              <input
                type="range"
                min={0}
                max={128}
                value={wandTol}
                onChange={(e) => setWandTol(Number(e.target.value))}
              />
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              点击颜色相近的连通区域即可选中。需找回被误删的内容时，勾选下方「显示原图参考」，在原图上点选该区域后选「保留所选」。
            </div>
          </Section>
        )}

        {hasResult && mode === 'lasso' && (
          <Section title="套索">
            <div className="seg">
              <button
                className={`seg-btn ${lassoKeep ? 'on' : ''}`}
                onClick={() => setLassoKeep(true)}
              >
                保留所选
              </button>
              <button
                className={`seg-btn ${!lassoKeep ? 'on' : ''}`}
                onClick={() => setLassoKeep(false)}
              >
                删除所选
              </button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={finishLasso}>
                闭合并应用
              </button>
              <button
                className="btn"
                onClick={() => {
                  lassoPtsRef.current = []
                  lassoCursorRef.current = null
                  compose()
                }}
              >
                取消
              </button>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              沿物体边缘依次点击添加顶点，双击或点「闭合并应用」生成选区。需找回被误删内容时，勾选「显示原图参考」后在原图上描边。
            </div>
          </Section>
        )}

        {hasResult && (
          <Section title="显示">
            <label className="check">
              <input
                type="checkbox"
                checked={showOrig}
                onChange={(e) => {
                  setShowOrig(e.target.checked)
                  compose()
                }}
              />
              显示原图参考（半透明，定位被扣内容）
            </label>
            <label className="check" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={showMask}
                onChange={(e) => {
                  setShowMask(e.target.checked)
                  compose()
                }}
              />
              显示保留蒙版（白=保留）
            </label>
          </Section>
        )}

        {slices.length > 0 && (
          <Section title={`拆分结果（${slices.length}）`}>
            <div className="slice-grid">
              {slices.map((s) => (
                <div className="slice-item" key={s.id}>
                  <div className="slice-thumb">
                    <img src={s.url} alt={`element ${s.id}`} />
                  </div>
                  <div className="slice-meta">
                    {s.id}. {s.w}×{s.h}
                  </div>
                  <button
                    className="btn tiny"
                    onClick={() =>
                      downloadBlob(
                        s.blob,
                        `${origName.replace(/\.[^.]+$/, '')}-element_${String(s.id).padStart(3, '0')}.png`,
                      )
                    }
                  >
                    下载
                  </button>
                </div>
              ))}
            </div>
            <button className="btn primary block" style={{ marginTop: 10 }} onClick={downloadAllSlices}>
              ⬇ 全部下载（ZIP）
            </button>
          </Section>
        )}

        <Section title="结果">
          {hasResult ? (
            <>
              <div className="stat">
                <span>原图</span>
                <span className="v">{formatBytes(origBytes)}</span>
              </div>
              <button className="btn primary block" style={{ marginTop: 12 }} onClick={download}>
                ⬇ 导出透明 PNG
              </button>
              <CompressControls
                compress={c.compress}
                setCompress={c.setCompress}
                quality={c.quality}
                setQuality={c.setQuality}
              />
              {tip && <div className="hint">{tip}</div>}
            </>
          ) : (
            <div className="hint">上传图片后，AI 会自动去除背景并生成透明 PNG。</div>
          )}
        </Section>

        <div className="hint">
          首次使用会在后台下载 AI 模型（仅一次，之后走浏览器缓存）。处理在人像与主体清晰的图像上效果最佳。
        </div>
      </div>
    </ToolLayout>
  )
}
