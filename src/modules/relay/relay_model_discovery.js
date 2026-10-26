import * as codexManifest from './relay_codex_models_manifest.js'

export const sendModelDiscovery = (req, res, models, gemini = false) => {
  if (gemini) {
    return res.json({ models: models.map((model) => ({ name: `models/${model.id}`, displayName: model.id })) })
  }
  if (typeof req.query?.client_version === 'string' && req.query.client_version.trim()) {
    const manifest = codexManifest.buildCodexModelsManifest(models.map((model) => model.id))
    const etag = codexManifest.codexManifestEtag(manifest)
    res.setHeader('ETag', etag)
    if (codexManifest.codexManifestETagMatches(req.headers['if-none-match'], etag)) {
      return res.status(304).end()
    }
    return res.json(manifest)
  }
  return res.json({ object: 'list', data: models })
}
