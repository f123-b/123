const state = { plan: null, projects: [], selectedProject: null, recipeSchema: null, workflowPayload: null, workflowDiagnosis: null, libraryTab: "recipes", promptMode: "image", routePrompt: "", routeImage: null, routeImages: [], routeReferences: [], routeQueue: [], imageViewerBound: false, characters: [], character: null, apiConfigs: [], selectedApiConfigId: null, promptStudio: { result: null, view: "enhanced" }, canvas: { title: "AI Canvas 项目", nodes: [], selectedId: null } };
const API_CONFIG_STORAGE_KEY = "comfyui.studio.api-configs";
const GENERATION_TIMING_STORAGE_KEY = "comfyui.studio.generation-timings";
const CANVAS_STORAGE_KEY = "comfyui.studio.ai-canvas";
const CANVAS_STORAGE_VERSION = 2;
let apiBase = "";
const apiBaseReady = window.desktop?.getApiBase
  ? window.desktop.getApiBase().then((value) => { apiBase = value || ""; return apiBase; })
  : Promise.resolve(window.location.protocol === "file:" ? "http://127.0.0.1:8188" : "");

const $ = (selector) => document.querySelector(selector);

const modelTypeLabels = {
  image: "图片生成",
  video: "视频生成",
  prompt: "提示词优化",
  character: "人物卡",
  videoProcess: "视频处理",
};

function readLocalJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "耗时 —";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `耗时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `耗时 ${minutes} 分 ${rest} 秒`;
  return `耗时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function historyElapsedMs(job) {
  const start = Number(job?.execution_start_time || job?.create_time);
  const end = Number(job?.execution_end_time);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  let historyStart = null;
  let historyEnd = null;
  for (const entry of job?.status?.messages || []) {
    const event = entry?.[0];
    const timestamp = Number(entry?.[1]?.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (event === "execution_start") historyStart = timestamp;
    if (["execution_success", "execution_error", "execution_interrupted"].includes(event)) historyEnd = timestamp;
  }
  if (historyStart !== null && historyEnd !== null && historyEnd >= historyStart) return historyEnd - historyStart;
  return null;
}

function generationTimings() {
  const value = readLocalJson(GENERATION_TIMING_STORAGE_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function startGenerationTiming(promptId, kind = "image") {
  if (!promptId) return;
  const timings = generationTimings();
  const current = timings[promptId] || {};
  timings[promptId] = { ...current, kind, startedAt: current.startedAt || Date.now(), elapsedMs: current.elapsedMs ?? null };
  const keys = Object.keys(timings);
  keys.slice(0, Math.max(0, keys.length - 100)).forEach((key) => delete timings[key]);
  writeLocalJson(GENERATION_TIMING_STORAGE_KEY, timings);
}

function finishGenerationTiming(promptId, job) {
  if (!promptId) return null;
  const timings = generationTimings();
  const current = timings[promptId] || { startedAt: Date.now() };
  const elapsedMs = historyElapsedMs(job) ?? current.elapsedMs ?? Math.max(0, Date.now() - current.startedAt);
  timings[promptId] = { ...current, completedAt: Date.now(), elapsedMs };
  writeLocalJson(GENERATION_TIMING_STORAGE_KEY, timings);
  return elapsedMs;
}

function getGenerationElapsed(promptId, job) {
  return historyElapsedMs(job) ?? generationTimings()[promptId]?.elapsedMs ?? null;
}

function jobElapsedLabel(job) {
  const elapsed = getGenerationElapsed(job?.id, job);
  if (elapsed !== null) return formatElapsed(elapsed);
  return ["pending", "in_progress", "running"].includes(job?.status) ? "耗时进行中" : "耗时 —";
}

async function api(path, options = {}) {
  await apiBaseReady;
  if (window.location.protocol === "file:") {
    throw new Error("请先启动 ComfyUI，再通过 http://127.0.0.1:8188/product/ 打开页面。");
  }
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${apiBase}${path}`, {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      if (!response.ok) throw new Error(data.error || "请求失败 (" + response.status + ")");
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 4) {
        if (lastError instanceof TypeError || /failed to fetch|networkerror/i.test(lastError.message || "")) {
          const hint = window.location.protocol === "file:"
            ? "请先启动 ComfyUI，再通过 http://127.0.0.1:8188/product/ 打开页面。"
            : "请确认 ComfyUI 服务已启动。";
          throw new Error(`无法连接 ComfyUI 服务。${hint}`);
        }
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError;
}

function setStatus(message, error = false) {
  const element = $("#plan-status");
  if (!element) return;
  element.className = `status-row${error ? " error" : ""}`;
  const pulse = document.createElement("span");
  pulse.className = "status-pulse";
  const text = document.createElement("span");
  text.textContent = message;
  element.replaceChildren(pulse, text);
}

function refreshAfterBackendReady(status) {
  if (status.state !== "ready") return;
  setStatus("本地服务已就绪，可以开始创作。");
  loadProjects(); loadTemplates(); loadEnvironment(); loadGallery(); loadModels(); loadNodes(); loadJobs();
}

function renderRecipes(recipes) {
  $("#recipe-count").textContent = recipes.length;
  const target = $("#recipes");
  if (!recipes.length) { target.className = `list empty${state.libraryTab === "recipes" ? "" : " is-hidden"}`; target.textContent = "暂无候选。"; return; }
  target.className = `list${state.libraryTab === "recipes" ? "" : " is-hidden"}`;
  target.replaceChildren(...recipes.map((recipe) => {
    const row = document.createElement("div"); row.className = "list-item";
    const text = document.createElement("div");
    text.innerHTML = `<strong></strong><small></small>`;
    text.querySelector("strong").textContent = recipe.name || recipe.id;
    text.querySelector("small").textContent = `${recipe.category || "未分类"} · 匹配 ${recipe.score ?? 0}`;
    const button = document.createElement("button"); button.className = "button tiny"; button.textContent = "选择";
    button.onclick = () => selectRecipe(recipe);
    row.append(text, button); return row;
  }));
}

async function materializeRecipe(recipe) {
  if (recipe.source !== "template") return recipe;
  const copied = await api(`/api/recipes/templates/${encodeURIComponent(recipe.template_id || recipe.id)}/copy`, {
    method: "POST",
    body: JSON.stringify({ name: recipe.name }),
  });
  return copied;
}

async function selectRecipe(recipe) {
  if (!state.plan) return;
  try {
    setStatus(recipe.source === "template" ? "正在复制内置 Recipe…" : `已选择 Recipe：${recipe.name || recipe.id}`);
    const selected = await materializeRecipe(recipe);
    state.plan.selected_recipe = selected;
    renderPlan(state.plan);
    setStatus(`已选择 Recipe：${selected.name || selected.id}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadRecipeSchema(recipe) {
  const target = $("#recipe-inputs");
  state.recipeSchema = null;
  target.className = "recipe-inputs empty";
  target.textContent = "正在读取 Recipe 参数…";
  try {
    state.recipeSchema = await api(`/api/recipes/${encodeURIComponent(recipe.id)}/schema`);
    renderRecipeInputs(state.recipeSchema);
  } catch (error) {
    target.textContent = error.message;
  }
}

function renderRecipeInputs(schema) {
  const target = $("#recipe-inputs");
  const inputs = schema?.inputs || [];
  if (!inputs.length) { target.className = "recipe-inputs empty"; target.textContent = "此 Recipe 不需要额外参数。"; return; }
  target.className = "recipe-inputs";
  target.replaceChildren(...inputs.map((item) => {
    const wrapper = document.createElement("div"); wrapper.className = "recipe-input";
    const label = document.createElement("label"); label.textContent = `${item.label || item.name}${item.required ? " *" : ""}`;
    let control;
    if (Array.isArray(item.choices) && item.choices.length) {
      control = document.createElement("select");
      item.choices.forEach((choice) => { const option = document.createElement("option"); option.value = choice; option.textContent = choice; control.append(option); });
    } else {
      control = document.createElement("input");
      control.type = item.type === "integer" || item.type === "number" ? "number" : "text";
    }
    control.dataset.recipeParam = item.name;
    control.placeholder = item.description || item.name;
    if (item.default !== undefined) control.value = item.default;
    wrapper.append(label, control); return wrapper;
  }));
}

function renderPlan(plan) {
  state.plan = plan;
  $("#intent").textContent = `${plan.intent?.label || "图片生成"} · ${plan.intent?.type || "image"}`;
  const recipe = plan.selected_recipe;
  const model = plan.selected_model;
  const hardware = plan.recommended?.hardware || {};
  const target = $("#recommendation");
  target.className = "recommendation";
  target.innerHTML = "";
  [["Recipe", recipe?.name || recipe?.id || "未选择"], ["模型", model?.name || "未找到本地模型"], ["硬件策略", hardware.tier || "按当前环境"], ["分辨率建议", hardware.max_resolution ? `${hardware.max_resolution}px` : "由 Recipe 决定"]].forEach(([key, value]) => {
    const row = document.createElement("div"); row.className = "kv";
    const left = document.createElement("span"); left.textContent = key;
    const right = document.createElement("span"); right.textContent = value;
    row.append(left, right); target.append(row);
  });
  $("#queue-button").disabled = !recipe;
  renderRecipes(plan.recipe_candidates || []);
  if (recipe && recipe.source !== "template") loadRecipeSchema(recipe);
  else { $("#recipe-inputs").className = "recipe-inputs empty"; $("#recipe-inputs").textContent = "选择 Recipe 后加载输入参数。"; }
}

async function planTask() {
  const task = $("#task").value.trim();
  if (!task) { setStatus("请先输入任务描述。", true); return; }
  state.routePrompt = task;
  setStatus("正在读取本地 Recipe、模型和硬件状态…");
  try {
    const plan = await api("/api/workflow/plan", { method: "POST", body: JSON.stringify({ task }) });
    if (plan.selected_recipe?.source === "template") {
      plan.selected_recipe = await materializeRecipe(plan.selected_recipe);
    }
    renderPlan(plan);
    setStatus("规划完成。所有候选均来自本机。");
  }
  catch (error) { setStatus(error.message, true); }
}

async function queueRecipe() {
  const recipe = state.plan?.selected_recipe;
  if (!recipe) return;
  const modelName = state.plan?.selected_model?.name || "";
  if (modelName.includes("qwen_image_2.1") || recipe.model?.value === "model.safetensors") {
    await queueQwenImage(state.routePrompt || $("#task")?.value.trim(), setStatus);
    return;
  }
  try {
    const values = {};
    document.querySelectorAll("[data-recipe-param]").forEach((control) => {
      if (control.value === "") return;
      const name = control.dataset.recipeParam;
      const type = state.recipeSchema?.inputs?.find((item) => item.name === name)?.type;
      values[name] = type === "integer" ? Number.parseInt(control.value, 10) : type === "number" ? Number.parseFloat(control.value) : control.value;
    });
    const body = { values };
    if (state.selectedProject) body.project_id = state.selectedProject;
    const result = await api(`/api/recipes/${encodeURIComponent(recipe.id)}/queue`, { method: "POST", body: JSON.stringify(body) });
    setStatus(`已入队：${result.prompt_id || "任务已提交"}`);
  } catch (error) { setStatus(error.message, true); }
}

function qwenPromptRequestsText(prompt) {
  return /(文字|文本|标题|标注|标签|字幕|海报|信息图|图表|表格|字体|排版|logo|signage|caption|poster|infographic|chart|table|typography)/i.test(prompt);
}

function qwenAnatomyHint(prompt) {
  const terms = {
    "阴道": "vagina",
    "子宫": "uterus",
    "宫颈": "cervix",
    "卵巢": "ovary",
    "心脏": "heart",
    "肺": "lungs",
    "胃": "stomach",
    "肝脏": "liver",
    "肾脏": "kidneys",
  };
  const term = Object.keys(terms).find((item) => prompt.includes(item));
  return term ? `医学解剖示意图，重点准确展示 ${terms[term]}（${term}），不替换为其他器官，不添加无关主题。` : "";
}

function qwenPromptPolicy(prompt, hasReference) {
  const cleanPrompt = prompt.trim();
  if (hasReference || qwenPromptRequestsText(cleanPrompt)) {
    return {
      prompt: cleanPrompt,
      negativePrompt: "blurry, low quality, distorted, watermark",
    };
  }
  return {
    prompt: `${cleanPrompt}。${qwenAnatomyHint(cleanPrompt)}准确呈现用户指定的主体，不替换成其他对象。单一主体，构图简洁，主体完整清晰，避免自造信息图。不出现任何文字、字母、标签、标题、箭头、图表、边框或水印。`,
    negativePrompt: "blurry, low quality, distorted, unwanted text, gibberish, random labels, malformed letters, captions, logos, watermark, infographic",
  };
}

function buildQwenImagePrompt(prompt, options = {}) {
  const width = options.width || 768;
  const height = options.height || 768;
  const steps = options.steps || 20;
  const reference = options.image;
  const promptPolicy = qwenPromptPolicy(prompt, Boolean(reference));
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_w4a8.safetensors", type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "4": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto", dtype: "default" } },
    "5": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], prompt: promptPolicy.prompt, negative_prompt: promptPolicy.negativePrompt, resolution: 1024 } },
    "7": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["5", 0], negative: ["5", 1], seed: options.seed >= 0 ? options.seed : Math.floor(Math.random() * 2147483647), steps, cfg: options.cfg ?? 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "Studio_Qwen", images: ["8", 0] } },
  };
  if (reference) {
    const imageName = reference.subfolder ? `${reference.subfolder}/${reference.name}` : reference.name;
    graph["10"] = { class_type: "LoadImage", inputs: { image: imageName } };
    graph["5"].inputs.images = [["10", 0]];
    graph["7"].inputs.latent_image = ["5", 2];
  } else {
    graph["6"] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } };
    graph["7"].inputs.latent_image = ["6", 0];
  }
  return graph;
}

function openProgressSocket(clientId) {
  try {
    const base = new URL(apiBase || window.location.origin, window.location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/ws";
    base.search = `?clientId=${encodeURIComponent(clientId)}`;
    return new WebSocket(base.toString());
  } catch {
    return null;
  }
}

async function queueQwenImage(prompt, updateStatus, onProgress, options = {}) {
  if (!prompt) {
    updateStatus("请先输入描述。", true);
    return;
  }
  try {
    updateStatus("正在提交 Qwen-Image 2.1 本地生成任务…");
    const clientId = `studio-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const progressSocket = openProgressSocket(clientId);
    const result = await api("/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: buildQwenImagePrompt(prompt, options), client_id: clientId }),
    });
    onProgress?.(0, "已入队，等待执行…");
    updateStatus(`已入队：${result.prompt_id || "任务已提交"}`);
    return { ...result, clientId, progressSocket };
  } catch (error) {
    updateStatus(error.message, true);
  }
}

function replaceStoryboardReferences(prompt, referenceCount = 0) {
  return prompt
    .replace(/@参考(?:图)?\s*(\d+)/gi, (_, index) => `<Picture ${index}>`)
    .replace(/@(?:分镜|图)\s*(\d+)/gi, (_, index) => `<Picture ${referenceCount + Number(index)}>`);
}

function buildMiniMaxH3StoryboardPrompt(prompt, options = {}) {
  const width = options.width || 512;
  const height = options.height || 288;
  const length = options.length || 124;
  const images = options.images || [];
  const references = options.references || [];
  const sources = [...references, ...images];
  const shotPrompts = options.shotPrompts || [];
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_pruned_w6a8.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_int8_convrot.safetensors" } },
    "1000": { class_type: "ConcatenateVideo", inputs: { codec: "auto" } },
    "1001": { class_type: "SaveVideo", inputs: { video: ["1000", 0], filename_prefix: "Studio_MiniMax_H3_Storyboard", format: "mp4", codec: "h264" } },
  };

  sources.forEach((image, index) => {
    const imageName = image.subfolder ? `${image.subfolder}/${image.name}` : image.name;
    graph[String(10 + index)] = { class_type: "LoadImage", inputs: { image: imageName } };
  });

  images.forEach((_, index) => {
    const base = 20 + index * 10;
    const shotPrompt = shotPrompts[index]?.trim();
    const fullPrompt = replaceStoryboardReferences(`${prompt}${shotPrompt ? `。本镜头动作：${shotPrompt}` : `。本镜头为第 ${index + 1} 个分镜，保持主体和风格连续。`}`, references.length);
    const referenceNode = String(base);
    const guideNode = String(base + 1);
    const guiderNode = String(base + 2);
    const samplerNode = String(base + 3);
    const schedulerNode = String(base + 4);
    const noiseNode = String(base + 5);
    const sampleNode = String(base + 6);
    const decodeNode = String(base + 7);
    const videoNode = String(base + 8);
    const refInputs = {
      clip: ["2", 0],
      vae: ["3", 0],
      prompt: fullPrompt,
      width,
      height,
      length,
      ref_image_size: "match",
    };
    sources.forEach((_, refIndex) => { refInputs[`ref_images.ref_image_${refIndex}`] = [String(10 + refIndex), 0]; });
    graph[referenceNode] = { class_type: "MiniMaxH3ReferenceToVideo", inputs: refInputs };
    graph[guideNode] = { class_type: "MiniMaxH3AddGuide", inputs: { positive: [referenceNode, 0], vae: ["3", 0], latent: [referenceNode, 1], image: [String(10 + references.length + index), 0], frame_idx: 0 } };
    graph[guiderNode] = { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: [guideNode, 0] } };
    graph[samplerNode] = { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } };
    graph[schedulerNode] = { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps: options.steps || 12, denoise: 1 } };
    graph[noiseNode] = { class_type: "RandomNoise", inputs: { noise_seed: options.seed >= 0 ? options.seed + index : Math.floor(Math.random() * 0xffffffffffffffff) } };
    graph[sampleNode] = { class_type: "SamplerCustomAdvanced", inputs: { noise: [noiseNode, 0], guider: [guiderNode, 0], sampler: [samplerNode, 0], sigmas: [schedulerNode, 0], latent_image: [referenceNode, 1] } };
    graph[decodeNode] = { class_type: "VAEDecode", inputs: { samples: [sampleNode, 0], vae: ["3", 0] } };
    graph[videoNode] = { class_type: "CreateVideo", inputs: { images: [decodeNode, 0], fps: 24, bit_depth: "auto", color_space: "sRGB", codec: "none" } };
    graph["1000"].inputs[`videos.video${index}`] = [videoNode, 0];
  });
  return graph;
}

function buildMiniMaxH3VideoPrompt(prompt, options = {}) {
  if (options.storyboard) return buildMiniMaxH3StoryboardPrompt(prompt, options);
  const width = options.width || 512;
  const height = options.height || 288;
  const length = options.length || 124;
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_pruned_w6a8.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_int8_convrot.safetensors" } },
    "4": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["2", 0], vae: ["3", 0], prompt, width, height, length } },
    "5": { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["4", 0] } },
    "6": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "7": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps: options.steps || 12, denoise: 1 } },
    "8": { class_type: "RandomNoise", inputs: { noise_seed: options.seed >= 0 ? options.seed : Math.floor(Math.random() * 0xffffffffffffffff) } },
    "9": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["8", 0], guider: ["5", 0], sampler: ["6", 0], sigmas: ["7", 0], latent_image: ["4", 1] } },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
    "11": { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: 24, bit_depth: "auto", color_space: "sRGB", codec: "none" } },
    "12": { class_type: "SaveVideo", inputs: { video: ["11", 0], filename_prefix: "Studio_MiniMax_H3", format: "mp4", codec: "h264" } },
  };
  if (options.image) {
    const imageName = options.image.subfolder ? `${options.image.subfolder}/${options.image.name}` : options.image.name;
    graph["13"] = { class_type: "LoadImage", inputs: { image: imageName } };
    graph["4"].inputs.first_frame = ["13", 0];
  }
  return graph;
}

async function queueMiniMaxH3Video(prompt, updateStatus, options = {}) {
  if (!prompt) {
    updateStatus("请先输入镜头描述。", true);
    return;
  }
  try {
    updateStatus("正在提交 MiniMax H3 本地视频任务…");
    const clientId = `studio-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const progressSocket = openProgressSocket(clientId);
    const result = await api("/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: buildMiniMaxH3VideoPrompt(prompt, options), client_id: clientId }),
    });
    updateStatus(`已入队：${result.prompt_id || "任务已提交"}`);
    return { ...result, clientId, progressSocket };
  } catch (error) {
    updateStatus(error.message, true);
  }
}

function updateGenerationProgress(target, value, label) {
  const progress = target?.matches?.(".route-generation-item")
    ? target.querySelector(".route-generation-progress")
    : target?.querySelector?.("#route-progress") || $("#route-progress");
  const bar = progress?.querySelector(".route-progress-track span") || $("#route-progress-bar");
  const valueLabel = progress?.querySelector("#route-progress-value") || $("#route-progress-value");
  const textLabel = progress?.querySelector("#route-progress-label") || $("#route-progress-label");
  if (!progress || !bar || !valueLabel || !textLabel) return;
  progress.classList.remove("is-hidden");
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  bar.style.width = `${percent}%`;
  valueLabel.textContent = `${percent}%`;
  textLabel.textContent = label;
}

function startGenerationTimer(item, promptId, kind) {
  startGenerationTiming(promptId, kind);
  if (!item) return;
  if (item._generationTimer) window.clearInterval(item._generationTimer);
  const update = () => {
    const record = generationTimings()[promptId];
    const elapsed = record?.elapsedMs ?? (record?.startedAt ? Date.now() - record.startedAt : null);
    const label = item.querySelector(".route-generation-timing");
    if (label) label.textContent = formatElapsed(elapsed);
  };
  update();
  item._generationTimer = window.setInterval(update, 1000);
}

function stopGenerationTimer(item, promptId, job) {
  if (item?._generationTimer) window.clearInterval(item._generationTimer);
  const elapsed = finishGenerationTiming(promptId, job);
  const label = item?.querySelector(".route-generation-timing");
  if (label) label.textContent = formatElapsed(elapsed);
  return elapsed;
}

function updateRouteProgress(value, label) {
  updateGenerationProgress($("#route-result"), value, label);
}

async function watchQwenResult(promptId, target, status, clientId, progressSocket, initialState = "running", onComplete = null, mediaKind = "image") {
  if (!promptId || !target) return;
  let finished = false;
  const item = target.matches?.(".route-generation-item") ? target : null;
  startGenerationTimer(item, promptId, mediaKind);
  const output = item?.querySelector(".route-generation-output");
  const updateProgress = (value, label) => item ? updateGenerationProgress(item, value, label) : updateRouteProgress(value, label);
  const updateItemState = (label, className = "") => {
    if (!item) return;
    item.classList.remove("is-running", "is-complete", "is-error");
    if (className) item.classList.add(className);
    const stateLabel = item.querySelector(".route-generation-state");
    if (stateLabel) stateLabel.textContent = label;
  };
  const handleProgress = (data) => {
    if (data.prompt_id !== promptId) return;
    updateItemState("生成中", "is-running");
    if (data.nodes) {
      const nodes = Object.values(data.nodes);
      const current = nodes.find((node) => node.state === "running" && node.max > 0) || nodes.find((node) => node.max > 0);
      if (current) updateProgress((current.value / current.max) * 100, current.state === "finished" ? "处理完成，正在保存…" : "正在生成…");
    } else if (data.max > 0) {
      updateProgress((data.value / data.max) * 100, "正在生成…");
    }
  };
  updateItemState(initialState === "pending" ? "排队中" : "生成中", initialState === "pending" ? "" : "is-running");
  const socket = progressSocket || openProgressSocket(clientId);
  socket?.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "progress_state" || message.type === "progress") handleProgress(message.data || {});
    } catch { /* Ignore non-JSON websocket messages. */ }
  });
  const check = async () => {
    if (!target.isConnected || finished) {
      if (item?._generationTimer) window.clearInterval(item._generationTimer);
      socket?.close();
      return;
    }
    try {
      const history = await api(`/history/${encodeURIComponent(promptId)}`);
      const job = history[promptId];
      if (job?.status?.status_str === "error") {
        if (status) status.textContent = "有任务生成失败，请查看任务记录。";
        status?.classList.add("error");
        updateProgress(100, "生成失败");
        updateItemState("生成失败", "is-error");
        stopGenerationTimer(item, promptId, job);
        finished = true;
        socket?.close();
        return;
      }
      const media = Object.values(job?.outputs || {}).flatMap((output) => {
        if (mediaKind !== "video") return output.images || [];
        return [
          ...(output.videos || []),
          ...(output.images || []).filter((item) => /\.(mp4|webm|mkv)$/i.test(item.filename || "")),
        ];
      })[0];
      if (!media) {
        window.setTimeout(check, 2500);
        return;
      }
      const mediaUrl = `/view?filename=${encodeURIComponent(media.filename)}&subfolder=${encodeURIComponent(media.subfolder || "")}&type=${encodeURIComponent(media.type || "output")}`;
      const preview = document.createElement(mediaKind === "video" ? "video" : "img");
      preview.className = mediaKind === "video" ? "route-result-video" : "route-result-image";
      preview.src = mediaUrl;
      if (mediaKind === "video") preview.controls = true;
      else preview.alt = "Qwen-Image 2.1 生成结果";
      const caption = document.createElement("div");
      caption.className = "route-result-caption";
      caption.textContent = "已完成 · 本地生成";
      if (output) {
        output.replaceChildren(preview, caption);
      } else {
        target.replaceChildren(preview, caption);
      }
      const elapsed = stopGenerationTimer(item, promptId, job);
      caption.textContent = `已完成 · 本地生成 · ${formatElapsed(elapsed)}`;
      if (status) {
        status.textContent = item ? "任务完成，结果已回显。" : "生成完成，结果已回显。";
        status.classList.remove("error");
      }
      updateProgress(100, "生成完成");
      updateItemState("已完成", "is-complete");
      onComplete?.(media);
      if (mediaKind === "image") loadRouteImageHistory();
      finished = true;
      socket?.close();
    } catch (error) {
      window.setTimeout(check, 3500);
    }
  };
  window.setTimeout(check, 1500);
}

function renderProjects(projects) {
  state.projects = projects;
  $("#project-count").textContent = projects.length;
  const selected = projects.find((project) => project.id === state.selectedProject);
  $("#queue-project-label").textContent = selected ? selected.name || selected.id : "未选择项目";
  const target = $("#projects");
  if (!projects.length) { target.className = "list empty"; target.textContent = "暂无项目。"; return; }
  target.className = "list";
  target.replaceChildren(...projects.map((project) => {
    const row = document.createElement("div"); row.className = "list-item";
    const text = document.createElement("div"); text.innerHTML = `<strong></strong><small></small>`;
    text.querySelector("strong").textContent = project.name || project.id;
    text.querySelector("small").textContent = `${project.item_count || 0} 个条目`;
    const button = document.createElement("button"); button.className = "button tiny"; button.textContent = state.selectedProject === project.id ? "已选" : "用于归档";
    button.onclick = () => { state.selectedProject = project.id; renderProjects(projects); };
    row.append(text, button); return row;
  }));
}

async function loadProjects() { try { renderProjects(await api("/api/projects")); } catch (error) { $("#projects").textContent = error.message; } }

async function loadTemplates() {
  const target = $("#templates");
  try {
    const templates = await api("/api/recipes/templates");
    target.className = `list${state.libraryTab === "templates" ? "" : " is-hidden"}`;
    target.replaceChildren(...templates.map((template) => {
      const row = document.createElement("div"); row.className = "list-item";
      const text = document.createElement("div"); text.innerHTML = "<strong></strong><small></small>";
      text.querySelector("strong").textContent = template.name;
      text.querySelector("small").textContent = `${template.category} · ${template.available ? "可复制" : "依赖未安装"}`;
      row.append(text);
      const button = document.createElement("button"); button.className = "button tiny"; button.textContent = template.available ? "复制" : "查看依赖"; button.disabled = !template.available;
      button.onclick = async () => { button.disabled = true; try { await api(`/api/recipes/templates/${encodeURIComponent(template.id)}/copy`, { method: "POST", body: JSON.stringify({}) }); button.textContent = "已复制"; } catch (error) { button.disabled = false; button.textContent = error.message; } };
      row.append(button); return row;
    }));
  } catch (error) { target.className = `list empty${state.libraryTab === "templates" ? "" : " is-hidden"}`; target.textContent = error.message; }
}

async function createProject() {
  const name = $("#project-name").value.trim();
  if (!name) return;
  try { await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) }); $("#project-name").value = ""; await loadProjects(); }
  catch (error) { setStatus(error.message, true); }
}

async function loadEnvironment() {
  const target = $("#environment");
  try {
    const data = await api("/api/environment/diagnose");
    const recommendation = data.hardware?.recommendation || {};
    target.className = "environment";
    target.replaceChildren();
    [["状态", data.summary || data.status], ["硬件", recommendation.tier || "未检测"], ["精度", recommendation.precision || "自动"], ["显存策略", recommendation.cpu_offload ? "CPU Offload" : "标准"]].forEach(([key, value]) => {
      const row = document.createElement("div"); row.className = "kv";
      const left = document.createElement("span"); left.textContent = key;
      const right = document.createElement("span"); right.textContent = value; row.append(left, right); target.append(row);
    });
    const badge = $("#runtime-badge"); badge.textContent = data.runtime_ready ? "环境就绪" : "需要处理"; badge.className = `status-badge ${data.runtime_ready ? "ready" : "warn"}`;
  } catch (error) {
    target.textContent = error.message;
    const badge = $("#runtime-badge");
    if (badge) { badge.textContent = "未连接"; badge.className = "status-badge warn"; }
    if (window.location.protocol === "file:") setStatus(error.message, true);
  }
}

async function loadGallery() {
  const target = $("#gallery");
  try {
    const data = await api("/api/assets?limit=12&sort=updated_at&order=desc");
    const assets = data.assets || [];
    if (!assets.length) {
      if (target.querySelector(".studio-media-card, .gallery-item")) return;
      target.className = "gallery empty";
      target.textContent = "暂无本地素材。";
      return;
    }
    target.className = "gallery-grid";
    target.replaceChildren(...assets.map((asset) => {
      const item = document.createElement("div"); item.className = "gallery-item";
      if (asset.preview_url) { const image = document.createElement("img"); image.src = asset.preview_url; image.alt = asset.name || asset.id; item.append(image); }
      const label = document.createElement("small"); label.textContent = asset.name || asset.id; item.append(label); return item;
    }));
  } catch (error) {
    if (target.querySelector(".studio-media-card, .gallery-item")) return;
    target.className = "gallery empty";
    target.textContent = "素材库未启用或暂时不可用。";
  }
}

async function loadModels() {
  const target = $("#models");
  try {
    const folders = await api("/api/experiment/models/catalog");
    target.className = "list";
    target.replaceChildren(...folders.slice(0, 8).map((folder) => {
      const row = document.createElement("div"); row.className = "list-item";
      const text = document.createElement("div"); text.innerHTML = "<strong></strong><small></small>";
      text.querySelector("strong").textContent = folder.name;
      text.querySelector("small").textContent = `${folder.file_count} 个文件 · ${Math.round((folder.total_size || 0) / 1024 / 1024)} MB`;
      row.append(text); return row;
    }));
    if (!folders.length) target.textContent = "没有发现模型目录。";
  } catch (error) { target.className = "list empty"; target.textContent = error.message; }
}

async function loadNodes() {
  const target = $("#nodes");
  if (!target) return;
  try {
    const nodes = await api("/api/custom_nodes/catalog");
    target.className = "list";
    target.replaceChildren(...nodes.slice(0, 10).map((node) => {
      const row = document.createElement("div"); row.className = "list-item";
      const text = document.createElement("div"); text.innerHTML = "<strong></strong><small></small>";
      text.querySelector("strong").textContent = node.name || node.module || "Custom Node";
      text.querySelector("small").textContent = node.status || "unknown";
      row.append(text);
      if (node.status === "disabled") {
        const button = document.createElement("button"); button.className = "button tiny"; button.textContent = "启用";
        button.onclick = async () => { button.disabled = true; try { await api(`/api/custom_nodes/${encodeURIComponent(node.name)}/enable`, { method: "POST", body: "{}" }); button.textContent = "已启用"; } catch (error) { button.disabled = false; button.textContent = error.message; } };
        row.append(button);
      }
      return row;
    }));
    if (!nodes.length) target.textContent = "没有发现 Custom Node。";
  } catch (error) { target.className = "list empty"; target.textContent = error.message; }
}

async function loadJobs() {
  const target = $("#jobs");
  try {
    const data = await api("/api/jobs?limit=8&sort_by=created_at&sort_order=desc");
    const jobs = data.jobs || [];
    $("#nav-job-count").textContent = jobs.length;
    if (!jobs.length) { target.className = "list empty"; target.textContent = "暂无任务。"; return; }
    target.className = "list";
    target.replaceChildren(...jobs.map((job) => {
      const row = document.createElement("div"); row.className = "list-item";
      const text = document.createElement("div"); text.innerHTML = "<strong></strong><small></small>";
      text.querySelector("strong").textContent = job.status || "unknown";
      text.querySelector("small").textContent = `${job.id} · ${jobElapsedLabel(job)}`;
      row.append(text);
      if (job.status === "failed") {
        const button = document.createElement("button"); button.className = "button tiny"; button.textContent = "显存恢复重试";
        button.onclick = async () => { button.disabled = true; try { await api(`/api/history/${encodeURIComponent(job.id)}/retry`, { method: "POST", body: JSON.stringify({ recovery: { changes: { resolution_scale: 0.75, batch_size: 1, vae_tiling: true, cpu_offload: true } } }) }); button.textContent = "已重试"; } catch (error) { button.disabled = false; button.textContent = error.message; } };
        row.append(button);
      }
      return row;
    }));
  } catch (error) { target.className = "list empty"; target.textContent = error.message; }
}

function initializeCanvas() {
  const canvas = $("#canvas");
  const context = canvas.getContext("2d");
  context.fillStyle = "#0b0f15"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.lineWidth = 4; context.lineCap = "round"; context.strokeStyle = "#8ed0ff";
  let drawing = false;
  const point = (event) => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; };
  canvas.addEventListener("pointerdown", (event) => { drawing = true; const p = point(event); context.beginPath(); context.moveTo(p.x, p.y); canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", (event) => { if (!drawing) return; const p = point(event); context.lineTo(p.x, p.y); context.stroke(); });
  canvas.addEventListener("pointerup", () => { drawing = false; });
  $("#canvas-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    const image = new Image(); image.onload = () => { context.fillStyle = "#0b0f15"; context.fillRect(0, 0, canvas.width, canvas.height); const scale = Math.min(canvas.width / image.width, canvas.height / image.height); const width = image.width * scale; const height = image.height * scale; context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height); URL.revokeObjectURL(image.src); }; image.src = URL.createObjectURL(file);
  });
  $("#clear-canvas").onclick = () => { context.fillStyle = "#0b0f15"; context.fillRect(0, 0, canvas.width, canvas.height); };
  $("#export-canvas").onclick = () => { const link = document.createElement("a"); link.download = "comfy-canvas.png"; link.href = canvas.toDataURL("image/png"); link.click(); };
}

function renderRepairActions(diagnosis) {
  const target = $("#repair-actions");
  target.replaceChildren();
  const actions = (diagnosis?.repair_plan || []).filter((item) => item.status === "available" && item.requires_confirmation);
  if (!actions.length) return;
  actions.forEach((item) => {
    const row = document.createElement("div"); row.className = "repair-action";
    const text = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = item.message || item.action;
    const detail = document.createElement("small"); detail.textContent = `${item.action}${item.node_name ? ` · ${item.node_name}` : ""}`;
    text.append(title, detail);
    const controls = document.createElement("div");
    let candidateSelect = null;
    if (item.action === "select_local_model" && Array.isArray(item.candidates)) {
      candidateSelect = document.createElement("select");
      item.candidates.forEach((candidate, index) => { const option = document.createElement("option"); option.value = index; option.textContent = `${candidate.name || "候选"} (${candidate.folder || "本地"})`; candidateSelect.append(option); });
      controls.append(candidateSelect);
    }
    const button = document.createElement("button"); button.className = "button tiny"; button.textContent = "确认应用";
    button.onclick = () => applyRepair(item, candidateSelect ? item.candidates[Number(candidateSelect.value)] : null, button);
    controls.append(button); row.append(text, controls); target.append(row);
  });
}

async function applyRepair(item, selectedModel, button) {
  if (!state.workflowPayload) return;
  button.disabled = true;
  const action = { action: item.action, node_id: item.node_id, node_name: item.node_name, input_name: item.input_name, model_name: item.model_name, model_folder: item.model_folder };
  if (selectedModel) action.selected_model = selectedModel;
  try {
    const result = await api("/api/workflow/repair/apply", { method: "POST", body: JSON.stringify({ ...state.workflowPayload, actions: [action] }) });
    state.workflowPayload = { prompt: result.prompt };
    state.workflowDiagnosis = result.diagnosis;
    $("#diagnosis").textContent = JSON.stringify(result, null, 2);
    renderRepairActions(result.diagnosis);
  } catch (error) {
    $("#diagnosis").textContent = error.message;
    button.disabled = false;
  }
}

async function diagnoseWorkflow() {
  const text = $("#workflow").value.trim();
  if (!text) return;
  try {
    state.workflowPayload = JSON.parse(text);
    const result = await api("/api/workflow/diagnose", { method: "POST", body: text, headers: { "Content-Type": "application/json" } });
    state.workflowDiagnosis = result;
    $("#diagnosis").textContent = JSON.stringify(result, null, 2);
    renderRepairActions(result);
  } catch (error) { $("#diagnosis").textContent = error.message; }
}

function switchLibraryTab(tab) {
  state.libraryTab = tab;
  document.querySelectorAll("[data-library-tab]").forEach((button) => button.classList.toggle("active", button.dataset.libraryTab === tab));
  $("#recipes").classList.toggle("is-hidden", tab !== "recipes");
  $("#templates").classList.toggle("is-hidden", tab !== "templates");
}

const routeDefinitions = {
  home: { label: "首页", kicker: "WORKSPACE", title: "本地创作工作台", description: "从灵感、模型到工作流，在一个清晰的空间完成创作。" },
  "text-to-image": { label: "文生图", kicker: "CREATE · TEXT TO IMAGE", title: "用文字生成图片", description: "输入一句话，自动匹配本地 Qwen-Image 2.1 与适合当前显存的工作流。", mode: "image" },
  "image-to-image": { label: "图生图", kicker: "CREATE · IMAGE TO IMAGE", title: "基于参考图继续创作", description: "上传一张参考图，再用自然语言控制构图、风格和细节。", mode: "image" },
  "image-editor": { label: "图片编辑", kicker: "TOOLS · IMAGE EDITOR", title: "用文字编辑图片", description: "上传图片，用自然语言修改主体、背景、风格和细节。", mode: "image" },
  "prompt-studio": { label: "Prompt Studio", kicker: "CREATE · PROMPT STUDIO", title: "把简单想法变成专业提示词", description: "结构化理解、智能扩写，并适配当前本地图片模型。", mode: "prompt" },
  "character-studio": { label: "角色工作室", kicker: "CREATE · CHARACTER STUDIO", title: "创建可复用的角色资产", description: "从人物设定到主视觉，再到独立角色视图，保持创作一致性。", mode: "character" },
  "ai-canvas": { label: "AI 画布", kicker: "CREATE · AI CANVAS", title: "把灵感、分镜和生成链路放到一张画布", description: "借鉴 AI Canvas 的节点式创作方式，把提示词、参考图、分镜和结果组织成可复用的本地项目。", mode: "canvas" },
  "text-to-video": { label: "文生视频", kicker: "CREATE · TEXT TO VIDEO", title: "把想法变成分镜", description: "先拆解镜头与节奏，再交给本地工作流生成视频方案。", mode: "video" },
  "image-to-video": { label: "图生视频", kicker: "CREATE · IMAGE TO VIDEO", title: "让静态画面动起来", description: "上传分镜图和全局参考图，按镜头顺序生成并合成完整视频。", mode: "video" },
  "video-process": { label: "视频处理", kicker: "TOOLS · VIDEO PROCESS", title: "快速处理本地视频", description: "放大、稳定、抽帧和格式处理都集中在一个操作面板。" },
  workflows: { label: "工作流", kicker: "LOCAL LIBRARY · WORKFLOWS", title: "常用工作流", description: "管理可复用的 Recipe，并在需要精细控制时打开专业节点编辑器。" },
  models: { label: "模型管理", kicker: "LOCAL RUNTIME · MODELS", title: "模型与运行环境", description: "确认本机模型、显存策略和运行状态，减少生成前的排查。" },
  assets: { label: "素材库", kicker: "LOCAL LIBRARY · ASSETS", title: "你的本地素材", description: "统一查看生成结果和导入素材，随时回到下一次创作。" },
  history: { label: "历史记录", kicker: "QUEUE · HISTORY", title: "任务与生成记录", description: "查看最近任务状态，失败任务可以从这里恢复或重试。" },
  settings: { label: "偏好设置", kicker: "LOCAL SETTINGS · API", title: "模型 API 配置", description: "按模型类型整理本地或兼容 OpenAI 协议的 API 配置。" },
};

function routeFromHash() {
  const name = window.location.hash.replace(/^#page\/?/, "") || "home";
  return routeDefinitions[name] ? name : "home";
}

function routeHeader(def) {
  const icon = def.mode === "video" ? "movie-open-outline" : def.mode === "canvas" ? "graph-outline" : "creation";
  return `<div class="route-header"><div><p class="studio-kicker">${def.kicker}</p><h1>${def.title}</h1><p>${def.description}</p></div><span class="route-header-icon mdi mdi-${icon}"></span></div>`;
}

function imageRouteGenerationPage(route, def) {
  const image = route === "image-to-image" || route === "image-editor";
  const promptLabel = route === "image-editor" ? "编辑指令" : image ? "创作指令" : "提示词";
  const promptPlaceholder = route === "image-editor"
    ? "例如：保留人物和光线，把背景替换成海边，去掉右侧路人"
    : image
    ? "例如：保留人物姿态，将背景改成暖色工作室，增加柔和轮廓光"
    : "例如：一只可爱的金毛在雪山下奔跑，高清写实，阳光明媚";
  const upload = image
    ? `<div class="image-route-upload"><label for="route-reference">参考图</label><label class="route-dropzone" for="route-reference"><span class="mdi mdi-cloud-upload-outline"></span><strong>拖入图片或点击上传</strong><small>支持 PNG、JPG、WEBP · 本地处理</small><input id="route-reference" type="file" accept="image/*"></label><div id="route-upload-progress" class="route-upload-progress is-hidden"><div class="route-progress-top"><span id="route-upload-label">准备上传</span><strong id="route-upload-percent">0%</strong></div><div class="route-progress-track"><span id="route-upload-bar"></span></div></div><div id="route-image-preview" class="route-image-preview is-hidden"></div><p id="route-file-name" class="route-file-name">尚未选择参考图</p></div>`
    : "";
  const characterPicker = `<div class="image-route-character-picker"><div><label for="route-character">角色</label><small>选择已确认角色，会自动合并人物身份描述。</small></div><select id="route-character"><option value="">不使用角色</option></select></div>`;
  return `<section class="route-view image-route-view"><div class="image-route-banner"><div class="image-route-banner-copy"><p class="studio-kicker">${def.kicker}</p><h1>${def.title}</h1><p>${image ? def.description : "输入一句话，基于 Qwen-Image 2.1 在本地快速生成高质量图片。"}</p></div></div><div class="image-route-category-row" role="tablist" aria-label="创作分类"><button class="image-route-category active" type="button">推荐</button><button class="image-route-category" type="button">写实摄影</button><button class="image-route-category" type="button">二次元</button><button class="image-route-category" type="button">插画</button><button class="image-route-category" type="button">产品设计</button><button class="image-route-category" type="button">建筑景观</button><button class="image-route-category" type="button">游戏原画</button><button class="image-route-category" type="button">更多 <span class="mdi mdi-chevron-down"></span></button></div><div class="image-route-layout"><main class="image-route-main"><section class="image-route-prompt-card"><div class="image-route-card-heading"><div class="image-route-title"><span class="image-route-title-icon mdi mdi-image-plus-outline"></span><div><h2>${route === "image-editor" ? "上传图片并编辑" : image ? "参考图与提示词" : "描述你想生成的画面"}</h2><p>输入越具体，生成结果越接近预期。</p></div></div><span class="route-step">01</span></div>${upload}<div class="image-route-field"><label for="route-prompt">${promptLabel}</label><textarea id="route-prompt" rows="7" maxlength="1000" placeholder="${promptPlaceholder}"></textarea><div class="image-route-form-footer"><span><span class="mdi mdi-shield-check-outline"></span>仅在本机处理</span><span id="route-prompt-count">0/1000</span></div></div>${characterPicker}<div class="image-route-actions"><div class="image-route-quick-actions"><button class="image-route-tool" type="button" data-route-prompt="电影感，细节丰富，柔和光照"><span class="mdi mdi-auto-fix"></span>提示词优化</button><button class="image-route-tool" type="button" data-route-prompt="画面描述翻译成英文"><span class="mdi mdi-translate"></span>翻译成英文</button><button class="image-route-tool" type="button" data-route-prompt="随机灵感：自然光、高清细节"><span class="mdi mdi-dice-5-outline"></span>随机提示词</button></div><button id="route-plan-button" class="image-route-generate-button" type="button"><span class="mdi mdi-sparkles"></span>${route === "image-editor" ? "开始编辑" : "生成图片"} <span class="image-route-shortcut">⌘↵</span></button></div><span id="route-status" class="image-route-status">准备就绪</span></section><section class="image-route-history-section"><div class="image-route-section-heading"><div><p class="studio-kicker">LOCAL HISTORY</p><h2>生图历史</h2><p>你在本机生成的图片会自动出现在这里。</p></div><button id="route-history-refresh" class="image-route-refresh" type="button"><span class="mdi mdi-refresh"></span>刷新</button></div><div id="route-history-gallery" class="image-route-history-grid"><div class="image-route-history-empty"><span class="mdi mdi-image-multiple-outline"></span><span>正在读取生图历史…</span></div></div></section></main><aside class="image-route-sidebar"><section class="image-route-settings-card"><div class="image-route-section-heading compact"><div><h2>生成设置</h2><p>按当前电脑配置优化</p></div><button class="image-route-reset" type="button"><span class="mdi mdi-restore"></span>重置</button></div><div class="image-route-model-label">模型</div><div class="image-route-model"><span class="route-model-icon mdi mdi-image-filter-hdr"></span><div><strong>Qwen-Image 2.1</strong><small>本地模型 · 高质量生成</small></div><span class="mdi mdi-chevron-down"></span></div><div class="image-route-setting"><div class="image-route-setting-label"><span>图片尺寸</span><strong id="route-size-label">768 × 768</strong></div><div class="image-route-aspect-grid"><button class="image-route-aspect active" type="button" data-aspect="1:1"><span class="aspect-glyph square"></span><span>1:1</span></button><button class="image-route-aspect" type="button" data-aspect="16:9"><span class="aspect-glyph wide"></span><span>16:9</span></button><button class="image-route-aspect" type="button" data-aspect="9:16"><span class="aspect-glyph tall"></span><span>9:16</span></button><button class="image-route-aspect" type="button" data-aspect="4:3"><span class="aspect-glyph landscape"></span><span>4:3</span></button><button class="image-route-aspect" type="button" data-aspect="3:4"><span class="aspect-glyph portrait"></span><span>3:4</span></button></div></div><div class="image-route-setting"><div class="image-route-setting-label"><span>采样步数</span><output id="route-steps-value">20</output></div><input id="route-steps" type="range" min="1" max="30" value="20"></div><div class="image-route-setting"><div class="image-route-setting-label"><span>提示词引导 (CFG)</span><output id="route-cfg-value">1.0</output></div><input id="route-cfg" type="range" min="0.5" max="2" step="0.5" value="1"></div><details class="image-route-advanced"><summary><span class="mdi mdi-tune-variant"></span>高级设置</summary><p>当前使用低显存策略与 CPU Offload，适合 8 GB 显存设备。</p></details></section><section class="image-route-result-card"><div class="image-route-section-heading compact"><div><h2>生成结果</h2><p>直接生成，多个任务会按顺序执行</p></div><span id="route-queue-count" class="route-queue-count">0 个任务</span></div><div id="route-result" class="route-result"><span class="route-result-empty">等待你的第一条指令</span></div></section></aside></div></section>`;
}

function aiCanvasPageMarkup() {
  return `<section class="route-view ai-canvas-view ai-canvas-target-view">
    <header class="ai-canvas-projectbar">
      <div class="ai-canvas-project-pill">
        <span class="ai-canvas-logo mdi mdi-creation"></span>
        <strong>AI Canvas</strong>
        <span class="ai-canvas-divider"></span>
        <input id="canvas-title" value="项目 4" maxlength="80" aria-label="项目名称">
        <span class="ai-canvas-divider"></span>
        <button id="canvas-new" type="button" title="新建项目" aria-label="新建项目"><span class="mdi mdi-plus"></span></button>
      </div>
      <div class="ai-canvas-project-actions">
        <button id="canvas-save" type="button" title="保存画布" aria-label="保存画布"><span class="mdi mdi-content-save-outline"></span></button>
        <button id="canvas-fit" type="button" title="整理节点" aria-label="整理节点"><span class="mdi mdi-fit-to-screen-outline"></span></button>
        <button id="canvas-reset" type="button" title="恢复示例" aria-label="恢复示例"><span class="mdi mdi-refresh"></span></button>
      </div>
    </header>
    <aside class="ai-canvas-float-tools" aria-label="画布工具">
      <button type="button" data-canvas-add="prompt" title="添加提示词节点"><span class="mdi mdi-plus"></span></button>
      <button id="canvas-grid-toggle" type="button" title="显示网格"><span class="mdi mdi-dots-grid"></span></button>
      <button type="button" data-canvas-add="reference" title="添加参考图节点"><span class="mdi mdi-folder-outline"></span></button>
      <button type="button" data-canvas-add="reference" title="添加人物参考节点"><span class="mdi mdi-account-box-outline"></span></button>
      <button type="button" data-canvas-add="storyboard" title="添加分镜节点"><span class="mdi mdi-briefcase-outline"></span></button>
      <button id="canvas-generate-image" type="button" title="生成图片"><span class="mdi mdi-pause-circle-outline"></span></button>
      <button id="canvas-open-inspector" type="button" title="节点属性"><span class="mdi mdi-cog-outline"></span></button>
    </aside>
    <main id="ai-canvas-workspace" class="ai-canvas-workspace ai-canvas-infinite-workspace" aria-label="AI Canvas 无限画布">
      <div class="ai-canvas-planet" aria-hidden="true"></div>
      <svg id="ai-canvas-connections" class="ai-canvas-connections" aria-hidden="true"></svg>
      <div id="ai-canvas-nodes" class="ai-canvas-nodes"></div>
      <div id="canvas-empty" class="ai-canvas-empty is-hidden"><span class="mdi mdi-graph-outline"></span><strong>从左侧添加第一个节点</strong><small>你可以从提示词、分镜或参考图开始。</small></div>
      <button class="ai-canvas-mascot" type="button" title="画布助手" aria-label="画布助手"><span class="mdi mdi-creation"></span></button>
    </main>
    <aside class="ai-canvas-inspector" aria-label="节点属性">
      <div class="ai-canvas-inspector-top"><strong>节点属性</strong><button id="canvas-inspector-close" type="button" aria-label="关闭属性"><span class="mdi mdi-close"></span></button></div>
      <div id="canvas-inspector-body" class="ai-canvas-inspector-body"><div class="ai-canvas-inspector-empty"><span class="mdi mdi-cursor-default-click-outline"></span><span>选择一个节点查看属性</span></div></div>
    </aside>
    <div class="ai-canvas-drawing-toolbar" aria-label="绘图工具">
      <button class="active" data-canvas-tool="select" type="button" title="选择"><span class="mdi mdi-cursor-default-outline"></span></button>
      <button data-canvas-tool="rect" type="button" title="矩形"><span class="mdi mdi-rectangle-outline"></span></button>
      <button data-canvas-tool="diamond" type="button" title="菱形"><span class="mdi mdi-rhombus-outline"></span></button>
      <button data-canvas-tool="circle" type="button" title="圆形"><span class="mdi mdi-circle-outline"></span></button>
      <button data-canvas-tool="arrow" type="button" title="箭头"><span class="mdi mdi-arrow-right"></span></button>
      <button data-canvas-tool="line" type="button" title="直线"><span class="mdi mdi-minus"></span></button>
      <button data-canvas-tool="pen" type="button" title="画笔"><span class="mdi mdi-pen"></span></button>
      <button data-canvas-tool="text" type="button" title="文本"><span class="mdi mdi-format-text"></span></button>
      <button data-canvas-tool="image" type="button" title="图片"><span class="mdi mdi-image-outline"></span></button>
      <button data-canvas-tool="eraser" type="button" title="橡皮擦"><span class="mdi mdi-eraser"></span></button>
    </div>
    <div class="ai-canvas-bottom-actions">
      <button id="canvas-generate-video" type="button"><span class="mdi mdi-play"></span>生成分镜视频</button>
      <span id="canvas-run-status" class="route-status">准备就绪</span>
      <div id="canvas-run-queue" class="ai-canvas-run-queue"><div class="ai-canvas-queue-empty">暂无任务</div></div>
    </div>
    <div class="ai-canvas-view-controls">
      <button id="canvas-zoom-out" type="button" aria-label="缩小"><span class="mdi mdi-minus"></span></button>
      <button id="canvas-zoom-in" type="button" aria-label="放大"><span class="mdi mdi-plus"></span></button>
      <button id="canvas-reset-view" type="button" aria-label="适应画布"><span class="mdi mdi-fit-to-screen-outline"></span></button>
      <strong id="canvas-zoom-value">84%</strong>
    </div>
    <div class="ai-canvas-minimap" aria-label="画布缩略图"><div class="ai-canvas-minimap-block block-one"></div><div class="ai-canvas-minimap-block block-two"></div><div class="ai-canvas-minimap-block block-three"></div><div class="ai-canvas-minimap-block block-four"></div><div class="ai-canvas-minimap-viewport"></div></div>
    <input id="canvas-title-hidden" type="hidden">
  </section>`;
}

function routeImageDimensions() {
  const sizes = { "1:1": [768, 768], "16:9": [768, 432], "9:16": [432, 768], "4:3": [768, 576], "3:4": [576, 768], custom: [768, 768] };
  const aspect = document.querySelector(".image-route-aspect.active")?.dataset.aspect || "1:1";
  const [width, height] = sizes[aspect] || sizes["1:1"];
  return { width, height, steps: Number($("#route-steps")?.value) || 20, cfg: Number($("#route-cfg")?.value) || 1 };
}

function routeGenerationPage(route, def) {
  const video = def.mode === "video";
  const image = route === "image-to-image";
  const videoReference = video && route === "image-to-video";
  if (!video) return imageRouteGenerationPage(route, def);
  const promptLabel = image ? "创作指令" : video ? "镜头描述" : "提示词";
  const promptPlaceholder = image
    ? "例如：保留人物姿态，将背景改成暖色工作室，增加柔和轮廓光"
    : video
      ? "例如：镜头缓慢推进，女孩抬头看向窗外，发丝随风轻动，电影感，高稳定"
      : "例如：一只趴在窗边的橘猫，午后阳光，真实摄影，高清细节";
  const upload = image || videoReference
    ? videoReference
      ? `<div class="route-field storyboard-upload-field"><div class="storyboard-field-heading"><label for="route-reference">分镜图</label><span>每张图生成一个镜头并自动合并</span></div><label class="route-dropzone storyboard-dropzone" for="route-reference"><span class="mdi mdi-cloud-upload-outline"></span><strong>上传多张分镜图</strong><small>选择顺序就是镜头顺序 · 支持 PNG、JPG、WEBP · 最多 9 张</small><input id="route-reference" type="file" accept="image/*" multiple></label><div id="route-upload-progress" class="route-upload-progress is-hidden"><div class="route-progress-top"><span id="route-upload-label">准备上传</span><strong id="route-upload-percent">0%</strong></div><div class="route-progress-track"><span id="route-upload-bar"></span></div></div><div id="route-storyboard-list" class="storyboard-list"><div class="storyboard-empty"><span class="mdi mdi-view-sequential-outline"></span><span>上传分镜图后，会在这里调整顺序和镜头描述。</span></div></div><p class="storyboard-help"><span class="mdi mdi-at"></span>分镜可用 <strong>@分镜1</strong> 或兼容写法 <strong>@图1</strong> 引用。</p></div><div class="route-field storyboard-upload-field reference-upload-field"><div class="storyboard-field-heading"><label for="route-global-reference">全局参考图</label><span>人物、服装、风格和场景参考</span></div><label class="route-dropzone storyboard-dropzone" for="route-global-reference"><span class="mdi mdi-image-multiple-outline"></span><strong>上传额外参考图</strong><small>这些图片不会单独生成镜头，会作为整支视频的参考</small><input id="route-global-reference" type="file" accept="image/*" multiple></label><div id="route-reference-upload-progress" class="route-upload-progress is-hidden"><div class="route-progress-top"><span id="route-reference-upload-label">准备上传</span><strong id="route-reference-upload-percent">0%</strong></div><div class="route-progress-track"><span id="route-reference-upload-bar"></span></div></div><div id="route-reference-list" class="storyboard-list"><div class="storyboard-empty"><span class="mdi mdi-image-outline"></span><span>可选：上传人物或风格参考图。</span></div></div><p class="storyboard-help"><span class="mdi mdi-at"></span>点击标签插入 <strong>@参考1</strong>、<strong>@参考2</strong>；分镜与参考图合计最多 9 张。</p></div>`
      : `<div class="route-field"><label for="route-reference">参考图</label><label class="route-dropzone" for="route-reference"><span class="mdi mdi-cloud-upload-outline"></span><strong>拖入图片或点击上传</strong><small>支持 PNG、JPG、WEBP，本地处理</small><input id="route-reference" type="file" accept="image/*"></label><div id="route-upload-progress" class="route-upload-progress is-hidden"><div class="route-progress-top"><span id="route-upload-label">准备上传</span><strong id="route-upload-percent">0%</strong></div><div class="route-progress-track"><span id="route-upload-bar"></span></div></div><div id="route-image-preview" class="route-image-preview is-hidden"></div><p id="route-file-name" class="route-file-name">尚未选择参考图</p></div>`
    : "";
  const options = video
    ? `<div class="route-option-grid"><label class="route-option"><span>${videoReference ? "每镜头时长" : "时长"}</span><select id="route-video-duration"><option value="3">3 秒</option><option value="5" selected>5 秒</option><option value="8">8 秒</option></select></label><label class="route-option"><span>输出质量</span><select id="route-video-quality"><option value="preview" selected>预览 · 512 × 288</option><option value="balanced">平衡 · 640 × 384</option><option value="high">高质量 · 768 × 432</option></select></label></div>`
    : `<div class="route-chip-row"><button class="route-chip active" type="button">写实</button><button class="route-chip" type="button">动漫</button><button class="route-chip" type="button">产品</button><button class="route-chip" type="button">电影感</button></div>`;
  return `<section class="route-view">${routeHeader(def)}<div class="route-layout"><div class="route-card route-form-card"><div class="route-card-heading"><div><h2>${image ? "参考图与提示词" : video ? "镜头与叙事" : "描述你想生成的画面"}</h2><p>${videoReference ? "每张分镜图对应一个镜头，额外参考图可用 @参考N 引用，生成后自动合并为一个视频。" : video ? "MiniMax H3 会直接生成视频，任务按顺序排队执行。" : "输入越具体，方案越容易一次成功。"}</p></div><span class="route-step">01</span></div>${upload}<div class="route-field"><label for="route-prompt">${promptLabel}</label><textarea id="route-prompt" rows="8" placeholder="${promptPlaceholder}"></textarea><div class="route-form-footer"><span><span class="mdi mdi-shield-check-outline"></span>仅在本机处理</span><span id="route-prompt-count">0/1000</span></div></div>${!image && !video ? "" : options}<div class="route-actions"><button id="route-plan-button" class="route-primary-button" type="button"><span class="mdi mdi-auto-fix"></span>${video ? "生成视频" : "智能规划并生成"}</button><span id="route-status" class="route-status">准备就绪</span></div></div><aside class="route-side"><div class="route-card route-model-card"><div class="route-card-heading"><div><h2>本地生成引擎</h2><p>已按你的电脑配置优化</p></div><span class="route-ready"><span></span>就绪</span></div><div class="route-model-row"><span class="route-model-icon mdi ${video ? "mdi-movie-open-outline" : "mdi-image-filter-hdr"}"></span><div><strong>${video ? "MiniMax H3" : "Qwen-Image 2.1"}</strong><small>${video ? "W6A8 · 低显存视频生成" : "本地模型 · 低显存策略"}</small></div><span class="mdi mdi-chevron-down"></span></div><div class="route-stats"><div><span>默认尺寸</span><strong>${video ? "512 × 288" : "768 × 768"}</strong></div><div><span>显存策略</span><strong>CPU Offload</strong></div></div></div><div class="route-card route-result-card"><div class="route-card-heading"><div><h2>生成结果</h2><p>${video ? "视频完成后可直接播放或下载" : "规划完成后会显示在这里"}</p></div>${video ? '<span id="route-queue-count" class="route-queue-count">0 个任务</span>' : '<span class="mdi mdi-sparkles"></span>'}</div><div id="route-result" class="route-result"><span class="route-result-empty">等待你的第一条指令</span></div></div></aside></div></section>`;
}

function promptStudioPageMarkup() {
  return `<section class="route-view prompt-studio-view">${routeHeader(routeDefinitions["prompt-studio"])}<div class="prompt-studio-category-row" role="tablist" aria-label="提示词分类"><button class="prompt-studio-category active" type="button" data-prompt-category="free">推荐</button><button class="prompt-studio-category" type="button" data-prompt-category="portrait">人像</button><button class="prompt-studio-category" type="button" data-prompt-category="product">产品</button><button class="prompt-studio-category" type="button" data-prompt-category="landscape">风景</button><button class="prompt-studio-category" type="button" data-prompt-category="anime">动漫</button><button class="prompt-studio-category" type="button" data-prompt-category="poster">海报</button><button class="prompt-studio-category" type="button" data-prompt-category="architecture">建筑</button></div><div class="prompt-studio-layout"><main><section class="route-card prompt-studio-editor"><div class="route-card-heading"><div><h2>描述你想生成的画面</h2><p>先说清楚想法，AI 会补充构图、镜头、光线和氛围。</p></div><span class="route-step">01</span></div><textarea id="prompt-studio-input" rows="8" maxlength="1000" placeholder="例如：雪山里面一座亮着灯的小木屋"></textarea><div class="prompt-studio-editor-footer"><span><span class="mdi mdi-shield-check-outline"></span>仅在本机处理</span><span id="prompt-studio-count">0/1000</span></div><div class="prompt-studio-actions"><button id="prompt-studio-template" class="route-secondary-button" type="button"><span class="mdi mdi-view-grid-outline"></span>模板</button><button id="prompt-studio-inspiration" class="route-secondary-button" type="button"><span class="mdi mdi-lightbulb-outline"></span>随机灵感</button><button id="prompt-studio-translate" class="route-secondary-button" type="button"><span class="mdi mdi-translate"></span>翻译</button><button id="prompt-studio-optimize" class="route-primary-button" type="button"><span class="mdi mdi-auto-fix"></span>智能优化</button></div><span id="prompt-studio-status" class="route-status">准备就绪</span></section><section class="route-card prompt-studio-result-card"><div class="route-card-heading"><div><h2>AI 优化结果</h2><p>不会覆盖你的原始描述，可以随时切换查看。</p></div><span class="route-step">02</span></div><div class="prompt-studio-tabs" role="tablist"><button class="prompt-studio-tab" type="button" data-prompt-view="original">原始描述</button><button class="prompt-studio-tab active" type="button" data-prompt-view="enhanced">优化结果</button></div><div id="prompt-studio-result" class="prompt-studio-result"><div class="prompt-studio-result-empty"><span class="mdi mdi-text-box-search-outline"></span><span>输入一句话，开始优化提示词</span></div></div><div class="prompt-studio-result-actions"><button id="prompt-studio-use" class="route-secondary-button" type="button" disabled><span class="mdi mdi-arrow-right-circle-outline"></span>应用到文生图</button><button id="prompt-studio-regenerate" class="route-secondary-button" type="button" disabled><span class="mdi mdi-refresh"></span>重新优化</button><button id="prompt-studio-copy" class="route-secondary-button" type="button" disabled><span class="mdi mdi-content-copy"></span>复制</button><button id="prompt-studio-generate" class="route-primary-button" type="button" disabled><span class="mdi mdi-image-plus-outline"></span>生成图片</button></div><div id="prompt-studio-generation" class="prompt-studio-generation"></div></section></main><aside class="prompt-studio-sidebar"><section class="route-card prompt-studio-structure-card"><div class="route-card-heading"><div><h2>结构化理解</h2><p>优化器会优先保留你的原始信息。</p></div><span class="mdi mdi-tune-variant"></span></div><div id="prompt-studio-structure" class="prompt-studio-structure"><span class="route-list-empty">优化后显示主体、场景和视觉方向。</span></div></section><section class="route-card prompt-studio-history-card"><div class="route-card-heading"><div><h2>最近使用</h2><p>保留在本机，方便复用。</p></div><button id="prompt-studio-history-refresh" class="route-icon-button" type="button" title="刷新"><span class="mdi mdi-refresh"></span></button></div><div id="prompt-studio-history" class="route-list"><div class="route-list-empty">正在读取记录…</div></div></section></aside></div></section>`;
}

function characterStudioPageMarkup() {
  const slots = [["hero", "主视觉", "确认角色前的 Master Reference"], ["front", "Front", "正面角色视图"], ["left", "Left", "左侧角色视图"], ["right", "Right", "右侧角色视图"], ["back", "Back", "背面角色视图"]];
  const viewCards = slots.map(([slot, title, description]) => `<article class="character-view-slot" data-slot="${slot}"><div class="character-slot-preview"><span class="mdi mdi-image-outline"></span><small>尚未生成</small></div><div class="character-slot-meta"><div><strong>${title}</strong><small>${description}</small></div><button class="character-slot-generate" type="button" data-character-slot="${slot}"><span class="mdi mdi-sparkles"></span>生成</button></div></article>`).join("");
  return `<section class="route-view character-studio-view">${routeHeader(routeDefinitions["character-studio"])}<div class="character-studio-layout"><aside class="route-card character-list-card"><div class="route-card-heading"><div><h2>我的角色</h2><p>创建后可以持续复用。</p></div><button id="character-new" class="route-icon-button" type="button" title="创建角色"><span class="mdi mdi-plus"></span></button></div><div id="character-list" class="character-list"><div class="route-list-empty">正在读取角色…</div></div></aside><main class="character-studio-main"><section class="route-card character-editor-card"><div class="route-card-heading"><div><h2 id="character-editor-title">创建角色</h2><p>先描述人物，再让本地引擎完善视觉身份。</p></div><span class="route-step">01</span></div><div id="character-empty" class="character-empty"><span class="mdi mdi-account-plus-outline"></span><strong>创建一个可复用的角色</strong><small>保存后可以生成主视觉、三视图并用于文生图。</small><button id="character-empty-new" class="route-primary-button" type="button"><span class="mdi mdi-plus"></span>创建角色</button></div><div id="character-form" class="character-form is-hidden"><div class="character-form-grid"><label>人物名称<input id="character-name" maxlength="80" placeholder="例如：林夏"></label><label>性别<input id="character-gender" maxlength="30" placeholder="女性"></label><label>年龄<input id="character-age" maxlength="30" placeholder="25 岁"></label><label>身高<input id="character-height" maxlength="30" placeholder="168 cm"></label><label>体型<input id="character-body" maxlength="50" placeholder="纤细"></label><label>发色 / 发型<input id="character-hair" maxlength="100" placeholder="黑色长直发"></label><label>脸部特征<input id="character-face" maxlength="120" placeholder="鹅蛋脸、清澈眼睛"></label><label>性格关键词<input id="character-personality" maxlength="120" placeholder="安静、温柔、坚定"></label></div><label class="character-description-field">一句话描述<textarea id="character-description" rows="4" maxlength="2000" placeholder="25 岁中国女性设计师，黑色长发，性格安静温柔"></textarea></label><div class="character-form-actions"><button id="character-enhance" class="route-secondary-button" type="button"><span class="mdi mdi-auto-fix"></span>AI 完善人物设定</button><button id="character-save" class="route-primary-button" type="button"><span class="mdi mdi-content-save-outline"></span>保存角色</button></div><span id="character-status" class="route-status">填写设定后保存角色</span><div class="character-identity-panel"><div class="route-card-heading"><div><h3>Character Identity Prompt</h3><p>后续视图和文生图会优先复用这段身份描述。</p></div><span id="character-confirmed" class="route-tag">未确认</span></div><textarea id="character-identity-prompt" rows="3" placeholder="保存后自动生成"></textarea></div></div></section><section class="route-card character-views-card"><div class="route-card-heading"><div><h2>角色视觉资产</h2><p>每张视图都可以单独生成和重新生成。</p></div><div class="character-views-actions"><button id="character-confirm" class="route-secondary-button" type="button" disabled><span class="mdi mdi-check-circle-outline"></span>确认人物</button></div></div><div class="character-view-grid">${viewCards}</div><div id="character-task-log" class="character-task-log"></div></section></main></div></section>`;
}

function settingsPageMarkup() {
  const typeOptions = Object.entries(modelTypeLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  return `<section class="route-view settings-view">${routeHeader(routeDefinitions.settings)}<section class="route-card settings-notice"><div><span class="mdi mdi-shield-lock-outline"></span><div><strong>本地保存，按类型管理</strong><p>配置仅保存在当前浏览器的本机存储中。当前图片和视频生成仍使用本地 ComfyUI，不会自动向外部 API 发起请求。</p></div></div><span class="route-tag">LOCAL ONLY</span></section><div class="settings-api-filter" role="tablist" aria-label="模型类型"><button class="settings-filter active" type="button" data-settings-filter="all">全部</button>${Object.entries(modelTypeLabels).map(([value, label]) => `<button class="settings-filter" type="button" data-settings-filter="${value}">${label}</button>`).join("")}</div><div class="settings-api-layout"><aside class="route-card settings-api-list-card"><div class="route-card-heading"><div><h2>API 配置</h2><p>不同模型类型分别选择配置。</p></div><button id="settings-api-new" class="route-icon-button" type="button" title="新增配置"><span class="mdi mdi-plus"></span></button></div><div id="settings-api-list" class="settings-api-list"><div class="route-list-empty">还没有 API 配置。</div></div></aside><main class="route-card settings-api-editor"><div class="route-card-heading"><div><h2>配置详情</h2><p>保存后可在对应模型类型中复用。</p></div><span id="settings-api-type-badge" class="route-tag">未选择</span></div><div class="settings-form-grid"><label>配置名称<input id="settings-api-name" maxlength="60" placeholder="例如：本地提示词服务"></label><label>模型类型<select id="settings-api-type">${typeOptions}</select></label><label>服务商<input id="settings-api-provider" maxlength="60" placeholder="例如：OpenAI Compatible"></label><label>模型名称<input id="settings-api-model" maxlength="120" placeholder="例如：qwen-plus / 自定义模型名"></label></div><label class="settings-form-field">API 地址<input id="settings-api-base-url" type="url" placeholder="https://api.example.com/v1"></label><label class="settings-form-field">API Key<input id="settings-api-key" type="password" autocomplete="off" placeholder="仅保存在本机浏览器"></label><label class="settings-enabled"><input id="settings-api-enabled" type="checkbox"><span><strong>启用此配置</strong><small>仅作为该模型类型的可用配置标记</small></span></label><div class="settings-form-actions"><button id="settings-api-save" class="route-primary-button" type="button"><span class="mdi mdi-content-save-outline"></span>保存配置</button><button id="settings-api-delete" class="route-secondary-button danger" type="button"><span class="mdi mdi-delete-outline"></span>删除配置</button></div><span id="settings-api-status" class="route-status">点击右上角新增一条配置。</span></main></div><section class="route-card settings-type-guide"><div class="route-card-heading"><div><h2>模型类型说明</h2><p>把能力分开，后续调用和参数不会混在一起。</p></div></div><div class="settings-type-guide-grid">${Object.entries(modelTypeLabels).map(([value, label]) => `<article><span class="settings-type-icon type-${value}"><span class="mdi mdi-${value === "image" ? "image-outline" : value === "video" ? "movie-open-outline" : value === "prompt" ? "text-box-edit-outline" : value === "character" ? "account-star-outline" : "video-settings-outline"}"></span></span><div><strong>${label}</strong><small>${value === "image" ? "文生图、图生图、图片编辑" : value === "video" ? "文生视频、图生视频、分镜视频" : value === "prompt" ? "提示词改写、翻译和结构化" : value === "character" ? "人物卡、角色身份和一致性" : "放大、抽帧、稳定和转码"}</small></div></article>`).join("")}</div></section></section>`;
}

function selectedApiConfig() {
  return state.apiConfigs.find((config) => config.id === state.selectedApiConfigId) || null;
}

function apiConfigTitle(config) {
  return config.name || config.model || config.provider || "未命名配置";
}

function renderApiConfigList() {
  const target = $("#settings-api-list");
  if (!target) return;
  const filter = state.apiConfigFilter || "all";
  const configs = state.apiConfigs.filter((config) => filter === "all" || config.type === filter);
  if (!configs.length) {
    target.innerHTML = `<div class="route-list-empty">${state.apiConfigs.length ? "此类型还没有配置。" : "还没有 API 配置。"}</div>`;
    return;
  }
  target.replaceChildren(...configs.map((config) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `settings-api-item${config.id === state.selectedApiConfigId ? " active" : ""}`;
    row.innerHTML = `<span class="settings-type-icon type-${config.type}"><span class="mdi mdi-${config.type === "image" ? "image-outline" : config.type === "video" ? "movie-open-outline" : config.type === "prompt" ? "text-box-edit-outline" : config.type === "character" ? "account-star-outline" : "video-settings-outline"}"></span></span><span><strong></strong><small></small></span><i class="mdi mdi-${config.enabled === false ? "pause-circle-outline" : "check-circle-outline"}"></i>`;
    row.querySelector("strong").textContent = apiConfigTitle(config);
    row.querySelector("small").textContent = `${modelTypeLabels[config.type] || "其他"} · ${config.baseUrl || "未填写 API 地址"}`;
    row.addEventListener("click", () => { state.selectedApiConfigId = config.id; renderApiConfigList(); renderApiConfigForm(); });
    return row;
  }));
}

function renderApiConfigForm() {
  const config = selectedApiConfig();
  const fields = {
    name: $("#settings-api-name"),
    type: $("#settings-api-type"),
    provider: $("#settings-api-provider"),
    model: $("#settings-api-model"),
    baseUrl: $("#settings-api-base-url"),
    apiKey: $("#settings-api-key"),
    enabled: $("#settings-api-enabled"),
  };
  if (!fields.type) return;
  fields.name.value = config?.name || "";
  fields.type.value = config?.type || "image";
  fields.provider.value = config?.provider || "";
  fields.model.value = config?.model || "";
  fields.baseUrl.value = config?.baseUrl || "";
  fields.apiKey.value = config?.apiKey || "";
  fields.enabled.checked = config?.enabled !== false;
  Object.values(fields).forEach((field) => { field.disabled = !config; });
  $("#settings-api-save").disabled = !config;
  $("#settings-api-delete").disabled = !config;
  const badge = $("#settings-api-type-badge");
  if (badge) badge.textContent = config ? modelTypeLabels[config.type] || "其他" : "未选择";
  const status = $("#settings-api-status");
  if (status && !config) status.textContent = "点击右上角新增一条配置。";
}

function bindApiSettings() {
  state.apiConfigs = readLocalJson(API_CONFIG_STORAGE_KEY, []).filter((config) => config && config.id && modelTypeLabels[config.type]);
  state.apiConfigFilter = "all";
  state.selectedApiConfigId = state.apiConfigs[0]?.id || null;
  document.querySelectorAll(".settings-filter").forEach((button) => button.addEventListener("click", () => {
    state.apiConfigFilter = button.dataset.settingsFilter;
    document.querySelectorAll(".settings-filter").forEach((item) => item.classList.toggle("active", item === button));
    renderApiConfigList();
  }));
  $("#settings-api-new")?.addEventListener("click", () => {
    const type = state.apiConfigFilter !== "all" ? state.apiConfigFilter : "image";
    const id = crypto.randomUUID?.() || `api-${Date.now()}`;
    state.apiConfigs.push({ id, type, provider: "", model: "", baseUrl: "", apiKey: "", enabled: true });
    state.selectedApiConfigId = id;
    renderApiConfigList();
    renderApiConfigForm();
    $("#settings-api-name")?.focus();
  });
  $("#settings-api-type")?.addEventListener("change", (event) => {
    const badge = $("#settings-api-type-badge");
    if (badge) badge.textContent = modelTypeLabels[event.target.value] || "其他";
  });
  $("#settings-api-save")?.addEventListener("click", () => {
    const config = selectedApiConfig();
    if (!config) return;
    config.name = $("#settings-api-name").value.trim();
    config.type = $("#settings-api-type").value;
    config.provider = $("#settings-api-provider").value.trim();
    config.model = $("#settings-api-model").value.trim();
    config.baseUrl = $("#settings-api-base-url").value.trim();
    config.apiKey = $("#settings-api-key").value;
    config.enabled = $("#settings-api-enabled").checked;
    config.updatedAt = Date.now();
    writeLocalJson(API_CONFIG_STORAGE_KEY, state.apiConfigs);
    renderApiConfigList();
    renderApiConfigForm();
    const status = $("#settings-api-status");
    if (status) { status.textContent = "配置已保存在本机。"; status.classList.remove("error"); }
  });
  $("#settings-api-delete")?.addEventListener("click", () => {
    const config = selectedApiConfig();
    if (!config || !window.confirm(`确定删除“${apiConfigTitle(config)}”吗？`)) return;
    state.apiConfigs = state.apiConfigs.filter((item) => item.id !== config.id);
    state.selectedApiConfigId = state.apiConfigs[0]?.id || null;
    writeLocalJson(API_CONFIG_STORAGE_KEY, state.apiConfigs);
    renderApiConfigList();
    renderApiConfigForm();
  });
  renderApiConfigList();
  renderApiConfigForm();
}

function routePageMarkup(route) {
  const def = routeDefinitions[route];
  if (route === "ai-canvas") return aiCanvasPageMarkup();
  if (route === "prompt-studio") return promptStudioPageMarkup();
  if (route === "character-studio") return characterStudioPageMarkup();
  if (route === "settings") return settingsPageMarkup();
  if (["text-to-image", "image-to-image", "image-editor", "text-to-video", "image-to-video"].includes(route)) return routeGenerationPage(route, def);
  if (route === "video-process") return `<section class="route-view">${routeHeader(def)}<div class="route-card route-process-card"><div class="route-process-grid"><button class="route-process-tool active" type="button" data-process-tool="upscale"><span class="mdi mdi-arrow-expand-all"></span><strong>视频放大</strong><small>提升清晰度，保留原始色彩</small></button><button class="route-process-tool" type="button" data-process-tool="stabilize"><span class="mdi mdi-video-stabilization"></span><strong>画面稳定</strong><small>减少手持抖动和镜头晃动</small></button><button class="route-process-tool" type="button" data-process-tool="frames"><span class="mdi mdi-filmstrip"></span><strong>抽帧与转码</strong><small>调整帧率、格式和片段</small></button></div><label class="route-dropzone large" for="route-video-file"><span class="mdi mdi-video-plus-outline"></span><strong>拖入视频文件</strong><small>支持 MP4、WEBM、MOV，本地处理不上传</small><input id="route-video-file" type="file" accept="video/*"></label><p id="route-file-name" class="route-file-name">尚未选择视频</p><div class="route-actions"><button id="route-process-button" class="route-primary-button" type="button"><span class="mdi mdi-play-circle-outline"></span>开始处理</button><span id="route-status" class="route-status">选择处理方式和视频文件</span></div></div></section>`;
  if (route === "workflows") return `<section class="route-view">${routeHeader(def)}<div class="route-card-grid workflow-grid"><article class="route-card workflow-card"><span class="workflow-icon blue mdi mdi-image-outline"></span><div><h2>Qwen 文生图</h2><p>适配 4060 的本地图片生成 Recipe。</p><span class="route-tag">已安装 · 推荐</span></div><a class="route-text-button" href="#page/text-to-image">开始使用 <span class="mdi mdi-arrow-right"></span></a></article><article class="route-card workflow-card"><span class="workflow-icon teal mdi mdi-image-multiple-outline"></span><div><h2>Qwen 图生图</h2><p>参考图重绘、风格迁移和局部创作。</p><span class="route-tag">图片 · 可复用</span></div><a class="route-text-button" href="#page/image-to-image">开始使用 <span class="mdi mdi-arrow-right"></span></a></article><article class="route-card workflow-card"><span class="workflow-icon purple mdi mdi-filmstrip"></span><div><h2>分镜图方案</h2><p>先生成镜头描述，再批量制作分镜草图。</p><span class="route-tag">工作流 · 本地</span></div><a class="route-text-button" href="#page/text-to-video">开始使用 <span class="mdi mdi-arrow-right"></span></a></article></div><div class="route-banner"><div><strong>需要精细调整节点？</strong><p>在专业模式中打开完整 ComfyUI 画布，保留当前本地工作流。</p></div><a class="route-primary-button" href="/?mode=editor">打开专业模式 <span class="mdi mdi-arrow-top-right"></span></a></div></section>`;
  if (route === "models") return `<section class="route-view">${routeHeader(def)}<div class="route-layout route-layout-wide"><div class="route-card"><div class="route-card-heading"><div><h2>已安装模型</h2><p>模型文件位于本机 ComfyUI 模型目录。</p></div><button id="route-refresh-models" class="route-icon-button" type="button" title="刷新"><span class="mdi mdi-refresh"></span></button></div><article class="model-list-row"><span class="route-model-icon blue mdi mdi-image-filter-hdr"></span><div><strong>Qwen-Image 2.1</strong><small>文生图 / 图生图 · safetensors</small></div><span class="route-ready"><span></span>可用</span></article><div id="route-model-list" class="route-list"><div class="route-list-empty">正在读取模型目录…</div></div></div><div class="route-card route-runtime-card"><div class="route-card-heading"><div><h2>运行策略</h2><p>针对当前电脑自动选择</p></div></div><div class="route-runtime-item"><span class="mdi mdi-memory"></span><div><strong>低显存模式</strong><small>按需加载，减少显存峰值</small></div><span class="route-ready"><span></span>启用</span></div><div class="route-runtime-item"><span class="mdi mdi-cpu-64-bit"></span><div><strong>CPU Offload</strong><small>适合 8 GB 显存设备</small></div><span class="route-ready"><span></span>启用</span></div><a class="route-outline-button" href="#page/home">返回工作台</a></div></div></section>`;
  if (route === "assets") return `<section class="route-view">${routeHeader(def)}<div class="route-card"><div class="route-card-heading"><div><h2>最近素材</h2><p>本地生成结果会自动出现在这里。</p></div><a class="route-outline-button" href="#page/text-to-image">去生成</a></div><div class="route-asset-grid"><img src="assets/gallery/floating-castle.png" alt="漂浮城堡"><img src="assets/gallery/neon-portrait.png" alt="霓虹人像"><img src="assets/gallery/golden-cat.png" alt="金色猫咪"><img src="assets/gallery/ice-princess.png" alt="冰晶幻想"><img src="assets/gallery/sunlit-interior.png" alt="阳光客厅"><img src="assets/gallery/winter-profile.png" alt="雪夜侧影"></div></div></section>`;
  if (route === "history") return `<section class="route-view">${routeHeader(def)}<div class="route-card"><div class="route-card-heading"><div><h2>最近任务</h2><p>实时查看生成、失败和等待中的任务。</p></div><button id="route-refresh-history" class="route-outline-button" type="button"><span class="mdi mdi-refresh"></span>刷新</button></div><div id="route-history-list" class="route-list"><div class="route-list-empty">正在读取任务记录…</div></div></div></section>`;
  return "";
}

const canvasNodeLabels = { prompt: "提示词", storyboard: "分镜", reference: "参考图", result: "输出" };
const canvasNodeIcons = { prompt: "text-box-outline", storyboard: "view-sequential-outline", reference: "image-multiple-outline", result: "movie-play-outline" };

function canvasNodeId(type) {
  return `canvas-${type}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function createCanvasNode(type, patch = {}) {
  const defaults = {
    id: canvasNodeId(type),
    type,
    title: canvasNodeLabels[type] || "节点",
    position: { x: 60, y: 60 },
    images: [],
    content: "",
    shotPrompt: "",
    output: null,
  };
  return { ...defaults, ...patch, position: { ...defaults.position, ...(patch.position || {}) }, images: Array.isArray(patch.images) ? patch.images : [] };
}

function defaultCanvasNodes() {
  return [
    createCanvasNode("prompt", { id: "canvas-prompt-main", title: "01 三镜剧本已生成", content: "镜头1｜4秒｜中景，地面轨迹｜林夏站在月台边缘，抬手接住飘落的雪花，远处列车缓慢进站，冷色晨雾包裹站台。\n镜头2｜3秒｜近景，轨道旁｜列车灯光穿过薄雾，女孩转身看向车窗，发丝被风吹动，镜头轻微推进。\n镜头3｜4秒｜画面由远及近｜列车停靠在月台，女孩走向车门，雪光在玻璃上留下柔和倒影。", position: { x: 118, y: 292 }, demo: true }),
    createCanvasNode("storyboard", { id: "canvas-storyboard-main", title: "02 GPT Image 2 三格分镜", shotPrompt: "车站、列车和人物动作保持连续，电影感构图，冷色雪夜光线", position: { x: 458, y: 300 }, demo: true, images: [{ demoSrc: "assets/gallery/winter-profile.png", fileName: "分镜 1" }, { demoSrc: "assets/gallery/neon-portrait.png", fileName: "分镜 2" }, { demoSrc: "assets/gallery/floating-castle.png", fileName: "分镜 3" }] }),
    createCanvasNode("result", { id: "canvas-video-main", title: "生成视频 1.mp4", position: { x: 790, y: 292 }, demo: true, demoSrc: "assets/gallery/winter-profile.png" }),
    createCanvasNode("result", { id: "canvas-video-secondary", title: "生成视频_1.mp4.mp4", position: { x: 1138, y: 292 }, demo: true, demoSrc: "assets/gallery/neon-portrait.png" }),
    createCanvasNode("result", { id: "canvas-panorama-main", title: "生成360全景图", position: { x: 458, y: 585 }, demo: true, demoSrc: "assets/gallery/sunlit-interior.png" }),
    createCanvasNode("result", { id: "canvas-panorama-left", title: "全景截图-1784881013331.png", position: { x: 790, y: 585 }, demo: true, demoSrc: "assets/gallery/floating-castle.png" }),
    createCanvasNode("result", { id: "canvas-panorama-right", title: "全景截图-1784881025533.png", position: { x: 1138, y: 585 }, demo: true, demoSrc: "assets/gallery/ice-princess.png" }),
  ];
}

function loadCanvasState() {
  const saved = readLocalJson(CANVAS_STORAGE_KEY, null);
  if (saved?.version === CANVAS_STORAGE_VERSION && Array.isArray(saved.nodes)) {
    state.canvas = { title: saved.title || "AI Canvas 项目", nodes: saved.nodes.map((node) => createCanvasNode(node.type, { ...node, images: (node.images || []).map(({ previewUrl, ...image }) => image) })), selectedId: saved.selectedId || null };
  } else {
    state.canvas = { title: "项目 4", nodes: defaultCanvasNodes(), selectedId: null, zoom: .84 };
  }
}

function saveCanvasState() {
  const nodes = state.canvas.nodes.map((node) => ({ ...node, images: node.images.map(({ previewUrl, ...image }) => image) }));
  writeLocalJson(CANVAS_STORAGE_KEY, { version: CANVAS_STORAGE_VERSION, title: state.canvas.title, nodes, selectedId: state.canvas.selectedId, zoom: state.canvas.zoom });
}

function canvasSelectedNode() {
  return state.canvas.nodes.find((node) => node.id === state.canvas.selectedId) || null;
}

function canvasNodeMediaUrl(media) {
  if (!media?.filename) return "";
  const base = apiBase || window.location.origin;
  return `${base}/view?filename=${encodeURIComponent(media.filename)}&subfolder=${encodeURIComponent(media.subfolder || "")}&type=${encodeURIComponent(media.type || "output")}`;
}

function canvasImageUrl(image) {
  if (image?.demoSrc) return image.demoSrc;
  if (image?.previewUrl) return image.previewUrl;
  if (!image?.name) return "";
  const base = apiBase || window.location.origin;
  return `${base}/view?filename=${encodeURIComponent(image.name)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=input`;
}

function canvasNodeDescription(node) {
  return { prompt: "总提示词与视觉方向", storyboard: "镜头画面与动作", reference: "人物、风格或场景", result: "图片 / 视频输出" }[node.type] || "画布节点";
}

function renderCanvasResultNode(node) {
  const target = document.querySelector(`[data-canvas-node-id="${CSS.escape(node.id)}"] .canvas-node-result-output`);
  if (!target) return;
  target.replaceChildren();
  if (!node.output?.media?.filename && !node.demoSrc) {
    target.innerHTML = `<span class="canvas-node-result-empty"><span class="mdi mdi-movie-play-outline"></span>执行画布后，结果会显示在这里</span>`;
    return;
  }
  const mediaKind = node.output?.mediaKind || "image";
  const url = node.output?.media?.filename ? canvasNodeMediaUrl(node.output.media) : node.demoSrc;
  const media = document.createElement(mediaKind === "video" ? "video" : "img");
  media.className = "canvas-node-result-media";
  media.src = url;
  media.alt = "画布生成结果";
  if (mediaKind === "video") media.controls = true;
  else media.addEventListener("click", () => openImageViewer(url, "画布生成结果"));
  const meta = document.createElement("small");
  meta.textContent = node.output?.elapsedMs != null ? `已完成 · ${formatElapsed(node.output.elapsedMs)}` : "本地素材 · 点击放大";
  target.append(media, meta);
}

function renderCanvasInspector() {
  const target = $("#canvas-inspector-body");
  if (!target) return;
  const panel = target.closest(".ai-canvas-inspector");
  const node = canvasSelectedNode();
  if (!node) {
    panel?.classList.remove("is-open");
    target.innerHTML = `<div class="ai-canvas-inspector-empty"><span class="mdi mdi-cursor-default-click-outline"></span><span>选择一个节点查看属性</span></div>`;
    return;
  }
  panel?.classList.add("is-open");
  target.innerHTML = `<div class="canvas-inspector-type"><span class="canvas-node-icon ${node.type}"><span class="mdi mdi-${canvasNodeIcons[node.type]}"></span></span><div><strong>${canvasNodeLabels[node.type]}</strong><small>${canvasNodeDescription(node)}</small></div></div><label class="canvas-inspector-field">节点名称<input id="canvas-inspector-title" maxlength="80"></label><div class="canvas-inspector-stats"><span>位置 <strong>${Math.round(node.position.x)} / ${Math.round(node.position.y)}</strong></span><span>媒体 <strong>${node.images.length} 张</strong></span></div><button id="canvas-inspector-delete" class="canvas-inspector-delete" type="button"><span class="mdi mdi-delete-outline"></span>删除此节点</button>`;
  $("#canvas-inspector-title").value = node.title;
  $("#canvas-inspector-title").addEventListener("input", (event) => { node.title = event.target.value || canvasNodeLabels[node.type]; renderCanvasNodes(); saveCanvasState(); });
  $("#canvas-inspector-delete").addEventListener("click", () => removeCanvasNode(node.id));
}

function renderCanvasConnections() {
  const svg = $("#ai-canvas-connections");
  const stage = $("#ai-canvas-workspace");
  if (!svg || !stage) return;
  const nodes = state.canvas.nodes;
  const nodeElements = new Map(nodes.map((node) => [node.id, document.querySelector(`[data-canvas-node-id="${CSS.escape(node.id)}"]`)]));
  const width = Math.max(stage.clientWidth, ...nodes.map((node) => node.position.x + 330), 980);
  const height = Math.max(stage.clientHeight, ...nodes.map((node) => node.position.y + 260), 660);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const edges = [];
  const prompt = nodes.find((node) => node.type === "prompt");
  const mediaNodes = nodes.filter((node) => node.type === "storyboard" || node.type === "reference");
  const outputs = nodes.filter((node) => node.type === "result");
  if (prompt) mediaNodes.forEach((node) => edges.push([prompt, node, "#4c9eff"]));
  if (outputs.length) outputs.forEach((output) => (mediaNodes.length ? mediaNodes : prompt ? [prompt] : []).forEach((node) => edges.push([node, output, "#55d8bf"])));
  const paths = edges.map(([from, to, color]) => {
    const fromElement = nodeElements.get(from.id);
    const toElement = nodeElements.get(to.id);
    const fromWidth = fromElement?.offsetWidth || 280;
    const fromHeight = fromElement?.offsetHeight || 160;
    const toHeight = toElement?.offsetHeight || 160;
    const x1 = from.position.x + fromWidth;
    const y1 = from.position.y + fromHeight / 2;
    const x2 = to.position.x;
    const y2 = to.position.y + toHeight / 2;
    const bend = Math.max(50, Math.abs(x2 - x1) * .42);
    return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" stroke="${color}" />`;
  }).join("");
  svg.innerHTML = `<defs><marker id="canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke"></path></marker></defs>${paths}`;
}

function renderCanvasZoom() {
  const zoom = state.canvas.zoom || 1;
  const nodes = $("#ai-canvas-nodes");
  const connections = $("#ai-canvas-connections");
  if (nodes) nodes.style.transform = `scale(${zoom})`;
  if (connections) connections.style.transform = `scale(${zoom})`;
  const value = $("#canvas-zoom-value");
  if (value) value.textContent = `${Math.round(zoom * 100)}%`;
}

function renderCanvasNodes() {
  const target = $("#ai-canvas-nodes");
  if (!target) return;
  const empty = $("#canvas-empty");
  target.replaceChildren();
  if (!state.canvas.nodes.length) {
    empty?.classList.remove("is-hidden");
    const count = $("#canvas-node-count");
    if (count) count.textContent = "0 个节点";
    renderCanvasInspector();
    renderCanvasConnections();
    return;
  }
  empty?.classList.add("is-hidden");
  state.canvas.nodes.forEach((node) => {
    const card = document.createElement("article");
    card.className = `ai-canvas-node ${node.type}${node.demo ? " demo" : ""}${node.id === state.canvas.selectedId ? " selected" : ""}`;
    card.dataset.canvasNodeId = node.id;
    card.style.left = `${node.position.x}px`;
    card.style.top = `${node.position.y}px`;
    const head = document.createElement("div");
    head.className = "ai-canvas-node-head";
    head.innerHTML = `<div class="ai-canvas-node-heading"><span class="canvas-node-icon ${node.type}"><span class="mdi mdi-${canvasNodeIcons[node.type]}"></span></span><span><strong></strong><small></small></span></div><button class="ai-canvas-node-delete" type="button" title="删除节点"><span class="mdi mdi-close"></span></button>`;
    head.querySelector("strong").textContent = node.title;
    head.querySelector("small").textContent = canvasNodeDescription(node);
    head.querySelector("button").addEventListener("click", (event) => { event.stopPropagation(); removeCanvasNode(node.id); });
    card.append(head);
    if (node.type === "prompt") {
      const editor = document.createElement("textarea");
      editor.className = "canvas-node-prompt";
      editor.rows = 5;
      editor.maxLength = 2000;
      editor.placeholder = "写下这张画布的总提示词…";
      editor.value = node.content || "";
      editor.addEventListener("input", () => { node.content = editor.value; saveCanvasState(); });
      card.append(editor);
      const footer = document.createElement("div");
      footer.className = "canvas-node-footer";
      footer.innerHTML = `<span><span class="mdi mdi-link-variant"></span>自动连接到媒体节点</span><small></small>`;
      footer.querySelector("small").textContent = `${(node.content || "").length}/2000`;
      editor.addEventListener("input", () => { footer.querySelector("small").textContent = `${editor.value.length}/2000`; });
      card.append(footer);
    } else if (node.type === "storyboard" || node.type === "reference") {
      const mediaGrid = document.createElement("div");
      mediaGrid.className = "canvas-node-media-grid";
      if (!node.images.length) mediaGrid.innerHTML = `<span class="canvas-node-media-empty"><span class="mdi mdi-image-plus-outline"></span>上传${node.type === "storyboard" ? "分镜图" : "参考图"}</span>`;
      node.images.forEach((image, index) => {
        const item = document.createElement("div");
        item.className = "canvas-node-media-item";
        const thumbnail = document.createElement("img");
        thumbnail.src = canvasImageUrl(image);
        thumbnail.alt = `${canvasNodeLabels[node.type]} ${index + 1}`;
        item.append(thumbnail);
        item.addEventListener("click", (event) => { if (event.target.closest("button")) return; openImageViewer(canvasImageUrl(image), thumbnail.alt); });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.title = "移除图片";
        remove.innerHTML = `<span class="mdi mdi-close"></span>`;
        remove.addEventListener("click", (event) => { event.stopPropagation(); node.images.splice(index, 1); renderCanvasNodes(); saveCanvasState(); });
        item.append(remove);
        mediaGrid.append(item);
      });
      card.append(mediaGrid);
      const upload = document.createElement("label");
      upload.className = "canvas-node-upload";
      upload.innerHTML = `<span class="mdi mdi-upload-outline"></span><span>上传${node.type === "storyboard" ? "分镜图" : "参考图"}</span><input type="file" accept="image/*" multiple>`;
      const input = upload.querySelector("input");
      input.addEventListener("change", () => uploadCanvasNodeImages(node, input.files));
      card.append(upload);
      const uploadProgress = document.createElement("div");
      uploadProgress.className = "canvas-node-upload-progress is-hidden";
      uploadProgress.innerHTML = `<div><span>准备上传</span><strong>0%</strong></div><span><i></i></span>`;
      card.append(uploadProgress);
      if (node.type === "storyboard") {
        const shotPrompt = document.createElement("textarea");
        shotPrompt.className = "canvas-node-shot-prompt";
        shotPrompt.rows = 2;
        shotPrompt.maxLength = 500;
        shotPrompt.placeholder = "镜头动作 / 景别 / 节奏…";
        shotPrompt.value = node.shotPrompt || "";
        shotPrompt.addEventListener("input", () => { node.shotPrompt = shotPrompt.value; saveCanvasState(); });
        card.append(shotPrompt);
      }
      const foot = document.createElement("div");
      foot.className = "canvas-node-footer";
      foot.innerHTML = `<span><span class="mdi mdi-link-variant"></span>${node.type === "storyboard" ? "生成视频镜头" : "保持主体一致"}</span><small>${node.images.length} 张</small>`;
      card.append(foot);
    } else {
      const output = document.createElement("div");
      output.className = "canvas-node-result-output";
      card.append(output);
      const footer = document.createElement("div");
      footer.className = "canvas-node-footer";
      footer.innerHTML = `<span><span class="mdi mdi-clock-outline"></span>任务完成后显示耗时</span>`;
      card.append(footer);
    }
    card.addEventListener("click", () => { state.canvas.selectedId = node.id; renderCanvasNodes(); renderCanvasInspector(); });
    head.addEventListener("pointerdown", (event) => startCanvasNodeDrag(event, node, card));
    target.append(card);
    if (node.type === "result") renderCanvasResultNode(node);
  });
  const count = $("#canvas-node-count");
  if (count) count.textContent = `${state.canvas.nodes.length} 个节点`;
  renderCanvasInspector();
  renderCanvasZoom();
  renderCanvasConnections();
}

function startCanvasNodeDrag(event, node, card) {
  if (event.target.closest("button, input, textarea")) return;
  const workspace = $("#ai-canvas-workspace");
  if (!workspace) return;
  event.preventDefault();
  state.canvas.selectedId = node.id;
  const zoom = state.canvas.zoom || 1;
  const startX = event.clientX;
  const startY = event.clientY;
  const origin = { ...node.position };
  const move = (moveEvent) => {
    node.position = { x: Math.max(12, origin.x + (moveEvent.clientX - startX) / zoom), y: Math.max(12, origin.y + (moveEvent.clientY - startY) / zoom) };
    card.style.left = `${node.position.x}px`;
    card.style.top = `${node.position.y}px`;
    renderCanvasConnections();
  };
  const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); saveCanvasState(); renderCanvasInspector(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
}

function addCanvasNode(type) {
  const sameType = state.canvas.nodes.filter((node) => node.type === type).length;
  const node = createCanvasNode(type, { title: type === "storyboard" ? `分镜 ${sameType + 1}` : type === "reference" ? `参考图 ${sameType + 1}` : type === "prompt" ? `提示词 ${sameType + 1}` : `输出 ${sameType + 1}`, position: { x: 70 + (sameType % 2) * 320, y: 80 + sameType * 210 } });
  state.canvas.nodes.push(node);
  state.canvas.selectedId = node.id;
  renderCanvasNodes();
  saveCanvasState();
}

function removeCanvasNode(id) {
  state.canvas.nodes = state.canvas.nodes.filter((node) => node.id !== id);
  if (state.canvas.selectedId === id) state.canvas.selectedId = state.canvas.nodes[0]?.id || null;
  renderCanvasNodes();
  saveCanvasState();
}

async function uploadCanvasNodeImages(node, files) {
  const validFiles = [...(files || [])].filter((file) => file.type.startsWith("image/"));
  if (!validFiles.length) return;
  const totalImages = state.canvas.nodes.reduce((total, item) => total + item.images.length, 0);
  const filesToUpload = validFiles.slice(0, Math.max(0, 9 - totalImages));
  const status = $("#canvas-run-status");
  if (!filesToUpload.length) { if (status) status.textContent = "画布参考图最多支持 9 张，请先移除图片。"; return; }
  if (status) status.textContent = `正在上传 ${filesToUpload.length} 张画布素材…`;
  const card = document.querySelector(`[data-canvas-node-id="${CSS.escape(node.id)}"]`);
  const progress = card?.querySelector(".canvas-node-upload-progress");
  const progressLabel = progress?.querySelector("div span");
  const progressValue = progress?.querySelector("div strong");
  const progressBar = progress?.querySelector("i");
  progress?.classList.remove("is-hidden");
  for (let index = 0; index < filesToUpload.length; index += 1) {
    const file = filesToUpload[index];
    try {
      if (progressLabel) progressLabel.textContent = `正在上传 ${index + 1}/${filesToUpload.length}`;
      const uploaded = await uploadRouteImage(file, (value) => { if (progressValue) progressValue.textContent = `${value}%`; if (progressBar) progressBar.style.width = `${value}%`; });
      node.images.push({ ...uploaded, fileName: file.name, previewUrl: URL.createObjectURL(file) });
    } catch (error) {
      if (status) { status.textContent = error.message; status.classList.add("error"); }
      return;
    }
  }
  if (progressLabel) progressLabel.textContent = `已上传 ${filesToUpload.length} 张`;
  if (progressValue) progressValue.textContent = "100%";
  if (progressBar) progressBar.style.width = "100%";
  if (status) { status.textContent = `已加入 ${filesToUpload.length} 张素材；可以继续执行画布。`; status.classList.remove("error"); }
  renderCanvasNodes();
  saveCanvasState();
}

function fitCanvasLayout() {
  const positions = { prompt: { x: 118, y: 292 }, reference: { x: 458, y: 300 }, storyboard: { x: 458, y: 300 }, result: { x: 790, y: 292 } };
  const counters = { prompt: 0, reference: 0, storyboard: 0, result: 0 };
  state.canvas.nodes.forEach((node) => {
    const base = positions[node.type] || { x: 80, y: 80 };
    const offset = counters[node.type]++;
    node.position = node.demo ? { ...node.position } : { x: base.x + (node.type === "result" ? (offset % 3) * 348 : (offset % 2) * 25), y: base.y + (node.type === "storyboard" ? offset * 220 : offset * 185) };
  });
  renderCanvasNodes();
  saveCanvasState();
}

function canvasPromptText() {
  return state.canvas.nodes.find((node) => node.type === "prompt" && node.content?.trim())?.content.trim() || "保持主体和整体风格一致，画面自然、有电影感。";
}

function canvasResultNode() {
  let node = state.canvas.nodes.find((item) => item.type === "result");
  if (!node) { node = createCanvasNode("result", { title: "最终输出", position: { x: 720, y: 160 } }); state.canvas.nodes.push(node); }
  return node;
}

async function queueCanvasGeneration(mediaKind) {
  const status = $("#canvas-run-status");
  const imageNodes = state.canvas.nodes.filter((node) => node.type === "storyboard");
  const referenceNodes = state.canvas.nodes.filter((node) => node.type === "reference");
  const storyboardImages = imageNodes.flatMap((node) => node.images.map((image) => ({ ...image, prompt: node.shotPrompt || "" })));
  const references = referenceNodes.flatMap((node) => node.images);
  const prompt = canvasPromptText();
  if (mediaKind === "video" && !storyboardImages.length) {
    if (status) { status.textContent = "请先在分镜节点上传至少一张分镜图。"; status.classList.add("error"); }
    return;
  }
  const button = mediaKind === "video" ? $("#canvas-generate-video") : $("#canvas-generate-image");
  if (button) { button.disabled = true; button.classList.add("is-submitting"); }
  if (status) { status.textContent = "正在提交本地任务…"; status.classList.remove("error"); }
  try {
    let queued;
    if (mediaKind === "video") {
      const rawLength = 5 * 24;
      const length = rawLength + (5 - (rawLength % 17)) % 17;
      queued = await queueMiniMaxH3Video(prompt, (message, error) => { if (status) { status.textContent = message; status.classList.toggle("error", Boolean(error)); } }, { width: 512, height: 288, steps: 12, length, storyboard: true, images: storyboardImages, references, shotPrompts: storyboardImages.map((image) => image.prompt || "") });
    } else {
      queued = await queueQwenImage(prompt, (message, error) => { if (status) { status.textContent = message; status.classList.toggle("error", Boolean(error)); } }, null, { width: 768, height: 768, steps: 20, cfg: 1 });
    }
    if (!queued?.prompt_id) return;
    const item = appendRouteQueueItem(prompt, queued, mediaKind, $("#canvas-run-queue"));
    const resultNode = canvasResultNode();
    state.canvas.selectedId = resultNode.id;
    renderCanvasNodes();
    saveCanvasState();
    if (status) { status.textContent = mediaKind === "video" ? `已加入分镜视频队列 · ${storyboardImages.length} 个镜头` : "已加入图片生成队列"; status.classList.remove("error"); }
    watchQwenResult(queued.prompt_id, item, status, queued.clientId, queued.progressSocket, "running", (media) => {
      resultNode.output = { media, mediaKind, elapsedMs: getGenerationElapsed(queued.prompt_id) };
      saveCanvasState();
      renderCanvasResultNode(resultNode);
    }, mediaKind);
  } finally {
    if (button) { button.disabled = false; button.classList.remove("is-submitting"); }
  }
}

function bindAICanvas() {
  loadCanvasState();
  const title = $("#canvas-title");
  if (title) { title.value = state.canvas.title; title.addEventListener("input", () => { state.canvas.title = title.value; saveCanvasState(); }); }
  document.querySelectorAll("[data-canvas-add]").forEach((button) => button.addEventListener("click", () => addCanvasNode(button.dataset.canvasAdd)));
  $("#canvas-new")?.addEventListener("click", () => { state.canvas = { title: "项目 4", nodes: [], selectedId: null, zoom: .84 }; saveCanvasState(); if (title) title.value = state.canvas.title; renderCanvasNodes(); });
  $("#canvas-save")?.addEventListener("click", () => { saveCanvasState(); const status = $("#canvas-run-status"); if (status) status.textContent = "画布项目已保存到本机。"; });
  $("#canvas-fit")?.addEventListener("click", fitCanvasLayout);
  $("#canvas-reset")?.addEventListener("click", () => { state.canvas.nodes = defaultCanvasNodes(); state.canvas.selectedId = null; state.canvas.zoom = .84; renderCanvasNodes(); saveCanvasState(); });
  $("#canvas-zoom-in")?.addEventListener("click", () => { state.canvas.zoom = Math.min(1.35, (state.canvas.zoom || 1) + .1); renderCanvasZoom(); });
  $("#canvas-zoom-out")?.addEventListener("click", () => { state.canvas.zoom = Math.max(.65, (state.canvas.zoom || 1) - .1); renderCanvasZoom(); });
  $("#canvas-reset-view")?.addEventListener("click", () => { state.canvas.zoom = .84; renderCanvasZoom(); });
  $("#canvas-grid-toggle")?.addEventListener("click", (event) => { const workspace = $("#ai-canvas-workspace"); workspace?.classList.toggle("grid-hidden"); event.currentTarget.classList.toggle("active"); });
  $("#canvas-open-inspector")?.addEventListener("click", () => $(".ai-canvas-inspector")?.classList.toggle("is-open"));
  $("#canvas-inspector-close")?.addEventListener("click", () => $(".ai-canvas-inspector")?.classList.remove("is-open"));
  document.querySelectorAll("[data-canvas-tool]").forEach((button) => button.addEventListener("click", () => document.querySelectorAll("[data-canvas-tool]").forEach((item) => item.classList.toggle("active", item === button))));
  $("#canvas-generate-image")?.addEventListener("click", () => queueCanvasGeneration("image"));
  $("#canvas-generate-video")?.addEventListener("click", () => queueCanvasGeneration("video"));
  renderCanvasNodes();
  restoreRouteQueue($("#canvas-run-queue"), $("#canvas-run-status"));
}

async function routePlan() {
  const route = routeFromHash();
  if (route === "text-to-image" || route === "image-to-image" || route === "image-editor") {
    await queueImageRoute();
    return;
  }
  if (route === "text-to-video" || route === "image-to-video") {
    await queueVideoRoute();
    return;
  }
  const prompt = $("#route-prompt")?.value.trim();
  const status = $("#route-status");
  const result = $("#route-result");
  if (!prompt) { if (status) status.textContent = "请先输入描述。"; return; }
  state.routePrompt = prompt;
  if (status) status.textContent = "正在读取本地方案…";
  try {
    const plan = await api("/api/workflow/plan", { method: "POST", body: JSON.stringify({ task: prompt }) });
    if (plan.selected_recipe?.source === "template") plan.selected_recipe = await materializeRecipe(plan.selected_recipe);
    state.plan = plan;
    if (result) {
      result.innerHTML = `<div class="route-result-main"><span class="route-result-icon mdi mdi-check"></span><div><strong>方案已准备好</strong><small>${plan.selected_recipe?.name || "本地 Recipe"}</small></div></div><div class="route-result-meta"><span>${plan.selected_model?.name || "Qwen-Image 2.1"}</span><span>${plan.recommended?.hardware?.tier || "低显存策略"}</span></div><div id="route-progress" class="route-generation-progress is-hidden"><div class="route-progress-top"><span id="route-progress-label">等待任务</span><strong id="route-progress-value">0%</strong></div><div class="route-progress-track"><span id="route-progress-bar"></span></div></div><button id="route-queue-button" class="route-secondary-button" type="button"><span class="mdi mdi-play"></span>加入任务队列</button>`;
      $("#route-queue-button").onclick = async (event) => {
        const queueButton = event.currentTarget;
        queueButton.disabled = true;
        queueButton.textContent = "任务提交中…";
        if (routeFromHash() === "image-to-image" && !state.routeImage) {
          if (status) status.textContent = "请先上传参考图。";
          queueButton.disabled = false;
          queueButton.textContent = "加入任务队列";
          return;
        }
        const queued = await queueQwenImage(state.routePrompt, (message, error) => {
          if (status) { status.textContent = message; status.classList.toggle("error", Boolean(error)); }
        }, updateRouteProgress, { image: state.routeImage, ...routeImageDimensions() });
        if (queued?.prompt_id) {
          queueButton.textContent = "生成中…";
          watchQwenResult(queued.prompt_id, result, status, queued.clientId, queued.progressSocket);
        } else {
          queueButton.disabled = false;
          queueButton.textContent = "加入任务队列";
        }
      };
    }
    if (status) status.textContent = "规划完成，可以加入任务队列。";
  } catch (error) { if (status) status.textContent = error.message; if (result) result.innerHTML = `<span class="route-result-error">${error.message}</span>`; }
}

async function loadRouteModels() {
  const target = $("#route-model-list");
  if (!target) return;
  try {
    const folders = await api("/api/experiment/models/catalog");
    target.replaceChildren(...folders.slice(0, 8).map((folder) => { const row = document.createElement("div"); row.className = "route-list-row"; row.innerHTML = `<strong></strong><small></small>`; row.querySelector("strong").textContent = folder.name; row.querySelector("small").textContent = `${folder.file_count} 个文件 · ${Math.round((folder.total_size || 0) / 1024 / 1024)} MB`; return row; }));
    if (!folders.length) target.innerHTML = `<div class="route-list-empty">没有发现模型目录。</div>`;
  } catch (error) { target.innerHTML = `<div class="route-list-empty">${error.message}</div>`; }
}

async function loadRouteImageHistory() {
  const target = $("#route-history-gallery");
  if (!target) return;
  try {
    const data = await api("/api/jobs?limit=12&sort_by=created_at&sort_order=desc");
    const jobs = (data.jobs || []).filter((job) => job.preview_output?.filename);
    if (!jobs.length) {
      target.innerHTML = `<div class="image-route-history-empty"><span class="mdi mdi-image-multiple-outline"></span><span>还没有本地生图记录</span></div>`;
      return;
    }
    target.replaceChildren(...jobs.map((job) => {
      const output = job.preview_output;
      const card = document.createElement("article");
      card.className = "image-route-history-card";
      card.dataset.jobId = job.id;
      const isVideo = /\.(mp4|webm|mkv)$/i.test(output.filename || "");
      const image = document.createElement(isVideo ? "video" : "img");
      image.src = `/view?filename=${encodeURIComponent(output.filename)}&subfolder=${encodeURIComponent(output.subfolder || "")}&type=${encodeURIComponent(output.type || "output")}`;
      image.alt = isVideo ? "本地生成视频" : "本地生成图片";
      if (isVideo) { image.controls = true; image.preload = "metadata"; }
      image.addEventListener("click", () => { if (!isVideo) openImageViewer(image.currentSrc || image.src, image.alt); });
      const meta = document.createElement("div");
      meta.className = "image-route-history-meta";
      const metaTop = document.createElement("div");
      metaTop.className = "image-route-history-meta-top";
      const title = document.createElement("strong");
      title.textContent = isVideo ? "本地生成视频" : job.status === "completed" ? "本地生成结果" : "生成记录";
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "image-route-history-delete";
      deleteButton.title = "删除图片";
      deleteButton.setAttribute("aria-label", "删除图片");
      deleteButton.innerHTML = `<span class="mdi mdi-delete-outline"></span>`;
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteRouteImage(job.id, card, deleteButton);
      });
      metaTop.append(title, deleteButton);
      const id = document.createElement("small");
      id.textContent = `${job.id} · ${jobElapsedLabel(job)}`;
      meta.append(metaTop, id);
      card.append(image, meta);
      return card;
    }));
  } catch (error) {
    target.innerHTML = `<div class="image-route-history-empty"><span class="mdi mdi-alert-outline"></span><span>${error.message}</span></div>`;
  }
}

async function deleteRouteImage(jobId, card, button) {
  if (!window.confirm("确定删除这张图片及其生成记录吗？")) return;
  button.disabled = true;
  card.classList.add("is-deleting");
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    card.remove();
    loadRouteImageHistory();
    loadJobs();
    loadRouteHistory();
  } catch (error) {
    button.disabled = false;
    card.classList.remove("is-deleting");
    const status = $("#route-status");
    if (status) {
      status.textContent = `删除失败：${error.message}`;
      status.classList.add("error");
    }
  }
}

function updateRouteQueueCount() {
  const count = $("#route-queue-count");
  if (count) count.textContent = `${state.routeQueue.length} 个任务`;
}

function appendRouteQueueItem(prompt, queued, mediaKind = "image", target = $("#route-result")) {
  if (!target) return null;
  target.querySelector(".route-result-empty, .ai-canvas-queue-empty")?.remove();
  const item = document.createElement("article");
  item.className = "route-generation-item";
  item.innerHTML = `<div class="route-generation-item-head"><div><strong></strong><small></small></div><span class="route-generation-state">排队中</span></div><div class="route-generation-timing">耗时 —</div><div class="route-generation-progress"><div class="route-progress-top"><span id="route-progress-label">等待执行…</span><strong id="route-progress-value">0%</strong></div><div class="route-progress-track"><span></span></div></div><div class="route-generation-output"></div>`;
  item.querySelector("strong").textContent = `任务 ${state.routeQueue.length + 1}`;
  item.querySelector("small").textContent = prompt;
  item.dataset.promptId = queued.prompt_id;
  target.append(item);
  state.routeQueue.push({ promptId: queued.prompt_id, item });
  startGenerationTimer(item, queued.prompt_id, mediaKind);
  updateRouteQueueCount();
  return item;
}

async function restoreRouteQueue(target = $("#route-result"), status = $("#route-status")) {
  if (!target) return;
  try {
    const data = await api("/queue");
    const running = (data.queue_running || []).map((entry) => ({ entry, state: "running" }));
    const pending = (data.queue_pending || []).map((entry) => ({ entry, state: "pending" }));
    const tasks = [...running, ...pending];
    tasks.forEach(({ entry, state: taskState }) => {
      const promptId = entry?.[1];
      if (!promptId || state.routeQueue.some((task) => task.promptId === promptId)) return;
      const graph = entry?.[2] || {};
      const isVideo = Object.values(graph).some((node) => ["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "ConcatenateVideo"].includes(node?.class_type));
      const promptNode = Object.values(graph).find((node) => ["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node?.class_type));
      const prompt = promptNode?.inputs?.prompt || "本地生成任务";
      const item = appendRouteQueueItem(prompt, { prompt_id: promptId }, isVideo ? "video" : "image");
      if (!item) return;
      watchQwenResult(promptId, item, status, entry?.[3]?.client_id, null, taskState, null, isVideo ? "video" : "image");
    });
    if (tasks.length && status) status.textContent = `已恢复 ${tasks.length} 个进行中的任务`;
  } catch {
    // Queue state is optional during startup; the history and page remain usable.
  }
}

async function queueImageRoute() {
  const prompt = $("#route-prompt")?.value.trim();
  const status = $("#route-status");
  const button = $("#route-plan-button");
  if (!prompt) {
    if (status) status.textContent = "请先输入描述。";
    return;
  }
  if (["image-to-image", "image-editor"].includes(routeFromHash()) && !state.routeImage) {
    if (status) status.textContent = "请先上传参考图。";
    return;
  }
  state.routePrompt = prompt;
  if (button) {
    button.disabled = true;
    button.classList.add("is-submitting");
    button.innerHTML = `<span class="mdi mdi-loading mdi-spin"></span>正在排队…`;
  }
  try {
    const generationPrompt = await routePromptWithCharacter(prompt);
    const queued = await queueQwenImage(generationPrompt, (message, error) => {
      if (!status) return;
      status.textContent = message;
      status.classList.toggle("error", Boolean(error));
    }, null, { image: state.routeImage, ...routeImageDimensions() });
    if (!queued?.prompt_id) return;
    const item = appendRouteQueueItem(prompt, queued, "image");
    if (status) {
      status.textContent = `已加入生成队列 · ${state.routeQueue.length} 个任务`;
      status.classList.remove("error");
    }
    watchQwenResult(queued.prompt_id, item, status, queued.clientId, queued.progressSocket);
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-submitting");
      button.innerHTML = `<span class="mdi mdi-sparkles"></span>生成图片 <span class="image-route-shortcut">⌘↵</span>`;
    }
  }
}

async function queueVideoRoute() {
  const route = routeFromHash();
  const prompt = $("#route-prompt")?.value.trim();
  const status = $("#route-status");
  const button = $("#route-plan-button");
  if (!prompt) {
    if (status) status.textContent = "请先输入镜头描述。";
    return;
  }
  const storyboard = route === "image-to-video";
  const storyboardImages = storyboard ? state.routeImages : [];
  if (storyboard && !storyboardImages.length) {
    if (status) status.textContent = "请先上传至少一张分镜图。";
    return;
  }
  const seconds = Number($("#route-video-duration")?.value) || 5;
  const quality = $("#route-video-quality")?.value || "preview";
  const settings = {
    preview: { width: 512, height: 288, steps: 12 },
    balanced: { width: 640, height: 384, steps: 16 },
    high: { width: 768, height: 432, steps: 20 },
  }[quality] || { width: 512, height: 288, steps: 12 };
  const rawLength = Math.max(5, Math.round(seconds * 24));
  const length = rawLength + (5 - (rawLength % 17)) % 17;
  state.routePrompt = prompt;
  if (button) {
    button.disabled = true;
    button.classList.add("is-submitting");
    button.innerHTML = `<span class="mdi mdi-loading mdi-spin"></span>正在排队…`;
  }
  try {
    const generationPrompt = await routePromptWithCharacter(prompt);
    const queued = await queueMiniMaxH3Video(generationPrompt, (message, error) => {
      if (!status) return;
      status.textContent = message;
      status.classList.toggle("error", Boolean(error));
    }, { ...settings, length, storyboard, images: storyboardImages, references: storyboard ? state.routeReferences : [], shotPrompts: storyboardImages.map((image) => image.prompt || "") });
    if (!queued?.prompt_id) return;
    const item = appendRouteQueueItem(prompt, queued, "video");
    if (status) {
      status.textContent = storyboard
        ? `已加入 ${storyboardImages.length} 镜头合成队列 · ${state.routeQueue.length} 个任务`
        : `已加入视频队列 · ${state.routeQueue.length} 个任务`;
      status.classList.remove("error");
    }
    watchQwenResult(queued.prompt_id, item, status, queued.clientId, queued.progressSocket, "running", null, "video");
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-submitting");
      button.innerHTML = `<span class="mdi mdi-auto-fix"></span>生成视频`;
    }
  }
}

async function loadRouteCharacters() {
  const select = $("#route-character");
  if (!select) return;
  try {
    const characters = await api("/api/characters");
    state.characters = characters;
    select.replaceChildren(new Option("不使用角色", ""), ...characters.map((character) => new Option(`${character.name}${character.hero ? " · 已有主视觉" : ""}`, character.id)));
  } catch (error) {
    select.replaceChildren(new Option("角色列表不可用", ""));
    const status = $("#route-status");
    if (status) status.textContent = `角色列表加载失败：${error.message}`;
  }
}

async function routePromptWithCharacter(prompt) {
  const characterId = $("#route-character")?.value;
  if (!characterId) return prompt;
  const character = await api(`/api/characters/${encodeURIComponent(characterId)}`);
  const identity = character.visualIdentityPrompt || character.description;
  const cleanIdentity = identity?.replace(/[。！？!?.,，\s]+$/g, "");
  return cleanIdentity ? `${cleanIdentity}。${prompt}` : prompt;
}

async function loadRouteHistory() {
  const target = $("#route-history-list");
  if (!target) return;
  try {
    const data = await api("/api/jobs?limit=12&sort_by=created_at&sort_order=desc");
    const jobs = data.jobs || [];
    target.replaceChildren(...jobs.map((job) => { const row = document.createElement("div"); row.className = "route-list-row"; const icon = document.createElement("span"); icon.className = `route-history-icon ${job.status === "failed" ? "error" : ""} mdi ${job.status === "completed" ? "mdi-check" : job.status === "failed" ? "mdi-alert" : "mdi-timer-sand"}`; const text = document.createElement("div"); text.innerHTML = `<strong></strong><small></small>`; text.querySelector("strong").textContent = job.status || "排队中"; text.querySelector("small").textContent = `${job.id} · ${jobElapsedLabel(job)}`; row.append(icon, text); return row; }));
    if (!jobs.length) target.innerHTML = `<div class="route-list-empty">暂无任务记录。</div>`;
  } catch (error) { target.innerHTML = `<div class="route-list-empty">${error.message}</div>`; }
}

function promptStudioText() {
  const result = state.promptStudio.result;
  if (!result) return "";
  return state.promptStudio.view === "original" ? result.originalPrompt : result.enhancedPrompt;
}

function renderPromptStudioResult() {
  const result = state.promptStudio.result;
  const target = $("#prompt-studio-result");
  const structure = $("#prompt-studio-structure");
  const controls = ["#prompt-studio-use", "#prompt-studio-regenerate", "#prompt-studio-copy", "#prompt-studio-generate"];
  controls.forEach((selector) => { const button = $(selector); if (button) button.disabled = !result; });
  document.querySelectorAll(".prompt-studio-tab").forEach((button) => button.classList.toggle("active", button.dataset.promptView === state.promptStudio.view));
  if (!target || !structure) return;
  if (!result) {
    target.innerHTML = `<div class="prompt-studio-result-empty"><span class="mdi mdi-text-box-search-outline"></span><span>输入一句话，开始优化提示词</span></div>`;
    structure.innerHTML = `<span class="route-list-empty">优化后显示主体、场景和视觉方向。</span>`;
    return;
  }
  const text = document.createElement("p");
  text.className = "prompt-studio-result-text";
  text.textContent = promptStudioText();
  target.replaceChildren(text);
  const labels = { subject: "主体", subjectDetails: "外观细节", action: "动作", environment: "场景", composition: "构图", camera: "镜头", lighting: "光线", color: "色彩", style: "风格", mood: "氛围", materials: "材质", textContent: "文字", extraDetails: "补充" };
  structure.replaceChildren(...Object.entries(result.structuredPrompt || {}).filter(([, value]) => value).map(([key, value]) => {
    const row = document.createElement("div"); row.className = "prompt-studio-structure-row";
    const label = document.createElement("span"); label.textContent = labels[key] || key;
    const content = document.createElement("strong"); content.textContent = value;
    row.append(label, content); return row;
  }));
  if (!structure.children.length) structure.innerHTML = `<span class="route-list-empty">暂未提取到结构化信息。</span>`;
}

async function loadPromptStudioHistory() {
  const target = $("#prompt-studio-history");
  if (!target) return;
  try {
    const history = await api("/api/prompt-studio/history?limit=8");
    if (!history.length) { target.innerHTML = `<div class="route-list-empty">还没有优化记录。</div>`; return; }
    target.replaceChildren(...history.map((item) => {
      const button = document.createElement("button"); button.className = "prompt-studio-history-item"; button.type = "button";
      const title = document.createElement("strong"); title.textContent = item.originalPrompt;
      const meta = document.createElement("small"); meta.textContent = `${item.category || "free"} · ${item.modelAdapter || "QwenImageAdapter"}`;
      button.append(title, meta);
      button.addEventListener("click", () => { state.promptStudio.result = item; state.promptStudio.view = "enhanced"; const input = $("#prompt-studio-input"); if (input) { input.value = item.originalPrompt; input.dispatchEvent(new Event("input")); } renderPromptStudioResult(); });
      return button;
    }));
  } catch (error) { target.innerHTML = `<div class="route-list-empty">${error.message}</div>`; }
}

async function optimizePromptStudio() {
  const input = $("#prompt-studio-input");
  const status = $("#prompt-studio-status");
  const button = $("#prompt-studio-optimize");
  const originalPrompt = input?.value.trim();
  if (!originalPrompt) { if (status) status.textContent = "请先输入一句描述。"; return; }
  if (button) { button.disabled = true; button.innerHTML = `<span class="mdi mdi-loading mdi-spin"></span>正在优化…`; }
  try {
    const result = await api("/api/prompt-studio/optimize", { method: "POST", body: JSON.stringify({ originalPrompt, category: state.promptStudio.category || "free", model: "Qwen-Image 2.1", aspectRatio: "1:1" }) });
    state.promptStudio.result = result;
    state.promptStudio.view = "enhanced";
    renderPromptStudioResult();
    loadPromptStudioHistory();
    if (status) status.textContent = "优化完成，可以应用到文生图或直接生成。";
  } catch (error) { if (status) status.textContent = error.message; }
  finally { if (button) { button.disabled = false; button.innerHTML = `<span class="mdi mdi-auto-fix"></span>智能优化`; } }
}

function appendPromptStudioTask(prompt) {
  const target = $("#prompt-studio-generation");
  if (!target) return null;
  const item = document.createElement("article");
  item.className = "route-generation-item";
  item.innerHTML = `<div class="route-generation-item-head"><div><strong>生成任务</strong><small></small></div><span class="route-generation-state">排队中</span></div><div class="route-generation-timing">耗时 —</div><div class="route-generation-progress"><div class="route-progress-top"><span id="route-progress-label">等待执行…</span><strong id="route-progress-value">0%</strong></div><div class="route-progress-track"><span></span></div></div><div class="route-generation-output"></div>`;
  item.querySelector("small").textContent = prompt;
  target.replaceChildren(item);
  return item;
}

async function generatePromptStudioImage() {
  const prompt = promptStudioText();
  const status = $("#prompt-studio-status");
  if (!prompt) { if (status) status.textContent = "请先完成提示词优化。"; return; }
  const target = appendPromptStudioTask(prompt);
  const queued = await queueQwenImage(prompt, (message, error) => { if (status) { status.textContent = message; status.classList.toggle("error", Boolean(error)); } }, null, { width: 768, height: 768, steps: 20, cfg: 1 });
  if (queued?.prompt_id) watchQwenResult(queued.prompt_id, target, status, queued.clientId, queued.progressSocket);
}

function bindPromptStudio() {
  const input = $("#prompt-studio-input");
  const updateCount = () => { const count = $("#prompt-studio-count"); if (count && input) count.textContent = `${input.value.length}/1000`; };
  input?.addEventListener("input", updateCount);
  document.querySelectorAll(".prompt-studio-category").forEach((button) => button.addEventListener("click", () => {
    state.promptStudio.category = button.dataset.promptCategory;
    document.querySelectorAll(".prompt-studio-category").forEach((item) => item.classList.toggle("active", item === button));
  }));
  document.querySelectorAll(".prompt-studio-tab").forEach((button) => button.addEventListener("click", () => { state.promptStudio.view = button.dataset.promptView; renderPromptStudioResult(); }));
  $("#prompt-studio-optimize")?.addEventListener("click", optimizePromptStudio);
  $("#prompt-studio-regenerate")?.addEventListener("click", optimizePromptStudio);
  $("#prompt-studio-history-refresh")?.addEventListener("click", loadPromptStudioHistory);
  $("#prompt-studio-copy")?.addEventListener("click", async () => { const status = $("#prompt-studio-status"); try { await navigator.clipboard.writeText(promptStudioText()); if (status) status.textContent = "已复制当前提示词。"; } catch { if (status) status.textContent = "复制失败，请手动选择文本。"; } });
  $("#prompt-studio-use")?.addEventListener("click", () => { state.routePrompt = promptStudioText(); window.location.hash = "#page/text-to-image"; });
  $("#prompt-studio-generate")?.addEventListener("click", generatePromptStudioImage);
  $("#prompt-studio-inspiration")?.addEventListener("click", () => { if (input) { input.value = "清晨薄雾里的山间木屋，窗内亮着暖黄色的灯"; updateCount(); } });
  $("#prompt-studio-translate")?.addEventListener("click", () => { if (input && input.value.trim()) { input.value = `${input.value.trim()}，英文视觉描述，保留主体与构图`; updateCount(); } });
  $("#prompt-studio-template")?.addEventListener("click", () => { const category = state.promptStudio.category === "free" ? "portrait" : "free"; state.promptStudio.category = category; document.querySelectorAll(".prompt-studio-category").forEach((item) => item.classList.toggle("active", item.dataset.promptCategory === category)); const status = $("#prompt-studio-status"); if (status) status.textContent = category === "portrait" ? "已选择人像模板。" : "已回到推荐模板。"; });
  renderPromptStudioResult();
  loadPromptStudioHistory();
}

function characterImageUrl(image) {
  if (!image?.filename) return "";
  return `/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=${encodeURIComponent(image.type || "output")}`;
}

function renderCharacterList() {
  const target = $("#character-list");
  if (!target) return;
  if (!state.characters.length) { target.innerHTML = `<div class="route-list-empty">还没有角色，先创建一个。</div>`; return; }
  target.replaceChildren(...state.characters.map((character) => {
    const button = document.createElement("button"); button.className = `character-list-item${state.character?.id === character.id ? " active" : ""}`; button.type = "button";
    const preview = document.createElement("span"); preview.className = "character-list-thumb";
    const url = characterImageUrl(character.hero); if (url) { const image = document.createElement("img"); image.src = url; image.alt = character.name; preview.append(image); } else preview.innerHTML = `<span class="mdi mdi-account-outline"></span>`;
    const text = document.createElement("span"); text.className = "character-list-copy"; const title = document.createElement("strong"); title.textContent = character.name; const detail = document.createElement("small"); detail.textContent = `${character.profile?.age || "未填写年龄"} · ${character.profile?.gender || "未填写性别"}`; text.append(title, detail); button.append(preview, text);
    button.addEventListener("click", () => loadCharacter(character.id));
    return button;
  }));
}

function renderCharacterEditor() {
  const empty = $("#character-empty");
  const form = $("#character-form");
  const views = document.querySelectorAll(".character-slot-generate");
  const confirm = $("#character-confirm");
  if (!empty || !form) return;
  const character = state.character;
  empty.classList.toggle("is-hidden", Boolean(character));
  form.classList.toggle("is-hidden", !character);
  views.forEach((button) => { button.disabled = !character?.id; });
  if (!character) { if (confirm) confirm.disabled = true; return; }
  $("#character-editor-title").textContent = character.name || "编辑角色";
  $("#character-name").value = character.name || "";
  $("#character-description").value = character.description || "";
  $("#character-gender").value = character.profile?.gender || "";
  $("#character-age").value = character.profile?.age || "";
  $("#character-height").value = character.profile?.height || "";
  $("#character-body").value = character.profile?.bodyType || "";
  $("#character-hair").value = [character.hair?.color, character.hair?.style, character.hair?.length].filter(Boolean).join(" ");
  $("#character-face").value = [character.face?.faceShape, character.face?.skinTone, character.face?.eyes].filter(Boolean).join(" ");
  $("#character-personality").value = Array.isArray(character.personality?.keywords) ? character.personality.keywords.join("、") : "";
  $("#character-identity-prompt").value = character.visualIdentityPrompt || "";
  const confirmed = Boolean(character.identity?.confirmed);
  $("#character-confirmed").textContent = confirmed ? "已确认" : "未确认";
  $("#character-confirmed").classList.toggle("is-confirmed", confirmed);
  if (confirm) confirm.disabled = !character.images?.hero || confirmed;
  document.querySelectorAll(".character-view-slot").forEach((slot) => {
    const slotName = slot.dataset.slot;
    const preview = slot.querySelector(".character-slot-preview");
    const imageData = character.images?.[slotName];
    if (!preview) return;
    preview.replaceChildren();
    const url = characterImageUrl(imageData);
    if (url) { const image = document.createElement("img"); image.src = url; image.alt = `${character.name} ${slotName}`; image.addEventListener("click", () => openImageViewer(url, image.alt)); preview.append(image); } else preview.innerHTML = `<span class="mdi mdi-image-outline"></span><small>尚未生成</small>`;
  });
  renderCharacterList();
}

async function loadCharacters() {
  try { state.characters = await api("/api/characters"); renderCharacterList(); } catch (error) { const target = $("#character-list"); if (target) target.innerHTML = `<div class="route-list-empty">${error.message}</div>`; }
}

async function loadCharacter(characterId) {
  try { state.character = await api(`/api/characters/${encodeURIComponent(characterId)}`); renderCharacterEditor(); } catch (error) { const status = $("#character-status"); if (status) status.textContent = error.message; }
}

function resetCharacterDraft() {
  state.character = { name: "", description: "", profile: {}, hair: {}, images: {}, identity: {} };
  $("#character-status")?.replaceChildren(document.createTextNode("填写设定后保存角色"));
  renderCharacterEditor();
}

function characterFormBody() {
  const keywords = $("#character-personality")?.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) || [];
  return { name: $("#character-name")?.value.trim(), description: $("#character-description")?.value.trim(), profile: { gender: $("#character-gender")?.value.trim(), age: $("#character-age")?.value.trim(), height: $("#character-height")?.value.trim(), bodyType: $("#character-body")?.value.trim(), ethnicity: "" }, face: { faceShape: $("#character-face")?.value.trim(), skinTone: "", eyes: "", eyebrows: "", nose: "", mouth: "" }, hair: { color: $("#character-hair")?.value.trim(), style: "", length: "" }, personality: { keywords }, visualIdentityPrompt: $("#character-identity-prompt")?.value.trim() };
}

async function saveCharacter() {
  const body = characterFormBody();
  const status = $("#character-status");
  if (!body.name || !body.description) { if (status) status.textContent = "请填写人物名称和一句话描述。"; return; }
  try {
    const method = state.character?.id ? "PUT" : "POST";
    const path = state.character?.id ? `/api/characters/${encodeURIComponent(state.character.id)}` : "/api/characters";
    state.character = await api(path, { method, body: JSON.stringify(body) });
    if (status) status.textContent = "角色已保存，可以生成主视觉。";
    await loadCharacters();
    renderCharacterEditor();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function enhanceCharacter() {
  const description = $("#character-description")?.value.trim();
  const status = $("#character-status");
  if (!description) { if (status) status.textContent = "请先输入人物描述。"; return; }
  try {
    const result = await api("/api/prompt-studio/optimize", { method: "POST", body: JSON.stringify({ originalPrompt: description, category: "portrait", model: "Qwen-Image 2.1", aspectRatio: "1:1" }) });
    $("#character-identity-prompt").value = result.enhancedPrompt;
    if (status) status.textContent = "人物设定已完善，确认后点击保存角色。";
  } catch (error) { if (status) status.textContent = error.message; }
}

function characterViewPrompt(slot) {
  const identity = ($("#character-identity-prompt")?.value.trim() || state.character?.description || "一个稳定一致的角色").replace(/[。！？!?.,，\s]+$/g, "");
  const view = { hero: "半身主视觉，正面看向镜头，干净背景，角色设计展示", front: "全身正面视图，中立站姿，白色背景，角色设定参考图", left: "全身左侧视图，中立站姿，白色背景，角色设定参考图", right: "全身右侧视图，中立站姿，白色背景，角色设定参考图", back: "全身背面视图，中立站姿，白色背景，角色设定参考图" }[slot];
  return `${identity}。${view}。保持脸部、发型、体型和服装身份一致，细节清晰。`;
}

function appendCharacterTask(prompt, slot) {
  const target = $("#character-task-log");
  if (!target) return null;
  const item = document.createElement("article"); item.className = "route-generation-item"; item.innerHTML = `<div class="route-generation-item-head"><div><strong></strong><small></small></div><span class="route-generation-state">排队中</span></div><div class="route-generation-progress"><div class="route-progress-top"><span id="route-progress-label">等待执行…</span><strong id="route-progress-value">0%</strong></div><div class="route-progress-track"><span></span></div></div><div class="route-generation-output"></div>`; item.querySelector("strong").textContent = `${slot} 视图`; item.querySelector("small").textContent = prompt; target.prepend(item); return item;
}

async function generateCharacterSlot(slot) {
  if (!state.character?.id) return;
  const button = document.querySelector(`.character-slot-generate[data-character-slot="${slot}"]`);
  const status = $("#character-status");
  const prompt = characterViewPrompt(slot);
  const task = appendCharacterTask(prompt, slot);
  if (button) { button.disabled = true; button.classList.add("is-loading"); }
  try {
    const queued = await queueQwenImage(prompt, (message, error) => { if (status) { status.textContent = message; status.classList.toggle("error", Boolean(error)); } }, null, { width: 768, height: 768, steps: 20, cfg: 1 });
    if (!queued?.prompt_id) return;
    watchQwenResult(queued.prompt_id, task, status, queued.clientId, queued.progressSocket, "running", async (image) => {
      try { state.character = await api(`/api/characters/${encodeURIComponent(state.character.id)}/images`, { method: "POST", body: JSON.stringify({ slot, image }) }); renderCharacterEditor(); if (status) status.textContent = `${slot} 视图已保存。`; } catch (error) { if (status) status.textContent = error.message; }
    });
  } finally { if (button) { button.disabled = false; button.classList.remove("is-loading"); } }
}

async function confirmCharacter() {
  if (!state.character?.id) return;
  const status = $("#character-status");
  try { state.character = await api(`/api/characters/${encodeURIComponent(state.character.id)}/confirm`, { method: "POST", body: "{}" }); renderCharacterEditor(); if (status) status.textContent = "角色已确认，后续生成会优先参考主视觉。"; } catch (error) { if (status) status.textContent = error.message; }
}

function bindCharacterStudio() {
  $("#character-new")?.addEventListener("click", resetCharacterDraft);
  $("#character-empty-new")?.addEventListener("click", resetCharacterDraft);
  $("#character-save")?.addEventListener("click", saveCharacter);
  $("#character-enhance")?.addEventListener("click", enhanceCharacter);
  $("#character-confirm")?.addEventListener("click", confirmCharacter);
  document.querySelectorAll(".character-slot-generate").forEach((button) => button.addEventListener("click", () => generateCharacterSlot(button.dataset.characterSlot)));
  loadCharacters();
  renderCharacterEditor();
}

async function uploadRouteImage(file, onProgress) {
  await apiBaseReady;
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${apiBase}/upload/image`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    request.onerror = () => reject(new Error("参考图上传失败，请确认 ComfyUI 服务仍在运行。"));
    request.onload = () => {
      let data = {};
      try { data = request.responseText ? JSON.parse(request.responseText) : {}; } catch { data = {}; }
      if (request.status >= 200 && request.status < 300 && data.name) resolve(data);
      else reject(new Error(data.error || `参考图上传失败（${request.status}）`));
    };
    const form = new FormData();
    form.append("image", file, file.name);
    form.append("type", "input");
    request.send(form);
  });
}

async function bindRouteImage() {
  const input = $("#route-reference");
  const dropzone = input?.closest(".route-dropzone");
  const label = $("#route-file-name");
  const progress = $("#route-upload-progress");
  const bar = $("#route-upload-bar");
  const progressLabel = $("#route-upload-label");
  const progressPercent = $("#route-upload-percent");
  const preview = $("#route-image-preview");
  if (!input || !dropzone || !label || !progress || !bar || !progressLabel || !progressPercent || !preview) return;

  const selectFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      label.textContent = "请选择 PNG、JPG 或 WEBP 图片。";
      return;
    }
    state.routeImage = null;
    progress.classList.remove("is-hidden", "error");
    bar.style.width = "0%";
    progressPercent.textContent = "0%";
    progressLabel.textContent = "正在上传参考图…";
    label.textContent = file.name;
    try {
      const uploaded = await uploadRouteImage(file, (value) => {
        bar.style.width = `${value}%`;
        progressPercent.textContent = `${value}%`;
      });
      state.routeImage = uploaded;
      bar.style.width = "100%";
      progressPercent.textContent = "100%";
      progressLabel.textContent = "参考图已上传 · 仅保存在本机";
      label.textContent = `${file.name} · 已就绪`;
      preview.replaceChildren();
      const image = document.createElement("img");
      image.src = URL.createObjectURL(file);
      image.alt = "已上传参考图";
      preview.append(image);
      preview.classList.remove("is-hidden");
    } catch (error) {
      state.routeImage = null;
      progressLabel.textContent = error.message;
      progress.classList.add("error");
    }
  };

  input.addEventListener("change", () => selectFile(input.files?.[0]));
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("is-dragging"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragging"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
    selectFile(event.dataTransfer?.files?.[0]);
  });
}

function insertStoryboardReference(tag) {
  const prompt = $("#route-prompt");
  if (!prompt) return;
  const start = prompt.selectionStart ?? prompt.value.length;
  const end = prompt.selectionEnd ?? start;
  prompt.value = `${prompt.value.slice(0, start)}${tag}${prompt.value.slice(end)}`;
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  prompt.focus();
  prompt.setSelectionRange(start + tag.length, start + tag.length);
}

function renderStoryboardImages() {
  const target = $("#route-storyboard-list");
  if (!target) return;
  target.replaceChildren();
  if (!state.routeImages.length) {
    target.innerHTML = `<div class="storyboard-empty"><span class="mdi mdi-view-sequential-outline"></span><span>上传分镜图后，会在这里调整顺序和镜头描述。</span></div>`;
    return;
  }
  state.routeImages.forEach((image, index) => {
    const card = document.createElement("article");
    card.className = "storyboard-item";
    const preview = document.createElement("div");
    preview.className = "storyboard-item-preview";
    const thumbnail = document.createElement("img");
    thumbnail.src = image.previewUrl || `${apiBase}/view?filename=${encodeURIComponent(image.name)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=input`;
    thumbnail.alt = `分镜图 ${index + 1}`;
    preview.append(thumbnail);
    const meta = document.createElement("div");
    meta.className = "storyboard-item-meta";
    const heading = document.createElement("div");
    heading.className = "storyboard-item-heading";
    const title = document.createElement("strong");
    title.textContent = `图${index + 1}`;
    const filename = document.createElement("small");
    filename.textContent = image.fileName || image.name;
    heading.append(title, filename);
    const prompt = document.createElement("textarea");
    prompt.rows = 2;
    prompt.maxLength = 500;
    prompt.placeholder = "这个镜头发生什么？可使用 @分镜1、@参考1…";
    prompt.value = image.prompt || "";
    prompt.addEventListener("input", () => { image.prompt = prompt.value; });
    const actions = document.createElement("div");
    actions.className = "storyboard-item-actions";
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "storyboard-tag";
    tag.textContent = `@分镜${index + 1}`;
    tag.title = "插入到总提示词";
    tag.addEventListener("click", () => insertStoryboardReference(`@分镜${index + 1}`));
    const moveUp = document.createElement("button");
    moveUp.type = "button";
    moveUp.className = "storyboard-icon-button";
    moveUp.title = "上移镜头";
    moveUp.innerHTML = `<span class="mdi mdi-arrow-up"></span>`;
    moveUp.disabled = index === 0;
    moveUp.addEventListener("click", () => {
      [state.routeImages[index - 1], state.routeImages[index]] = [state.routeImages[index], state.routeImages[index - 1]];
      renderStoryboardImages();
    });
    const moveDown = document.createElement("button");
    moveDown.type = "button";
    moveDown.className = "storyboard-icon-button";
    moveDown.title = "下移镜头";
    moveDown.innerHTML = `<span class="mdi mdi-arrow-down"></span>`;
    moveDown.disabled = index === state.routeImages.length - 1;
    moveDown.addEventListener("click", () => {
      [state.routeImages[index], state.routeImages[index + 1]] = [state.routeImages[index + 1], state.routeImages[index]];
      renderStoryboardImages();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "storyboard-icon-button danger";
    remove.title = "移除镜头";
    remove.innerHTML = `<span class="mdi mdi-delete-outline"></span>`;
    remove.addEventListener("click", () => {
      state.routeImages.splice(index, 1);
      state.routeImage = state.routeImages[0] || null;
      renderStoryboardImages();
    });
    actions.append(tag, moveUp, moveDown, remove);
    meta.append(heading, prompt, actions);
    card.append(preview, meta);
    target.append(card);
  });
  state.routeImage = state.routeImages[0] || null;
}

function renderReferenceImages() {
  const target = $("#route-reference-list");
  if (!target) return;
  target.replaceChildren();
  if (!state.routeReferences.length) {
    target.innerHTML = `<div class="storyboard-empty"><span class="mdi mdi-image-outline"></span><span>可选：上传人物或风格参考图。</span></div>`;
    return;
  }
  state.routeReferences.forEach((image, index) => {
    const card = document.createElement("article");
    card.className = "storyboard-item reference-item";
    const preview = document.createElement("div");
    preview.className = "storyboard-item-preview";
    const thumbnail = document.createElement("img");
    thumbnail.src = image.previewUrl || `${apiBase}/view?filename=${encodeURIComponent(image.name)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=input`;
    thumbnail.alt = `参考图 ${index + 1}`;
    preview.append(thumbnail);
    const meta = document.createElement("div");
    meta.className = "storyboard-item-meta";
    const heading = document.createElement("div");
    heading.className = "storyboard-item-heading";
    const title = document.createElement("strong");
    title.textContent = `参考${index + 1}`;
    const filename = document.createElement("small");
    filename.textContent = image.fileName || image.name;
    heading.append(title, filename);
    const actions = document.createElement("div");
    actions.className = "storyboard-item-actions";
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "storyboard-tag";
    tag.textContent = `@参考${index + 1}`;
    tag.title = "插入到总提示词";
    tag.addEventListener("click", () => insertStoryboardReference(`@参考${index + 1}`));
    const moveUp = document.createElement("button");
    moveUp.type = "button";
    moveUp.className = "storyboard-icon-button";
    moveUp.title = "上移参考图";
    moveUp.innerHTML = `<span class="mdi mdi-arrow-up"></span>`;
    moveUp.disabled = index === 0;
    moveUp.addEventListener("click", () => {
      [state.routeReferences[index - 1], state.routeReferences[index]] = [state.routeReferences[index], state.routeReferences[index - 1]];
      renderReferenceImages();
    });
    const moveDown = document.createElement("button");
    moveDown.type = "button";
    moveDown.className = "storyboard-icon-button";
    moveDown.title = "下移参考图";
    moveDown.innerHTML = `<span class="mdi mdi-arrow-down"></span>`;
    moveDown.disabled = index === state.routeReferences.length - 1;
    moveDown.addEventListener("click", () => {
      [state.routeReferences[index], state.routeReferences[index + 1]] = [state.routeReferences[index + 1], state.routeReferences[index]];
      renderReferenceImages();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "storyboard-icon-button danger";
    remove.title = "移除参考图";
    remove.innerHTML = `<span class="mdi mdi-delete-outline"></span>`;
    remove.addEventListener("click", () => { state.routeReferences.splice(index, 1); renderReferenceImages(); });
    actions.append(tag, moveUp, moveDown, remove);
    meta.append(heading, actions);
    card.append(preview, meta);
    target.append(card);
  });
}

function bindRouteImageCollection(options) {
  const input = $(`#${options.inputId}`);
  const dropzone = input?.closest(".route-dropzone");
  const progress = $(`#${options.progressId}`);
  const bar = $(`#${options.barId}`);
  const progressLabel = $(`#${options.labelId}`);
  const progressPercent = $(`#${options.percentId}`);
  if (!input || !dropzone || !progress || !bar || !progressLabel || !progressPercent) return;

  const uploadFiles = async (files) => {
    const validFiles = [...files].filter((file) => file.type.startsWith("image/"));
    if (!validFiles.length) {
      progressLabel.textContent = "请选择 PNG、JPG 或 WEBP 图片。";
      progress.classList.remove("is-hidden", "error");
      progress.classList.add("error");
      return;
    }
    const available = Math.max(0, 9 - state.routeImages.length - state.routeReferences.length);
    const filesToUpload = validFiles.slice(0, available);
    if (!filesToUpload.length) {
      progressLabel.textContent = "已达到 MiniMax H3 的 9 张参考图上限。";
      progress.classList.remove("is-hidden", "error");
      progress.classList.add("error");
      return;
    }
    progress.classList.remove("is-hidden", "error");
    for (let index = 0; index < filesToUpload.length; index += 1) {
      const file = filesToUpload[index];
      progressLabel.textContent = `正在上传第 ${index + 1}/${filesToUpload.length} 张${options.label}…`;
      bar.style.width = "0%";
      progressPercent.textContent = "0%";
      try {
        const uploaded = await uploadRouteImage(file, (value) => {
          bar.style.width = `${value}%`;
          progressPercent.textContent = `${value}%`;
        });
        state[options.stateKey].push({ ...uploaded, fileName: file.name, previewUrl: URL.createObjectURL(file), prompt: "" });
        options.render();
      } catch (error) {
        progressLabel.textContent = error.message;
        progress.classList.add("error");
        return;
      }
    }
    bar.style.width = "100%";
    progressPercent.textContent = "100%";
    progressLabel.textContent = `已上传 ${state[options.stateKey].length} 张${options.label} · 顺序可调整`;
    input.value = "";
  };

  input.addEventListener("change", () => uploadFiles(input.files || []));
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("is-dragging"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragging"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
    uploadFiles(event.dataTransfer?.files || []);
  });
}

function bindRouteStoryboardImages() {
  bindRouteImageCollection({ inputId: "route-reference", progressId: "route-upload-progress", barId: "route-upload-bar", labelId: "route-upload-label", percentId: "route-upload-percent", stateKey: "routeImages", label: "分镜图", render: renderStoryboardImages });
  bindRouteImageCollection({ inputId: "route-global-reference", progressId: "route-reference-upload-progress", barId: "route-reference-upload-bar", labelId: "route-reference-upload-label", percentId: "route-reference-upload-percent", stateKey: "routeReferences", label: "参考图", render: renderReferenceImages });
  renderStoryboardImages();
  renderReferenceImages();
}

function bindRouteFile(inputId, labelId) {
  const input = $(`#${inputId}`); const label = $(`#${labelId}`);
  if (!input || !label) return;
  input.addEventListener("change", () => { label.textContent = input.files?.[0]?.name || "尚未选择文件"; });
}

function closeImageViewer() {
  const viewer = $(".image-viewer");
  if (!viewer) return;
  viewer.classList.remove("is-open");
  viewer.remove();
  document.body.classList.remove("is-image-viewer-open");
}

function openImageViewer(src, alt) {
  closeImageViewer();
  const viewer = document.createElement("div");
  viewer.className = "image-viewer";
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", "放大查看图片");
  viewer.innerHTML = `<div class="image-viewer-panel"><button class="image-viewer-close" type="button" aria-label="关闭"><span class="mdi mdi-close"></span></button><img class="image-viewer-image" alt=""><p class="image-viewer-hint">点击外部或按 Esc 关闭</p></div>`;
  const image = viewer.querySelector(".image-viewer-image");
  image.src = src;
  image.alt = alt || "生成图片";
  viewer.querySelector(".image-viewer-close").addEventListener("click", closeImageViewer);
  viewer.addEventListener("click", (event) => { if (event.target === viewer) closeImageViewer(); });
  document.body.append(viewer);
  document.body.classList.add("is-image-viewer-open");
  requestAnimationFrame(() => viewer.classList.add("is-open"));
}

function bindImageViewer() {
  if (state.imageViewerBound) return;
  state.imageViewerBound = true;
  document.addEventListener("click", (event) => {
    const image = event.target instanceof Element
      ? event.target.closest(".route-result-image, .route-image-preview img, .route-asset-grid img")
      : null;
    if (!image) return;
    event.preventDefault();
    openImageViewer(image.currentSrc || image.src, image.alt);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeImageViewer(); });
}

function renderRoute() {
  const route = routeFromHash();
  if (route === "ai-canvas") {
    if (window.location.protocol === "file:") {
      apiBaseReady.then((base) => window.location.assign(`${base}/product/ai-canvas/`));
    } else {
      window.location.assign("/product/ai-canvas/");
    }
    return;
  }
  const page = $("#route-page");
  state.routeImage = null;
  state.routeImages = [];
  state.routeReferences = [];
  state.routeQueue = [];
  const homeSections = document.querySelectorAll(".studio-main-grid, #jobs-section, #assets-section, #system-section");
  document.querySelectorAll("[data-route]").forEach((item) => item.classList.toggle("active", item.dataset.route === route));
  if (route === "home") {
    page.classList.add("is-hidden");
    homeSections.forEach((section) => section.classList.remove("is-hidden"));
    document.body.dataset.studioRoute = route;
    return;
  }
  page.classList.remove("is-hidden");
  homeSections.forEach((section) => section.classList.add("is-hidden"));
  page.innerHTML = routePageMarkup(route);
  document.body.dataset.studioRoute = route;
  $("#route-plan-button")?.addEventListener("click", routePlan);
  const routePrompt = $("#route-prompt");
  routePrompt?.addEventListener("input", (event) => { const count = $("#route-prompt-count"); if (count) count.textContent = `${event.target.value.length}/1000`; });
  if (routePrompt && state.routePrompt && ["text-to-image", "image-to-image", "image-editor", "text-to-video", "image-to-video"].includes(route)) {
    routePrompt.value = state.routePrompt;
    routePrompt.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (route === "image-to-video") bindRouteStoryboardImages();
  else if (["image-to-image", "image-editor"].includes(route)) bindRouteImage();
  else bindRouteFile("route-reference", "route-file-name");
  bindRouteFile("route-video-file", "route-file-name");
  document.querySelectorAll(".image-route-category").forEach((button) => button.addEventListener("click", () => document.querySelectorAll(".image-route-category").forEach((item) => item.classList.toggle("active", item === button))));
  document.querySelectorAll(".image-route-tool").forEach((button) => button.addEventListener("click", () => {
    const prompt = $("#route-prompt");
    if (!prompt) return;
    const value = button.dataset.routePrompt || "";
    if (button.textContent.includes("翻译")) {
      prompt.value = `${prompt.value}${prompt.value ? "，" : ""}英文提示词`;
    } else if (button.textContent.includes("随机")) {
      prompt.value = `${prompt.value}${prompt.value ? "，" : ""}${value.replace("随机灵感：", "")}`;
    } else {
      prompt.value = `${prompt.value}${prompt.value ? "，" : ""}${value}`;
    }
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  }));
  const aspectGrid = $(".image-route-aspect-grid");
  if (aspectGrid && !aspectGrid.querySelector("[data-aspect='custom']")) {
    const customAspect = document.createElement("button");
    customAspect.className = "image-route-aspect";
    customAspect.type = "button";
    customAspect.dataset.aspect = "custom";
    customAspect.innerHTML = `<span class="mdi mdi-crop-free"></span><span>自定义</span>`;
    aspectGrid.append(customAspect);
  }
  document.querySelectorAll(".image-route-aspect").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".image-route-aspect").forEach((item) => item.classList.toggle("active", item === button));
    const dimensions = routeImageDimensions();
    const size = $("#route-size-label");
    if (size) size.textContent = `${dimensions.width} × ${dimensions.height}`;
  }));
  $("#route-steps")?.addEventListener("input", (event) => { const output = $("#route-steps-value"); if (output) output.textContent = event.target.value; });
  $("#route-cfg")?.addEventListener("input", (event) => { const output = $("#route-cfg-value"); if (output) output.textContent = Number(event.target.value).toFixed(1); });
  $(".image-route-reset")?.addEventListener("click", () => {
    const aspect = $(".image-route-aspect[data-aspect='1:1']");
    aspect?.click();
    const steps = $("#route-steps"); if (steps) { steps.value = "20"; steps.dispatchEvent(new Event("input")); }
    const cfg = $("#route-cfg"); if (cfg) { cfg.value = "1"; cfg.dispatchEvent(new Event("input")); }
  });
  document.querySelectorAll(".route-chip").forEach((button) => button.addEventListener("click", () => document.querySelectorAll(".route-chip").forEach((item) => item.classList.toggle("active", item === button))));
  document.querySelectorAll(".route-process-tool").forEach((button) => button.addEventListener("click", () => document.querySelectorAll(".route-process-tool").forEach((item) => item.classList.toggle("active", item === button))));
  $("#route-process-button")?.addEventListener("click", () => { const status = $("#route-status"); status.textContent = $("#route-video-file")?.files?.length ? "已加入本地处理队列。" : "请先选择视频文件。"; });
  $("#route-refresh-models")?.addEventListener("click", loadRouteModels);
  $("#route-refresh-history")?.addEventListener("click", loadRouteHistory);
  $("#route-history-refresh")?.addEventListener("click", loadRouteImageHistory);
  if (route === "models") loadRouteModels();
  if (route === "history") loadRouteHistory();
  if (route === "settings") bindApiSettings();
  if (route === "prompt-studio") bindPromptStudio();
  if (route === "character-studio") bindCharacterStudio();
  if (route === "ai-canvas") bindAICanvas();
  if (["text-to-image", "image-to-image", "image-editor", "text-to-video", "image-to-video"].includes(route)) {
    loadRouteImageHistory();
    loadRouteCharacters();
    restoreRouteQueue();
  }
  bindImageViewer();
}

function initializeWorkbench() {
  document.querySelectorAll("[data-library-tab]").forEach((button) => {
    button.addEventListener("click", () => switchLibraryTab(button.dataset.libraryTab));
  });

  const task = $("#task");
  const promptCount = $("#prompt-count");
  const updatePromptCount = () => { if (promptCount) promptCount.textContent = `${task.value.length}/1000`; };
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      task.value = button.classList.contains("prompt-tool") && task.value.trim()
        ? `${task.value.trim()}，${button.dataset.prompt}`
        : button.dataset.prompt;
      task.focus();
      updatePromptCount();
    });
  });
  document.querySelectorAll("[data-prompt-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.promptMode = button.dataset.promptMode;
      document.querySelectorAll("[data-prompt-mode]").forEach((item) => item.classList.toggle("active", item === button));
      const placeholders = {
        image: "例如：做一张苹果官网风格的商品白底图，柔和阴影，高清输出",
        video: "例如：把一张人物照片做成 5 秒自然微动的视频，保持面部稳定",
        workflow: "例如：我需要一个图片放大并保存到本地的完整工作流",
      };
      task.placeholder = placeholders[state.promptMode];
    });
  });
  task.addEventListener("input", updatePromptCount);
  updatePromptCount();

  document.querySelectorAll("[data-panel-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.panelTab;
      document.querySelectorAll("[data-panel-tab]").forEach((item) => item.classList.toggle("active", item === button));
      $("#generate-panel").classList.toggle("is-hidden", tab !== "generate");
      $("#workflow-panel").classList.toggle("is-hidden", tab !== "workflow");
    });
  });
  document.querySelectorAll(".studio-top-icon[title='设置'], .local-space-settings").forEach((button) => button.addEventListener("click", () => { window.location.hash = "#page/settings"; }));

  document.querySelectorAll("[data-gallery-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.galleryFilter;
      document.querySelectorAll("[data-gallery-filter]").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll("#gallery .studio-media-card").forEach((card) => {
        const visible = filter === "all" || filter === "more" || (card.dataset.galleryKind || "").split(" ").includes(filter);
        card.classList.toggle("is-hidden", !visible);
      });
    });
  });

  document.querySelectorAll("[data-aspect]").forEach((button) => {
    button.addEventListener("click", () => document.querySelectorAll("[data-aspect]").forEach((item) => item.classList.toggle("active", item === button)));
  });
  [["steps", "steps-value"], ["cfg", "cfg-value"]].forEach(([inputId, outputId]) => {
    const input = $(`#${inputId}`);
    const output = $(`#${outputId}`);
    if (!input || !output) return;
    input.addEventListener("input", () => { output.value = input.value; output.textContent = input.value; });
  });
  $("#hero-start")?.addEventListener("click", () => { $("#task").focus(); $("#generate")?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("#refresh-gallery")?.addEventListener("click", loadGallery);
  task.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); planTask(); }
  });
  $("#project-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); createProject(); }
  });

  window.addEventListener("hashchange", renderRoute);
}

$("#plan-button").onclick = planTask;
$("#queue-button").onclick = queueRecipe;
$("#create-project").onclick = createProject;
$("#refresh-environment").onclick = loadEnvironment;
$("#diagnose-button").onclick = diagnoseWorkflow;
$("#refresh-gallery").onclick = loadGallery;
$("#refresh-models").onclick = loadModels;
$("#refresh-nodes")?.addEventListener("click", loadNodes);
$("#refresh-jobs").onclick = loadJobs;
initializeWorkbench();
window.desktop?.onStatus(refreshAfterBackendReady);
apiBaseReady.then((base) => {
  const link = $("#professional-link");
  const runtimeLink = $("#runtime-open-link");
  if (link && base) {
    link.href = window.location.protocol === "file:" ? `${base}/product/` : `${base}/?mode=editor`;
    if (window.location.protocol === "file:") link.textContent = "用服务地址打开";
  }
  if (runtimeLink && base && window.location.protocol === "file:") {
    runtimeLink.href = `${base}/product/`;
    runtimeLink.classList.remove("is-hidden");
  }
});
loadProjects();
loadTemplates();
loadEnvironment();
loadGallery();
loadModels();
loadNodes();
loadJobs();
initializeCanvas();
renderRoute();
