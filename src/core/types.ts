import type { ComponentType, SVGProps } from 'react'

/**
 * 工具定义 —— 整个工作台的"扩展口子"。
 * 想新增一个工具（例如以后要补的视频工具），只需在 src/tools/ 下
 * 新建一个默认导出的组件，并在 registry.tsx 里加一条记录即可，
 * 工作台会自动渲染入口、无需改动 App 或其它工具。
 */
export interface ToolDef {
  /** 唯一 id，用作路由与懒加载 key */
  id: string
  /** 侧边栏显示名 */
  name: string
  /** 侧边栏图标：线形 SVG 组件，active 状态由外层样式控制 */
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** 一句话简介 */
  description: string
  /** 分组，用于侧边栏归类 */
  group: string
  /** 是否启用（预留：视频类先关掉，后续置 true 即出现） */
  enabled: boolean
  /** 工具主体组件（建议默认导出，便于 React.lazy 代码分割） */
  component: ComponentType
}

export const ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp,image/gif,image/avif'
