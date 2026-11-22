export const tableViewportAncestors = element => {
  const ancestors = []
  for (let parent = element?.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) ancestors.push(parent)
  return ancestors
}

// Natural-height dialog bodies must grow to their allowed maximum. Their
// current content bottom cannot be a boundary for the table growing inside.
const hasFixedHeight = element => {
  if (!element) return false
  const height = element.computedStyleMap?.().get('height')?.toString()
  if (height != null && height !== 'auto') return !height.includes('%') || element === document.documentElement || hasFixedHeight(element.parentElement)
  const parent = element.parentElement
  const style = getComputedStyle(element)
  const parentStyle = parent && getComputedStyle(parent)
  return !!parentStyle && (Number.parseFloat(style.flexGrow) > 0 || parentStyle.display.includes('grid')) && hasFixedHeight(parent)
}

const contentBottom = (element, style) => {
  if (hasFixedHeight(element)) return element.getBoundingClientRect().top + element.clientTop + element.clientHeight - Number.parseFloat(style.paddingBottom)
  if (/^\d+(?:\.\d+)?px$/.test(style.maxHeight)) {
    const extra = style.boxSizing === 'border-box' ? -Number.parseFloat(style.borderBottomWidth) - Number.parseFloat(style.paddingBottom) : element.clientTop + Number.parseFloat(style.paddingTop)
    return element.getBoundingClientRect().top + Number.parseFloat(style.maxHeight) + extra
  }
  return Infinity
}

export const measureTableAvailableHeight = (element, bottomReserve = 24) => {
  const top = element.getBoundingClientRect().top
  let available = Infinity
  let scrollOffset = 0
  for (const parent of tableViewportAncestors(element)) {
    if (parent === document.body) continue
    scrollOffset += parent.scrollTop
    const style = getComputedStyle(parent)
    if (!/^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowY)) continue
    const bottom = contentBottom(parent, style)
    available = Math.min(available, bottom - top - scrollOffset)
  }
  available = Math.min(available, window.innerHeight - top - scrollOffset - window.scrollY)
  return Math.max(0, Math.floor(available - bottomReserve))
}
