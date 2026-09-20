// 轻量使用统计埋点：匿名 uid + sendBeacon 上报到 Netlify Function
// 仅在同源网页版生效（扩展侧边栏 origin 为 chrome-extension://，上报会静默失败，不影响使用）

const UID_KEY = 'dw_uid'
const ENDPOINT = '/.netlify/functions/track'

function getUid(): string {
  try {
    let uid = localStorage.getItem(UID_KEY)
    if (!uid) {
      uid =
        (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ||
        'u' + Math.random().toString(36).slice(2) + Date.now().toString(36)
      localStorage.setItem(UID_KEY, uid)
    }
    return uid
  } catch {
    return 'anon'
  }
}

/**
 * 上报一次使用事件。
 * @param type 事件类型，如 'tool_open'
 * @param tool 当前工具 id（可选）
 */
export function track(type: string, tool?: string) {
  try {
    const payload = JSON.stringify({
      type,
      tool: tool ?? '',
      uid: getUid(),
      t: Date.now(),
    })
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(
        ENDPOINT,
        new Blob([payload], { type: 'application/json' })
      )
      if (ok) return
    }
    // 兜底
    fetch(ENDPOINT, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json' },
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* 静默失败，统计不影响主功能 */
  }
}
