import { useRef, useState, useEffect } from 'react'
import { ToolLayout, DropZone, Section, Slider, CompressControls, useSmartCompress, usePasteImport } from '../../core/components'
import { loadImageFromFile, downloadBlob, blobExt, formatBytes } from '../../core/utils/image'
import { encodeApng, type GifFrame } from '../../core/utils/gif'

type EffectKind = 'pulse' | 'slide' | 'shimmer' | 'fade' | 'spin'

interface Effect {
  id: string
  kind: EffectKind
  amp: number // 幅度（含义随类型而变）
  intensity?: number // 扫光强度 0~100
  angle?: number // 扫光角度（度）
}

interface Layer {
  id: string
  name: string
  img: HTMLImageElement
  x: number
  y: number
  scale: number
  rotation: number
  effects: Effect[]
  visible: boolean
}

interface Offscreen {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

const EFFECT_LABELS: Record<EffectKind, string> = {
  pulse: '脉冲放大缩小',
  slide: '左右滑动',
  shimmer: '扫光',
  fade: '淡入淡出',
  spin: '旋转',
}

function uid() {
  return Math.random().toString(36).slice(2, 9)
}

function makeEffect(kind: EffectKind): Effect {
  switch (kind) {
    case 'pulse':
      return { id: uid(), kind, amp: 15 }
    case 'slide':
      return { id: uid(), kind, amp: 20 }
    case 'shimmer':
      return { id: uid(), kind, amp: 50, intensity: 70, angle: 0 }
    case 'fade':
      return { id: uid(), kind, amp: 0 }
    case 'spin':
      return { id: uid(), kind, amp: 360 }
  }
}

/** 计算某图层在相位 t(0~1) 下的实际变换（汇总所有动效） */
function applyEffects(l: Layer, t: number) {
  let scale = l.scale
  let x = l.x
  let y = l.y
  let rotation = l.rotation
  let alpha = 1
  const phase = Math.sin(t * Math.PI * 2)
  for (const e of l.effects) {
    switch (e.kind) {
      case 'pulse':
        scale *= 1 + e.amp * 0.01 * phase
        break
      case 'slide':
        x += e.amp * phase
        break
      case 'spin':
        rotation += e.amp * phase
        break
      case 'fade': {
        const minA = e.amp * 0.01
        alpha *= minA + (1 - minA) * (0.5 + 0.5 * phase)
        break
      }
      // shimmer 为像素级高光，不影响变换
    }
  }
  return { scale, x, y, rotation, alpha }
}

/** 选中元素的变换控件坐标（旋转柄 / 缩放柄 / 角点），基于静态变换 */
function computeHandles(l: Layer) {
  const { scale } = applyEffects(l, 0)
  const dw = l.img.naturalWidth * scale
  const dh = l.img.naturalHeight * scale
  const r = (l.rotation * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const rot = (px: number, py: number) => ({
    x: l.x + px * cos - py * sin,
    y: l.y + px * sin + py * cos,
  })
  return {
    resize: rot(dw / 2, dh / 2),
    rot: rot(0, -(dh / 2 + 26)),
    top: rot(0, -dh / 2),
    corners: [rot(-dw / 2, -dh / 2), rot(dw / 2, -dh / 2), rot(dw / 2, dh / 2), rot(-dw / 2, dh / 2)],
  }
}

/** 绘制单个元素；shimmer 用离屏画布 + source-atop 隔离，高光只在素材不透明范围内，并支持强度/角度 */
function drawElement(ctx: CanvasRenderingContext2D, l: Layer, t: number, getOff: () => Offscreen) {
  if (!l.visible) return
  const { scale, x, y, rotation, alpha } = applyEffects(l, t)
  const dw = l.img.naturalWidth * scale
  const dh = l.img.naturalHeight * scale
  const shimmer = l.effects.find((e) => e.kind === 'shimmer')
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  ctx.rotate((rotation * Math.PI) / 180)
  if (shimmer) {
    const off = getOff()
    off.canvas.width = Math.max(1, Math.ceil(dw))
    off.canvas.height = Math.max(1, Math.ceil(dh))
    const octx = off.ctx
    octx.clearRect(0, 0, off.canvas.width, off.canvas.height)
    octx.drawImage(l.img, 0, 0, dw, dh)
    // source-atop：只在已绘制的（即素材自身）像素上叠加高光
    octx.save()
    octx.globalCompositeOperation = 'source-atop'
    const wband = dw * (shimmer.amp / 100)
    const ang = ((shimmer.angle ?? 0) * Math.PI) / 180
    octx.translate(dw / 2, dh / 2)
    octx.rotate(ang)
    const span = dw + wband
    const bx = -wband + span * t // 沿方向扫过
    const intensity = (shimmer.intensity ?? 70) / 100
    const g = octx.createLinearGradient(bx, 0, bx + wband, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.5, `rgba(255,255,255,${intensity})`)
    g.addColorStop(1, 'rgba(255,255,255,0)')
    octx.fillStyle = g
    const big = Math.max(dw, dh) * 3
    octx.fillRect(bx - 2, -big, wband + 4, big * 2)
    octx.restore()
    ctx.drawImage(off.canvas, 0, 0, off.canvas.width, off.canvas.height, -dw / 2, -dh / 2, dw, dh)
  } else {
    ctx.drawImage(l.img, -dw / 2, -dh / 2, dw, dh)
  }
  ctx.restore()
}

export default function AnimakerTool() {
  const [layers, setLayers] = useState<Layer[]>([])
  const [boardW, setBoardW] = useState(480)
  const [boardH, setBoardH] = useState(480)
  const [bg, setBg] = useState('transparent')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [duration, setDuration] = useState(2)
  const [fps, setFps] = useState(20)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tip, setTip] = useState('')
  const [tipKind, setTipKind] = useState<'info' | 'success' | 'error'>('info')
  const [progress, setProgress] = useState(0)
  const [addKind, setAddKind] = useState<EffectKind>('pulse')
  const [dither, setDither] = useState(false)
  const c = useSmartCompress()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offRef = useRef<Offscreen | null>(null)
  const playRef = useRef(false)
  const dragRef = useRef<{ id: string; mode: 'move' | 'rotate' | 'scale'; dx: number; dy: number } | null>(null)

  const getOff = () => {
    if (!offRef.current) {
      const c = document.createElement('canvas')
      offRef.current = { canvas: c, ctx: c.getContext('2d')! }
    }
    return offRef.current
  }

  function draw(t: number) {
    const cv = canvasRef.current
    if (!cv) return
    cv.width = boardW
    cv.height = boardH
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, boardW, boardH)
    if (bg !== 'transparent') {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, boardW, boardH)
    }
    for (const l of layers) drawElement(ctx, l, t, getOff)
    // 选中控件（播放时不显示）
    if (!playRef.current && selectedId) {
      const sel = layers.find((l) => l.id === selectedId)
      if (sel && sel.visible) drawSelection(ctx, sel)
    }
  }

  function drawSelection(ctx: CanvasRenderingContext2D, l: Layer) {
    const h = computeHandles(l)
    ctx.save()
    ctx.strokeStyle = '#4f46e5'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(h.corners[0].x, h.corners[0].y)
    for (let i = 1; i < 4; i++) ctx.lineTo(h.corners[i].x, h.corners[i].y)
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
    // 旋转连杆 + 柄
    ctx.beginPath()
    ctx.moveTo(h.top.x, h.top.y)
    ctx.lineTo(h.rot.x, h.rot.y)
    ctx.stroke()
    ctx.fillStyle = '#4f46e5'
    ctx.beginPath()
    ctx.arc(h.rot.x, h.rot.y, 7, 0, Math.PI * 2)
    ctx.fill()
    // 缩放柄（右下角方块）
    ctx.fillStyle = '#fff'
    ctx.fillRect(h.resize.x - 6, h.resize.y - 6, 12, 12)
    ctx.strokeRect(h.resize.x - 6, h.resize.y - 6, 12, 12)
    ctx.restore()
  }

  // 静态重绘
  useEffect(() => {
    if (!playing) draw(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, boardW, boardH, bg, selectedId, playing])

  // 播放循环
  useEffect(() => {
    playRef.current = playing
    if (!playing) {
      draw(0)
      return
    }
    let raf = 0
    const dur = duration * 1000
    const loop = (ts: number) => {
      const t = (ts % dur) / dur
      draw(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration])

  async function addElements(files: FileList | File[]) {
    const list = Array.from(files)
    const newLayers: Layer[] = []
    for (const f of list) {
      const img = await loadImageFromFile(f)
      newLayers.push({
        id: uid(),
        name: f.name,
        img,
        x: 0,
        y: 0,
        scale: 1, // 默认 100%
        rotation: 0,
        effects: [],
        visible: true,
      })
    }
    const merged = [...layers, ...newLayers]
    // 画布默认 = 所有素材中最大元素的尺寸
    let maxW = 0
    let maxH = 0
    for (const l of merged) {
      maxW = Math.max(maxW, l.img.naturalWidth)
      maxH = Math.max(maxH, l.img.naturalHeight)
    }
    // 新素材 100% 居中（轻微错位避免完全重叠）
    merged.slice(layers.length).forEach((l, k) => {
      l.x = maxW / 2 + k * 18
      l.y = maxH / 2 + k * 18
    })
    setLayers(merged)
    if (maxW) setBoardW(maxW)
    if (maxH) setBoardH(maxH)
    setSelectedId(newLayers[newLayers.length - 1].id)
  }

  // 粘贴导入：剪贴板里的图片直接作为画板元素添加
  usePasteImport((f) => addElements([f]), 'image/')

  function updateSelected(patch: Partial<Layer>) {
    setLayers((prev) => prev.map((l) => (l.id === selectedId ? { ...l, ...patch } : l)))
  }

  /** dir=+1 向画布顶层移动（数组末尾），dir=-1 向底层移动 */
  function moveLayer(id: string, dir: -1 | 1) {
    setLayers((prev) => {
      const i = prev.findIndex((l) => l.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function toggleVisible(id: string) {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)))
  }

  function removeLayer(id: string) {
    setLayers((prev) => prev.filter((l) => l.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  // 动效叠加管理
  function addEffect(kind: EffectKind) {
    const e = makeEffect(kind)
    setLayers((prev) => prev.map((l) => (l.id === selectedId ? { ...l, effects: [...l.effects, e] } : l)))
  }
  function updateEffect(eid: string, patch: Partial<Effect>) {
    setLayers((prev) =>
      prev.map((l) =>
        l.id === selectedId ? { ...l, effects: l.effects.map((e) => (e.id === eid ? { ...e, ...patch } : e)) } : l,
      ),
    )
  }
  function removeEffect(eid: string) {
    setLayers((prev) => prev.map((l) => (l.id === selectedId ? { ...l, effects: l.effects.filter((e) => e.id !== eid) } : l)))
  }

  // 画布交互
  function toBoard(e: React.MouseEvent) {
    const cv = canvasRef.current!
    const r = cv.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * boardW,
      y: ((e.clientY - r.top) / r.height) * boardH,
    }
  }
  function onDown(e: React.MouseEvent) {
    const { x, y } = toBoard(e)
    const sel = layers.find((l) => l.id === selectedId)
    if (sel && sel.visible) {
      const h = computeHandles(sel)
      if (Math.hypot(x - h.rot.x, y - h.rot.y) < 12) {
        dragRef.current = { id: sel.id, mode: 'rotate', dx: 0, dy: 0 }
        return
      }
      if (Math.hypot(x - h.resize.x, y - h.resize.y) < 12) {
        dragRef.current = { id: sel.id, mode: 'scale', dx: 0, dy: 0 }
        return
      }
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]
      if (!l.visible) continue
      const { scale } = applyEffects(l, 0)
      const dw = l.img.naturalWidth * scale
      const dh = l.img.naturalHeight * scale
      if (x >= l.x - dw / 2 && x <= l.x + dw / 2 && y >= l.y - dh / 2 && y <= l.y + dh / 2) {
        setSelectedId(l.id)
        dragRef.current = { id: l.id, mode: 'move', dx: x - l.x, dy: y - l.y }
        return
      }
    }
    setSelectedId(null)
  }
  function onMove(e: React.MouseEvent) {
    const drag = dragRef.current
    if (!drag) return
    const { x, y } = toBoard(e)
    if (drag.mode === 'move') {
      setLayers((prev) => prev.map((l) => (l.id === drag.id ? { ...l, x: x - drag.dx, y: y - drag.dy } : l)))
    } else if (drag.mode === 'rotate') {
      const l = layers.find((z) => z.id === drag.id)
      if (!l) return
      const ang = (Math.atan2(y - l.y, x - l.x) * 180) / Math.PI + 90
      setLayers((prev) => prev.map((z) => (z.id === drag.id ? { ...z, rotation: ang } : z)))
    } else if (drag.mode === 'scale') {
      const l = layers.find((z) => z.id === drag.id)
      if (!l) return
      const hd0 = Math.hypot(l.img.naturalWidth / 2, l.img.naturalHeight / 2)
      const d = Math.hypot(x - l.x, y - l.y)
      const s = Math.min(10, Math.max(0.05, d / hd0))
      setLayers((prev) => prev.map((z) => (z.id === drag.id ? { ...z, scale: s } : z)))
    }
  }
  function onUp() {
    dragRef.current = null
  }

  function collectFrames(): GifFrame[] {
    const visible = layers.filter((l) => l.visible)
    const n = Math.max(2, Math.round(duration * fps))
    const frames: GifFrame[] = []
    const cv = document.createElement('canvas')
    cv.width = boardW
    cv.height = boardH
    const cx = cv.getContext('2d')!
    for (let i = 0; i < n; i++) {
      const t = i / n
      cx.clearRect(0, 0, boardW, boardH)
      if (bg !== 'transparent') {
        cx.fillStyle = bg
        cx.fillRect(0, 0, boardW, boardH)
      }
      for (const l of visible) drawElement(cx, l, t, getOff)
      const data = cx.getImageData(0, 0, boardW, boardH).data
      frames.push({ rgba: new Uint8ClampedArray(data), delay: Math.round(1000 / fps) })
    }
    return frames
  }

  async function exportGif() {
    if (layers.length === 0) return
    setBusy(true)
    setTipKind('info')
    setTip('准备导出…')
    setProgress(5)
    try {
      const frames = collectFrames()
      setTip('后台生成 APNG 并转码为 GIF…')
      // 把帧的 ArrayBuffer 转移给 Worker，避免大块内存拷贝、主线程不卡顿
      const transfer = frames.map((f) => f.rgba.buffer)
      const blob = await new Promise<Blob>((resolve, reject) => {
        const worker = new Worker(new URL('../../core/utils/gifWorker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (ev: MessageEvent) => {
          if (ev.data?.type === 'progress') {
            setTip(ev.data.text || '处理中…')
            setProgress(ev.data.percent || 0)
            return
          }
          worker.terminate()
          if (ev.data?.ok) resolve(new Blob([ev.data.bytes], { type: 'image/gif' }))
          else reject(new Error(ev.data?.error || 'GIF 转码失败'))
        }
        worker.onerror = (err) => {
          worker.terminate()
          reject(new Error(err.message || 'GIF Worker 异常'))
        }
        worker.postMessage(
          { width: boardW, height: boardH, frames, transparent: bg === 'transparent', paletteSize: 256, dither },
          transfer,
        )
      })
      setTip('智能压缩中…')
      setProgress(95)
      let out = await c.run(blob)
      setProgress(100)
      const ext = blobExt(out)
      downloadBlob(out, `animaker-${boardW}x${boardH}${bg === 'transparent' ? '-alpha' : ''}.${ext}`)
      setTipKind('success')
      setTip(`GIF 导出完成：${frames.length} 帧 · ${formatBytes(out.size)}${c.compress ? ' · 已智能压缩' : ''}（经 APNG→GIF 转码，仍为 256 色，需真彩请用 APNG）`)
    } catch (e) {
      setTipKind('error')
      setTip('导出失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function exportApng() {
    if (layers.length === 0) return
    setBusy(true)
    setTipKind('info')
    setTip('正在渲染 APNG 帧…')
    setProgress(10)
    try {
      const frames = collectFrames()
      setProgress(50)
      let blob = encodeApng({ width: boardW, height: boardH, frames, cnum: 0 })
      setTip('智能压缩中…')
      setProgress(80)
      blob = await c.run(blob)
      setProgress(100)
      const ext = blobExt(blob)
      downloadBlob(blob, `animaker-${boardW}x${boardH}${bg === 'transparent' ? '-alpha' : ''}.${ext}`)
      setTipKind('success')
      setTip(`APNG 导出完成：${frames.length} 帧 · ${formatBytes(blob.size)} · 真彩色透明${c.compress ? ' · 已智能压缩' : ''}`)
    } catch (e) {
      setTipKind('error')
      setTip('导出失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const selected = layers.find((l) => l.id === selectedId) || null
  // 顶层（数组末尾）排在列表最上方
  const displayLayers = [...layers].reverse()

  return (
    <ToolLayout title="动图制作" description="上传 PNG 元素，在画板上摆放；单击选中后可直接拖拽移动、拖角缩放、拖柄旋转。可给同一元素叠加多个动效，最后导出 GIF。">
      <div className="card">
        <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
          <button className="btn" onClick={() => document.getElementById('anim-add')?.click()}>＋ 添加 PNG 元素</button>
          <input id="anim-add" type="file" accept="image/png,image/*" multiple hidden onChange={(e) => e.target.files && addElements(e.target.files)} />
          <button className="btn" onClick={() => setPlaying((p) => !p)} disabled={layers.length === 0}>{playing ? '⏸ 暂停' : '▶ 预览'}</button>
          <span className="muted">画布 {boardW}×{boardH}</span>
        </div>

        <div
          className="preview"
          style={{ minHeight: 0 }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (e.dataTransfer.files?.length) addElements(e.dataTransfer.files)
          }}
        >
          <canvas
            ref={canvasRef}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            style={{ cursor: 'pointer', maxHeight: '56vh' }}
          />
        </div>
        {layers.length === 0 && <div className="hint" style={{ textAlign: 'center' }}>添加 PNG 元素后即可在画板上拖拽摆放</div>}

        <div className="row" style={{ marginTop: 12 }}>
          <div className="field"><label>画布宽</label><input type="number" value={boardW} min={50} onChange={(e) => setBoardW(Number(e.target.value))} /></div>
          <div className="field"><label>画布高</label><input type="number" value={boardH} min={50} onChange={(e) => setBoardH(Number(e.target.value))} /></div>
        </div>
      </div>

      <div className="panel">
        <Section title="图层（顶层在上）">
          {layers.length === 0 && <div className="hint">暂无元素</div>}
          {displayLayers.map((l) => (
            <div key={l.id} className={`nav-item ${l.id === selectedId ? 'active' : ''}`} style={{ marginBottom: 4 }} onClick={() => setSelectedId(l.id)}>
              <img className="layer-thumb" src={l.img.src} alt="" style={{ opacity: l.visible ? 1 : 0.35 }} />
              <span className="nav-name" style={{ fontSize: 13, opacity: l.visible ? 1 : 0.5 }}>{l.name}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <button className="btn" style={{ padding: '2px 7px' }} title="上移一层" onClick={() => moveLayer(l.id, 1)}>↑</button>
                <button className="btn" style={{ padding: '2px 7px' }} title="下移一层" onClick={() => moveLayer(l.id, -1)}>↓</button>
                <button className="btn" style={{ padding: '2px 7px' }} title={l.visible ? '隐藏' : '显示'} onClick={() => toggleVisible(l.id)}>{l.visible ? '👁' : '🚫'}</button>
                <button className="btn" style={{ padding: '2px 7px' }} onClick={() => removeLayer(l.id)}>✕</button>
              </div>
            </div>
          ))}
        </Section>

        {selected && (
          <>
            <Section title="选中元素 · 变换">
              <Slider label="缩放" min={5} max={300} value={Math.round(selected.scale * 100)} onChange={(v) => updateSelected({ scale: v / 100 })} suffix="%" />
              <Slider label="旋转" min={-180} max={180} value={Math.round(selected.rotation)} onChange={(v) => updateSelected({ rotation: v })} suffix="°" />
              <div className="hint">也可在画布中：拖动元素移动、拖右下角方块缩放、拖上方圆点旋转。</div>
            </Section>

            <Section title={`选中元素 · 动效（${selected.effects.length}）`}>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>添加动效</label>
                  <select value={addKind} onChange={(e) => setAddKind(e.target.value as EffectKind)}>
                    <option value="pulse">脉冲放大缩小</option>
                    <option value="slide">左右滑动</option>
                    <option value="shimmer">扫光</option>
                    <option value="fade">淡入淡出</option>
                    <option value="spin">旋转</option>
                  </select>
                </div>
                <button className="btn" style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }} onClick={() => addEffect(addKind)}>＋ 添加</button>
              </div>

              {selected.effects.length === 0 && <div className="hint">尚未添加动效，可在上方选择并添加；支持同一元素叠加多个动效。</div>}

              {selected.effects.map((e) => (
                <div key={e.id} className="effect-card">
                  <div className="effect-head">
                    <span className="effect-title">{EFFECT_LABELS[e.kind]}</span>
                    <button className="btn" style={{ padding: '2px 8px' }} title="删除该动效" onClick={() => removeEffect(e.id)}>✕</button>
                  </div>
                  {e.kind === 'pulse' && (
                    <Slider label="幅度" min={1} max={50} value={e.amp} onChange={(v) => updateEffect(e.id, { amp: v })} suffix="%" />
                  )}
                  {e.kind === 'slide' && (
                    <Slider label="幅度" min={5} max={100} value={e.amp} onChange={(v) => updateEffect(e.id, { amp: v })} suffix="px" />
                  )}
                  {e.kind === 'spin' && (
                    <Slider label="旋转幅度" min={30} max={720} value={e.amp} onChange={(v) => updateEffect(e.id, { amp: v })} suffix="°" />
                  )}
                  {e.kind === 'fade' && (
                    <Slider label="最低不透明度" min={0} max={100} value={e.amp} onChange={(v) => updateEffect(e.id, { amp: v })} suffix="%" />
                  )}
                  {e.kind === 'shimmer' && (
                    <>
                      <Slider label="光带宽度" min={10} max={100} value={e.amp} onChange={(v) => updateEffect(e.id, { amp: v })} suffix="%" />
                      <Slider label="强度" min={0} max={100} value={e.intensity ?? 70} onChange={(v) => updateEffect(e.id, { intensity: v })} suffix="%" />
                      <Slider label="角度" min={-90} max={90} value={e.angle ?? 0} onChange={(v) => updateEffect(e.id, { angle: v })} suffix="°" />
                    </>
                  )}
                </div>
              ))}
              <div className="hint">动效按 {duration}s 循环播放并导出。</div>
            </Section>
          </>
        )}

        <Section title="导出">
          <Slider label="时长" min={1} max={10} step={0.5} value={duration} onChange={setDuration} suffix="s" />
          <Slider label="帧率" min={8} max={30} value={fps} onChange={setFps} suffix="fps" />
          <div className="field">
            <label>背景通道</label>
            <select value={bg} onChange={(e) => setBg(e.target.value)}>
              <option value="transparent">透明通道</option>
              <option value="#ffffff">白色实底</option>
              <option value="#000000">黑色实底</option>
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={dither} onChange={(e) => setDither(e.target.checked)} />
            抖动（关闭更平滑；开启保留半透明羽化边缘的小点）
          </label>
          <CompressControls compress={c.compress} setCompress={c.setCompress} quality={c.quality} setQuality={c.setQuality} />
          <button className="btn primary block" disabled={layers.length === 0 || busy} onClick={exportGif}>
            {busy ? '导出中…' : '⬇ 导出 GIF'}
          </button>
          <button className="btn block" disabled={layers.length === 0 || busy} onClick={exportApng} style={{ marginTop: 8 }}>
            {busy ? '导出中…' : '⬇ 导出 APNG'}
          </button>
          <div className="hint" style={{ marginTop: 8 }}>需要真彩色透明边缘时选 APNG。</div>
          {busy && (
            <div className="progress" style={{ marginTop: 12 }} title={tip}>
              <i style={{ width: `${Math.max(5, Math.min(100, progress))}%` }} />
            </div>
          )}
          {busy && tip && <div className="hint" style={{ marginTop: 6 }}>{tip}</div>}
          {!busy && tip && <div className={`hint ${tipKind}`}>{tip}</div>}
        </Section>
      </div>
    </ToolLayout>
  )
}
