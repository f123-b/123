from __future__ import annotations

import re
from typing import Any, Mapping


_MODEL_INPUT_FOLDERS = {
    "ckpt_name": "checkpoints",
    "checkpoint_name": "checkpoints",
    "lora_name": "loras",
    "vae_name": "vae",
    "control_net_name": "controlnet",
    "controlnet_name": "controlnet",
    "unet_name": "diffusion_models",
    "clip_name": "text_encoders",
    "clip_name1": "text_encoders",
    "clip_name2": "text_encoders",
    "clip_vision_name": "clip_vision",
    "style_model_name": "style_models",
    "gligen_name": "gligen",
    "model_name": "diffusion_models",
    "upscale_model": "upscale_models",
    "upscale_model_name": "upscale_models",
    "model_patch_name": "model_patches",
    "model_patches": "model_patches",
}

_MODEL_INPUT_PARTS = (
    "checkpoint",
    "ckpt",
    "lora",
    "vae",
    "controlnet",
    "control_net",
    "unet",
    "clip",
    "gligen",
    "upscale",
    "hypernetwork",
    "photomaker",
    "ipadapter",
    "style_model",
    "model_patch",
)
_MISSING_MODULE = re.compile(r"no module named ['\"]([^'\"]+)['\"]", re.IGNORECASE)

_MESSAGES = {
    "required_input_missing": "缺少必填参数",
    "invalid_input_type": "参数类型错误",
    "value_not_in_list": "参数值不可用",
    "return_type_mismatch": "节点连接类型不匹配",
    "bad_linked_input": "节点连接格式错误",
    "dependency_cycle": "工作流存在循环依赖",
    "prompt_no_outputs": "工作流没有可执行输出节点",
    "prompt_outputs_failed_validation": "工作流校验未通过",
}


def _is_prompt_graph(value: Any) -> bool:
    return isinstance(value, dict) and bool(value) and all(
        isinstance(node, dict) and "class_type" in node
        for node in value.values()
    )


def extract_prompt(payload: Any) -> dict[str, dict[str, Any]]:
    """Extract an API prompt graph from an API or UI workflow payload."""
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")

    is_direct_prompt = _is_prompt_graph(payload)
    prompt = payload if is_direct_prompt else payload.get("prompt", payload.get("workflow", payload))
    if not _is_prompt_graph(prompt) and isinstance(prompt, dict) and "prompt" in prompt and isinstance(prompt["prompt"], dict):
        prompt = prompt["prompt"]

    if isinstance(prompt, dict) and "nodes" in prompt:
        return _normalize_ui_workflow(prompt)

    if not isinstance(prompt, dict) or not prompt:
        raise ValueError("请求中缺少有效的 prompt 工作流")

    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            raise ValueError(f"节点 {node_id} 必须是 JSON 对象")

    return prompt


def _normalize_ui_workflow(workflow: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("UI 工作流缺少有效的 nodes 列表")

    node_ids = set()
    for node in nodes:
        if not isinstance(node, dict) or node.get("id") is None:
            continue
        node_ids.add(str(node["id"]))

    links = {}
    for link in workflow.get("links", []) or []:
        if isinstance(link, list) and len(link) >= 5:
            links[str(link[0])] = link

    prompt = {}
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("UI 工作流中的节点必须是 JSON 对象")

        node_id = node.get("id")
        if node_id is None:
            raise ValueError("UI 工作流节点缺少 id")
        node_id = str(node_id)
        if node_id in prompt:
            raise ValueError(f"UI 工作流包含重复节点 id：{node_id}")

        node_inputs = node.get("inputs", [])
        if not isinstance(node_inputs, list):
            raise ValueError(f"节点 {node_id} 的 inputs 必须是列表")
        widget_values = node.get("widgets_values", [])
        if not isinstance(widget_values, list):
            widget_values = [widget_values]

        inputs = {}
        widget_index = 0
        for node_input in node_inputs:
            if not isinstance(node_input, dict):
                continue
            input_name = node_input.get("name")
            if not input_name:
                continue

            link_id = node_input.get("link")
            link = links.get(str(link_id)) if link_id is not None else None
            if link_id is not None:
                if link is None:
                    raise ValueError(f"节点 {node_id} 的连接 {link_id} 不存在")
                if str(link[1]) not in node_ids:
                    raise ValueError(f"节点 {node_id} 的连接 {link_id} 指向不存在的节点")
                inputs[input_name] = [str(link[1]), link[2]]

            if node_input.get("widget") is not None:
                if widget_index < len(widget_values) and link_id is None:
                    inputs[input_name] = widget_values[widget_index]
                widget_index += 1

        prompt_node = {
            "class_type": node.get("class_type") or node.get("type"),
            "inputs": inputs,
        }
        title = node.get("title")
        if title:
            prompt_node["_meta"] = {"title": title}
        properties = node.get("properties")
        if isinstance(properties, Mapping) and properties.get("cnr_id"):
            prompt_node.setdefault("_meta", {})["node_pack"] = properties["cnr_id"]
        prompt[node_id] = prompt_node

    return prompt


def _node_title(node: Mapping[str, Any], class_type: str | None = None) -> str | None:
    metadata = node.get("_meta")
    title = metadata.get("title") if isinstance(metadata, Mapping) else None
    return title or class_type


def capture_repair_state(prompt: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    return {node_id: node.get("class_type") for node_id, node in prompt.items()}


def build_repair_report(
    before: Mapping[str, Any],
    prompt: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    repairs = []
    for node_id, old_class_type in before.items():
        node = prompt.get(node_id)
        if node is None or node.get("class_type") == old_class_type:
            continue
        new_class_type = node.get("class_type")
        repairs.append({
            "node_id": node_id,
            "from": old_class_type,
            "to": new_class_type,
            "title": _node_title(node, new_class_type),
            "message": f"已自动替换节点：{old_class_type} → {new_class_type}",
        })
    return repairs


def find_missing_nodes(
    prompt: Mapping[str, Mapping[str, Any]],
    node_class_mappings: Mapping[str, object],
) -> list[dict[str, Any]]:
    missing = []
    for node_id, node in prompt.items():
        class_type = node.get("class_type")
        if class_type is not None and class_type in node_class_mappings:
            continue

        title = _node_title(node, class_type)
        item = {
            "node_id": node_id,
            "class_type": class_type,
            "title": title,
            "message": f"缺少节点：{title or f'节点 #{node_id}'}",
        }
        metadata = node.get("_meta")
        if isinstance(metadata, Mapping) and metadata.get("node_pack"):
            item["node_pack"] = metadata["node_pack"]
        missing.append(item)
    return missing


def _is_model_input(input_name: str) -> bool:
    name = input_name.lower()
    return name in _MODEL_INPUT_FOLDERS or any(part in name for part in _MODEL_INPUT_PARTS)


def _model_folder(input_name: str) -> str | None:
    name = input_name.lower()
    if name in _MODEL_INPUT_FOLDERS:
        return _MODEL_INPUT_FOLDERS[name]
    if "lora" in name:
        return "loras"
    if "vae" in name:
        return "vae"
    if "control" in name:
        return "controlnet"
    if "clip" in name:
        return "text_encoders"
    if "upscale" in name:
        return "upscale_models"
    if "checkpoint" in name or "ckpt" in name:
        return "checkpoints"
    if "unet" in name or name == "model_name":
        return "diffusion_models"
    return None


def _error_message(error: Mapping[str, Any]) -> str:
    error_type = error.get("type", "workflow_error")
    message = _MESSAGES.get(error_type, error.get("message", "工作流校验失败"))
    details = error.get("details")
    if details:
        return f"{message}：{details}"
    return message


def _runtime_result(
    code: str,
    message: str,
    retryable: bool,
    suggestions: list[str],
    actions: list[tuple[str, str]],
    recovery_plan: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    result = {
        "code": code,
        "message": message,
        "retryable": retryable,
        "suggestions": suggestions,
        "next_steps": [
            {
                "type": "runtime_recovery",
                "action": action,
                "status": "suggested",
                "message": action_message,
            }
            for action, action_message in actions
        ],
    }
    if recovery_plan:
        result["recovery_plan"] = recovery_plan
    return result


def build_runtime_diagnosis(exception_type: str | None, exception_message: str | None) -> dict[str, Any]:
    error_text = f"{exception_type or ''} {exception_message or ''}".lower()
    if "executionblocked" in error_text or "execution blocked" in error_text:
        return _runtime_result(
            "execution_blocked",
            "节点被条件分支阻止执行",
            False,
            ["检查条件节点", "确认当前输入满足执行条件"],
            [("review_blocking_condition", "检查阻止执行的条件节点")],
        )
    if "outofmemory" in error_text or "out of memory" in error_text:
        return _runtime_result(
            "gpu_oom",
            "显存不足，节点执行失败",
            True,
            ["降低分辨率", "减少 Batch Size", "启用 VAE Tiling", "开启 CPU Offload"],
            [
                ("reduce_resolution", "降低分辨率后重试"),
                ("reduce_batch_size", "减少 Batch Size 后重试"),
                ("enable_vae_tiling", "启用 VAE Tiling"),
                ("enable_cpu_offload", "开启 CPU Offload"),
            ],
            [
                {
                    "action": "reduce_resolution",
                    "changes": {"resolution_scale": 0.75},
                    "message": "将宽高缩小到当前的 75% 后重试",
                },
                {
                    "action": "reduce_batch_size",
                    "changes": {"batch_size": 1},
                    "message": "将 Batch Size 调整为 1 后重试",
                },
                {
                    "action": "enable_vae_tiling",
                    "changes": {"vae_tiling": True},
                    "message": "启用 VAE Tiling 后重试",
                },
                {
                    "action": "enable_cpu_offload",
                    "changes": {"cpu_offload": True},
                    "message": "启用 CPU Offload 后重试",
                },
            ],
        )
    if (
        "cuda is not available" in error_text
        or "found no nvidia driver" in error_text
        or "no cuda-capable device" in error_text
        or "cudnn_status_not_initialized" in error_text
    ):
        return _runtime_result(
            "gpu_unavailable",
            "未检测到可用 GPU 或 CUDA 环境未就绪",
            False,
            ["检查显卡驱动和 CUDA", "切换 CPU 或开启 CPU Offload"],
            [("review_hardware", "检查显卡驱动和 CUDA 环境")],
        )
    if "modulenotfounderror" in error_text or "no module named" in error_text:
        result = _runtime_result(
            "python_dependency_missing",
            "Python 节点依赖缺失",
            False,
            ["检查节点依赖", "安装该节点声明的 Python 依赖"],
            [("inspect_node_requirements", "查看节点声明的依赖")],
        )
        match = _MISSING_MODULE.search(exception_message or "")
        if match:
            result["dependency"] = match.group(1)
        return result
    if "filenotfounderror" in error_text or "no such file" in error_text:
        return _runtime_result(
            "file_missing",
            "模型或输入文件不存在",
            False,
            ["检查模型目录", "重新选择模型或输入文件"],
            [
                ("search_local_models", "搜索本地模型文件"),
                ("select_input_file", "重新选择输入文件"),
            ],
        )
    if "permissionerror" in error_text or "permission denied" in error_text:
        return _runtime_result(
            "permission_denied",
            "文件或目录没有访问权限",
            False,
            ["检查目录权限", "选择 ComfyUI 有权限访问的路径"],
            [("select_accessible_path", "选择 ComfyUI 有权限访问的路径")],
        )
    if (
        "same device" in error_text
        or "found at least two devices" in error_text
        or "expected all tensors to be on the same device" in error_text
    ):
        return _runtime_result(
            "device_mismatch",
            "模型和节点所在设备不一致",
            True,
            ["检查模型与节点的设备设置", "尝试启用 CPU Offload 或统一计算设备"],
            [("review_device_placement", "检查模型与节点的设备设置")],
        )
    if "mat1 and mat2 shapes" in error_text or "shape mismatch" in error_text:
        return _runtime_result(
            "model_shape_mismatch",
            "模型结构或连接类型不匹配",
            False,
            ["检查模型与 CLIP 类型", "确认节点连接和模型版本匹配"],
            [("review_model_compatibility", "检查模型与 CLIP 类型")],
        )
    return _runtime_result(
        "execution_failed",
        "节点执行失败",
        False,
        ["检查当前节点参数和输入"],
        [("review_node_inputs", "检查当前节点参数和输入")],
    )


def attach_runtime_diagnosis(data: dict[str, Any]) -> dict[str, Any]:
    """Attach one stable runtime diagnosis to an execution error event."""
    if "diagnosis" not in data:
        data["diagnosis"] = build_runtime_diagnosis(
            data.get("exception_type"), data.get("exception_message")
        )
    return data


def build_next_steps(
    missing_nodes: list[dict[str, Any]],
    missing_models: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    steps = []
    for node in missing_nodes:
        step = {
            "type": "node_dependency",
            "action": "install_or_enable",
            "status": "required",
            "node_id": node["node_id"],
            "message": node["message"],
        }
        if node.get("node_pack"):
            step["node_pack"] = node["node_pack"]
        steps.append(step)

    for model in missing_models:
        steps.append({
            "type": "model_dependency",
            "action": "select_or_install",
            "status": "required",
            "node_id": model["node_id"],
            "input_name": model["input_name"],
            "model_name": model["model_name"],
            "model_folder": model.get("model_folder"),
            "message": model["message"],
        })

    for error in errors:
        step = {
            "type": "workflow_validation",
            "action": "review_input",
            "status": "required",
            "message": error["message"],
        }
        for key in ("node_id", "input_name", "code"):
            if key in error:
                step[key] = error[key]
        steps.append(step)
    return steps


def add_local_dependency_state(
    diagnosis: dict[str, Any],
    node_catalog: list[Mapping[str, Any]],
    model_candidates: Mapping[tuple[str | None, str], list[Mapping[str, Any]]],
    node_requirements: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    node_requirements = node_requirements or {}
    node_entries = {
        str(item["name"]).casefold(): item
        for item in node_catalog
        if item.get("name")
    }
    for node in diagnosis["missing_nodes"]:
        names = [node.get("node_pack"), node.get("class_type")]
        entry = next(
            (
                node_entries[name.casefold()]
                for name in names
                if isinstance(name, str) and name.casefold() in node_entries
            ),
            None,
        )
        requirement_entry = next(
            (
                node_requirements[name.casefold()]
                for name in names
                if isinstance(name, str) and name.casefold() in node_requirements
            ),
            None,
        )
        state = entry.get("status", "missing") if entry is not None else "missing"
        node["local_status"] = state
        for key in ("error_type", "error", "missing_dependency", "requirements_available"):
            if entry is not None and entry.get(key):
                node[f"local_{key}"] = entry[key]
        if requirement_entry is not None:
            node["local_requirements"] = {
                key: requirement_entry[key]
                for key in ("packages", "package_status", "missing_packages")
                if key in requirement_entry
            }
            if requirement_entry.get("missing_packages"):
                node["local_missing_packages"] = list(
                    requirement_entry["missing_packages"]
                )
        for step in diagnosis["next_steps"]:
            if step.get("type") != "node_dependency" or step.get("node_id") != node.get("node_id"):
                continue
            if state == "disabled":
                step["action"] = "enable_custom_node"
                step["message"] = "启用本地节点包后重启 ComfyUI"
            elif state in {"installed", "loaded", "failed"}:
                if state == "failed" and node.get("local_requirements_available"):
                    step["action"] = "inspect_node_requirements"
                    step["message"] = "查看节点 requirements.txt，确认缺失的 Python 依赖"
                    if node.get("local_missing_packages"):
                        step["missing_packages"] = list(node["local_missing_packages"])
                else:
                    step["action"] = "inspect_node_load"
                    step["message"] = node.get(
                        "local_error", "节点包已存在，检查加载失败或版本兼容性"
                    )
            break

    for model in diagnosis["missing_models"]:
        model_name = model.get("model_name")
        key = (model.get("model_folder"), model_name)
        model["local_candidates"] = list(model_candidates.get(key, []))
    return diagnosis


def add_environment_state(
    diagnosis: dict[str, Any],
    environment: Mapping[str, Any],
) -> dict[str, Any]:
    """Attach local runtime state while keeping workflow validation separate."""
    diagnosis["environment"] = dict(environment)
    diagnosis["execution_ready"] = diagnosis["can_run"] and environment.get(
        "runtime_ready", True
    )
    if not environment.get("runtime_ready", True):
        diagnosis["status"] = "needs_attention"
        diagnosis["summary"]["environment_issues"] = max(
            len(environment.get("blocking_issues", [])), 1
        )
    for step in environment.get("next_steps", []):
        diagnosis["next_steps"].append({
            "type": "environment",
            **step,
        })
    return diagnosis


def build_repair_plan(
    diagnosis: Mapping[str, Any],
    replacement_candidates: Mapping[str, list[Mapping[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    """Turn a diagnosis into explicit, user-confirmable repair actions."""
    replacement_candidates = replacement_candidates or {}
    plan = []

    for repair in diagnosis.get("repairs", []):
        plan.append({
            "id": f"node-replacement:{repair.get('node_id')}",
            "type": "node_replacement",
            "action": "node_replacement",
            "status": "applied",
            "requires_confirmation": False,
            "message": repair.get("message", "节点替换已应用"),
            "node_id": repair.get("node_id"),
        })

    for node in diagnosis.get("missing_nodes", []):
        node_id = node.get("node_id")
        node_name = node.get("node_pack") or node.get("class_type")
        local_status = node.get("local_status", "missing")
        if local_status == "disabled":
            plan.append({
                "id": f"enable-node:{node_name}",
                "type": "node_dependency",
                "action": "enable_custom_node",
                "status": "available",
                "requires_confirmation": True,
                "message": "启用本地节点包后重启 ComfyUI",
                "node_id": node_id,
                "node_name": node_name,
                "requires_restart": True,
            })
            continue

        candidates = replacement_candidates.get(str(node.get("class_type")), [])
        if candidates:
            plan.append({
                "id": f"replace-node:{node_id}",
                "type": "node_dependency",
                "action": "replace_node",
                "status": "available",
                "requires_confirmation": True,
                "message": "存在可用的节点替换方案",
                "node_id": node_id,
                "candidates": list(candidates),
            })
        elif local_status == "failed" and node.get("local_requirements_available"):
            step = {
                "id": f"inspect-requirements:{node_name}",
                "type": "node_dependency",
                "action": "inspect_node_requirements",
                "status": "available",
                "requires_confirmation": False,
                "message": "查看节点 requirements.txt，确认缺失的 Python 依赖",
                "node_id": node_id,
                "node_name": node_name,
            }
            if node.get("local_missing_packages"):
                step["missing_packages"] = list(node["local_missing_packages"])
                step["message"] = (
                    "节点缺少 Python 依赖："
                    + ", ".join(node["local_missing_packages"])
                )
            if isinstance(node_name, str) and re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", node_name
            ):
                step["requirements_url"] = f"/custom_nodes/{node_name}/requirements"
            plan.append(step)
        elif local_status in {"installed", "loaded", "failed"}:
            plan.append({
                "id": f"inspect-node:{node_name}",
                "type": "node_dependency",
                "action": "inspect_node_load",
                "status": "blocked",
                "requires_confirmation": False,
                "message": node.get("local_error", "节点包已存在，但未成功提供该节点"),
                "node_id": node_id,
                "node_name": node_name,
            })
        else:
            plan.append({
                "id": f"install-node:{node_name}",
                "type": "node_dependency",
                "action": "install_custom_node",
                "status": "unavailable",
                "requires_confirmation": True,
                "message": "需要安装缺少的 Custom Node",
                "node_id": node_id,
                "node_name": node_name,
            })

    for model in diagnosis.get("missing_models", []):
        model_name = model.get("model_name")
        model_id = f"model:{model.get('node_id')}:{model.get('input_name')}"
        candidates = list(model.get("local_candidates", []))
        if candidates:
            plan.append({
                "id": model_id,
                "type": "model_dependency",
                "action": "select_local_model",
                "status": "available",
                "requires_confirmation": True,
                "message": "找到相似的本地模型，请确认替换",
                "node_id": model.get("node_id"),
                "input_name": model.get("input_name"),
                "model_name": model_name,
                "candidates": candidates,
            })
        else:
            plan.append({
                "id": model_id,
                "type": "model_dependency",
                "action": "install_model",
                "status": "unavailable",
                "requires_confirmation": True,
                "message": "本地未找到模型，需要用户选择来源并确认安装",
                "node_id": model.get("node_id"),
                "input_name": model.get("input_name"),
                "model_name": model_name,
                "model_folder": model.get("model_folder"),
            })

    for error in diagnosis.get("errors", []):
        plan.append({
            "id": f"workflow-error:{error.get('node_id')}:{error.get('code')}",
            "type": "workflow_validation",
            "action": "review_input",
            "status": "blocked",
            "requires_confirmation": False,
            "message": error.get("message", "请检查工作流参数"),
            "node_id": error.get("node_id"),
            "input_name": error.get("input_name"),
        })

    environment = diagnosis.get("environment") or {}
    for step in environment.get("next_steps", []):
        plan.append({
            "id": "environment:install-requirements",
            "type": "environment",
            "action": step.get("action", "install_requirements"),
            "status": "blocked" if not environment.get("runtime_ready", True) else "available",
            "requires_confirmation": True,
            "message": step.get("label") or step.get("detail", "检查本机运行环境"),
        })
    return plan


def build_diagnosis(
    prompt: Mapping[str, Mapping[str, Any]],
    validation: tuple[bool, Mapping[str, Any] | None, list[str], Mapping[str, Any]],
    node_class_mappings: Mapping[str, object],
    repairs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Convert execution validation output into a stable product-facing report."""
    valid, global_error, _, node_errors = validation
    repairs = repairs or []
    missing_nodes = find_missing_nodes(prompt, node_class_mappings)
    missing_node_ids = {item["node_id"] for item in missing_nodes}
    missing_models = []
    errors = []
    seen_errors = set()

    for node_id, node_error in node_errors.items():
        node = prompt.get(node_id, {})
        class_type = node_error.get("class_type", node.get("class_type"))
        title = _node_title(node, class_type)
        for error in node_error.get("errors", []):
            error_type = error.get("type")
            extra_info = error.get("extra_info", {})
            input_name = extra_info.get("input_name")
            received_value = extra_info.get("received_value")
            if error_type == "value_not_in_list" and input_name and _is_model_input(input_name):
                item = {
                    "node_id": node_id,
                    "class_type": class_type,
                    "title": title,
                    "input_name": input_name,
                    "model_name": received_value,
                    "model_folder": _model_folder(input_name),
                    "message": f"缺少模型：{received_value}",
                }
                key = (node_id, input_name, str(received_value))
                if key not in seen_errors:
                    missing_models.append(item)
                    seen_errors.add(key)
                continue

            item = {
                "node_id": node_id,
                "class_type": class_type,
                "title": title,
                "code": error_type,
                "message": _error_message(error),
            }
            errors.append(item)

    if global_error and global_error.get("type") not in {"missing_node_type", "prompt_outputs_failed_validation"}:
        error_type = global_error.get("type")
        item = {
            "code": error_type,
            "message": _error_message(global_error),
        }
        if item not in errors:
            errors.append(item)

    errors = [error for error in errors if error.get("node_id") not in missing_node_ids]
    can_run = valid and not missing_nodes and not missing_models and not errors
    next_steps = build_next_steps(missing_nodes, missing_models, errors)
    return {
        "status": "ready" if can_run else "needs_attention",
        "can_run": can_run,
        "summary": {
            "missing_nodes": len(missing_nodes),
            "missing_models": len(missing_models),
            "errors": len(errors),
            "repairs": len(repairs),
        },
        "missing_nodes": missing_nodes,
        "missing_models": missing_models,
        "errors": errors,
        "repairs": repairs,
        "next_steps": next_steps,
    }
