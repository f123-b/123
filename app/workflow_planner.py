from __future__ import annotations

from typing import Any


_INTENT_RULES = (
    ("video", "视频", ("video", "视频", "动画", "短视频", "首尾帧")),
    ("edit", "图片编辑", ("inpaint", "局部重绘", "换背景", "抠图", "修复", "编辑", "edit")),
    ("anime", "动漫", ("anime", "动漫", "二次元", "漫画", "卡通")),
    ("portrait", "人物", ("portrait", "人像", "人物", "证件照", "换脸", "换装")),
    ("product", "商品图", ("商品", "电商", "产品图", "白底图", "商品图")),
    ("image", "图片生成", ("image", "图片", "海报", "封面", "插画", "文生图", "生图")),
)


def infer_intent(task: str) -> dict[str, Any]:
    if not isinstance(task, str) or not task.strip():
        raise ValueError("task 不能为空")

    text = task.casefold()
    for intent_type, label, hints in _INTENT_RULES:
        matched = [hint for hint in hints if hint.casefold() in text]
        if matched:
            return {
                "type": intent_type,
                "label": label,
                "matched_keywords": matched,
            }

    return {
        "type": "image",
        "label": "图片生成",
        "matched_keywords": [],
    }


def build_workflow_plan(
    task: str,
    recipe_candidates: list[dict[str, Any]],
    model_candidates: list[dict[str, Any]],
    environment: dict[str, Any],
    *,
    category: str | None = None,
) -> dict[str, Any]:
    if len(task) > 512:
        raise ValueError("task 参数过长")
    intent = infer_intent(task)
    selected_recipe = next(
        (
            recipe
            for recipe in recipe_candidates
            if isinstance(recipe, dict) and int(recipe.get("score", 0) or 0) > 0
        ),
        None,
    )
    if selected_recipe is None:
        selected_recipe = next(
            (recipe for recipe in recipe_candidates if isinstance(recipe, dict)),
            None,
        )
    selected_model = next(
        (model for model in model_candidates if isinstance(model, dict)),
        None,
    )

    hardware = environment.get("hardware", {})
    recommendation = hardware.get("recommendation", {}) if isinstance(hardware, dict) else {}
    runtime_ready = bool(environment.get("runtime_ready", True))
    next_steps = []
    if selected_recipe is None:
        next_steps.append({
            "action": "choose_recipe",
            "label": "选择或创建配方",
            "detail": "没有找到高匹配度的本地 Recipe，请先选择模板或保存一个工作流。",
        })
    else:
        next_steps.append({
            "action": "prepare_recipe",
            "label": "准备配方参数",
            "recipe_id": selected_recipe.get("id"),
        })
    if selected_model is None:
        next_steps.append({
            "action": "choose_model",
            "label": "选择本地模型",
            "detail": "当前模型目录没有匹配的本地候选，未执行下载。",
        })
    if not runtime_ready:
        next_steps.append({
            "action": "diagnose_environment",
            "label": "修复运行环境",
            "detail": "环境诊断存在阻塞问题，工作流暂时不能执行。",
        })

    return {
        "task": task,
        "category": category,
        "intent": intent,
        "selected_recipe": selected_recipe,
        "selected_model": selected_model,
        "recipe_candidates": recipe_candidates,
        "model_candidates": model_candidates,
        "hardware": hardware,
        "recommended": {
            "hardware": recommendation,
            "recipe_id": selected_recipe.get("id") if selected_recipe else None,
            "model": selected_model.get("name") if selected_model else None,
        },
        "runtime_ready": runtime_ready,
        "next_steps": next_steps,
        "local_only": True,
    }
