import json
import os
import re
import tempfile
import time
import uuid
from typing import Any

from aiohttp import web

import folder_paths


PROMPT_CATEGORIES = {
    "portrait": "人像",
    "product": "产品",
    "landscape": "风景",
    "anime": "动漫",
    "poster": "海报",
    "architecture": "建筑",
    "ui": "界面",
    "free": "自由",
}

PROMPT_FIELDS = (
    "subject",
    "subjectDetails",
    "action",
    "environment",
    "composition",
    "camera",
    "lighting",
    "color",
    "style",
    "mood",
    "materials",
    "textContent",
    "extraDetails",
)

PROMPT_TEMPLATES = [
    {"id": "portrait", "name": "人像摄影", "category": "portrait", "fields": ["人物", "外观", "服装", "动作", "场景", "风格"]},
    {"id": "product", "name": "产品摄影", "category": "product", "fields": ["产品", "颜色 / 材质", "背景", "摆放方式", "灯光", "风格"]},
    {"id": "landscape", "name": "风景摄影", "category": "landscape", "fields": ["主体", "环境", "天气", "时间", "构图", "氛围"]},
    {"id": "anime", "name": "动漫角色", "category": "anime", "fields": ["角色", "外观", "服装", "动作", "场景", "风格"]},
    {"id": "poster", "name": "海报设计", "category": "poster", "fields": ["主题", "文字", "构图", "配色", "风格"]},
    {"id": "architecture", "name": "建筑设计", "category": "architecture", "fields": ["建筑", "材质", "环境", "视角", "光线", "风格"]},
]


def _text(value: Any, name: str, limit: int, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} 必须是字符串")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{name} 不能为空")
    if len(value) > limit:
        raise ValueError(f"{name} 长度不能超过 {limit}")
    return value


def _language(prompt: str) -> str:
    return "zh" if re.search(r"[\u4e00-\u9fff]", prompt) else "en"


class PromptAnalyzer:
    _category_keywords = {
        "portrait": ("人物", "女生", "女孩", "男孩", "男人", "女性", "男性", "肖像"),
        "product": ("产品", "商品", "瓶", "手机", "耳机", "包装", "广告"),
        "landscape": ("雪山", "山", "海边", "森林", "湖", "草原", "风景", "天空"),
        "anime": ("动漫", "二次元", "漫画", "角色设计", "赛博朋克"),
        "poster": ("海报", "标题", "排版", "宣传页"),
        "architecture": ("建筑", "房子", "小屋", "客厅", "城市", "街道", "室内"),
        "ui": ("界面", "网页", "后台", "仪表盘", "UI"),
    }

    def analyze(self, prompt: str, category: str | None = None) -> dict[str, str]:
        environment = ""
        environment_match = re.search(r"(?:在|位于|坐落于|坐落在)([^，。,.]+)", prompt)
        if environment_match:
            environment = environment_match.group(1).strip()
        else:
            known_environment = ("雪山", "海边", "森林", "咖啡厅", "城市", "街道", "室内", "客厅", "花园")
            environment = next((item for item in known_environment if item in prompt), "")

        action = ""
        action_match = re.search(r"(?:正在|并且|然后)([^，。,.]+)", prompt)
        if action_match:
            action = action_match.group(1).strip()

        subject = prompt
        subject_terms = ("木屋", "小屋", "女孩", "女生", "女性", "男性", "男孩", "猫", "狗", "产品", "建筑", "人物")
        subject = next((term for term in subject_terms if term in prompt), subject)
        detected_category = category if category in PROMPT_CATEGORIES else "free"
        if detected_category == "free":
            for name, keywords in self._category_keywords.items():
                if any(keyword in prompt for keyword in keywords):
                    detected_category = name
                    break

        return {
            "subject": subject,
            "subjectDetails": "",
            "action": action,
            "environment": environment,
            "composition": "",
            "camera": "",
            "lighting": "",
            "color": "",
            "style": "",
            "mood": "",
            "materials": "",
            "textContent": "",
            "extraDetails": "",
            "category": detected_category,
        }


class PromptEnhancerProvider:
    def enhance(self, original_prompt: str, structured_prompt: dict[str, str]) -> str:
        raise NotImplementedError


class LocalPromptEnhancerProvider(PromptEnhancerProvider):
    def enhance(self, original_prompt: str, structured_prompt: dict[str, str]) -> str:
        parts = [original_prompt.rstrip("。.")]
        if structured_prompt.get("composition"):
            parts.append(structured_prompt["composition"])
        else:
            parts.append("主体清晰，画面层次自然，构图平衡")
        if structured_prompt.get("camera"):
            parts.append(structured_prompt["camera"])
        else:
            parts.append("自然视角，中等景深，细节清晰")
        if structured_prompt.get("lighting"):
            parts.append(structured_prompt["lighting"])
        else:
            parts.append("柔和的环境光，明暗过渡自然")
        if structured_prompt.get("color"):
            parts.append(structured_prompt["color"])
        else:
            parts.append("色彩协调，保留主体原有颜色")
        if structured_prompt.get("style"):
            parts.append(structured_prompt["style"])
        else:
            parts.append("高质量视觉设计，真实材质与清晰细节")
        if structured_prompt.get("mood"):
            parts.append(structured_prompt["mood"])
        return "，".join(part for part in parts if part) + "。"


class PromptModelAdapter:
    def adapt(self, prompt: str, model: str) -> tuple[str, str]:
        model_name = model or "Qwen-Image 2.1"
        if "SDXL" in model_name:
            return prompt, "SDXLAdapter"
        if "Flux" in model_name:
            return prompt, "FluxAdapter"
        return prompt, "QwenImageAdapter"


class PromptEngine:
    def __init__(self):
        self.analyzer = PromptAnalyzer()
        self.enhancer = LocalPromptEnhancerProvider()
        self.adapter = PromptModelAdapter()

    def optimize(self, original_prompt: str, category: str, model: str, aspect_ratio: str) -> dict[str, Any]:
        structured = self.analyzer.analyze(original_prompt, category)
        resolved_category = structured.pop("category")
        enhanced = self.enhancer.enhance(original_prompt, structured)
        enhanced, adapter = self.adapter.adapt(enhanced, model)
        return {
            "id": str(uuid.uuid4()),
            "originalPrompt": original_prompt,
            "structuredPrompt": structured,
            "enhancedPrompt": enhanced,
            "negativePrompt": "模糊、低质量、变形、水印、过度锐化",
            "category": resolved_category,
            "language": _language(original_prompt),
            "modelAdapter": adapter,
            "model": model or "Qwen-Image 2.1",
            "aspectRatio": aspect_ratio or "1:1",
            "createdAt": int(time.time() * 1000),
        }


class PromptStudioManager:
    def __init__(self, user_manager):
        self.user_manager = user_manager
        self.engine = PromptEngine()

    def _history_path(self, request) -> str | None:
        path = self.user_manager.get_request_user_filepath(request, "prompt-studio/history.json", create_dir=True)
        root = self.user_manager.get_request_user_filepath(request, None, create_dir=True)
        if path is None or root is None or not folder_paths.is_within_directory(root, path):
            return None
        return path

    def _read_history(self, request) -> list[dict[str, Any]]:
        path = self._history_path(request)
        if path is None or not os.path.isfile(path):
            return []
        with open(path, "r", encoding="utf-8") as file:
            value = json.load(file)
        return value if isinstance(value, list) else []

    def _write_history(self, request, history: list[dict[str, Any]]) -> None:
        path = self._history_path(request)
        if path is None:
            raise PermissionError("无权保存 Prompt 历史")
        fd, temporary_path = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".prompt-history.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(history, file, ensure_ascii=False, indent=2)
                file.write("\n")
            os.replace(temporary_path, path)
        except Exception:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
            raise

    @staticmethod
    def _body(request_body: Any) -> tuple[str, str, str, str]:
        if not isinstance(request_body, dict):
            raise ValueError("请求体必须是 JSON 对象")
        original = _text(request_body.get("originalPrompt", ""), "originalPrompt", 1000, True)
        category = request_body.get("category", "free")
        if category not in PROMPT_CATEGORIES:
            raise ValueError("category 无效")
        model = _text(request_body.get("model", "Qwen-Image 2.1"), "model", 100, True)
        aspect_ratio = _text(request_body.get("aspectRatio", "1:1"), "aspectRatio", 20, True)
        return original, category, model, aspect_ratio

    def add_routes(self, routes):
        @routes.get("/prompt-studio/templates")
        async def list_prompt_templates(request):
            return web.json_response(PROMPT_TEMPLATES)

        @routes.get("/prompt-studio/history")
        async def list_prompt_history(request):
            try:
                limit = max(1, min(int(request.rel_url.query.get("limit", "20")), 50))
                return web.json_response(self._read_history(request)[:limit])
            except (KeyError, OSError, ValueError) as error:
                return web.json_response({"error": str(error)}, status=400)

        @routes.post("/prompt-studio/optimize")
        async def optimize_prompt(request):
            try:
                body = await request.json()
                original, category, model, aspect_ratio = self._body(body)
                prompt_object = self.engine.optimize(original, category, model, aspect_ratio)
                history = self._read_history(request)
                history.insert(0, prompt_object)
                self._write_history(request, history[:30])
                return web.json_response(prompt_object, status=201)
            except (KeyError, OSError, PermissionError, ValueError, json.JSONDecodeError) as error:
                return web.json_response({"error": str(error)}, status=400)
