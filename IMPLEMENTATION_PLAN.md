# Prompt Studio 与 Character Studio 实施计划

## 现有架构分析

- 产品页是原生 HTML + CSS + JavaScript 单页入口：`web/product/index.html`、`web/product/assets/app.js`、`web/product/assets/style.css`。
- 页面通过 hash 路由切换功能页，现有图片生成页已经复用 `queueQwenImage()`、`watchQwenResult()`、`/prompt`、`/api/jobs` 和 `/view`。
- PromptServer 会把 `server.py` 和各管理器注册的路由同时暴露为 `/api/*`，项目和 Recipe 数据使用 UserManager 的本地用户目录持久化。
- 当前最适合的扩展边界是：新增两个轻量本地管理器负责结构化数据和 API，前端继续复用现有 Qwen 工作流与异步任务逻辑。

## 本次范围（Phase 1 + Phase 2 MVP）

### Prompt Studio

- 新增独立路由和一级导航入口。
- 支持原始描述、分类、模型适配、优化结果、原始/优化切换、复制和应用到文生图。
- 使用本地 PromptEngine：Analyzer 提取已有信息，Enhancer 只补充构图、镜头、光线、色彩和氛围，不调用外网服务。
- 统一返回 PromptObject，并保存最近优化记录；提供少量内置模板。
- “生成图片”复用现有 Qwen-Image 2.1 `/prompt` 工作流，继续使用队列和进度回显。

### Character Studio

- 新增角色列表、创建/编辑角色和角色详情路由。
- 支持名称、人物描述、基础信息、外观、头发、性格和视觉身份提示词。
- 支持生成主视觉并确认为 Master Reference。
- 支持 Front、Side、Back 三个视图独立生成、重新生成和确认，不重新生成整张角色卡。
- 角色数据保存到用户目录 `characters/{character_id}.json`，同时创建 references/outfits/expressions/poses/training 目录，为后续扩展保留资产边界。
- 文生图页面加入角色选择器，选择角色后自动合并 Character Identity Prompt 与场景描述。

## 需要修改的文件

- `web/product/index.html`：增加 Prompt Studio、Character Studio 导航入口。
- `web/product/assets/app.js`：增加路由页面、Prompt 优化交互、角色 CRUD、角色视图生成和文生图角色选择。
- `web/product/assets/style.css`：补充两页的克制深色卡片、向导、角色网格和 Prompt 结果样式。
- `server.py`：实例化并注册两个管理器。

## 需要新增的文件

- `app/prompt_studio.py`：PromptObject、Analyzer、Enhancer、Model Adapter、模板和本地历史 API。
- `app/character_manager.py`：角色数据校验、用户目录持久化、角色图片引用和角色 API。

## API 设计

### Prompt Studio

- `POST /api/prompt-studio/optimize`
  - 请求：`{ originalPrompt, category, model, aspectRatio }`
  - 返回：`PromptObject`
- `GET /api/prompt-studio/history?limit=20`
- `GET /api/prompt-studio/templates`

### Character Studio

- `GET /api/characters`
- `POST /api/characters`
- `GET /api/characters/{character_id}`
- `PUT /api/characters/{character_id}`
- `DELETE /api/characters/{character_id}`
- `POST /api/characters/{character_id}/images`
  - 请求：`{ slot, image }`，保存生成结果引用，不复制或上传到外部服务。
- `POST /api/characters/{character_id}/confirm`

## 数据模型

- Prompt 数据使用 `PromptObject`，包含 `originalPrompt`、`structuredPrompt`、`enhancedPrompt`、`negativePrompt`、`category`、`language`、`modelAdapter`、`model`、`aspectRatio`、`createdAt`。
- Character 数据使用 JSON 文档保存完整角色设定和图片引用，避免为本地 MVP 引入新的数据库依赖；字段结构与后续 Character Asset 兼容。
- 生成任务继续使用现有 ComfyUI prompt ID 和 `/api/jobs`，不新增第二套队列。

## 开发顺序

1. 新增 PromptEngine 和 Prompt Studio API，先用本地规则跑通优化数据。
2. 新增 Prompt Studio 页面，接入优化、复制、应用和 Qwen 生成。
3. 新增 CharacterManager 和角色 API，验证角色保存和重新打开。
4. 新增 Character Studio 向导和主视觉/三视图生成。
5. 把角色选择接入文生图，并验证身份提示词合并。
6. 运行语法检查、API 冒烟测试和浏览器流程测试。

## 风险点

- 本机 PromptEngine 是可解释的本地增强器，不等同于云端大模型扩写；接口预留 Provider 边界，后续可替换实现。
- Qwen 生成仍受当前显存和模型加载时间影响，UI 必须保持异步任务状态，不能阻塞页面。
- 角色图片先保存为本地生成结果引用；删除或清理角色时不直接删除共享输出文件，避免破坏历史记录。
- 角色一致性第一版通过 Master Reference + Identity Prompt 实现，不强依赖 LoRA、IPAdapter 或 PuLID。

## 完成标准

- Prompt Studio 输入“雪山里面的木屋”后可以优化、查看原文/优化文、复制，并应用到文生图。
- Character Studio 可以创建角色、保存、重新打开、生成主视觉，并独立生成 Front、Side、Back。
- 文生图选择已保存角色后，提交的 Qwen prompt 包含角色身份描述和用户场景描述。
- 原有文生图、图生图、图片编辑、队列恢复和历史删除功能不回归。
