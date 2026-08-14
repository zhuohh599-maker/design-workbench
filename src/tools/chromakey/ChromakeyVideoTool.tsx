import { useRef, useState, useEffect } from 'react'
import { ToolLayout, Section, Slider, CompressControls, useSmartCompress } from '../../core/components'
import { downloadBlob, blobExt, formatBytes } from '../../core/utils/image'
import { encodeGif, encodeApng, type GifFrame } from '../../core/utils/gif'

interface VideoMeta {
  w: number
  h: number
  duration: number
}

interface KeyOpts {
  keyR: number
  keyG: number
  keyB: number
  threshold: number // 0~100
  softness: number // 0~100
  // 水印区域（视频归一化坐标 0~1），null 表示不处理
  wm: { x: number; y: number; w: number; h: number } | null
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** 对整帧像素做绿幕抠像 + 水印抹除（原地修改 alpha） */
function keyPixels(data: Uint8ClampedArray, opts: KeyOpts, vw: number, vh: number) {
  const { keyR, keyG, keyB, threshold, softness } = opts
  const t = (threshold / 100) * 300
  const band = (softness / 100) * 60
  const inner = t - band
  const outer = t + band
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const dr = r - keyR
    const dg = g - keyG
    const db = b - keyB
    const d = Math.sqrt(dr * dr + dg * dg + db * db)
    let alpha: number
    if (d <= inner) alpha = 0
    else if (d >= outer) alpha = 255
    else alpha = ((d - inner) / (outer - inner)) * 255
    // 边缘绿溢色抑制：把绿色通道压到与红蓝相当
    if (alpha > 0) {
      const mg = Math.min(r, b)
      data[i + 1] = alpha < 255 ? Math.min(g, mg) : g
    }
    data[i + 3] = alpha
  }
  // 水印区域强制透明
  if (opts.wm) {
    const x0 = Math.floor(opts.wm.x * vw)
    const y0 = Math.floor(opts.wm.y * vh)
    const x1 = Math.floor((opts.wm.x + opts.wm.w) * vw)
    const y1 = Math.floor((opts.wm.y + opts.wm.h) * vh)
    for (let y = y0; y < y1; y++) {
      if (y < 0 || y >= vh) continue
      for (let x = x0; x < x1; x++) {
        if (x < 0 || x >= vw) continue
        const i = (y * vw + x) * 4
        data[i + 3] = 0
      }
    }
  }
}

export default function ChromakeyVideoTool() {
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [keyColor, setKeyColor] = useState('#00ff00')
  const [threshold, setThreshold] = useState(45)
  const [softness, setSoftness] = useState(20)
  const [wm, setWm] = useState<KeyOpts['wm']>(null)
  const [outW, setOutW] = useState(480)
  const [outH, setOutH] = useState(480)
  const [scale, setScale] = useState(1)
  const [posX, setPosX] = useState(0)
  const [posY, setPosY] = useState(0)
  const [fps, setFps] = useState(25)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [previewT, setPreviewT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tip, setTip] = useState('')
  const [progress, setProgress] = useState(0)
  const [dither, setDither] = useState(true)
  const c = useSmartCompress()

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const srcCanvas = useRef<HTMLCanvasElement | null>(null)
  const outCanvas = useRef<HTMLCanvasElement | null>(null)
  const workRef = useRef<HTMLCanvasElement | null>(null)
  const playRef = useRef(false)
  const dragWm = useRef<{ x: number; y: number } | null>(null)
  const dragPos = useRef<{ dx: number; dy: number } | null>(null)

  function getOpts(): KeyOpts {
    const { r, g, b } = hexToRgb(keyColor)
    return { keyR: r, keyG: g, keyB: b, threshold, softness, wm }
  }

  function getWork() {
    if (!workRef.current) {
      workRef.current = document.createElement('canvas')
    }
    return workRef.current
  }

  /** 把当前视频帧抠像后画到目标 ctx（dest 矩形） */
  function renderKeyed(dest: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number) {
    const v = videoRef.current
    if (!v || !meta) return
    const work = getWork()
    work.width = meta.w
    work.height = meta.h
    const wctx = work.getContext('2d')!
    wctx.drawImage(v, 0, 0, meta.w, meta.h)
    const img = wctx.getImageData(0, 0, meta.w, meta.h)
    keyPixels(img.data, getOpts(), meta.w, meta.h)
    wctx.putImageData(img, 0, 0)
    dest.drawImage(work, 0, 0, meta.w, meta.h, dx, dy, dw, dh)
  }

  function clearAndDraw() {
    const s = srcCanvas.current
    const o = outCanvas.current
    if (s) {
      const c = s.getContext('2d')!
      c.clearRect(0, 0, s.width, s.height)
      if (meta) renderKeyed(c, 0, 0, meta.w, meta.h)
    }
    if (o) {
      const c = o.getContext('2d')!
      c.clearRect(0, 0, o.width, o.height)
      renderKeyed(c, posX, posY, meta!.w * scale, meta!.h * scale)
    }
  }

  function grabFrame(v: HTMLVideoElement, t: number): Promise<void> {
    return new Promise((resolve) => {
      const onSeek = () => {
        v.removeEventListener('seeked', onSeek)
        resolve()
      }
      v.addEventListener('seeked', onSeek)
      v.currentTime = Math.min(v.duration, Math.max(0, t))
    })
  }

  // 静止预览（调参时）
  useEffect(() => {
    if (!meta || playing) return
    let cancelled = false
    ;(async () => {
      await grabFrame(videoRef.current!, previewT)
      if (!cancelled) clearAndDraw()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, playing, previewT, keyColor, threshold, softness, wm, posX, posY, scale, outW, outH])

  // 播放预览循环
  useEffect(() => {
    playRef.current = playing
    const v = videoRef.current
    if (!v || !meta) return
    if (!playing) {
      v.pause()
      return
    }
    v.play().catch(() => {})
    const rVFC = (v as unknown as { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback
    let handle = 0
    const loop = () => {
      if (!playRef.current) return
      clearAndDraw()
      if (rVFC) handle = rVFC.call(v, loop)
      else handle = requestAnimationFrame(loop) as unknown as number
    }
    if (rVFC) handle = rVFC.call(v, loop)
    else handle = requestAnimationFrame(loop)
    return () => {
      if (rVFC) (v as unknown as { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback?.(handle)
      else cancelAnimationFrame(handle)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, meta])

  async function onFile(f: File) {
    const v = videoRef.current!
    const url = URL.createObjectURL(f)
    v.src = url
    await new Promise<void>((res) => {
      v.onloadedmetadata = () => res()
    })
    const m: VideoMeta = { w: v.videoWidth, h: v.videoHeight, duration: v.duration }
    setMeta(m)
    setOutW(m.w)
    setOutH(m.h)
    setTrimEnd(m.duration)
    setPosX(0)
    setPosY(0)
    setScale(1)
    setPreviewT(0)
  }

  // —— 源画布：拖拽框选水印区域 ——
  function wmDown(e: React.MouseEvent) {
    if (!meta) return
    const cv = srcCanvas.current!
    const r = cv.getBoundingClientRect()
    dragWm.current = {
      x: ((e.clientX - r.left) / r.width) * meta.w,
      y: ((e.clientY - r.top) / r.height) * meta.h,
    }
  }
  function wmMove(e: React.MouseEvent) {
    if (!dragWm.current || !meta) return
    const cv = srcCanvas.current!
    const r = cv.getBoundingClientRect()
    const cx = ((e.clientX - r.left) / r.width) * meta.w
    const cy = ((e.clientY - r.top) / r.height) * meta.h
    const x = Math.min(dragWm.current.x, cx)
    const y = Math.min(dragWm.current.y, cy)
    const w = Math.abs(cx - dragWm.current.x)
    const h = Math.abs(cy - dragWm.current.y)
    setWm({ x: x / meta.w, y: y / meta.h, w: w / meta.w, h: h / meta.h })
  }
  function wmUp() {
    dragWm.current = null
    if (wm && wm.w < 0.01 && wm.h < 0.01) setWm(null)
  }

  // —— 输出画布：拖动设置视频位置 ——
  function posDown(e: React.MouseEvent) {
    if (!meta) return
    const cv = outCanvas.current!
    const r = cv.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * outW
    const y = ((e.clientY - r.top) / r.height) * outH
    const dw = meta.w * scale
    const dh = meta.h * scale
    if (x >= posX && x <= posX + dw && y >= posY && y <= posY + dh) {
      dragPos.current = { dx: x - posX, dy: y - posY }
    }
  }
  function posMove(e: React.MouseEvent) {
    if (!dragPos.current || !meta) return
    const cv = outCanvas.current!
    const r = cv.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * outW
    const y = ((e.clientY - r.top) / r.height) * outH
    setPosX(Math.round(x - dragPos.current.dx))
    setPosY(Math.round(y - dragPos.current.dy))
  }
  function posUp() {
    dragPos.current = null
  }

  async function collectFrames(): Promise<GifFrame[]> {
    const v = videoRef.current!
    v.pause()
    const start = Math.min(trimStart, trimEnd)
    const end = Math.max(trimStart, trimEnd)
    const span = Math.max(0.01, end - start)
    const n = Math.max(1, Math.round(span * fps))
    const frames: GifFrame[] = []
    const o = outCanvas.current!
    o.width = outW
    o.height = outH
    const oc = o.getContext('2d')!
    const dw = meta!.w * scale
    const dh = meta!.h * scale
    for (let i = 0; i < n; i++) {
      const t = start + (i / n) * span
      await grabFrame(v, t)
      oc.clearRect(0, 0, outW, outH)
      renderKeyed(oc, posX, posY, dw, dh)
      const data = oc.getImageData(0, 0, outW, outH).data
      frames.push({ rgba: new Uint8ClampedArray(data), delay: Math.round(1000 / fps) })
      setProgress(Math.round(((i + 1) / n) * 100))
    }
    return frames
  }

  async function exportGif() {
    if (!meta) return
    setBusy(true)
    setTip('正在逐帧抠像并编码 GIF…')
    setProgress(0)
    try {
      const frames = await collectFrames()
      let blob = encodeGif({ width: outW, height: outH, frames, transparent: true, paletteSize: 256, dither })
      blob = await c.run(blob)
      const ext = blobExt(blob)
      downloadBlob(blob, `chromakey-${outW}x${outH}.${ext}`)
      setTip(`GIF 导出完成：${frames.length} 帧 · ${formatBytes(blob.size)} · 透明 GIF${c.compress ? ' · 已智能压缩' : ''}`)
    } catch (e) {
      setTip('导出失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function exportApng() {
    if (!meta) return
    setBusy(true)
    setTip('正在逐帧抠像并编码 APNG…')
    setProgress(0)
    try {
      const frames = await collectFrames()
      let blob = encodeApng({ width: outW, height: outH, frames, cnum: 0 })
      blob = await c.run(blob)
      const ext = blobExt(blob)
      downloadBlob(blob, `chromakey-${outW}x${outH}.${ext}`)
      setTip(`APNG 导出完成：${frames.length} 帧 · ${formatBytes(blob.size)} · 真彩色透明${c.compress ? ' · 已智能压缩' : ''}`)
    } catch (e) {
      setTip('导出失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const opts = getOpts()

  return (
    <ToolLayout
      title="绿幕视频抠像"
      description="上传绿幕 MP4，逐帧扣除绿幕（角落水印可框选抹除），再把透明结果摆到自定义尺寸画布上导出透明 GIF。纯浏览器处理，视频不上传。"
    >
      <div className="card">
        {/* 隐藏的视频解码源：用 <video> 逐帧 drawImage 到 Canvas 抠像（离屏定位，避免部分浏览器对 display:none 暂停解码） */}
        <video
          ref={videoRef}
          muted
          playsInline
          preload="auto"
          style={{ position: 'absolute', left: -99999, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        />

        {!meta && (
          <label
            className="dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f) onFile(f)
            }}
          >
            <input
              type="file"
              accept="video/mp4,video/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
                e.target.value = ''
              }}
            />
            <div className="dropzone-inner">
              <span className="dropzone-icon">🟢</span>
              <span>点击或拖拽绿幕 MP4 到此处</span>
              <span className="dropzone-hint">支持 H.264 MP4；处理在本地完成</span>
            </div>
          </label>
        )}

        {meta && (
          <>
            <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
              <span className="muted">视频 {meta.w}×{meta.h} · {meta.duration.toFixed(1)}s</span>
              <button className="btn" onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ 暂停预览' : '▶ 播放预览'}</button>
              <button className="btn" onClick={() => { setMeta(null); setWm(null); if (videoRef.current) videoRef.current.src = '' }}>重选视频</button>
            </div>
            <Slider label="预览时间轴" min={0} max={Math.round(meta.duration * 100)} value={Math.round(previewT * 100)} onChange={(v) => { setPlaying(false); setPreviewT(v / 100) }} suffix="s" />

            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>① 抠像预览（在画布上框选水印区域）</div>
                <canvas
                  ref={srcCanvas}
                  width={meta.w}
                  height={meta.h}
                  className="chk-canvas"
                  style={{ maxWidth: '100%', maxHeight: '42vh', cursor: wm ? 'crosshair' : 'default' }}
                  onMouseDown={wmDown}
                  onMouseMove={wmMove}
                  onMouseUp={wmUp}
                  onMouseLeave={wmUp}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>② 输出画布（拖动设置视频位置）</div>
                <canvas
                  ref={outCanvas}
                  width={outW}
                  height={outH}
                  className="chk-canvas"
                  style={{ maxWidth: '100%', maxHeight: '42vh', cursor: dragPos.current ? 'grabbing' : 'grab' }}
                  onMouseDown={posDown}
                  onMouseMove={posMove}
                  onMouseUp={posUp}
                  onMouseLeave={posUp}
                />
              </div>
            </div>
            {wm && <div className="hint">已框选水印区域（归一化 {wm.x.toFixed(2)}, {wm.y.toFixed(2)}, {wm.w.toFixed(2)}×{wm.h.toFixed(2)}），导出时会一并抹除。再次框选可重设，点「清除水印」取消。</div>}
          </>
        )}
      </div>

      {meta && (
        <div className="panel">
          <Section title="绿幕抠像">
            <div className="field">
              <label>绿幕颜色（可吸取，默认纯绿）</label>
              <input type="color" value={keyColor} onChange={(e) => setKeyColor(e.target.value)} style={{ width: '100%', height: 38, padding: 4 }} />
            </div>
            <Slider label="抠像阈值" min={0} max={100} value={threshold} onChange={setThreshold} suffix="%" />
            <Slider label="边缘柔化" min={0} max={100} value={softness} onChange={setSoftness} suffix="%" />
            <button className="btn block" disabled={!wm} onClick={() => setWm(null)}>清除水印选区</button>
            <div className="hint">阈值越大扣得越多；边缘柔化让抠像边界更平滑、减少锯齿。</div>
          </Section>

          <Section title="输出 GIF 画布">
            <div className="row">
              <div className="field"><label>画布宽</label><input type="number" value={outW} min={50} onChange={(e) => setOutW(Number(e.target.value))} /></div>
              <div className="field"><label>画布高</label><input type="number" value={outH} min={50} onChange={(e) => setOutH(Number(e.target.value))} /></div>
            </div>
            <Slider label="视频缩放" min={10} max={200} value={Math.round(scale * 100)} onChange={(v) => setScale(v / 100)} suffix="%" />
            <div className="field">
              <label>位置 X / Y（画布像素）</label>
              <div className="row">
                <input type="number" value={posX} onChange={(e) => setPosX(Number(e.target.value))} />
                <input type="number" value={posY} onChange={(e) => setPosY(Number(e.target.value))} />
              </div>
            </div>
            <div className="hint">也可在右侧输出画布上直接拖动视频调整位置。</div>
          </Section>

          <Section title="导出">
            <Slider label="帧率" min={8} max={30} value={fps} onChange={setFps} suffix="fps" />
            <div className="row">
              <div className="field"><label>起始(s)</label><input type="number" step={0.1} min={0} value={trimStart} onChange={(e) => setTrimStart(Number(e.target.value))} /></div>
              <div className="field"><label>结束(s)</label><input type="number" step={0.1} min={0} value={trimEnd} onChange={(e) => setTrimEnd(Number(e.target.value))} /></div>
            </div>
            <CompressControls compress={c.compress} setCompress={c.setCompress} quality={c.quality} setQuality={c.setQuality} />
            <button className="btn primary block" disabled={busy} onClick={exportGif}>⬇ 导出 GIF</button>
            <button className="btn block" disabled={busy} onClick={exportApng} style={{ marginTop: 8 }}>⬇ 导出 APNG</button>
            <div className="hint" style={{ marginTop: 8 }}>需要真彩色透明边缘时选 APNG。</div>
            {busy && <div className="progress" style={{ marginTop: 10 }}><i style={{ width: `${progress}%` }} /></div>}
            {tip && <div className="hint">{tip}</div>}
          </Section>
        </div>
      )}
    </ToolLayout>
  )
}
