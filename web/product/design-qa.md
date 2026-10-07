# AI Canvas 移植验收

- 来源：[Tenney95/AI-Canvas-tauri](https://github.com/Tenney95/AI-Canvas-tauri)
- 页面：`/product/ai-canvas/`
- 构建：原项目生产构建，浏览器模式适配本地 ComfyUI
- 结果：通过
- final result: passed

已核对启动页、项目新建、画布进入、无限点阵画布、节点工具栏、生成图像节点、提示词编辑面板、项目标签和小地图。页面无浏览器错误；同源 `/system_stats` 请求返回 200，ComfyUI 本地 API 通道可用。

说明：Tauri 原生窗口、系统目录对话框等能力只在原生 Tauri 壳中存在，浏览器页面保留原项目的 Web 可用路径，不伪造这些系统能力。
