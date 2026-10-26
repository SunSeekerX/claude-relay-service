import path from 'node:path'

export const tokenizerAssetPath = (file, root) => {
  let relative = file.path
  if (relative === undefined && typeof file.filename === 'string') {
    const basename = file.filename.replaceAll('\\', '/').split('/').pop()
    if (!basename?.startsWith(`${file.sha256}.`)) {
      throw new Error('旧词表文件路径无法识别，请重新应用')
    }
    relative = `blobs/${basename}`
  }
  if (typeof relative !== 'string' || !relative.startsWith('blobs/')) {
    throw new Error('词表文件路径无效')
  }
  const target = path.resolve(root, relative)
  const remaining = path.relative(path.resolve(root), target)
  if (remaining.startsWith('..') || path.isAbsolute(remaining)) {
    throw new Error('词表文件路径越过资源目录')
  }
  return target
}
