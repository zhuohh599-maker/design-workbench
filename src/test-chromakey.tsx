// 保护区功能独立测试入口：单工具渲染，不依赖线上站点与本地服务器，
// 构建后内联为单文件 HTML，可直接双击打开测试。
import { createRoot } from 'react-dom/client'
import { InboxProvider } from './core/inbox'
import ChromakeyVideoTool from './tools/chromakey/ChromakeyVideoTool'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <InboxProvider>
    <ChromakeyVideoTool />
  </InboxProvider>,
)
