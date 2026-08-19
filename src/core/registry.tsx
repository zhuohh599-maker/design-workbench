import { lazy } from 'react'
import type { ToolDef } from './types'
import {
  ResizeIcon,
  ConvertIcon,
  CompressIcon,
  MattingIcon,
  AnimakerIcon,
  ChromakeyIcon,
  RoundedIcon,
  VectorizeIcon,
} from './icons'

/**
 * 工具注册表 —— 工作台唯一的工具清单。
 *
 * 新增工具步骤：
 *   1) 在 src/tools/<your-tool>/ 下创建默认导出的 React 组件
 *   2) 在下面数组追加一条 ToolDef（enabled: true）
 *   3) 完成。侧边栏、路由、懒加载全部自动生效。
 *
 * 用 lazy() 做代码分割：重工具（抠图模型、动图编辑器）按需加载，
 * 首屏不拖慢其它工具。
 */
export const tools: ToolDef[] = [
  {
    id: 'resize',
    name: '尺寸缩放',
    icon: ResizeIcon,
    description: '把图片缩放/裁剪到指定尺寸',
    group: '图片处理',
    enabled: true,
    component: lazy(() => import('../tools/resize/ResizeTool')),
  },
  {
    id: 'convert',
    name: '格式转换',
    icon: ConvertIcon,
    description: 'JPG / PNG / WEBP / AVIF 互转',
    group: '图片处理',
    enabled: true,
    component: lazy(() => import('../tools/convert/ConvertTool')),
  },
  {
    id: 'compress',
    name: '智能压缩',
    icon: CompressIcon,
    description: '压缩 JPG / PNG / GIF 体积',
    group: '图片处理',
    enabled: true,
    component: lazy(() => import('../tools/compress/CompressTool')),
  },
  {
    id: 'rounded',
    name: '图片圆角',
    icon: RoundedIcon,
    description: '裁剪四个角圆角，导出透明 PNG',
    group: '图片处理',
    enabled: true,
    component: lazy(() => import('../tools/rounded/RoundedTool')),
  },
  {
    id: 'vectorize',
    name: '图片转矢量',
    icon: VectorizeIcon,
    description: '位图描摹，输出可缩放 SVG 矢量路径',
    group: '图片处理',
    enabled: true,
    component: lazy(() => import('../tools/vectorize/VectorizeTool')),
  },
  {
    id: 'matting',
    name: 'AI 抠图',
    icon: MattingIcon,
    description: 'AI 去背景，输出透明 PNG',
    group: 'AI 工具',
    enabled: true,
    component: lazy(() => import('../tools/matting/MattingTool')),
  },
  {
    id: 'animaker',
    name: '动图制作',
    icon: AnimakerIcon,
    description: '画板式动画编辑器，导出 GIF',
    group: '创作',
    enabled: true,
    component: lazy(() => import('../tools/animaker/AnimakerTool')),
  },
  {
    id: 'chromakey',
    name: '绿幕视频抠像',
    icon: ChromakeyIcon,
    description: '逐帧去绿幕，水印抹除，导出透明 GIF',
    group: '视频处理',
    enabled: true,
    component: lazy(() => import('../tools/chromakey/ChromakeyVideoTool')),
  },
]

export const toolsByGroup: Record<string, ToolDef[]> = tools
  .filter((t) => t.enabled)
  .reduce<Record<string, ToolDef[]>>((acc, t) => {
    ;(acc[t.group] ||= []).push(t)
    return acc
  }, {})
