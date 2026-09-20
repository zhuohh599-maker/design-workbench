import { Suspense, useEffect, useState } from 'react'
import { toolsByGroup, tools } from './core/registry'
import { DropZone } from './core/components'
import { InboxProvider, PanelDropZone } from './core/inbox'
import { PaletteIcon } from './core/icons'
import { track } from './core/analytics'

function Loader() {
  return <div className="loader">加载工具组件中…</div>
}

export function App({ compact = false }: { compact?: boolean }) {
  const [activeId, setActiveId] = useState(tools[0]?.id ?? '')
  const [collapsed, setCollapsed] = useState(false)
  const active = tools.find((t) => t.id === activeId && t.enabled)

  // 每次切换到某个工具即上报一次使用事件（用于后台使用统计）
  useEffect(() => {
    if (activeId) track('tool_open', activeId)
  }, [activeId])

  return (
    <InboxProvider>
      <div className={`app${compact ? ' app--compact' : ''}`}>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <PaletteIcon className="brand-mark" />
          <div className="brand-text">
            <div className="brand-title">设计工作台</div>
            <div className="brand-sub">Design Workbench</div>
          </div>
          {!compact && (
            <button
              className="sidebar-toggle"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? '展开侧边栏' : '收起侧边栏'}
              aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              {collapsed ? '›' : '‹'}
            </button>
          )}
        </div>
        <nav className="nav">
          {Object.entries(toolsByGroup).map(([group, list]) => (
            <div className="nav-group" key={group}>
              <div className="nav-group-title">{group}</div>
              {list.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.id}
                    className={`nav-item ${t.id === activeId ? 'active' : ''}`}
                    onClick={() => setActiveId(t.id)}
                    title={collapsed ? t.name : undefined}
                  >
                    <Icon className="nav-icon" />
                    <span className="nav-name">{t.name}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">纯前端设计小工具</div>
      </aside>

      <main className="main">
        {active ? (
          <Suspense fallback={<Loader />}>
            <active.component />
          </Suspense>
        ) : (
          <div className="empty">
            <DropZone onFile={() => {}} label="从左侧选择一个工具开始" />
          </div>
        )}
      </main>
      {compact && <PanelDropZone />}
      </div>
    </InboxProvider>
  )
}
