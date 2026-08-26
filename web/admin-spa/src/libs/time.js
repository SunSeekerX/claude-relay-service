import dayjs from 'dayjs'

export const formatDateTimeLocalValue = (value) => {
  if (!value) return ''
  const date = dayjs(value)
  if (!date.isValid()) return ''
  return date.format('YYYY-MM-DDTHH:mm')
}

export const getDateTimeLocalMinValue = (minutesFromNow = 1) => {
  return dayjs().add(minutesFromNow, 'minute').format('YYYY-MM-DDTHH:mm')
}

export const localDateTimeInputToISOString = (value) => {
  if (!value) return ''
  const date = dayjs(value)
  if (!date.isValid()) return ''
  return date.toDate().toISOString()
}

export const formatLocalDateTime = (value, format = 'YYYY-MM-DD HH:mm:ss') => {
  if (!value) return ''
  const date = dayjs(value)
  if (!date.isValid()) return ''
  return date.format(format)
}

export const formatLocalDate = (value, format = 'YYYY-MM-DD') => {
  if (!value) return ''
  const date = dayjs(value)
  if (!date.isValid()) return ''
  return date.format(format)
}

export const toLocalDateString = (value = new Date()) => {
  const date = dayjs(value)
  if (!date.isValid()) return ''
  return date.format('YYYY-MM-DD')
}

// ISO week：周一为一周起点
export const getStartOfIsoWeek = (value = dayjs()) => {
  const date = dayjs(value)
  const day = date.day()
  const offset = day === 0 ? 6 : day - 1
  return date.startOf('day').subtract(offset, 'day')
}

export const getEndOfIsoWeek = (value = dayjs()) => getStartOfIsoWeek(value).add(6, 'day').endOf('day')

// 统一存库格式：YYYY-MM-DD HH:mm:ss
export const toStoreDateTime = (value) => {
  if (value == null || value === '') return ''
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) {
    return value.length === 16 ? `${value}:00` : value.slice(0, 19)
  }
  if (typeof value === 'string' && value.includes('T')) {
    const normalized = value.replace('T', ' ').slice(0, 19)
    return normalized.length === 16 ? `${normalized}:00` : normalized
  }
  const date = dayjs(value)
  if (!date.isValid()) return ''
  return date.format('YYYY-MM-DD HH:mm:ss')
}

export const toDateTimeLocalInput = (value) => {
  if (value == null || value === '') return ''
  if (typeof value === 'string' && value.includes('T') && value.length >= 16) {
    return value.slice(0, 16)
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /.test(value)) {
    return value.replace(' ', 'T').slice(0, 16)
  }
  const date = dayjs(value)
  if (!date.isValid()) return ''
  return date.format('YYYY-MM-DDTHH:mm')
}

// 日期范围预设：返回 [start, end] 存库字符串，或 null（全部）
export const buildDateRangePreset = (key, now = dayjs()) => {
  const current = dayjs(now)
  const store = (date) => date.format('YYYY-MM-DD HH:mm:ss')

  switch (key) {
    case 'all':
      return null
    case '1h':
      return [store(current.subtract(1, 'hour')), store(current)]
    case '6h':
      return [store(current.subtract(6, 'hour')), store(current)]
    case '24h':
      return [store(current.subtract(24, 'hour')), store(current)]
    case 'today':
      return [store(current.startOf('day')), store(current)]
    case 'yesterday': {
      const yesterday = current.subtract(1, 'day')
      return [store(yesterday.startOf('day')), store(yesterday.endOf('day'))]
    }
    case '7d':
      return [store(current.subtract(7, 'day')), store(current)]
    case '30d':
      return [store(current.subtract(30, 'day')), store(current)]
    case 'this_week':
      return [store(getStartOfIsoWeek(current)), store(current)]
    case 'last_week': {
      const lastWeek = current.subtract(1, 'week')
      return [store(getStartOfIsoWeek(lastWeek)), store(getEndOfIsoWeek(lastWeek))]
    }
    case 'this_month':
      return [store(current.startOf('month')), store(current)]
    case 'last_month': {
      const lastMonth = current.subtract(1, 'month')
      return [store(lastMonth.startOf('month')), store(lastMonth.endOf('month'))]
    }
    default:
      return null
  }
}

// 默认筛选预设集（用量/请求明细）
export const DEFAULT_DATE_RANGE_PRESETS = [
  { key: '1h', label: '近1小时' },
  { key: '6h', label: '近6小时' },
  { key: '24h', label: '近24小时' },
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'this_week', label: '本周' },
  { key: 'this_month', label: '本月' },
  { key: 'all', label: '全部' }
]

export const SIMPLE_DATE_RANGE_PRESETS = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'this_month', label: '本月' },
  { key: 'all', label: '全部' }
]
