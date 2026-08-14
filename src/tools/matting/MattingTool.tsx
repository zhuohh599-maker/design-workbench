import { useState, useRef } from 'react'
import { removeBackground } from '@imgly/background-removal'
import { ToolLayout, DropZone, Section, CompressControls, useSmartCompress } from '../../core/components'
import { formatBytes, downloadBlob, blobExt } from '../../core/utils/image'
import { ACCEPT_IMAGES } from '../../core/types'

export default function MattingTool() {
  const [src, setSrc] = useState<string>('') // 原图预览
  const [result, setResult] = useState<Blob | null>(null)
  const [resultUrl, setResultUrl] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [step, setStep] = useState('')
  const [err, setErr] = useState('')
  const [origName, setOrigName] = useState('')
  const [origBytes, setOrigBytes] = useState(0)
  const [tip, setTip] = useState('')
  const resultImgRef = useRef<HTMLImageElement>(null)
  const c = useSmartCompress()

  async function onFile(file: File) {
    setErr('')
    setResult(null)
    setResultUrl('')
    setProgress(0)
    setStep('准备模型…')
    setOrigName(file.name)
    setOrigBytes(file.size)
    setSrc(URL.createObjectURL(file))

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
      const url = URL.createObjectURL(blob)
      setResult(blob)
      setResultUrl(url)
    } catch (e) {
      setErr('抠图失败：' + (e as Error).message + '\n（首次使用需联网下载 AI 模型，请确认网络畅通）')
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  async function download() {
    if (!result) return
    setTip('')
    let blob = result
    const orig = blob.size
    blob = await c.run(blob)
    const ext = blobExt(blob)
    downloadBlob(blob, `${origName.replace(/\.[^.]+$/, '')}-nocutout.${ext}`)
    setTip(`${c.compress ? `智能压缩 ${formatBytes(orig)} → ${formatBytes(blob.size)}` : `已导出 ${formatBytes(blob.size)}`}`)
  }

  return (
    <ToolLayout title="AI 抠图" description="本地运行的 AI 去背景，输出透明 PNG。文件与模型均不离开你的浏览器。">
      <div className="card">
        <DropZone onFile={onFile} accept={ACCEPT_IMAGES} label="拖入或选择一张图片（人像/物体均可）" />
        {src && (
          <div className="row" style={{ marginTop: 14, alignItems: 'stretch' }}>
            <div className="preview" style={{ flex: 1 }}>
              <img src={src} alt="原图" />
            </div>
            <div className="preview" style={{ flex: 1 }}>
              {resultUrl ? (
                <img ref={resultImgRef} src={resultUrl} alt="结果" />
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
        {err && <div className="hint" style={{ color: '#b91c1c', whiteSpace: 'pre-wrap' }}>{err}</div>}
      </div>

      <div className="panel">
        <Section title="结果">
          {result ? (
            <>
              <div className="stat"><span>原图</span><span className="v">{formatBytes(origBytes)}</span></div>
              <div className="stat"><span>抠图后</span><span className="v">{formatBytes(result.size)}</span></div>
              <button className="btn primary block" style={{ marginTop: 12 }} onClick={download}>
                ⬇ 导出透明 PNG
              </button>
              <CompressControls compress={c.compress} setCompress={c.setCompress} quality={c.quality} setQuality={c.setQuality} />
              {tip && <div className="hint">{tip}</div>}
            </>
          ) : (
            <div className="hint">上传图片后，AI 会自动去除背景并生成透明 PNG。</div>
          )}
        </Section>
        <div className="hint">
          首次使用会在后台下载约几十 MB 的 AI 模型（仅一次，之后走浏览器缓存）。处理在人像与主体清晰的图像上效果最佳。
        </div>
      </div>
    </ToolLayout>
  )
}
