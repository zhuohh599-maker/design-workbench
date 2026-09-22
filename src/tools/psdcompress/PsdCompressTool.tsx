import { useRef, useState, useEffect } from 'react'
import { ToolLayout, DropZone, Section, Slider } from '../../core/components'
import { useInboxHandler } from '../../core/inbox'
import { track } from '../../core/analytics'
import { downloadBlob, formatBytes, MIME_EXT } from '../../core/utils/image'
import { convertWithMagick, type MagickOutFormat } from '../../core/utils/magick'
import { compressPsd } from '../../core/utils/psd'

const ACCEPT = 'image/*,.psd,.psb,.pdf,.svg,.heic,.ai'
type OutFormat = MagickOutFormat | 'psd'
const FORMATS: { id: OutFormat; label: string }[] = [
  { id: 'psd', label: 'PSD（保留图层）' },
  { id: 'webp', label: 'WebP' },
  { id: 'avif', label: 'AVIF' },
  { id: 'jpg', label: 'JPG' },
]

export default function PsdCompressTool() {
  const [file, setFile] = useState<File | null>(null)
  const [origBytes, setOrigBytes] = useState(0)
  const [outBlob, setOutBlob] = useState<Blob | null>(null)
  const [outUrl, setOutUrl] = useState('')
  const [outBytes, setOutBytes] = useState(0)
  const [outName, setOutName] = useState('')
  const [format, setFormat] = useState<OutFormat>('psd')
  const [quality, setQuality] = useState(80)
  const [busy, setBusy] = useState(false)
  const [loadingWasm, setLoadingWasm] = useState(false)
  const [err, setErr] = useState('')
  const previewRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    return () => {
      if (outUrl) URL.revokeObjectURL(outUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useInboxHandler(onFile)

  async function onFile(f: File) {
    track('file_load', 'psdcompress')
    setErr('')
    setOutBlob(null)
    setFile(f)
    setOrigBytes(f.size)
    setOutName(f.name)
    await run(f, format, quality)
  }

  async function run(f: File, fmt: OutFormat, q: number) {
    setBusy(true)
    setErr('')
    try {
      // 首次才需要拉取较大的 wasm 编解码器
      if (!outBlob) setLoadingWasm(true)
      const blob = fmt === 'psd' ? await compressPsd(f) : await convertWithMagick(f, fmt, q)
      if (outUrl) URL.revokeObjectURL(outUrl)
      const url = URL.createObjectURL(blob)
      setOutBlob(blob)
      setOutUrl(url)
      setOutBytes(blob.size)
    } catch (e) {
      setErr((e as Error).message || '转换失败')
      setOutBlob(null)
      setOutUrl('')
      setOutBytes(0)
    } finally {
      setBusy(false)
      setLoadingWasm(false)
    }
  }

  async function download() {
    if (!outBlob) return
    if (format === 'psd') {
      const ext = outName.toLowerCase().endsWith('.psb') ? 'psb' : 'psd'
      downloadBlob(outBlob, `${outName.replace(/\.[^.]+$/, '')}-compressed.${ext}`)
      return
    }
    const ext = MIME_EXT[outBlob.type] || format
    downloadBlob(outBlob, `${outName.replace(/\.[^.]+$/, '')}-compressed.${ext}`)
  }

  const saving = origBytes > 0 && outBytes > 0 ? Math.round((1 - outBytes / origBytes) * 100) : 0
  const isPsd = format === 'psd'

  return (
    <ToolLayout
      title="PSD / 通用格式压缩"
      description="PSD 可保留图层结构重新压缩（ZIP 压缩 + 裁剪透明边 + 丢弃预览图）；也可用 ImageMagick (WASM) 合并图层导出 WebP / AVIF / JPG。"
    >
      <div className="card">
        {!file ? (
          <DropZone onFile={onFile} accept={ACCEPT} label="拖入或选择 PSD / PDF / SVG / HEIC 等文件" hint="PSD 支持最好；PDF/SVG/HEIC 取决于内置编解码器，个别格式可能提示不支持" />
        ) : (
          <div className="preview">
            {outUrl && !isPsd ? (
              <img ref={previewRef} src={outUrl} alt="预览" style={{ maxWidth: '100%', maxHeight: '42vh', display: 'block', margin: '0 auto' }} />
            ) : outBlob && isPsd ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <div style={{ fontSize: 40 }}>🗂</div>
                <div style={{ marginTop: 8 }}>PSD 无法直接预览，下载后用 Photoshop 打开验证</div>
                <div className="muted" style={{ marginTop: 4 }}>
                  图层结构已保留 · 合成预览图已移除（Photoshop 打开时自动重建）
                </div>
              </div>
            ) : (
              <span className="muted">{busy ? (loadingWasm ? '首次加载编解码器…' : '处理中（大文件可能需要较久）…') : '预览生成中…'}</span>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        {file && (
          <Section title="体积对比">
            <div className="stat">
              <span>原文件</span>
              <span className="v">{formatBytes(origBytes)}</span>
            </div>
            <div className="stat">
              <span>导出后</span>
              <span className="v">{outBytes > 0 ? formatBytes(outBytes) : '—'}</span>
            </div>
            <div className="stat">
              <span>节省</span>
              <span className="v" style={{ color: saving > 0 ? '#16a34a' : '#b91c1c' }}>
                {saving > 0 ? `↓ ${saving}%` : saving < 0 ? `↑ ${Math.abs(saving)}%` : '0%'}
              </span>
            </div>
          </Section>
        )}

        <Section title="导出格式">
          <div className="seg">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                className={`seg-btn ${format === f.id ? 'on' : ''}`}
                onClick={() => {
                  setFormat(f.id)
                  if (file) run(file, f.id, quality)
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="hint">
            {isPsd
              ? 'PSD 模式：保留图层，ZIP 压缩图层、裁剪图层透明边、丢弃合成预览与缩略图。仅支持 8-bit RGB；文字层会由 Photoshop 打开时自动重绘（仍可编辑）。'
              : '合并图层导出为图片格式，切换格式会自动用当前质量重新导出。'}
          </div>
        </Section>

        {!isPsd && (
          <Section title="压缩参数">
            <Slider label="质量" min={10} max={100} value={quality} onChange={(v) => { setQuality(v); if (file) run(file, format, v) }} suffix="%" />
            <div className="hint">JPG / WebP / AVIF 受质量滑块控制；质量越低体积越小。</div>
          </Section>
        )}

        {file && (
          <button className="btn primary block" disabled={!outBlob || busy} onClick={download} style={{ marginTop: 12 }}>
            ⬇ 下载导出结果
          </button>
        )}
        {err && (
          <div className="hint" style={{ color: '#b91c1c' }}>
            {err}
          </div>
        )}
      </div>
    </ToolLayout>
  )
}
