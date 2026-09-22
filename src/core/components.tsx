import { useState, useEffect, useRef } from 'react'
import { formatBytes } from './utils/image'

interface DropZoneProps {
  onFile?: (file: File) => void
  onFiles?: (files: File[]) => void
  multiple?: boolean
  accept?: string
  label?: string
  hint?: string
}

/** 全局粘贴导入：监听 window 'paste'，剪贴板含图片（或 accept 指定类型）文件时回调 onFile。
 * 仅在挂载该钩子的组件存活时生效；用 ref 持有最新回调，避免每次渲染重复绑定。 */
export function usePasteImport(onFile: (file: File) => void, accept = 'image/') {
  const cb = useRef(onFile)
  cb.current = onFile
  useEffect(() => {
    const mimePrefix = accept.includes('video') ? 'video/' : 'image/'
    const handler = (e: ClipboardEvent) => {
      // 在输入框里粘贴文字时不拦截，避免影响正常输入
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable) &&
        !e.clipboardData?.items?.length
      ) {
        return
      }
      const dt = e.clipboardData
      if (!dt) return
      let file: File | null = null
      if (dt.files?.length) {
        for (const f of Array.from(dt.files)) {
          if (f.type.startsWith(mimePrefix)) {
            file = f
            break
          }
        }
      }
      if (!file && dt.items?.length) {
        for (const it of Array.from(dt.items)) {
          if (it.kind === 'file' && it.type.startsWith(mimePrefix)) {
            const f = it.getAsFile()
            if (f) {
              file = f
              break
            }
          }
        }
      }
      if (file) {
        e.preventDefault()
        cb.current(file)
      }
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [accept])
}

/** 通用拖拽/点击取文件区，所有工具复用；并支持 Ctrl/⌘+V 粘贴导入 */
export function DropZone({ onFile, onFiles, multiple, accept, label, hint }: DropZoneProps) {
  const [drag, setDrag] = useState(false)
  usePasteImport((f) => {
    if (multiple && onFiles) onFiles([f])
    else onFile?.(f)
  }, accept)
  return (
    <label
      className={`dropzone${drag ? ' dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        const fs = e.dataTransfer.files
        if (multiple && onFiles && fs && fs.length > 1) onFiles(Array.from(fs))
        else {
          const f = fs?.[0]
          if (f) onFile?.(f)
        }
      }}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          const fs = e.target.files
          if (multiple && onFiles && fs && fs.length > 0) onFiles(Array.from(fs))
          else {
            const f = fs?.[0]
            if (f) onFile?.(f)
          }
          e.target.value = ''
        }}
      />
      <div className="dropzone-inner">
        <span className="dropzone-icon">⬆️</span>
        <span>{label ?? '点击、拖拽，或 Ctrl/⌘+V 粘贴图片到此处'}</span>
        <span className="dropzone-hint">{hint}</span>
      </div>
    </label>
  )
}

interface ToolLayoutProps {
  title: string
  description?: string
  children: React.ReactNode
}

/** 统一的工具页面外壳：标题 + 内容容器 */
export function ToolLayout({ title, description, children }: ToolLayoutProps) {
  return (
    <div className="tool">
      <header className="tool-header">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="tool-body">{children}</div>
    </div>
  )
}

/** 操作面板里的小节 */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      <div className="section-body">{children}</div>
    </section>
  )
}

/** 带标签的滑块 */
export function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  suffix,
}: {
  label: string
  min: number
  max: number
  step?: number
  value: number
  onChange: (v: number) => void
  suffix?: string
}) {
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <b>
          {value}
          {suffix}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function formatSize(n: number) {
  return formatBytes(n)
}
