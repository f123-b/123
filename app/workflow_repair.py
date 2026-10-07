from typing import Any


def apply_local_repair_actions(
    prompt: dict[str, dict[str, Any]],
    actions: list[Any],
    node_replace_manager,
    custom_node_manager,
    model_file_manager,
) -> dict[str, Any]:
    """Apply only explicitly confirmed repairs that are local and verifiable."""
    action_results = []
    replacement_requested = False

    def action_order(action):
        action_name = action.get("action") if isinstance(action, dict) else None
        if action_name in {"node_replacement", "replace_node"}:
            return 0
        if action_name == "select_local_model":
            return 1
        if action_name == "enable_custom_node":
            return 3
        return 2

    ordered_actions = sorted(actions, key=action_order)

    def finalize_replacements():
        nonlocal replacement_requested
        if not replacement_requested:
            return
        for result in action_results:
            if result["status"] != "pending":
                continue
            node = prompt.get(result.get("node_id"), {})
            if node.get("class_type") == result.get("class_type"):
                result["status"] = "failed"
                result["message"] = "注册的替换节点无效，未应用替换"
            else:
                result["status"] = "applied"
        replacement_requested = False

    for action in ordered_actions:
        if not isinstance(action, dict):
            action_results.append({
                "action": "unknown",
                "status": "failed",
                "message": "修复动作必须是 JSON 对象",
            })
            continue

        action_name = action.get("action")
        if action_name in {"node_replacement", "replace_node"}:
            node_id = action.get("node_id")
            if not isinstance(node_id, str):
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "message": "节点替换缺少有效 node_id",
                })
                continue
            node = prompt.get(node_id)
            if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "node_id": node_id,
                    "message": "工作流中不存在可替换的目标节点",
                })
                continue
            class_type = action.get("class_type")
            if class_type is not None and class_type != node["class_type"]:
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "node_id": node_id,
                    "message": "修复动作中的节点类型与工作流不匹配",
                })
                continue
            class_type = node["class_type"]
            if not isinstance(class_type, str) or not node_replace_manager.has_replacement(class_type):
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "node_id": node_id,
                    "message": "没有可用的已注册节点替换方案",
                })
                continue
            node_replace_manager.apply_replacements(prompt, {node_id})
            replacement_requested = True
            action_results.append({
                "action": action_name,
                "status": "pending",
                "node_id": node_id,
                "class_type": class_type,
                "message": "已确认应用已注册节点替换",
            })
            continue

        if action_name == "enable_custom_node":
            node_name = action.get("node_name")
            if not isinstance(node_name, str):
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "message": "启用节点缺少有效 node_name",
                })
                continue
            finalize_replacements()
            if any(
                result["status"] in {"failed", "unavailable"}
                for result in action_results
            ):
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "node_name": node_name,
                    "message": "前置修复未完成，未启用节点包",
                })
                continue
            try:
                result = custom_node_manager.enable_node(node_name)
            except (FileNotFoundError, FileExistsError, ValueError, OSError) as ex:
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "node_name": node_name,
                    "message": str(ex),
                })
            else:
                action_results.append({
                    **result,
                    "action": action_name,
                    "status": "applied",
                    "message": "节点包已启用，重启 ComfyUI 后生效",
                })
            continue

        if action_name == "select_local_model":
            node_id = action.get("node_id")
            input_name = action.get("input_name")
            model_name = action.get("model_name")
            model_folder = action.get("model_folder")
            selected_model = action.get("selected_model")
            selected_model_name = action.get("selected_model_name")
            if isinstance(selected_model, dict):
                selected_model_name = selected_model.get("name", selected_model_name)
                model_folder = selected_model.get("folder", model_folder)
            node = prompt.get(node_id) if isinstance(node_id, str) else None
            if (
                not isinstance(node, dict)
                or not isinstance(input_name, str)
                or not isinstance(model_name, str)
                or not isinstance(model_folder, str)
                or not isinstance(node.get("inputs"), dict)
            ):
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "message": "本地模型选择参数不完整",
                })
                continue
            if selected_model_name is not None and not isinstance(selected_model_name, str):
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "message": "selected_model_name 必须是字符串",
                })
                continue
            search_name = selected_model_name or model_name
            try:
                matches = model_file_manager.search_models(search_name, model_folder)
            except ValueError as ex:
                matches = []
                error_message = str(ex)
            else:
                error_message = (
                    "本地不存在完全匹配的候选模型"
                    if selected_model_name
                    else "本地不存在完全匹配的模型文件，请先选择候选模型"
                )
            candidate = next(
                (item for item in matches if item.get("match") == "exact"),
                None,
            )
            if candidate is None:
                action_results.append({
                    "action": action_name,
                    "status": "failed",
                    "node_id": node_id,
                    "input_name": input_name,
                    "message": error_message,
                })
                continue
            node["inputs"][input_name] = candidate["name"]
            action_results.append({
                "action": action_name,
                "status": "applied",
                "node_id": node_id,
                "input_name": input_name,
                "model_name": candidate["name"],
                "message": "已选择本地模型",
            })
            continue

        action_results.append({
            "action": action_name or "unknown",
            "status": "unavailable",
            "message": "该动作需要安装、下载或人工处理，当前接口不会自动执行",
        })

    finalize_replacements()

    return {
        "actions": action_results,
        "requires_restart": any(
            result.get("requires_restart") for result in action_results
        ),
    }
