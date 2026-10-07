from __future__ import annotations

import json
import copy
import logging
import os
import re
import tempfile
import time
import uuid
from typing import Any

from aiohttp import web

import folder_paths
from app.workflow_diagnostics import extract_prompt
from app.recipe_templates import get_template, list_templates


_RECIPE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_PROMPT_TEMPLATE_FIELD = re.compile(r"\{([A-Za-z0-9][A-Za-z0-9_-]*)\}")
_RECIPE_FIELDS = (
    "name",
    "description",
    "category",
    "prompt_template",
    "parameters",
    "inputs",
    "outputs",
    "model",
    "loras",
    "tags",
    "metadata",
)
_RECIPE_RECOMMEND_TERM = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]+")


class RecipeManager:
    """Stores local, reusable workflow recipes per ComfyUI user."""

    def __init__(self, user_manager, asset_resolver=None):
        self.user_manager = user_manager
        self.asset_resolver = asset_resolver

    @staticmethod
    def _validate_recipe_id(recipe_id: str) -> str:
        if not isinstance(recipe_id, str) or not _RECIPE_ID.fullmatch(recipe_id):
            raise ValueError("recipe_id 只能包含字母、数字、下划线和短横线，长度为 1-64")
        return recipe_id

    def _recipe_path(self, request, recipe_id: str, create_dir: bool = False) -> str | None:
        recipe_id = self._validate_recipe_id(recipe_id)
        path = self.user_manager.get_request_user_filepath(
            request, f"recipes/{recipe_id}.json", create_dir=create_dir
        )
        user_root = self.user_manager.get_request_user_filepath(
            request, None, create_dir=create_dir
        )
        if path is None or user_root is None:
            return None
        if not folder_paths.is_within_directory(user_root, path):
            return None
        return path

    @staticmethod
    def _read_recipe(path: str) -> dict[str, Any]:
        with open(path, "r", encoding="utf-8") as file:
            recipe = json.load(file)
        if not isinstance(recipe, dict):
            raise ValueError("配方文件必须是 JSON 对象")
        return recipe

    @staticmethod
    def _text_field(body: dict[str, Any], name: str, default: str, max_length: int) -> str:
        value = body.get(name, default)
        if not isinstance(value, str):
            raise ValueError(f"{name} 必须是字符串")
        value = value.strip()
        if len(value) > max_length:
            raise ValueError(f"{name} 长度不能超过 {max_length}")
        return value

    @staticmethod
    def _json_field(body: dict[str, Any], name: str, default: Any, expected_type):
        value = body.get(name, default)
        if not isinstance(value, expected_type):
            raise ValueError(f"{name} 类型不正确")
        return value

    def _build_recipe(
        self,
        recipe_id: str,
        body: dict[str, Any],
        created_at: int | None = None,
    ) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("配方请求体必须是 JSON 对象")

        workflow = body.get("workflow", body.get("prompt"))
        if workflow is None:
            raise ValueError("配方必须包含 workflow 或 prompt")
        normalized_prompt = extract_prompt({"workflow": workflow})

        now = int(time.time() * 1000)
        recipe = {
            "id": self._validate_recipe_id(recipe_id),
            "name": self._text_field(body, "name", recipe_id, 128),
            "description": self._text_field(body, "description", "", 2000),
            "category": self._text_field(body, "category", "未分类", 64),
            "prompt_template": self._text_field(body, "prompt_template", "", 10000),
            "parameters": self._json_field(body, "parameters", {}, dict),
            "inputs": self._json_field(body, "inputs", [], list),
            "outputs": self._json_field(body, "outputs", {}, (dict, list)),
            "model": self._json_field(body, "model", {}, (dict, str)),
            "loras": self._json_field(body, "loras", [], list),
            "tags": self._json_field(body, "tags", [], list),
            "metadata": self._json_field(body, "metadata", {}, dict),
            "workflow": normalized_prompt,
            "created_at": created_at or now,
            "updated_at": now,
        }
        return recipe

    @staticmethod
    def _summary(recipe: dict[str, Any]) -> dict[str, Any]:
        summary = dict(recipe)
        summary.pop("workflow", None)
        return summary

    def _list_summaries(self, request) -> list[dict[str, Any]]:
        recipe_dir = self.user_manager.get_request_user_filepath(
            request, "recipes", create_dir=False
        )
        if recipe_dir is None or not os.path.isdir(recipe_dir):
            return []

        summaries = []
        for filename in sorted(os.listdir(recipe_dir)):
            if not filename.endswith(".json"):
                continue
            recipe_id = filename[:-5]
            try:
                path = self._recipe_path(request, recipe_id, create_dir=False)
                if path is None or not os.path.isfile(path):
                    continue
                summaries.append(self._summary(self._read_recipe(path)))
            except (OSError, ValueError) as ex:
                logging.warning("Skipping invalid recipe %s: %s", filename, ex)
        return summaries

    def list_summaries(self, request) -> list[dict[str, Any]]:
        return self._list_summaries(request)

    @classmethod
    def recommend_summaries(
        cls,
        summaries: list[dict[str, Any]],
        task: str,
        category: str | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        query = task.casefold()
        terms = []
        for term in _RECIPE_RECOMMEND_TERM.findall(task):
            term = term.casefold()
            terms.append(term)
            if len(term) > 1 and all("\u4e00" <= char <= "\u9fff" for char in term):
                terms.extend(term[index:index + 2] for index in range(len(term) - 1))
        category_query = category.casefold() if category else None
        ranked = []
        for recipe in summaries:
            recipe_category = str(recipe.get("category", ""))
            if category_query and recipe_category.casefold() != category_query:
                continue

            name = str(recipe.get("name", recipe.get("id", "")))
            description = str(recipe.get("description", ""))
            tags = recipe.get("tags", [])
            if not isinstance(tags, list):
                tags = []
            tag_text = " ".join(str(tag) for tag in tags)
            searchable = " ".join((name, description, recipe_category, tag_text)).casefold()

            score = 0
            reasons = []
            if query and query in name.casefold():
                score += 12
                reasons.append("名称匹配")
            if query and query in searchable and query not in name.casefold():
                score += 6
                reasons.append("描述或标签匹配")
            name_term_matched = False
            for term in terms:
                if term in name.casefold():
                    score += 4
                    name_term_matched = True
                elif term in searchable:
                    score += 2
            if name_term_matched and "名称匹配" not in reasons:
                reasons.append("名称匹配")
            if category_query:
                score += 3
                reasons.append("分类匹配")
            ranked.append({
                **recipe,
                "score": score,
                "reasons": reasons or ["本地配方候选"],
            })

        ranked.sort(key=lambda item: (
            -item["score"],
            -int(item.get("updated_at", 0) or 0),
            str(item.get("name", item.get("id", ""))).casefold(),
        ))
        return ranked[:limit]

    @staticmethod
    def _render_prompt_template(
        template: str,
        parameters: dict[str, Any],
        values: dict[str, Any],
    ) -> str:
        def replace(match):
            name = match.group(1)
            if name in values:
                return str(values[name])
            specification = parameters.get(name)
            if isinstance(specification, dict) and "default" in specification:
                return str(specification["default"])
            raise ValueError(f"Prompt 模板缺少参数：{name}")

        return _PROMPT_TEMPLATE_FIELD.sub(replace, template)

    @staticmethod
    def _binding_from_metadata(specification: Any, label: str):
        if not isinstance(specification, dict):
            return None
        if "node_id" not in specification and "input" not in specification and "input_name" not in specification:
            return None

        node_id = specification.get("node_id")
        input_name = specification.get("input", specification.get("input_name"))
        if node_id is None or not isinstance(input_name, str) or not input_name:
            raise ValueError(f"{label} 绑定缺少 node_id 或 input")
        if "value" in specification:
            value = specification["value"]
        elif "name" in specification:
            value = specification["name"]
        else:
            raise ValueError(f"{label} 绑定缺少 value 或 name")
        return str(node_id), input_name, value

    def _apply_recipe_bindings(self, recipe: dict[str, Any], prompt: dict[str, Any]) -> None:
        bindings = []
        model_binding = self._binding_from_metadata(recipe.get("model"), "model")
        if model_binding is not None:
            bindings.append(("model", model_binding))

        loras = recipe.get("loras", [])
        if not isinstance(loras, list):
            raise ValueError("配方 loras 必须是列表")
        for index, lora in enumerate(loras):
            binding = self._binding_from_metadata(lora, f"loras[{index}]")
            if binding is not None:
                bindings.append((f"loras[{index}]", binding))

        for label, (node_id, input_name, value) in bindings:
            if node_id not in prompt:
                raise ValueError(f"{label} 绑定指向不存在的节点 {node_id}")
            inputs = prompt[node_id].get("inputs")
            if not isinstance(inputs, dict):
                raise ValueError(f"节点 {node_id} 缺少 inputs")
            inputs[input_name] = value

    @staticmethod
    def _validate_parameter_type(parameter_name: str, value: Any, specification: dict[str, Any]):
        parameter_type = specification.get("type")
        if parameter_type is None:
            return
        if parameter_type in {"string", "image", "video", "file", "prompt", "select"}:
            valid = isinstance(value, str)
        elif parameter_type == "integer":
            valid = isinstance(value, int) and not isinstance(value, bool)
        elif parameter_type == "number":
            valid = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif parameter_type == "boolean":
            valid = isinstance(value, bool)
        elif parameter_type in {"array", "multiselect"}:
            valid = isinstance(value, list)
        elif parameter_type == "object":
            valid = isinstance(value, dict)
        else:
            raise ValueError(f"参数 {parameter_name} 的 type 不支持：{parameter_type}")
        if not valid:
            raise ValueError(f"参数 {parameter_name} 类型错误，应为 {parameter_type}")

    def prepare_prompt(
        self,
        request,
        recipe_id: str,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        recipe_id = self._validate_recipe_id(recipe_id)
        path = self._recipe_path(request, recipe_id)
        if path is None:
            raise PermissionError("无权读取该配方")
        if not os.path.isfile(path):
            raise FileNotFoundError("配方不存在")
        recipe = self._read_recipe(path)
        prompt, applied, unknown = self._prepare_prompt(recipe, values)
        return {
            "recipe_id": recipe_id,
            "prompt": prompt,
            "applied_parameters": applied,
            "unknown_parameters": unknown,
        }

    def prepare_for_queue(
        self,
        request,
        recipe_id: str,
        values: dict[str, Any],
        recovery: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if recovery is None:
            return self.prepare_prompt(request, recipe_id, values)
        if not isinstance(recovery, dict):
            raise ValueError("recovery 必须是 JSON 对象")
        return self.prepare_recovery(request, recipe_id, values, recovery)

    @classmethod
    def build_execution_metadata(
        cls,
        recipe_id: str,
        values: dict[str, Any],
        batch_index: int | None = None,
        recovery: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        metadata = {
            "recipe_id": cls._validate_recipe_id(recipe_id),
            "recipe_values": copy.deepcopy(values),
        }
        if batch_index is not None:
            metadata["batch_index"] = batch_index
        if recovery is not None:
            metadata["recipe_recovery"] = copy.deepcopy(recovery)
        return metadata

    @classmethod
    def filter_execution_history(
        cls,
        history: dict[str, Any],
        recipe_id: str,
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[dict[str, Any], int]:
        recipe_id = cls._validate_recipe_id(recipe_id)
        if offset < 0:
            raise ValueError("offset 必须是非负整数")
        if limit < 1:
            raise ValueError("limit 必须是正整数")

        matching = []
        for prompt_id, entry in history.items():
            if not isinstance(entry, dict):
                continue
            prompt = entry.get("prompt")
            if not isinstance(prompt, (list, tuple)) or len(prompt) < 4:
                continue
            extra_data = prompt[3]
            if isinstance(extra_data, dict) and extra_data.get("recipe_id") == recipe_id:
                matching.append((prompt_id, entry))

        selected = matching[offset:offset + limit]
        return dict(selected), len(matching)

    def prepare_batch(
        self,
        request,
        recipe_id: str,
        values_list: list[Any],
        recovery: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        recipe_id = self._validate_recipe_id(recipe_id)
        path = self._recipe_path(request, recipe_id)
        if path is None:
            raise PermissionError("无权读取该配方")
        if not os.path.isfile(path):
            raise FileNotFoundError("配方不存在")
        if not values_list:
            raise ValueError("values 不能为空")
        if recovery is not None and not isinstance(recovery, dict):
            raise ValueError("recovery 必须是 JSON 对象")
        recipe = self._read_recipe(path)

        items = []
        for index, values in enumerate(values_list):
            if not isinstance(values, dict):
                items.append({
                    "index": index,
                    "error": "values 必须是 JSON 对象",
                })
                continue
            try:
                applied_changes = []
                ignored_changes = []
                prepared_values = values
                if recovery is not None:
                    prepared_values, applied_changes, ignored_changes = self._apply_recovery_values(
                        recipe, values, recovery
                    )
                prompt, applied, unknown = self._prepare_prompt(recipe, prepared_values)
            except ValueError as ex:
                items.append({"index": index, "error": str(ex)})
                continue
            item = {
                "index": index,
                "prompt": prompt,
                "applied_parameters": applied,
                "unknown_parameters": unknown,
            }
            if recovery is not None:
                item["applied_changes"] = applied_changes
                item["ignored_changes"] = ignored_changes
            items.append(item)

        return {
            "recipe_id": recipe_id,
            "count": len(items),
            "valid_count": sum("prompt" in item for item in items),
            "items": items,
        }

    def get_input_schema(self, request, recipe_id: str) -> dict[str, Any]:
        recipe_id = self._validate_recipe_id(recipe_id)
        path = self._recipe_path(request, recipe_id)
        if path is None:
            raise PermissionError("无权读取该配方")
        if not os.path.isfile(path):
            raise FileNotFoundError("配方不存在")
        recipe = self._read_recipe(path)
        parameters = recipe.get("parameters", {})
        if not isinstance(parameters, dict):
            raise ValueError("配方 parameters 必须是对象")

        inputs = []
        for name, specification in parameters.items():
            if not isinstance(specification, dict):
                continue
            item = {
                "name": name,
                "label": specification.get("label", name),
                "description": specification.get("description", ""),
                "type": specification.get("type", "string"),
                "required": bool(specification.get("required", False)),
            }
            if "role" in specification:
                item["role"] = specification["role"]
            for key in ("default", "choices"):
                if key in specification:
                    item[key] = specification[key]
            inputs.append(item)

        return {
            "recipe_id": recipe_id,
            "inputs": inputs,
            "prompt_template": recipe.get("prompt_template", ""),
        }

    @classmethod
    def _apply_recovery_values(
        cls,
        recipe: dict[str, Any],
        values: dict[str, Any],
        recovery: dict[str, Any],
    ) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
        changes = recovery.get("changes")
        if not isinstance(changes, dict):
            raise ValueError("recovery changes 必须是对象")
        parameters = recipe.get("parameters", {})
        if not isinstance(parameters, dict):
            raise ValueError("配方 parameters 必须是对象")

        adjusted = dict(values)
        applied_changes = []
        ignored_changes = []

        def matching_parameters(role: str):
            return [
                (name, specification)
                for name, specification in parameters.items()
                if isinstance(specification, dict)
                and str(specification.get("role", name)).casefold() == role
            ]

        scale = changes.get("resolution_scale")
        if isinstance(scale, (int, float)) and not isinstance(scale, bool):
            for role in ("width", "height"):
                matches = matching_parameters(role)
                if not matches:
                    ignored_changes.append(role)
                    continue
                for name, specification in matches:
                    current = adjusted.get(name, specification.get("default"))
                    if not isinstance(current, (int, float)) or isinstance(current, bool):
                        ignored_changes.append(name)
                        continue
                    adjusted[name] = max(1, int(round(current * scale)))
                    applied_changes.append({
                        "change": "resolution_scale",
                        "parameter": name,
                        "value": adjusted[name],
                    })
        elif "resolution_scale" in changes:
            raise ValueError("resolution_scale 必须是数字")

        for change_name in ("batch_size", "vae_tiling", "cpu_offload"):
            if change_name not in changes:
                continue
            matches = matching_parameters(change_name)
            if not matches:
                ignored_changes.append(change_name)
                continue
            for name, _ in matches:
                adjusted[name] = changes[change_name]
                applied_changes.append({
                    "change": change_name,
                    "parameter": name,
                    "value": changes[change_name],
                })

        return adjusted, applied_changes, ignored_changes

    def prepare_recovery(
        self,
        request,
        recipe_id: str,
        values: dict[str, Any],
        recovery: dict[str, Any],
    ) -> dict[str, Any]:
        recipe_id = self._validate_recipe_id(recipe_id)
        path = self._recipe_path(request, recipe_id)
        if path is None:
            raise PermissionError("无权读取该配方")
        if not os.path.isfile(path):
            raise FileNotFoundError("配方不存在")
        recipe = self._read_recipe(path)
        adjusted, applied_changes, ignored_changes = self._apply_recovery_values(
            recipe, values, recovery
        )
        prompt, applied, unknown = self._prepare_prompt(recipe, adjusted)
        return {
            "recipe_id": recipe_id,
            "values": adjusted,
            "applied_changes": applied_changes,
            "ignored_changes": ignored_changes,
            "prompt": prompt,
            "applied_parameters": applied,
            "unknown_parameters": unknown,
        }

    def fork_recipe(
        self,
        request,
        recipe_id: str,
        new_recipe_id: str,
        overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        source_path = self._recipe_path(request, recipe_id)
        if source_path is None or not os.path.isfile(source_path):
            raise FileNotFoundError("源配方不存在")
        new_recipe_id = self._validate_recipe_id(new_recipe_id)
        target_path = self._recipe_path(request, new_recipe_id, create_dir=True)
        if target_path is None:
            raise PermissionError("无权保存该配方")
        if os.path.exists(target_path):
            raise FileExistsError("目标配方已存在")
        source = self._read_recipe(source_path)
        body = copy.deepcopy(source)
        body.update(overrides or {})
        body["workflow"] = source["workflow"]
        body.pop("id", None)
        recipe = self._build_recipe(new_recipe_id, body)
        self._write_recipe(request, recipe)
        return recipe

    def _prepare_prompt(self, recipe: dict[str, Any], values: dict[str, Any]):
        workflow = recipe.get("workflow")
        if not isinstance(workflow, dict):
            raise ValueError("配方缺少有效的 workflow")
        prompt = copy.deepcopy(workflow)
        self._apply_recipe_bindings(recipe, prompt)
        parameters = recipe.get("parameters", {})
        if not isinstance(parameters, dict):
            raise ValueError("配方 parameters 必须是对象")
        values = dict(values)
        prompt_template = recipe.get("prompt_template", "")
        if not isinstance(prompt_template, str):
            raise ValueError("配方 prompt_template 必须是字符串")
        template_parameters = set(_PROMPT_TEMPLATE_FIELD.findall(prompt_template))
        if prompt_template:
            for parameter_name, specification in parameters.items():
                if not isinstance(specification, dict) or not specification.get("template"):
                    continue
                if parameter_name not in values:
                    values[parameter_name] = self._render_prompt_template(
                        prompt_template, parameters, values
                    )
                break

        applied = []
        unknown = [
            parameter_name
            for parameter_name in values
            if not isinstance(parameters.get(parameter_name), dict)
        ]
        for parameter_name, specification in parameters.items():
            if not isinstance(specification, dict):
                continue
            if parameter_name in values:
                value = values[parameter_name]
            elif "default" in specification:
                value = specification["default"]
            elif specification.get("required"):
                raise ValueError(f"参数 {parameter_name} 为必填")
            else:
                continue

            parameter_type = specification.get("type")
            if (
                parameter_type in {"image", "video", "file"}
                and isinstance(value, str)
                and value.startswith("asset:")
            ):
                if self.asset_resolver is None:
                    raise ValueError("当前运行环境不支持资产引用")
                value = self.asset_resolver(parameter_type, value)

            self._validate_parameter_type(parameter_name, value, specification)
            choices = specification.get("choices")
            if choices is not None:
                if not isinstance(choices, list):
                    raise ValueError(f"参数 {parameter_name} 的 choices 必须是列表")
                if value not in choices:
                    raise ValueError(f"参数 {parameter_name} 的值不可用，可选值：{choices}")

            node_id = specification.get("node_id")
            input_name = specification.get("input", specification.get("input_name"))
            if node_id is None or not isinstance(input_name, str) or not input_name:
                if parameter_name in template_parameters and not specification.get("template"):
                    continue
                raise ValueError(f"参数 {parameter_name} 缺少 node_id 或 input")
            node_id = str(node_id)
            if node_id not in prompt:
                raise ValueError(f"参数 {parameter_name} 指向不存在的节点 {node_id}")
            inputs = prompt[node_id].get("inputs")
            if not isinstance(inputs, dict):
                raise ValueError(f"节点 {node_id} 缺少 inputs")
            inputs[input_name] = value
            applied.append(parameter_name)

        return prompt, applied, unknown

    def _write_recipe(self, request, recipe: dict[str, Any]) -> str:
        path = self._recipe_path(request, recipe["id"], create_dir=True)
        if path is None:
            raise PermissionError("无权保存该配方")

        fd, temporary_path = tempfile.mkstemp(
            dir=os.path.dirname(path), prefix=f".{recipe['id']}.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(recipe, file, ensure_ascii=False, indent=2)
                file.write("\n")
            os.replace(temporary_path, path)
        except Exception:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
            raise
        return path

    @staticmethod
    def _error(message: str, status: int = 400):
        return web.json_response({"error": message}, status=status)

    async def _request_json(self, request):
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError) as ex:
            raise ValueError(f"无效的 JSON 请求：{ex}") from ex
        if not isinstance(body, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return body

    def add_routes(self, routes):
        @routes.get("/recipes")
        async def list_recipes(request):
            try:
                return web.json_response(self._list_summaries(request))
            except KeyError:
                return self._error("用户不存在", 401)

        @routes.get("/recipes/recommend")
        async def recommend_recipes(request):
            task = request.rel_url.query.get(
                "task", request.rel_url.query.get("query", "")
            ).strip()
            if not task:
                return self._error("task 参数不能为空")
            if len(task) > 512:
                return self._error("task 参数过长")

            category = request.rel_url.query.get("category")
            if category is not None:
                category = category.strip()
                if not category or len(category) > 64:
                    return self._error("category 参数无效")
            try:
                limit = int(request.rel_url.query.get("limit", "10"))
            except ValueError:
                return self._error("limit 必须是整数")
            if limit < 1 or limit > 100:
                return self._error("limit 必须在 1-100 之间")

            try:
                summaries = self._list_summaries(request)
                results = self.recommend_summaries(
                    summaries, task, category, limit
                )
            except KeyError:
                return self._error("用户不存在", 401)
            return web.json_response({
                "task": task,
                "category": category,
                "local_only": True,
                "results": results,
            })

        @routes.get("/recipes/templates")
        async def get_recipe_templates(request):
            return web.json_response(list_templates())

        @routes.post("/recipes/templates/{template_id}/copy")
        async def copy_recipe_template(request):
            try:
                body = await self._request_json(request)
                template = get_template(request.match_info["template_id"])
                if not template.get("available", False):
                    return self._error("该模板依赖尚未安装的节点或模型", 409)
                recipe_id = self._validate_recipe_id(body.pop("id", None) or uuid.uuid4().hex)
                path = self._recipe_path(request, recipe_id, create_dir=True)
                if path is None:
                    return self._error("无权保存该配方", 403)
                if os.path.exists(path):
                    return self._error("配方已存在", 409)
                template.update(body)
                template["id"] = recipe_id
                recipe = self._build_recipe(recipe_id, template)
                self._write_recipe(request, recipe)
                return web.json_response(recipe, status=201)
            except KeyError as ex:
                return self._error(str(ex), 404)
            except (OSError, PermissionError, ValueError) as ex:
                return self._error(str(ex))

        @routes.get("/recipes/{recipe_id}")
        async def get_recipe(request):
            try:
                path = self._recipe_path(request, request.match_info["recipe_id"])
                if path is None or not os.path.isfile(path):
                    return self._error("配方不存在", 404)
                return web.json_response(self._read_recipe(path))
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.post("/recipes/{recipe_id}/prepare")
        async def prepare_recipe(request):
            try:
                body = await self._request_json(request)
                values = body.get("values", body)
                if not isinstance(values, dict):
                    return self._error("values 必须是 JSON 对象")
                return web.json_response(self.prepare_prompt(
                    request, request.match_info["recipe_id"], values
                ))
            except KeyError:
                return self._error("用户不存在", 401)
            except FileNotFoundError as ex:
                return self._error(str(ex), 404)
            except PermissionError as ex:
                return self._error(str(ex), 403)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.get("/recipes/{recipe_id}/schema")
        async def get_recipe_schema(request):
            try:
                return web.json_response(self.get_input_schema(
                    request, request.match_info["recipe_id"]
                ))
            except KeyError:
                return self._error("用户不存在", 401)
            except FileNotFoundError as ex:
                return self._error(str(ex), 404)
            except PermissionError as ex:
                return self._error(str(ex), 403)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.post("/recipes/{recipe_id}/prepare-recovery")
        async def prepare_recipe_recovery(request):
            try:
                body = await self._request_json(request)
                values = body.get("values", {})
                recovery = body.get("recovery", {})
                if not isinstance(values, dict):
                    raise ValueError("values 必须是 JSON 对象")
                if not isinstance(recovery, dict):
                    raise ValueError("recovery 必须是 JSON 对象")
                return web.json_response(self.prepare_recovery(
                    request, request.match_info["recipe_id"], values, recovery
                ))
            except KeyError:
                return self._error("用户不存在", 401)
            except FileNotFoundError as ex:
                return self._error(str(ex), 404)
            except PermissionError as ex:
                return self._error(str(ex), 403)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.post("/recipes/{recipe_id}/fork")
        async def fork_recipe(request):
            try:
                body = await self._request_json(request)
                new_recipe_id = body.pop("id", None) or uuid.uuid4().hex
                new_recipe_id = self._validate_recipe_id(new_recipe_id)
                return web.json_response(self.fork_recipe(
                    request,
                    request.match_info["recipe_id"],
                    new_recipe_id,
                    body,
                ), status=201)
            except KeyError:
                return self._error("用户不存在", 401)
            except FileNotFoundError as ex:
                return self._error(str(ex), 404)
            except FileExistsError as ex:
                return self._error(str(ex), 409)
            except PermissionError as ex:
                return self._error(str(ex), 403)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.post("/recipes/{recipe_id}/prepare-batch")
        async def prepare_recipe_batch(request):
            try:
                body = await self._request_json(request)
                values = body.get("values", body.get("items"))
                if not isinstance(values, list):
                    raise ValueError("values 必须是 JSON 数组")
                recovery = body.get("recovery")
                if recovery is not None and not isinstance(recovery, dict):
                    raise ValueError("recovery 必须是 JSON 对象")
                return web.json_response(self.prepare_batch(
                    request, request.match_info["recipe_id"], values, recovery
                ))
            except KeyError:
                return self._error("用户不存在", 401)
            except FileNotFoundError as ex:
                return self._error(str(ex), 404)
            except PermissionError as ex:
                return self._error(str(ex), 403)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.post("/recipes")
        async def create_recipe(request):
            try:
                body = await self._request_json(request)
                recipe_id = body.get("id") or uuid.uuid4().hex
                recipe_id = self._validate_recipe_id(recipe_id)
                path = self._recipe_path(request, recipe_id, create_dir=True)
                if path is None:
                    return self._error("无权保存该配方", 403)
                if os.path.exists(path):
                    return self._error("配方已存在", 409)
                recipe = self._build_recipe(recipe_id, body)
                self._write_recipe(request, recipe)
                return web.json_response(recipe, status=201)
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, PermissionError, ValueError) as ex:
                return self._error(str(ex))

        @routes.put("/recipes/{recipe_id}")
        async def update_recipe(request):
            try:
                recipe_id = self._validate_recipe_id(request.match_info["recipe_id"])
                path = self._recipe_path(request, recipe_id)
                if path is None or not os.path.isfile(path):
                    return self._error("配方不存在", 404)
                body = await self._request_json(request)
                existing = self._read_recipe(path)
                recipe = self._build_recipe(recipe_id, body, existing.get("created_at"))
                self._write_recipe(request, recipe)
                return web.json_response(recipe)
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, PermissionError, ValueError) as ex:
                return self._error(str(ex))

        @routes.delete("/recipes/{recipe_id}")
        async def delete_recipe(request):
            try:
                path = self._recipe_path(request, request.match_info["recipe_id"])
                if path is None or not os.path.isfile(path):
                    return self._error("配方不存在", 404)
                os.remove(path)
                return web.Response(status=204)
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))
