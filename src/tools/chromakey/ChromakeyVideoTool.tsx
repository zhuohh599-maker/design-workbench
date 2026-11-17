import { useRef, useState, useEffect } from 'react'
import { ToolLayout, Section, Slider } from '../../core/components'
import { useInboxHandler } from '../../core/inbox'
import { track } from '../../core/analytics'
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

type Pt = [number, number]
/** 保护区形状：归一化坐标多边形（套索/多边形/矩形统一存成顶点列表） */
interface ProtectShape {
  pts: Pt[]
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function ptsToPath(pts: Pt[], w: number, h: number): Path2D {
  const p = new Path2D()
  pts.forEach(([x, y], i) => {
    const px = x * w
    const py = y * h
    if (i) p.lineTo(px, py)
    else p.moveTo(px, py)
  })
  p.closePath()
  return p
}

/** 对整帧像素做绿幕抠像 + 水印抹除（原地修改 alpha）。mask[y*vw+x] 非 0 的像素在保护区内，保持原样。 */
function keyPixels(data: Uint8ClampedArray, opts: KeyOpts, vw: number, vh: number, mask: Uint8Array | null) {
  const { keyR, keyG, keyB, threshold, softness } = opts
  const t = (threshold / 100) * 300
  const band = (softness / 100) * 60
  const inner = t - band
  const outer = t + band
  const hasMask = !!mask && mask.length === vw * vh
  for (let y = 0; y < vh; y++) {
    const rowOff = y * vw
    for (let x = 0; x < vw; x++) {
      const i = (rowOff + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      // 保护区（手绘形状 + AI 主体蒙版）：完全跳过抠像，保持原始颜色与不透明度
      if (hasMask && mask![rowOff + x]) {
        data[i + 3] = 255
        continue
      }
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
  const [protectShapes, setProtectShapes] = useState<ProtectShape[]>([])
  const [draftPts, setDraftPts] = useState<Pt[]>([])
  const [hoverPt, setHoverPt] = useState<Pt | null>(null)
  const [selMode, setSelMode] = useState<'wm' | 'lasso' | 'poly'>('wm')
  const [aiVer, setAiVer] = useState(0)
  const [aiThresh, setAiThresh] = useState(50)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiTip, setAiTip] = useState('')
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

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const srcCanvas = useRef<HTMLCanvasElement | null>(null)
  const outCanvas = useRef<HTMLCanvasElement | null>(null)
  const workRef = useRef<HTMLCanvasElement | null>(null)
  const playRef = useRef(false)
  const dragWm = useRef<Pt | null>(null)
  const drawingLasso = useRef(false)
  const dragPos = useRef<{ dx: number; dy: number } | null>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const maskDataRef = useRef<Uint8Array | null>(null)
  const aiAlphaRef = useRef<HTMLCanvasElement | null>(null) // alpha 通道 = AI 主体蒙版
  const aiTintRef = useRef<HTMLCanvasElement | null>(null) // 绿色高亮叠加
  const aiWhiteRef = useRef<HTMLCanvasElement | null>(null) // 白色二值蒙版（合成用）

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
    keyPixels(img.data, getOpts(), meta.w, meta.h, maskDataRef.current)
    wctx.putImageData(img, 0, 0)
    dest.drawImage(work, 0, 0, meta.w, meta.h, dx, dy, dw, dh)
  }

  /** 在源画布上叠加绘制：水印框（红）、手绘保护区（绿）、绘制中草稿、AI 主体蒙版（绿色高亮） */
  function drawSelOverlays(c: CanvasRenderingContext2D, vw: number, vh: number) {
    c.save()
    // 水印矩形
    if (wm && wm.w > 0 && wm.h > 0) {
      c.beginPath()
      c.rect(wm.x * vw, wm.y * vh, wm.w * vw, wm.h * vh)
      c.globalAlpha = 0.15
      c.fillStyle = '#ff4d4f'
      c.fill()
      c.globalAlpha = 1
      c.strokeStyle = '#ff4d4f'
      c.lineWidth = Math.max(2, vw / 300)
      c.setLineDash([vw / 60, vw / 60])
      c.stroke()
      c.setLineDash([])
      c.font = `bold ${Math.max(12, vw / 40)}px sans-serif`
      c.fillStyle = '#ff4d4f'
      c.fillText('水印抹除', wm.x * vw + 4, wm.y * vh + Math.max(14, vw / 36))
    }
    // 已完成的保护区形状
    for (const s of protectShapes) {
      if (s.pts.length < 3) continue
      const path = ptsToPath(s.pts, vw, vh)
      c.globalAlpha = 0.15
      c.fillStyle = '#22c55e'
      c.fill(path)
      c.globalAlpha = 1
      c.strokeStyle = '#22c55e'
      c.lineWidth = Math.max(2, vw / 300)
      c.setLineDash([vw / 60, vw / 60])
      c.stroke(path)
      c.setLineDash([])
    }
    // 绘制中的草稿（套索进行中 / 多边形顶点连线）
    if (draftPts.length > 0) {
      c.beginPath()
      draftPts.forEach(([x, y], i) => {
        const px = x * vw
        const py = y * vh
        if (i) c.lineTo(px, py)
        else c.moveTo(px, py)
      })
      if (hoverPt && selMode === 'poly') {
        c.lineTo(hoverPt[0] * vw, hoverPt[1] * vh)
      }
      if (selMode === 'lasso' && draftPts.length > 2) {
        c.closePath()
        c.globalAlpha = 0.15
        c.fillStyle = '#22c55e'
        c.fill()
        c.globalAlpha = 1
      }
      c.strokeStyle = '#86efac'
      c.lineWidth = Math.max(2, vw / 350)
      c.stroke()
      // 多边形顶点圆点
      if (selMode === 'poly') {
        c.fillStyle = '#22c55e'
        for (const [x, y] of draftPts) {
          c.beginPath()
          c.arc(x * vw, y * vh, Math.max(3, vw / 200), 0, Math.PI * 2)
          c.fill()
        }
      }
    }
    // AI 主体蒙版高亮
    if (aiTintRef.current) {
      c.globalAlpha = 0.45
      c.drawImage(aiTintRef.current, 0, 0, vw, vh)
      c.globalAlpha = 1
      c.font = `bold ${Math.max(12, vw / 40)}px sans-serif`
      c.fillStyle = '#22c55e'
      c.fillText('🤖 AI 主体保护区', 8, Math.max(18, vw / 32))
    }
    c.restore()
  }

  function clearAndDraw() {
    const s = srcCanvas.current
    const o = outCanvas.current
    if (s) {
      const c = s.getContext('2d')!
      c.clearRect(0, 0, s.width, s.height)
      if (meta) {
        renderKeyed(c, 0, 0, meta.w, meta.h)
        drawSelOverlays(c, meta.w, meta.h)
      }
    }
    if (o && meta) {
      const c = o.getContext('2d')!
      c.clearRect(0, 0, o.width, o.height)
      renderKeyed(c, posX, posY, meta.w * scale, meta.h * scale)
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

  // —— 保护区蒙版重建：手绘形状 + AI 主体蒙版（按阈值二值化）合成一张 Uint8 掩码 ——
  useEffect(() => {
    if (!meta) {
      maskDataRef.current = null
      aiTintRef.current = null
      aiWhiteRef.current = null
      return
    }
    const m = maskCanvasRef.current ?? (maskCanvasRef.current = document.createElement('canvas'))
    m.width = meta.w
    m.height = meta.h
    const ctx = m.getContext('2d', { willReadFrequently: true })!
    ctx.clearRect(0, 0, m.width, m.height)
    ctx.fillStyle = '#fff'
    for (const s of protectShapes) {
      if (s.pts.length >= 3) ctx.fill(ptsToPath(s.pts, meta.w, meta.h))
    }
    if (aiAlphaRef.current) {
      const a = aiAlphaRef.current
      const actx = a.getContext('2d', { willReadFrequently: true })!
      const img = actx.getImageData(0, 0, a.width, a.height)
      const th = Math.round((aiThresh / 100) * 255)
      const tint = aiTintRef.current ?? (aiTintRef.current = document.createElement('canvas'))
      const white = aiWhiteRef.current ?? (aiWhiteRef.current = document.createElement('canvas'))
      tint.width = white.width = meta.w
      tint.height = white.height = meta.h
      const tctx = tint.getContext('2d')!
      const wctx = white.getContext('2d')!
      const timg = tctx.createImageData(meta.w, meta.h)
      const wimg = wctx.createImageData(meta.w, meta.h)
      for (let i = 0; i < img.data.length; i += 4) {
        const on = img.data[i + 3] >= th ? 255 : 0
        timg.data[i] = 34
        timg.data[i + 1] = 197
        timg.data[i + 2] = 94
        timg.data[i + 3] = on
        wimg.data[i] = wimg.data[i + 1] = wimg.data[i + 2] = 255
        wimg.data[i + 3] = on
      }
      tctx.putImageData(timg, 0, 0)
      wctx.putImageData(wimg, 0, 0)
      ctx.drawImage(white, 0, 0)
    } else {
      aiTintRef.current = null
      aiWhiteRef.current = null
    }
    const raw = ctx.getImageData(0, 0, meta.w, meta.h).data
    const bin = new Uint8Array(meta.w * meta.h)
    for (let i = 0; i < bin.length; i++) bin[i] = raw[i * 4 + 3] > 127 ? 255 : 0
    maskDataRef.current = bin
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, protectShapes, aiVer, aiThresh])

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
  }, [meta, playing, previewT, keyColor, threshold, softness, wm, protectShapes, draftPts, hoverPt, selMode, aiVer, posX, posY, scale, outW, outH])

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

  useInboxHandler(onFile)

  async function onFile(f: File) {
    track('file_load', 'chromakey')
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
    setProtectShapes([])
    setDraftPts([])
    aiAlphaRef.current = null
    aiTintRef.current = null
    aiWhiteRef.current = null
    setAiVer((x) => x + 1)
  }

  // —— 源画布交互（按 selMode 分派） ——
  function cnvPt(e: React.MouseEvent): Pt {
    const cv = srcCanvas.current!
    const r = cv.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }
  function srcDown(e: React.MouseEvent) {
    if (!meta) return
    if (selMode === 'wm') {
      dragWm.current = cnvPt(e)
    } else if (selMode === 'lasso') {
      drawingLasso.current = true
      setDraftPts([cnvPt(e)])
    }
    // poly 模式用 click 添加顶点
  }
  function srcMove(e: React.MouseEvent) {
    if (!meta) return
    if (selMode === 'wm' && dragWm.current) {
      const a = dragWm.current
      const b = cnvPt(e)
      setWm({
        x: Math.min(a[0], b[0]),
        y: Math.min(a[1], b[1]),
        w: Math.abs(b[0] - a[0]),
        h: Math.abs(b[1] - a[1]),
      })
    } else if (selMode === 'lasso' && drawingLasso.current) {
      const p = cnvPt(e)
      setDraftPts((d) => {
        const last = d[d.length - 1]
        if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.004) return d
        return [...d, p]
      })
    } else if (selMode === 'poly') {
      setHoverPt(cnvPt(e))
    }
  }
  function srcUp() {
    if (selMode === 'wm') {
      dragWm.current = null
      if (!wm || (wm.w < 0.01 && wm.h < 0.01)) setWm(null)
    } else if (selMode === 'lasso') {
      drawingLasso.current = false
      closeDraft()
    }
  }
  function srcClick(e: React.MouseEvent) {
    if (selMode === 'poly' && meta) setDraftPts((d) => [...d, cnvPt(e)])
  }
  function srcDoubleClick() {
    if (selMode === 'poly') closeDraft()
  }
  function closeDraft() {
    if (draftPts.length >= 3) setProtectShapes((s) => [...s, { pts: draftPts }])
    setDraftPts([])
    setHoverPt(null)
  }
  function undoProtect() {
    setProtectShapes((s) => s.slice(0, -1))
  }
  function clearProtect() {
    setProtectShapes([])
    setDraftPts([])
    aiAlphaRef.current = null
    aiTintRef.current = null
    aiWhiteRef.current = null
    setAiVer((x) => x + 1)
    setAiTip('')
  }

  // —— AI 主体识别：复用 BiRefNet 512 对当前帧做分割，主体蒙版 → 保护区 ——
  async function detectSubject() {
    if (!meta || aiBusy) return
    setAiBusy(true)
    setAiTip('准备模型（首次使用需下载约 191MB，请稍候）…')
    try {
      setPlaying(false)
      await grabFrame(videoRef.current!, previewT)
      const snap = document.createElement('canvas')
      snap.width = meta.w
      snap.height = meta.h
      snap.getContext('2d')!.drawImage(videoRef.current!, 0, 0, meta.w, meta.h)
      const blob = await new Promise<Blob>((res, rej) =>
        snap.toBlob((b) => (b ? res(b) : rej(new Error('取帧失败'))), 'image/png'),
      )
      const { runBiRefNet } = await import('../../core/matting/birefnet')
      const png = await runBiRefNet(blob, (_k, c, t) => {
        setAiTip(
          t ? `主体识别：模型下载 ${(c / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} MB…` : '主体识别：准备模型…',
        )
      })
      setAiTip('主体识别：推理完成，解析蒙版…')
      const bmp = await createImageBitmap(png)
      const a = aiAlphaRef.current ?? (aiAlphaRef.current = document.createElement('canvas'))
      a.width = meta.w
      a.height = meta.h
      const actx = a.getContext('2d', { willReadFrequently: true })!
      actx.clearRect(0, 0, meta.w, meta.h)
      actx.drawImage(bmp, 0, 0, meta.w, meta.h) // PNG 的 alpha 通道即主体蒙版
      bmp.close?.()
      setAiVer((x) => x + 1)
      setAiTip('✅ 主体识别完成：绿色高亮为 AI 识别的主体保护区，可拖动「AI 保护范围」微调，也可再手绘补充')
    } catch (e) {
      setAiTip('❌ 主体识别失败：' + (e as Error).message)
    } finally {
      setAiBusy(false)
    }
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
      const blob = encodeGif({ width: outW, height: outH, frames, transparent: true, paletteSize: 256, dither })
      const ext = blobExt(blob)
      downloadBlob(blob, `chromakey-${outW}x${outH}.${ext}`)
      setTip(`GIF 导出完成：${frames.length} 帧 · ${formatBytes(blob.size)} · 透明 GIF`)
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
      const blob = encodeApng({ width: outW, height: outH, frames, cnum: 0 })
      const ext = blobExt(blob)
      downloadBlob(blob, `chromakey-${outW}x${outH}.${ext}`)
      setTip(`APNG 导出完成：${frames.length} 帧 · ${formatBytes(blob.size)} · 真彩色透明`)
    } catch (e) {
      setTip('导出失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const modeHint =
    selMode === 'wm'
      ? '在画布上拖拽框选水印区域（导出时抹除）'
      : selMode === 'lasso'
        ? '按住鼠标在画布上涂画任意形状，松开自动闭合为保护区'
        : '在画布上单击添加顶点，双击闭合为保护区'

  const opts = getOpts()

  return (
    <ToolLayout
      title="绿幕视频抠像"
      description="上传绿幕 MP4，逐帧扣除绿幕（可框选水印抹除），支持套索/多边形自由绘制保护区与 AI 主体智能识别，再把透明结果摆到自定义尺寸画布上导出透明 GIF。"
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
              <span className="dropzone-hint">支持 H.264 MP4</span>
            </div>
          </label>
        )}

        {meta && (
          <>
            <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
              <span className="muted">视频 {meta.w}×{meta.h} · {meta.duration.toFixed(1)}s</span>
              <button className="btn" onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ 暂停预览' : '▶ 播放预览'}</button>
              <button className="btn" onClick={() => { setMeta(null); setWm(null); clearProtect(); if (videoRef.current) videoRef.current.src = '' }}>重选视频</button>
            </div>
            <Slider label="预览时间轴" min={0} max={Math.round(meta.duration * 100)} value={Math.round(previewT * 100)} onChange={(v) => { setPlaying(false); setPreviewT(v / 100) }} suffix="s" />

            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>
                  ① 抠像预览
                  <span className="row" style={{ display: 'inline-flex', marginLeft: 8, gap: 6 }}>
                    <button className="btn" style={{ padding: '2px 10px', fontSize: 12, borderColor: selMode === 'wm' ? '#ff4d4f' : undefined, color: selMode === 'wm' ? '#ff4d4f' : undefined }} onClick={() => setSelMode('wm')}>框选水印区</button>
                    <button className="btn" style={{ padding: '2px 10px', fontSize: 12, borderColor: selMode === 'lasso' ? '#22c55e' : undefined, color: selMode === 'lasso' ? '#22c55e' : undefined }} onClick={() => { setSelMode('lasso'); setDraftPts([]) }}>套索保护区</button>
                    <button className="btn" style={{ padding: '2px 10px', fontSize: 12, borderColor: selMode === 'poly' ? '#22c55e' : undefined, color: selMode === 'poly' ? '#22c55e' : undefined }} onClick={() => { setSelMode('poly'); setDraftPts([]) }}>多边形保护区</button>
                  </span>
                </div>
                <canvas
                  ref={srcCanvas}
                  width={meta.w}
                  height={meta.h}
                  className="chk-canvas"
                  style={{ maxWidth: '100%', maxHeight: '42vh', cursor: 'crosshair' }}
                  onMouseDown={srcDown}
                  onMouseMove={srcMove}
                  onMouseUp={srcUp}
                  onMouseLeave={srcUp}
                  onClick={srcClick}
                  onDoubleClick={srcDoubleClick}
                />
                <div className="hint" style={{ marginTop: 4 }}>{modeHint}</div>
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
            {wm && <div className="hint">🟥 已框选水印区域（归一化 {wm.x.toFixed(2)}, {wm.y.toFixed(2)}, {wm.w.toFixed(2)}×{wm.h.toFixed(2)}），导出时会一并抹除。再次框选可重设，点「清除水印选区」取消。</div>}
            {protectShapes.length > 0 && <div className="hint">🟩 已绘制 {protectShapes.length} 块保护区，区域内的绿幕不会被抠掉。可用「撤销上一笔 / 清除保护区」调整。</div>}
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
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" style={{ flex: 1 }} disabled={!wm} onClick={() => setWm(null)}>清除水印选区</button>
              <button className="btn" style={{ flex: 1 }} disabled={!protectShapes.length && !draftPts.length} onClick={undoProtect}>撤销上一笔</button>
              <button className="btn" style={{ flex: 1 }} disabled={!protectShapes.length && !aiAlphaRef.current} onClick={clearProtect}>清除保护区</button>
            </div>
            <div className="hint">阈值越大扣得越多；边缘柔化让抠像边界更平滑、减少锯齿。画面里有不该被抠掉的绿色元素（绿道具、logo、字幕）时，用「套索/多边形保护区」把它圈住即可，可叠加多笔。</div>
          </Section>

          <Section title="🤖 AI 主体识别（智能保护区）">
            <button className="btn primary block" disabled={aiBusy} onClick={detectSubject}>
              {aiBusy ? '⏳ 识别中…' : '🤖 智能识别主体并保护'}
            </button>
            {aiTip && <div className="hint" style={{ marginTop: 8 }}>{aiTip}</div>}
            <Slider label="AI 保护范围（蒙版阈值）" min={10} max={95} value={aiThresh} onChange={setAiThresh} suffix="%" />
            <div className="hint">对当前预览帧做主体分割（BiRefNet 本地推理），主体区域整体设为保护区——绿幕会被抠掉、人物/道具保留。蒙版作用于整段视频，主体位置变化大时建议配合手绘补充。首次使用需下载约 191MB 模型。</div>
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
