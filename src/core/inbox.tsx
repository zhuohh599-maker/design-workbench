import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  useCallback,
} from 'react'

type FileHandler = (f: File) => void | Promise<void>

/** 扩展被重载后 chrome.runtime 会失效（访问即抛 Extension context invalidated），统一安全访问 */
function chromeAvailable(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime
  } catch {
    return false
  }
}

/** 通过 window 事件把载入失败冒泡给拖拽层的 toast 展示 */
export function notifyInboxError(message: string) {
  try {
    window.dispatchEvent(new CustomEvent('inbox-error', { detail: message }))
  } catch {
    /* ignore */
  }
}

interface InboxValue {
  /** 把一个文件推给当前已注册的工具加载器 */
  push: (f: File) => void
  /** 工具注册自己的文件加载函数，返回取消函数 */
  register: (cb: FileHandler) => () => void
}

const InboxContext = createContext<InboxValue | null>(null)

/**
 * 文件收件箱：侧边栏拖入 / 右键「发送到设计工作台」得到的文件，
 * 经由这里路由给「当前激活工具」内部注册的加载函数。
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const handlers = useRef<Set<FileHandler>>(new Set())

  const register = useCallback((cb: FileHandler) => {
    handlers.current.add(cb)
    return () => {
      handlers.current.delete(cb)
    }
  }, [])

  const push = useCallback((f: File) => {
    handlers.current.forEach((h) => {
      try {
        const r: any = h(f)
        // 工具的加载函数多为 async，Promise 拒绝不会被这里的 try/catch 捕获
        if (r && typeof r.catch === 'function') {
          r.catch((e: any) => {
            console.error('[inbox] 载入失败', e)
            notifyInboxError(`载入失败：${e?.message || String(e)}`)
          })
        }
      } catch (e) {
        console.error('[inbox] handler error', e)
        notifyInboxError(`载入失败：${(e as any)?.message || String(e)}`)
      }
    })
  }, [])

  return <InboxContext.Provider value={{ push, register }}>{children}</InboxContext.Provider>
}

export function useInbox() {
  const ctx = useContext(InboxContext)
  if (!ctx) throw new Error('useInbox 必须在 InboxProvider 内使用')
  return ctx
}

/** 工具调用它，把自己的内部文件加载函数挂到收件箱，拖入/右键发送时自动触发 */
export function useInboxHandler(cb: FileHandler) {
  const { register } = useInbox()
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => register((f) => ref.current(f)), [register])
}

function extractImageUrl(uri: string, html: string): string | null {
  const u = (uri || '').trim()
  if (/^https?:\/\//i.test(u)) return u
  const m = (html || '').match(/<img[^>]+src=["']([^"']+)["']/i)
  if (m) return m[1]
  return null
}

/** background 传回的 base64 → File（chrome 消息走 JSON 序列化，字节必须以 base64 传输） */
function b64ToFile(b64: string, mime: string, name: string): File {
  const bin = atob(b64 || '')
  if (!bin.length) throw new Error('收到空文件（图片字节传输失败）')
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new File([arr], name || 'image.png', { type: mime || 'image/png' })
}

/**
 * 侧边栏全局拖拽层（仅 compact/侧边栏模式渲染）。
 * - 本地文件（OS 拖入）：dataTransfer.files 直接可用
 * - 网页图片：drag 仅带 src URL，需经 background service worker 跨域抓取字节
 * - 右键菜单投递：background 直接 sendMessage INBOX_FILE 过来
 */
export function PanelDropZone() {
  const { push } = useInbox()
  const [over, setOver] = useState(false)
  const [tip, setTip] = useState<string | null>(null)

  useEffect(() => {
    if (!chromeAvailable()) return
    const onMsg = (m: any) => {
      if (m?.type === 'INBOX_FILE') {
        try {
          const f = b64ToFile(m.b64, m.mime, m.name)
          push(f)
          flash(`已加入工作台：${f.name}`)
        } catch (e) {
          flash(`加载失败：${String(e)}`)
        }
      } else if (m?.type === 'INBOX_ERROR') {
        flash(`获取失败：${m.error}`)
      }
    }
    let timer: number | undefined
    function flash(text: string) {
      setTip(text)
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => setTip(null), 3000)
    }
    let errHandler: ((e: Event) => void) | undefined
    let registered = false
    try {
      chrome.runtime.onMessage.addListener(onMsg)
      registered = true
      errHandler = (e: Event) => {
        const msg = (e as CustomEvent).detail
        if (typeof msg === 'string') flash(msg)
      }
      window.addEventListener('inbox-error', errHandler)
    } catch {
      /* 扩展上下文失效（刚重载过扩展），忽略 */
    }
    return () => {
      try {
        if (registered) chrome.runtime.onMessage.removeListener(onMsg)
      } catch {
        /* 扩展上下文失效，无需移除 */
      }
      if (errHandler) window.removeEventListener('inbox-error', errHandler)
      if (timer) clearTimeout(timer)
    }
  }, [push])

  useEffect(() => {
    const hasDroppable = (dt: DataTransfer | null) => {
      if (!dt || !dt.types) return false
      return Array.from(dt.types).some(
        (x) => x === 'Files' || x === 'text/uri-list' || x === 'text/plain',
      )
    }

    const onOver = (e: DragEvent) => {
      if (hasDroppable(e.dataTransfer)) {
        e.preventDefault()
        setOver(true)
      }
    }
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setOver(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      setOver(false)
      const dt = e.dataTransfer
      if (!dt) return
      // 1) 本地文件
      if (dt.files && dt.files.length) {
        Array.from(dt.files).forEach((f) => push(f))
        flash(`已加入 ${dt.files.length} 个文件`)
        return
      }
      // 2) 网页图片 URL → 经 background 跨域抓取
      const uri = dt.getData('text/uri-list') || dt.getData('text/plain') || ''
      const url = extractImageUrl(uri, dt.getData('text/html') || '')
      if (!url) return
      try {
        const res: any = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url })
        if (res?.ok) {
          const f = b64ToFile(res.b64, res.mime, res.name)
          push(f)
          flash(`已加入：${f.name}`)
        } else {
          flash(`获取失败：${res?.error || '未知错误'}`)
        }
      } catch (err) {
        flash(`获取失败：${String(err)}`)
      }
    }

    let timer: number | undefined
    function flash(text: string) {
      setTip(text)
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => setTip(null), 3000)
    }

    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      if (timer) clearTimeout(timer)
    }
  }, [push])

  return (
    <>
      {over && (
        <div className="panel-drop-overlay">
          <div className="panel-drop-inner">松开以加入工作台</div>
        </div>
      )}
      {tip && <div className="panel-toast">{tip}</div>}
    </>
  )
}
