import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './assets/fonts/inter/inter.css'
import App from './App.vue'
import router from './router'
import './assets/styles/main.css'
import './assets/styles/global.css'

// 创建Vue应用
const app = createApp(App)

// 使用Pinia状态管理
const pinia = createPinia()
app.use(pinia)

// 使用路由
app.use(router)

// 挂载应用
app.mount('#app')
