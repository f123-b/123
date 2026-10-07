$env:PYTHONPATH = Join-Path $PSScriptRoot '.codex-triton-shim'

py -3.12 main.py `
  --listen 127.0.0.1 `
  --port 8188 `
  --disable-auto-launch `
  --reserve-vram 1 `
  --lowvram `
  --disable-dynamic-vram `
  --disable-triton-backend
