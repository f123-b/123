from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import time
import uuid
from typing import Any

from aiohttp import web

import folder_paths


_PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_ITEM_TYPES = {"asset", "image", "video", "audio", "workflow", "prompt", "other"}


class ProjectManager:
    """Stores user-owned project metadata and references to local outputs."""

    def __init__(self, user_manager):
        self.user_manager = user_manager

    @staticmethod
    def _validate_id(value: str, label: str = "project_id") -> str:
        if not isinstance(value, str) or not _PROJECT_ID.fullmatch(value):
            raise ValueError(f"{label} 只能包含字母、数字、下划线和短横线，长度为 1-64")
        return value

    @staticmethod
    def _text(body: dict[str, Any], name: str, default: str, limit: int) -> str:
        value = body.get(name, default)
        if not isinstance(value, str):
            raise ValueError(f"{name} 必须是字符串")
        value = value.strip()
        if len(value) > limit:
            raise ValueError(f"{name} 长度不能超过 {limit}")
        return value

    @staticmethod
    def _list(body: dict[str, Any], name: str, default: list[Any]) -> list[Any]:
        value = body.get(name, default)
        if not isinstance(value, list):
            raise ValueError(f"{name} 必须是数组")
        return copy.deepcopy(value)

    @classmethod
    def _validate_items(cls, items: list[Any]) -> list[dict[str, Any]]:
        validated = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f"items[{index}] 必须是对象")
            item_id = cls._validate_id(item.get("id"), f"items[{index}].id")
            item_type = item.get("type", "other")
            if not isinstance(item_type, str) or item_type not in _ITEM_TYPES:
                raise ValueError(f"items[{index}].type 无效")
            label = item.get("label", item_id)
            if not isinstance(label, str) or len(label.strip()) > 256:
                raise ValueError(f"items[{index}].label 无效")
            metadata = item.get("metadata", {})
            if not isinstance(metadata, dict):
                raise ValueError(f"items[{index}].metadata 必须是对象")
            normalized = copy.deepcopy(item)
            normalized["id"] = item_id
            normalized["type"] = item_type
            normalized["label"] = label.strip()
            normalized["metadata"] = metadata
            validated.append(normalized)
        return validated

    def _path(self, request, project_id: str, create_dir: bool = False) -> str | None:
        project_id = self._validate_id(project_id)
        path = self.user_manager.get_request_user_filepath(
            request, f"projects/{project_id}.json", create_dir=create_dir
        )
        root = self.user_manager.get_request_user_filepath(
            request, None, create_dir=create_dir
        )
        if path is None or root is None or not folder_paths.is_within_directory(root, path):
            return None
        return path

    @staticmethod
    def _read(path: str) -> dict[str, Any]:
        with open(path, "r", encoding="utf-8") as file:
            value = json.load(file)
        if not isinstance(value, dict):
            raise ValueError("项目文件必须是 JSON 对象")
        if not isinstance(value.get("items", []), list):
            raise ValueError("项目 items 必须是数组")
        return value

    def _write(self, request, project: dict[str, Any]) -> str:
        path = self._path(request, project["id"], create_dir=True)
        if path is None:
            raise PermissionError("无权保存该项目")
        fd, temporary_path = tempfile.mkstemp(
            dir=os.path.dirname(path), prefix=f".{project['id']}.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(project, file, ensure_ascii=False, indent=2)
                file.write("\n")
            os.replace(temporary_path, path)
        except Exception:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
            raise
        return path

    def _build_project(
        self,
        project_id: str,
        body: dict[str, Any],
        existing: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("项目请求体必须是 JSON 对象")
        now = int(time.time() * 1000)
        items = self._validate_items(
            self._list(body, "items", existing.get("items", []) if existing else [])
        )
        project = {
            "id": self._validate_id(project_id),
            "name": self._text(
                body, "name", existing.get("name", project_id) if existing else project_id, 128
            ),
            "description": self._text(
                body, "description", existing.get("description", "") if existing else "", 2000
            ),
            "tags": self._list(
                body, "tags", existing.get("tags", []) if existing else []
            ),
            "items": items,
            "created_at": existing.get("created_at", now) if existing else now,
            "updated_at": now,
        }
        return project

    @staticmethod
    def _summary(project: dict[str, Any]) -> dict[str, Any]:
        summary = {key: value for key, value in project.items() if key != "items"}
        summary["item_count"] = len(project.get("items", []))
        return summary

    def list_projects(self, request) -> list[dict[str, Any]]:
        directory = self.user_manager.get_request_user_filepath(
            request, "projects", create_dir=False
        )
        if directory is None or not os.path.isdir(directory):
            return []
        projects = []
        for filename in sorted(os.listdir(directory)):
            if not filename.endswith(".json"):
                continue
            project_id = filename[:-5]
            try:
                path = self._path(request, project_id)
                if path is not None and os.path.isfile(path):
                    projects.append(self._summary(self._read(path)))
            except (OSError, ValueError):
                continue
        projects.sort(key=lambda item: (-int(item.get("updated_at", 0) or 0), item["id"]))
        return projects

    def get_project(self, request, project_id: str) -> dict[str, Any]:
        path = self._path(request, project_id)
        if path is None or not os.path.isfile(path):
            raise FileNotFoundError("项目不存在")
        return self._read(path)

    def add_prompt_item(
        self,
        request,
        project_id: str,
        prompt_id: str,
        recipe_id: str,
        batch_index: int | None = None,
    ) -> dict[str, Any]:
        metadata = {"recipe_id": recipe_id}
        if batch_index is not None:
            metadata["batch_index"] = batch_index
        return self.add_item(request, project_id, {
            "type": "prompt",
            "label": f"Recipe {recipe_id}",
            "prompt_id": prompt_id,
            "metadata": metadata,
        })

    def add_item(self, request, project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        path = self._path(request, project_id)
        if path is None or not os.path.isfile(path):
            raise FileNotFoundError("项目不存在")
        if not isinstance(body, dict):
            raise ValueError("项目条目必须是 JSON 对象")
        item_type = body.get("type", "other")
        if not isinstance(item_type, str) or item_type not in _ITEM_TYPES:
            raise ValueError(f"type 必须是 {_ITEM_TYPES} 之一")
        item_id = body.get("id") or uuid.uuid4().hex
        item_id = self._validate_id(item_id, "item_id")
        project = self._read(path)
        if any(item.get("id") == item_id for item in project["items"] if isinstance(item, dict)):
            raise ValueError("项目条目已存在")
        item = {
            "id": item_id,
            "type": item_type,
            "label": self._text(body, "label", item_id, 256),
            "asset_id": body.get("asset_id"),
            "prompt_id": body.get("prompt_id"),
            "metadata": body.get("metadata", {}),
            "created_at": int(time.time() * 1000),
        }
        if item["asset_id"] is not None and not isinstance(item["asset_id"], str):
            raise ValueError("asset_id 必须是字符串")
        if item["prompt_id"] is not None and not isinstance(item["prompt_id"], str):
            raise ValueError("prompt_id 必须是字符串")
        if not isinstance(item["metadata"], dict):
            raise ValueError("metadata 必须是对象")
        project["items"].append(item)
        project["updated_at"] = int(time.time() * 1000)
        self._write(request, project)
        return item

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
        @routes.get("/projects")
        async def list_projects(request):
            try:
                return web.json_response(self.list_projects(request))
            except KeyError:
                return self._error("用户不存在", 401)

        @routes.post("/projects")
        async def create_project(request):
            try:
                body = await self._request_json(request)
                project_id = self._validate_id(body.get("id") or uuid.uuid4().hex)
                path = self._path(request, project_id, create_dir=True)
                if path is None:
                    return self._error("无权保存该项目", 403)
                if os.path.exists(path):
                    return self._error("项目已存在", 409)
                project = self._build_project(project_id, body)
                self._write(request, project)
                return web.json_response(project, status=201)
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, PermissionError, ValueError) as ex:
                return self._error(str(ex))

        @routes.get("/projects/{project_id}")
        async def get_project(request):
            try:
                path = self._path(request, request.match_info["project_id"])
                if path is None or not os.path.isfile(path):
                    return self._error("项目不存在", 404)
                return web.json_response(self._read(path))
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.put("/projects/{project_id}")
        async def update_project(request):
            try:
                project_id = self._validate_id(request.match_info["project_id"])
                path = self._path(request, project_id)
                if path is None or not os.path.isfile(path):
                    return self._error("项目不存在", 404)
                project = self._build_project(project_id, await self._request_json(request), self._read(path))
                self._write(request, project)
                return web.json_response(project)
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, PermissionError, ValueError) as ex:
                return self._error(str(ex))

        @routes.delete("/projects/{project_id}")
        async def delete_project(request):
            try:
                path = self._path(request, request.match_info["project_id"])
                if path is None or not os.path.isfile(path):
                    return self._error("项目不存在", 404)
                os.remove(path)
                return web.Response(status=204)
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, ValueError) as ex:
                return self._error(str(ex))

        @routes.post("/projects/{project_id}/items")
        async def add_project_item(request):
            try:
                item = self.add_item(
                    request, request.match_info["project_id"], await self._request_json(request)
                )
                return web.json_response(item, status=201)
            except KeyError:
                return self._error("用户不存在", 401)
            except FileNotFoundError as ex:
                return self._error(str(ex), 404)
            except (OSError, PermissionError, ValueError) as ex:
                return self._error(str(ex))

        @routes.delete("/projects/{project_id}/items/{item_id}")
        async def delete_project_item(request):
            try:
                path = self._path(request, request.match_info["project_id"])
                if path is None or not os.path.isfile(path):
                    return self._error("项目不存在", 404)
                project = self._read(path)
                item_id = self._validate_id(request.match_info["item_id"], "item_id")
                remaining = [
                    item for item in project["items"]
                    if not isinstance(item, dict) or item.get("id") != item_id
                ]
                if len(remaining) == len(project["items"]):
                    return self._error("项目条目不存在", 404)
                project["items"] = remaining
                project["updated_at"] = int(time.time() * 1000)
                self._write(request, project)
                return web.Response(status=204)
            except KeyError:
                return self._error("用户不存在", 401)
            except (OSError, PermissionError, ValueError) as ex:
                return self._error(str(ex))
