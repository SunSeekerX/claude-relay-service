# Tokenizer resources

The source catalog and pinned manifest are ported from the user's local llysc checkout. They record fixed source revisions, original licenses and SHA256 hashes. Downloaded resources belong under the configured data directory, not in Git. Model weights are excluded.

Claude ctok 1.3.0 and its MIT license are shipped in `embedded/`. The Node engine is ported from llysc's corresponding Nest implementation. It reconstructs visible-content counts and does not claim official complete-request or billed usage.

The management page distinguishes files on disk from an executable counting engine. HF/SentencePiece resources can be managed locally and used through a compatible counting node; downloading a native library never installs or executes it.
