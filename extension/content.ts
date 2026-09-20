// 常驻浮球 content script —— 注入到所有网页右下角
// 点击浮球 → 发消息给 background 拉起侧边栏；× 收起浮球。
// 注意：本文件作为 classic content script 注入（manifest 不声明 module），
// 且被包裹为 IIFE —— background 会用 chrome.scripting 重复注入，必须幂等。

;(() => {
  const FAB_ID = 'dw-fab-root'
  const STYLE_ID = 'dw-fab-style'

  const STYLE = `
#dw-fab-root {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
}
#dw-fab-root .dw-fab-btn {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.12);
  background: #fff;
  color: #6d5bff;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
#dw-fab-root .dw-fab-btn:hover {
  transform: translateY(-2px) scale(1.04);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.24);
}
#dw-fab-root .dw-fab-close {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.6);
  background: rgba(40, 40, 60, 0.6);
  color: #fff;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
  position: absolute;
  top: -4px;
  right: -4px;
}
#dw-fab-root:hover .dw-fab-close { opacity: 1; }
#dw-fab-root .dw-fab-tip {
  background: rgba(20, 20, 30, 0.82);
  color: #fff;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.15s ease, transform 0.15s ease;
  pointer-events: none;
  white-space: nowrap;
}
#dw-fab-root:hover .dw-fab-tip { opacity: 1; transform: translateY(0); }
`

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = STYLE
    ;(document.head || document.documentElement).appendChild(s)
  }

  let observer: MutationObserver | null = null
  function startObserver() {
    if (observer) return
    observer = new MutationObserver(() => {
      // 页面 DOM 被框架清空（SPA 路由）时，自动把浮球补回来
      if (!document.getElementById(FAB_ID)) injectFab()
    })
    observer.observe(document.documentElement, { childList: true })
  }
  function stopObserver() {
    observer?.disconnect()
    observer = null
  }

  function injectFab() {
    if (document.getElementById(FAB_ID)) return
    injectStyle()

    const root = document.createElement('div')
    root.id = FAB_ID
    root.innerHTML = `
    <div class="dw-fab-tip">点击打开设计工作台，从网页拖图进来</div>
    <button class="dw-fab-btn" title="打开设计工作台" aria-label="打开设计工作台">🎨</button>
    <button class="dw-fab-close" title="收起浮球" aria-label="收起浮球">×</button>
  `
    document.documentElement.appendChild(root)
    console.info('[设计工作台] 浮球已注入')

    const btn = root.querySelector<HTMLButtonElement>('.dw-fab-btn')!
    const close = root.querySelector<HTMLButtonElement>('.dw-fab-close')!

    // 打开失败时的页面内兜底提示
    let tipEl: HTMLDivElement | null = null
    function showFallbackTip(text: string) {
      if (tipEl) tipEl.remove()
      tipEl = document.createElement('div')
      tipEl.textContent = text
      tipEl.style.cssText =
        'position:fixed;right:18px;bottom:80px;z-index:2147483647;background:rgba(20,20,30,.9);' +
        'color:#fff;font-size:13px;padding:8px 12px;border-radius:8px;max-width:280px;' +
        'font-family:system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)'
      document.documentElement.appendChild(tipEl)
      setTimeout(() => {
        tipEl?.remove()
        tipEl = null
      }, 5000)
    }

    btn.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) {
            console.warn('[设计工作台] 侧边栏打开失败', chrome.runtime.lastError || res)
            showFallbackTip('侧边栏未能自动打开：请点击浏览器右上角工具栏中的「设计工作台」图标。')
          }
        })
      } catch (e) {
        console.warn('[设计工作台] 发送消息失败', e)
        showFallbackTip('侧边栏未能自动打开：请点击浏览器右上角工具栏中的「设计工作台」图标。')
      }
    })
    close.addEventListener('click', () => {
      root.remove()
      stopObserver()
      // 5 秒后若仍无浮球，重新出现（用户可能误关）
      setTimeout(() => {
        if (!document.getElementById(FAB_ID)) injectFab()
      }, 5000)
    })
    startObserver()
  }

  function ensure() {
    if (document.getElementById(FAB_ID)) return
    injectFab()
  }

  // 立即尝试；页面仍在加载则等 DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensure, { once: true })
  } else {
    ensure()
  }
  // 兜底重试：部分 SPA（React/Vue）延迟挂载或中途清空 DOM，多试几次确保浮球出现
  ;[300, 1000, 2000].forEach((t) => setTimeout(ensure, t))
})()
