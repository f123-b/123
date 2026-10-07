from __future__ import annotations

import copy
from typing import Any


def _text_image_workflow() -> dict[str, dict[str, Any]]:
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "low quality, blurry, distorted", "clip": ["4", 1]}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 0, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
                "scheduler": "normal", "denoise": 1.0, "model": ["4", 0],
                "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ComfyUI", "images": ["8", 0]}},
    }


def _image_to_image_workflow() -> dict[str, dict[str, Any]]:
    workflow = _text_image_workflow()
    workflow["10"] = {"class_type": "LoadImage", "inputs": {"image": "input.png"}}
    workflow["12"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["4", 2]}}
    workflow["3"]["inputs"]["latent_image"] = ["12", 0]
    workflow["3"]["inputs"]["denoise"] = 0.65
    return workflow


def _upscale_workflow() -> dict[str, dict[str, Any]]:
    return {
        "10": {"class_type": "LoadImage", "inputs": {"image": "input.png"}},
        "11": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "RealESRGAN_x4plus.pth"}},
        "12": {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["11", 0], "image": ["10", 0]},
        },
        "13": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ComfyUI-Upscale", "images": ["12", 0]}},
    }


_TEMPLATES = {
    "text-to-image-basic": {
        "id": "text-to-image-basic", "name": "基础文生图", "category": "图片",
        "description": "Checkpoint + Prompt + KSampler 的通用文生图配方。",
        "tags": ["图片", "文生图", "基础"], "available": True,
        "workflow": _text_image_workflow(),
        "model": {"node_id": "4", "input": "ckpt_name", "value": "model.safetensors"},
        "parameters": {
            "prompt": {"label": "Prompt", "type": "prompt", "node_id": "6", "input": "text", "required": True},
            "negative_prompt": {"label": "Negative Prompt", "type": "prompt", "node_id": "7", "input": "text", "default": "low quality, blurry, distorted"},
            "width": {"label": "宽度", "type": "integer", "node_id": "5", "input": "width", "default": 1024, "role": "width"},
            "height": {"label": "高度", "type": "integer", "node_id": "5", "input": "height", "default": 1024, "role": "height"},
            "seed": {"label": "Seed", "type": "integer", "node_id": "3", "input": "seed", "default": 0},
            "steps": {"label": "Steps", "type": "integer", "node_id": "3", "input": "steps", "default": 20},
            "cfg": {"label": "CFG", "type": "number", "node_id": "3", "input": "cfg", "default": 7.0},
        },
    },
    "image-to-image-basic": {
        "id": "image-to-image-basic", "name": "基础图生图", "category": "图片",
        "description": "上传一张图片并用 Prompt 控制重绘强度。",
        "tags": ["图片", "图生图", "编辑"], "available": True,
        "workflow": _image_to_image_workflow(),
        "model": {"node_id": "4", "input": "ckpt_name", "value": "model.safetensors"},
        "parameters": {
            "image": {"label": "输入图片", "type": "image", "node_id": "10", "input": "image", "default": "input.png", "required": True},
            "prompt": {"label": "Prompt", "type": "prompt", "node_id": "6", "input": "text", "required": True},
            "denoise": {"label": "重绘强度", "type": "number", "node_id": "3", "input": "denoise", "default": 0.65},
            "width": {"label": "宽度", "type": "integer", "node_id": "5", "input": "width", "default": 1024, "role": "width"},
            "height": {"label": "高度", "type": "integer", "node_id": "5", "input": "height", "default": 1024, "role": "height"},
        },
    },
    "portrait-cinematic": {
        "id": "portrait-cinematic", "name": "电影感人物海报", "category": "人物",
        "description": "人物海报 Prompt 模板，模型和参数可在准备时覆盖。",
        "tags": ["人物", "海报", "电影感"], "available": True,
        "workflow": _text_image_workflow(),
        "model": {"node_id": "4", "input": "ckpt_name", "value": "model.safetensors"},
        "parameters": {
            "prompt": {"label": "人物描述", "type": "prompt", "node_id": "6", "input": "text", "default": "cinematic portrait, dramatic lighting, detailed face, movie poster", "required": True},
            "width": {"label": "宽度", "type": "integer", "node_id": "5", "input": "width", "default": 1024, "role": "width"},
            "height": {"label": "高度", "type": "integer", "node_id": "5", "input": "height", "default": 1536, "role": "height"},
            "seed": {"label": "Seed", "type": "integer", "node_id": "3", "input": "seed", "default": 0},
        },
    },
    "upscale-basic": {
        "id": "upscale-basic", "name": "高清放大", "category": "图片",
        "description": "使用本地 Upscale Model 放大输入图片。",
        "tags": ["图片", "高清", "放大"], "available": True,
        "workflow": _upscale_workflow(),
        "model": {"node_id": "11", "input": "model_name", "value": "RealESRGAN_x4plus.pth"},
        "parameters": {
            "image": {"label": "输入图片", "type": "image", "node_id": "10", "input": "image", "default": "input.png", "required": True},
        },
    },
    "wan-video-first-frame": {
        "id": "wan-video-first-frame", "name": "视频首帧生成", "category": "视频",
        "description": "需要已安装 Wan 视频节点和对应模型，安装后可复制为本地 Recipe。",
        "tags": ["视频", "首帧", "Wan"], "available": False,
        "required_nodes": ["WanVideo"], "required_models": ["Wan 视频模型"],
    },
}


def list_templates() -> list[dict[str, Any]]:
    result = []
    for template in _TEMPLATES.values():
        item = copy.deepcopy(template)
        item.pop("workflow", None)
        item.pop("parameters", None)
        item.pop("model", None)
        result.append(item)
    return result


def get_template(template_id: str) -> dict[str, Any]:
    template = _TEMPLATES.get(template_id)
    if template is None:
        raise KeyError("模板不存在")
    return copy.deepcopy(template)
