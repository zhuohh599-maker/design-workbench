import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

// 侧边栏（扩展）入口：以 compact 模式挂载工作台，支持拖入/右键发送文件
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App compact />
  </React.StrictMode>,
)
