import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'virtual:uno.css'
import './assets/fonts/inter/inter.css'
import App from './app.vue'
import router from './router'
import './assets/styles/main.css'
import './assets/styles/global.css'
import './assets/styles/controls.css'
import './assets/styles/theme.css'
import './assets/styles/theme_personalities.css'
import './assets/styles/admin_workspace.css'
import { useThemeStore } from './stores/theme'

// 创建Vue应用
const app = createApp(App)

// 使用Pinia状态管理
const pinia = createPinia()
app.use(pinia)
useThemeStore(pinia).initTheme()

// 使用路由
app.use(router)

// 挂载应用
app.mount('#app')
