import { useState, useRef, useEffect } from 'react'
import { traceDataUrl, getSVG, THRESHOLD_AUTO } from '@cadit-app/potrace-ts'
import { ToolLayout, DropZone, Section } from '../../core/components'
import { formatBytes, downloadBlob } from '../../core/utils/image'
import { ACCEPT_IMAGES } from '../../core/types'

type FgMode = 'auto' | 'dark' | 'light'

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = reject
    i.src = src
  })
}

// 读取图片并生成用于描摹的工作图（限制最大边，避免超大图过慢）+ 平均亮度（自动判断前景）
function prepare(img: HTMLImageElement) {
  const maxDim = 1800
  const sw = img.naturalWidth
  const sh = img.naturalHeight
  const scale = Math.min(1, maxDim / Math.max(sw, sh))
  const dw = Math.max(1, Math.round(sw * scale))
  const dh = Math.max(1, Math.round(sh * scale))
  const c = document.createElement('canvas')
  c.width = dw
  c.height = dh
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, dw, dh)
  const data = ctx.getImageData(0, 0, dw, dh).data
  let sum = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4 * 97) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    n++
  }
  return { dw, dh, url: c.toDataURL('image/png'), avg: n ? sum / n : 128 }
}

export default function VectorizeTool() {
  const [src, setSrc] = useState('') // 原图预览
  const [work, setWork] = useState('') // 描摹用工作图 dataURL
  const [svg, setSvg] = useState('')
  const [empty, setEmpty] = useState(false)
  const [err, setErr] = useState('')
  const [tip, setTip] = useState('')
  const [origName, setOrigName] = useState('')
  const [busy, setBusy] = useState(false)

  const [autoThreshold, setAutoThreshold] = useState(true)
  const [threshold, setThreshold] = useState(128)
  const [fgMode, setFgMode] = useState<FgMode>('auto')
  const [turdsize, setTurdsize] = useState(2)
  const [alphamax, setAlphamax] = useState(1)
  const [fill, setFill] = useState('#000000')

  const pathsRef = useRef<ReturnType<typeof traceDataUrl>>([])
  const avgLumRef = useRef(128)
  const fillRef = useRef(fill)
  fillRef.current = fill

  // 修正 getSVG 的偏移缺陷：路径用绝对坐标但 SVG 尺寸是包围盒，需平移到原点
  function buildSVG(paths: ReturnType<typeof traceDataUrl>, size: number, fillColor: string) {
    if (paths.length === 0) return ''
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of paths) {
      if (p.minX < minX) minX = p.minX
      if (p.minY < minY) minY = p.minY
      if (p.maxX > maxX) maxX = p.maxX
      if (p.maxY > maxY) maxY = p.maxY
    }
    let out = getSVG(paths, size, 'fill')
    out = out.replace('fill="black"', `fill="${fillColor}"`)
    out = out.replace(
      '<path d="',
      `<g transform="translate(${(-(minX * size)).toFixed(3)},${(-(minY * size)).toFixed(3)})"><path d="`,
    )
    out = out.replace('</svg>', '</g></svg>')
    return out
  }

  function renderSvg() {
    const s = buildSVG(pathsRef.current, 1, fillRef.current)
    setSvg(s)
    setEmpty(pathsRef.current.length === 0)
  }

  function trace() {
    if (!work) return
    setErr('')
    try {
      const opts: Record<string, unknown> = {
        turdsize,
        alphamax,
        optcurve: true,
        opttolerance: 0.2,
        threshold: autoThreshold ? THRESHOLD_AUTO : threshold,
      }
      if (fgMode === 'light') opts.invert = true
      else if (fgMode === 'dark') opts.blackOnWhite = true
      else if (avgLumRef.current < 128) opts.invert = true
      else opts.blackOnWhite = true
      pathsRef.current = traceDataUrl(work, opts as never)
      renderSvg()
    } catch (e) {
      setErr('描摹失败：' + (e as Error).message)
    }
  }

  // 参数变化（除填充色外）→ 防抖重新描摹
  useEffect(() => {
    if (!work) return
    const t = setTimeout(trace, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, autoThreshold, threshold, fgMode, turdsize, alphamax])

  async function onFile(file: File) {
    setErr('')
    setSvg('')
    setEmpty(false)
    setTip('')
    setBusy(true)
    try {
      const dataUrl = await readAsDataURL(file)
      setSrc(dataUrl)
      setOrigName(file.name)
      const img = await loadImage(dataUrl)
      const p = prepare(img)
      avgLumRef.current = p.avg
      setWork(p.url)
    } catch (e) {
      setErr('图片读取失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function copySvg() {
    if (!svg) return
    navigator.clipboard.writeText(svg).then(
      () => setTip('已复制 SVG 代码，可直接粘贴到 Figma'),
      () => setErr('复制失败，请手动选择文本复制'),
    )
  }

  function downloadSvg() {
    if (!svg) return
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    downloadBlob(blob, `${origName.replace(/\.[^.]+$/, '') || 'vector'}-vector.svg`)
  }

  function downloadPng() {
    if (!svg) return
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || 1
      const h = img.naturalHeight || 1
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(img, 0, 0)
      c.toBlob((b) => {
        if (b) downloadBlob(b, `${origName.replace(/\.[^.]+$/, '') || 'vector'}-vector.png`)
        URL.revokeObjectURL(url)
      }, 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      setErr('PNG 生成失败')
    }
    img.src = url
  }

  const svgBytes = svg ? new Blob([svg]).size : 0
  const svgPreview = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : ''

  return (
    <ToolLayout
      title="图片转矢量"
      description="位图描摹（Potrace 黑白描摹），输出可缩放的 SVG 矢量路径。"
    >
      <div className="card">
        <DropZone onFile={onFile} accept={ACCEPT_IMAGES} label="拖入或选择一张图片（Logo / 文字 / 图标最佳）" />
        {src && (
          <div className="row" style={{ marginTop: 14, alignItems: 'stretch' }}>
            <div className="preview" style={{ flex: 1 }}>
              <img src={src} alt="原图" />
            </div>
            <div className="preview" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--checker, repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px)' }}>
              {svg ? (
                <img src={svgPreview} alt="矢量结果" style={{ maxWidth: '100%', maxHeight: '100%' }} />
              ) : empty ? (
                <span className="muted">未检测到前景，调整「前景 / 阈值」后重试</span>
              ) : busy ? (
                <span className="muted">处理中…</span>
              ) : (
                <span className="muted">矢量结果将显示在这里</span>
              )}
            </div>
          </div>
        )}
        {err && (
          <div className="hint" style={{ color: '#b91c1c', whiteSpace: 'pre-wrap', marginTop: 12 }}>
            {err}
          </div>
        )}
        {tip && <div className="hint" style={{ marginTop: 8 }}>{tip}</div>}
      </div>

      <div className="panel">
        <Section title="描摹参数">
          <div className="field">
            <label>前景判断</label>
            <div className="seg">
              <button className={`seg-btn ${fgMode === 'auto' ? 'on' : ''}`} onClick={() => setFgMode('auto')}>自动</button>
              <button className={`seg-btn ${fgMode === 'dark' ? 'on' : ''}`} onClick={() => setFgMode('dark')}>暗色为前景</button>
              <button className={`seg-btn ${fgMode === 'light' ? 'on' : ''}`} onClick={() => setFgMode('light')}>亮色为前景</button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              黑底白字选「亮色为前景」；白底黑字选「暗色为前景」；自动按平均亮度判断。
            </div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label className="check">
              <input type="checkbox" checked={autoThreshold} onChange={(e) => setAutoThreshold(e.target.checked)} />
              自动阈值（Otsu）
            </label>
            {!autoThreshold && (
              <input
                type="range"
                min={0}
                max={255}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                style={{ marginTop: 8 }}
              />
            )}
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>去杂点 {turdsize}</label>
            <input type="range" min={0} max={20} value={turdsize} onChange={(e) => setTurdsize(Number(e.target.value))} />
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>平滑度（圆角）{alphamax.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1.334}
              step={0.01}
              value={alphamax}
              onChange={(e) => setAlphamax(Number(e.target.value))}
            />
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>填充色</label>
            <input type="color" value={fill} onChange={(e) => { setFill(e.target.value); renderSvg() }} style={{ width: 48, height: 28, padding: 0, border: 'none', background: 'none' }} />
          </div>
        </Section>

        <Section title="结果">
          {svg ? (
            <>
              <div className="stat">
                <span>SVG 体积</span>
                <span className="v">{formatBytes(svgBytes)}</span>
              </div>
              <button className="btn primary block" style={{ marginTop: 12 }} onClick={copySvg}>
                ⧉ 复制 SVG 代码（给 Figma）
              </button>
              <button className="btn block" style={{ marginTop: 8 }} onClick={downloadSvg}>
                ⬇ 下载 SVG（给 AI / PS 置入）
              </button>
              <button className="btn block" style={{ marginTop: 8 }} onClick={downloadPng}>
                ⬇ 下载 PNG（透明背景）
              </button>
              <div className="hint" style={{ marginTop: 8 }}>
                复制 SVG 代码可直接粘进 Figma 成为矢量图形组；PS 需下载 .svg 后「文件-置入嵌入对象」才会变成矢量智能对象（浏览器剪贴板无法直接写矢量路径进 PS）。
              </div>
            </>
          ) : (
            <div className="hint">上传图片后自动描摹，结果出现在这里。</div>
          )}
        </Section>
      </div>
    </ToolLayout>
  )
}
