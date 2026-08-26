import { formatLocalDate, formatLocalDateTime } from '@/libs/time'

// App 配置
export const APP_CONFIG = {
  basePath: import.meta.env.VITE_APP_BASE_URL || (import.meta.env.DEV ? '/admin/' : '/web/admin/'),
  apiPrefix: import.meta.env.DEV ? '/webapi' : ''
}

export const getAppUrl = (path = '') => {
  if (path && !path.startsWith('/')) path = '/' + path
  return APP_CONFIG.basePath + (path.startsWith('#') ? path : '#' + path)
}

export const getLoginUrl = () => getAppUrl('/login')

// Toast 通知管理
let toastContainer = null
let toastId = 0

export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export const showToast = (message, type = 'info', title = '', duration = 2500) => {
  // 创建容器
  if (!toastContainer) {
    toastContainer = document.createElement('div')
    toastContainer.id = 'toast-container'
    toastContainer.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:8px;pointer-events:none;'
    document.body.appendChild(toastContainer)
  }

  const id = ++toastId
  const toast = document.createElement('div')
  toast.className = `app-toast app-toast--${type}`
  toast.style.cssText = 'pointer-events:auto;transform:translateX(120%);transition:transform .25s ease;'

  const iconMap = {
    success: 'i-lucide-circle-check',
    error: 'i-lucide-circle-x',
    warning: 'i-lucide-triangle-alert',
    info: 'i-lucide-info'
  }

  // message/title 可能来自后端 error 字符串，禁止直接拼 innerHTML（DOM XSS）
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>')
  const titleHtml = safeTitle ? `<div class="app-toast__title">${safeTitle}</div>` : ''
  toast.innerHTML = `
    <i class="app-toast__icon ${iconMap[type] || iconMap.info}"></i>
    <div class="app-toast__body">
      ${titleHtml}
      <div class="app-toast__msg">${safeMessage}</div>
    </div>
    <button type="button" class="app-toast__close" aria-label="关闭">
      <i class="i-lucide-x"></i>
    </button>
  `

  const closeBtn = toast.querySelector('.app-toast__close')
  const dismiss = () => {
    toast.style.transform = 'translateX(120%)'
    setTimeout(() => toast.remove(), 250)
  }
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    dismiss()
  })
  toast.addEventListener('click', dismiss)

  toastContainer.appendChild(toast)
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(0)'
  })

  if (duration > 0) {
    setTimeout(dismiss, duration)
  }

  return id
}

// 复制文本到剪贴板
export const copyText = async (text, successMsg = '已复制') => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    showToast(successMsg, 'success')
    return true
  } catch (error) {
    console.error('Failed to copy:', error)
    showToast('复制失败', 'error')
    return false
  }
}

// 数字格式化
export const formatNumber = (num) => {
  if (num === null || num === undefined) return '0'
  const absNum = Math.abs(num)
  if (absNum >= 1e9) return (num / 1e9).toFixed(2) + 'B'
  if (absNum >= 1e6) return (num / 1e6).toFixed(2) + 'M'
  if (absNum >= 1e3) return (num / 1e3).toFixed(1) + 'K'
  return num.toLocaleString()
}

// 日期格式化
export const formatDate = (date, format = 'YYYY-MM-DD HH:mm:ss') => {
  if (!date) return ''
  return formatLocalDateTime(date, format)
}

// 相对时间格式化
export const formatRelativeTime = (date) => {
  if (!date) return ''
  const d = new Date(date)
  const diffMs = new Date() - d
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays >= 7) return formatLocalDate(date) || ''
  if (diffDays > 0) return `${diffDays}天前`
  if (diffHours > 0) return `${diffHours}小时前`
  if (diffMins > 0) return `${diffMins}分钟前`
  return '刚刚'
}

// 字节格式化
export const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals)) + ' ' + sizes[i]
}

// 日期时间格式化 (简化版)
export const formatDateTime = (date) => {
  if (!date) return ''
  return formatLocalDateTime(date)
}

// 金额格式化
export const formatCost = (value) => {
  const num = Number(value || 0)
  if (num === 0) return '$0.00'
  if (num < 0.01) return `$${num.toFixed(6)}`
  return `$${num.toFixed(2)}`
}

// 计算元素底边到视口底之间的固定占用：各级祖先的下内边距/下边框，
// 以及该元素及各级祖先之后兄弟的（上下外边距 + 高度）。用于动态算“填满视口剩余空间”的高度，
// 替代写死魔数。getBoundingClientRect().height 不含 margin，故 margin 单独累加；跨断点自适应。
// safety 为吸收子像素取整的安全垫。
export const calcViewportBottomReserve = (el, safety = 8) => {
  const px = (v) => parseFloat(v) || 0
  let reserve = safety
  for (
    let node = el;
    node && node !== document.body && node.parentElement;
    node = node.parentElement
  ) {
    const parent = node.parentElement
    reserve += px(getComputedStyle(node).marginBottom)
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const ss = getComputedStyle(sib)
      // 跳过浮层（模态框等），它们不占文档流
      if (ss.position === 'fixed' || ss.position === 'absolute') continue
      reserve += px(ss.marginTop) + sib.getBoundingClientRect().height + px(ss.marginBottom)
    }
    const ps = getComputedStyle(parent)
    reserve += px(ps.paddingBottom) + px(ps.borderBottomWidth)
  }
  return reserve
}

// 防抖：延迟 wait 毫秒执行 fn，期间再次触发则重新计时；返回函数带 .cancel() 取消挂起的调用。
// 替代 lodash-es 的 debounce（避免依赖会消失的间接包）
export const debounce = (fn, wait = 300) => {
  let timer = null
  const debounced = (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, wait)
  }
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return debounced
}
