import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 仪表字体：B612 Mono 由空客为驾驶舱显示屏委托设计，内嵌 woff2，离线可用
import '@fontsource/b612-mono/400.css'
import '@fontsource/b612-mono/700.css'
import { App } from './App'
import './index.css'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
