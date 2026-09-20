// MV3 background service worker —— 设计工作台浏览器扩展
// 职责：
//   1) 常驻浮球（content script）点击后，拉起侧边栏（side panel）
//   2) 侧边栏拖入「网页图片 URL」时，用扩展特权跨域 fetch 真实字节回传
//   3) 右键菜单「发送到设计工作台」把页面图片投递到侧边栏
//
// 说明：扩展页面的 drag 事件只带图片 src URL（不带二进制），所以必须在这里
// 用 host_permissions 跨域抓取。content script / side panel 都无此特权。

const MENU_ID = 'send-to-workbench'

function urlBaseName(url: string): string {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean).pop() || 'image'
    return seg.includes('.') ? seg : `${seg}.png`
  } catch {
    return 'image.png'
  }
}

/** ArrayBuffer → base64。chrome.runtime 消息走 JSON 序列化，ArrayBuffer 会丢失，必须转字符串 */
function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** 魔数校验：防止站点返回 HTML 防盗链页而非图片 */
function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 12) return false
  const ascii = (n: number, len: number) =>
    String.fromCharCode(...b.subarray(n, n + len))
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return true
  if (b[0] === 0xff && b[1] === 0xd8) return true // JPEG
  if (ascii(0, 3) === 'GIF') return true
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return true
  if (ascii(4, 4) === 'ftyp') return true // HEIC/AVIF 等
  return false
}

/** 跨域抓取图片字节（带 host_permissions 特权，不受页面 CORS 限制） */
async function fetchImageBytes(
  url: string,
): Promise<{ b64: string; mime: string; name: string }> {
  const res = await fetch(url, { credentials: 'omit' })
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`)
  const bytes = await res.arrayBuffer()
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0]
  const isImgMime = /^image\//i.test(mime)
  if (!isImgMime && !looksLikeImage(new Uint8Array(bytes))) {
    throw new Error('目标地址未返回图片（可能被防盗链拦截）')
  }
  return { b64: bytesToBase64(bytes), mime, name: urlBaseName(url) }
}

/** 把抓取到的图片投递给已打开的侧边栏 */
async function deliverToPanel(url: string) {
  try {
    const { b64, mime, name } = await fetchImageBytes(url)
    chrome.runtime.sendMessage({ type: 'INBOX_FILE', url, b64, mime, name }).catch(() => {})
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'INBOX_ERROR', error: String(e) }).catch(() => {})
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '发送到设计工作台',
    contexts: ['image'],
  })
})

// 点工具栏图标即打开侧边栏（若用户未用浮球）。顶层执行，确保任何情况下生效
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {})
} catch {
  /* Chrome < 114 无 sidePanel API，忽略 */
}

// 右键菜单：图片 → 设计工作台
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return
  const src = info.srcUrl
  if (!src) return
  if (tab?.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {})
  deliverToPanel(src)
})

// 浮球兜底注入：页面加载完成后用 scripting API 主动注入（content.js 自身幂等），
// 避免 manifest 声明式注入因时机/更新问题失效
if (chrome.scripting) {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content.js'] })
      .catch(() => {})
  })
}

// 来自侧边栏 / 浮球的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 浮球点击：拉起当前标签的侧边栏
  if (msg?.type === 'OPEN_SIDE_PANEL') {
    const open = (opts: any) =>
      chrome.sidePanel
        .open(opts)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error('[设计工作台] sidePanel.open 失败:', e)
          sendResponse({ ok: false, error: String(e) })
        })
    const tabId = sender.tab?.id
    const windowId = sender.tab?.windowId
    if (typeof tabId === 'number') open({ tabId })
    else if (typeof windowId === 'number') open({ windowId })
    else sendResponse({ ok: false, error: '无法确定目标标签页' })
    return true // 保持通道，等待 open 的异步结果
  }
  // 侧边栏拖入图片 URL：跨域抓取并回传字节
  if (msg?.type === 'FETCH_IMAGE') {
    fetchImageBytes(msg.url)
      .then(({ b64, mime, name }) => sendResponse({ ok: true, b64, mime, name }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true // 保持消息通道异步响应
  }
})
