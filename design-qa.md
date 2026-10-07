# Design QA

## Comparison target

- Source visual truth: `C:/Users/lenovo/AppData/Local/Temp/codex-clipboard-baf81b67-c9d6-4624-88c5-98d18be239e2.png`
- Source pixels: 1624 × 969.
- Implementation screenshot: `E:/ComfyUI-0.38.0/ComfyUI-0.38.0/design-qa-implementation-final.png`
- Implementation pixels: 2048 × 1222.
- Comparison input: `E:/ComfyUI-0.38.0/ComfyUI-0.38.0/design-qa-comparison-final.png`
- Viewport: 2048 × 1222 CSS pixels, desktop dark theme, `#page/text-to-image`.
- Normalization: both screenshots were scaled into equal 1024 × 611 panels before side-by-side comparison.

## State and interactions checked

- Text-to-image page loaded with the redesigned layout.
- Eight local generation-history images loaded from `/api/jobs` and rendered below the prompt card.
- Category tabs, prompt quick actions, aspect-ratio controls, reset control, and sampling sliders are wired.
- Six aspect controls are visible, including 自定义.
- Image-to-image upload was rechecked separately: upload reached 100% and the preview rendered.
- Clicking 生成图片 now submits `/prompt` directly; no intermediate “方案已准备好” state appears on image routes.
- Two real Qwen image prompts were submitted back-to-back: one ran and the second stayed pending, then both completed successfully.
- Each queued task renders its own status and progress bar; completed output is shown inside the result card.
- Clicking a history image opens the large-image viewer; close button and Esc close behavior were verified.
- Queue-progress evidence: `E:/ComfyUI-0.38.0/ComfyUI-0.38.0/qa-queue-progress-full.png`.
- Queue-complete evidence: `E:/ComfyUI-0.38.0/ComfyUI-0.38.0/qa-queue-complete.png`.
- 图片编辑页面 evidence: `E:/ComfyUI-0.38.0/ComfyUI-0.38.0/qa-image-editor-final.png`.
- Image-viewer behavior was verified in the browser; the opened viewer exposed a close button and Esc close behavior.
- 图片编辑 now has its own route, upload control, editing prompt, and direct Qwen image-to-image submission path.
- An uploaded local image reached 100% and rendered in the 图片编辑 preview.
- A low-step generation was submitted, the page was changed immediately, and the active task was restored on the next route with its queue card.
- Browser page errors: none reported.

## Findings

No actionable P0, P1, or P2 findings remain.

- The target uses curated inspiration cards; the implementation intentionally replaces them with real local generation history per the latest product requirement.
- Qwen-Image 2.1 keeps the machine-safe defaults of 20 sampling steps and CFG 1.0 instead of the target mock values, because this installation is optimized for an 8 GB GPU with CPU Offload.

## Fidelity review

- Typography: dark Studio hierarchy, compact labels, large display title, and readable Chinese UI copy are consistent with the target direction.
- Layout rhythm: grouped sidebar, top search, hero banner, category pills, large prompt card, sticky settings panel, result panel, and history grid align to the target composition.
- Colors and tokens: navy surfaces, blue active states, cyan primary action, muted secondary text, and thin blue borders are consistent.
- Image fidelity: the local hero asset and generated history images are real raster assets; no placeholder image blocks were used.
- Copy: the page now labels the lower section 生图历史 and explains that records are local.

## Comparison history

1. Initial redesign comparison identified two active sidebar entries caused by duplicate route aliases and a missing 自定义 aspect control.
2. Removed duplicate active route markers, normalized the preference button, added 自定义, captured the final implementation, and rechecked the same viewport.
3. Replaced the image-route planning handoff with direct queue submission, added per-task progress cards, and added a reusable local image viewer.
4. Added the standalone 图片编辑 route and restored active/pending queue tasks from `/queue` after route changes.

## Implementation checklist

- [x] Match the target page hierarchy and dark visual language.
- [x] Keep Qwen-Image 2.1 generation controls and local-only behavior.
- [x] Show real local generation history below the prompt area.
- [x] Preserve image-to-image upload behavior.
- [x] Submit image jobs directly and support multiple queued generations.
- [x] Open generated and history images in a large preview viewer.
- [x] Keep active and pending tasks visible after page navigation.
- [x] Provide a usable 图片编辑 route with local image upload.
- [x] Verify the rendered page and primary controls in the browser.

final result: passed
