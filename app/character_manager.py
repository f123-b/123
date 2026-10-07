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


CHARACTER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
IMAGE_SLOTS = ("hero", "face", "front", "left", "right", "back")


def _text(value: Any, name: str, limit: int, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} 必须是字符串")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{name} 不能为空")
    if len(value) > limit:
        raise ValueError(f"{name} 长度不能超过 {limit}")
    return value


def _character_id(value: Any) -> str:
    if not isinstance(value, str) or not CHARACTER_ID.fullmatch(value):
        raise ValueError("character_id 只能包含字母、数字、下划线和短横线，长度为 1-64")
    return value


class CharacterIdentityService:
    @staticmethod
    def generate_identity_prompt(character: dict[str, Any]) -> str:
        profile = character.get("profile", {})
        face = character.get("face", {})
        hair = character.get("hair", {})
        details = [
            profile.get("age"),
            profile.get("ethnicity"),
            profile.get("gender"),
            profile.get("bodyType"),
            face.get("faceShape"),
            face.get("skinTone"),
            face.get("eyes"),
            hair.get("color"),
            hair.get("style"),
            hair.get("length"),
        ]
        details = [str(item).strip() for item in details if item]
        if character.get("description"):
            details.insert(0, character["description"].strip())
        return "，".join(details)


class CharacterManager:
    def __init__(self, user_manager):
        self.user_manager = user_manager
        self.identity_service = CharacterIdentityService()

    def _path(self, request, character_id: str, create_dir: bool = False) -> str | None:
        character_id = _character_id(character_id)
        path = self.user_manager.get_request_user_filepath(request, f"characters/{character_id}.json", create_dir=create_dir)
        root = self.user_manager.get_request_user_filepath(request, None, create_dir=create_dir)
        if path is None or root is None or not folder_paths.is_within_directory(root, path):
            return None
        return path

    def _character_directory(self, request, character_id: str, create: bool) -> str | None:
        path = self.user_manager.get_request_user_filepath(request, f"characters/{_character_id(character_id)}", create_dir=create)
        root = self.user_manager.get_request_user_filepath(request, None, create_dir=create)
        if path is None or root is None or not folder_paths.is_within_directory(root, path):
            return None
        if create:
            for name in ("references", "outfits", "expressions", "poses", "training"):
                os.makedirs(os.path.join(path, name), exist_ok=True)
        return path

    @staticmethod
    def _defaults() -> dict[str, Any]:
        return {
            "profile": {"gender": "", "age": "", "height": "", "bodyType": "", "ethnicity": ""},
            "face": {"faceShape": "", "skinTone": "", "eyes": "", "eyebrows": "", "nose": "", "mouth": ""},
            "hair": {"color": "", "style": "", "length": ""},
            "personality": {"keywords": []},
            "images": {slot: None for slot in IMAGE_SLOTS},
            "outfits": [],
            "expressions": [],
            "poses": [],
            "identity": {"confirmed": False, "referenceImages": [], "lora": None, "embedding": None, "ipAdapter": None},
            "generation": {"model": "Qwen-Image 2.1", "seed": -1, "workflow": "character-base"},
        }

    @staticmethod
    def _merge(default: dict[str, Any], incoming: Any) -> dict[str, Any]:
        if not isinstance(incoming, dict):
            return default
        result = copy.deepcopy(default)
        for key, value in incoming.items():
            if key in result:
                result[key] = copy.deepcopy(value)
        return result

    def _build(self, character_id: str, body: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("角色请求体必须是 JSON 对象")
        current = existing or {}
        defaults = self._defaults()
        name = _text(body.get("name", current.get("name", "")), "name", 80, True)
        description = _text(body.get("description", current.get("description", "")), "description", 2000, True)
        profile = self._merge(self._merge(defaults["profile"], current.get("profile")), body.get("profile", current.get("profile")))
        face = self._merge(self._merge(defaults["face"], current.get("face")), body.get("face", current.get("face")))
        hair = self._merge(self._merge(defaults["hair"], current.get("hair")), body.get("hair", current.get("hair")))
        personality = self._merge(self._merge(defaults["personality"], current.get("personality")), body.get("personality", current.get("personality")))
        if not isinstance(personality.get("keywords"), list):
            raise ValueError("personality.keywords 必须是数组")
        now = int(time.time() * 1000)
        character = {
            "id": _character_id(character_id),
            "name": name,
            "description": description,
            "profile": profile,
            "face": face,
            "hair": hair,
            "personality": personality,
            "visualIdentityPrompt": _text(body.get("visualIdentityPrompt", current.get("visualIdentityPrompt", "")), "visualIdentityPrompt", 3000),
            "images": self._merge(defaults["images"], current.get("images")),
            "outfits": copy.deepcopy(current.get("outfits", defaults["outfits"])),
            "expressions": copy.deepcopy(current.get("expressions", defaults["expressions"])),
            "poses": copy.deepcopy(current.get("poses", defaults["poses"])),
            "identity": self._merge(defaults["identity"], current.get("identity")),
            "generation": self._merge(defaults["generation"], current.get("generation")),
            "createdAt": current.get("createdAt", now),
            "updatedAt": now,
        }
        if not character["visualIdentityPrompt"]:
            character["visualIdentityPrompt"] = self.identity_service.generate_identity_prompt(character)
        return character

    def _read(self, path: str) -> dict[str, Any]:
        with open(path, "r", encoding="utf-8") as file:
            value = json.load(file)
        if not isinstance(value, dict):
            raise ValueError("角色文件必须是 JSON 对象")
        return value

    def _write(self, request, character: dict[str, Any]) -> None:
        path = self._path(request, character["id"], create_dir=True)
        if path is None:
            raise PermissionError("无权保存角色")
        self._character_directory(request, character["id"], create=True)
        fd, temporary_path = tempfile.mkstemp(dir=os.path.dirname(path), prefix=f".{character['id']}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(character, file, ensure_ascii=False, indent=2)
                file.write("\n")
            os.replace(temporary_path, path)
        except Exception:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
            raise

    def list_characters(self, request) -> list[dict[str, Any]]:
        directory = self.user_manager.get_request_user_filepath(request, "characters", create_dir=False)
        if directory is None or not os.path.isdir(directory):
            return []
        result = []
        for filename in os.listdir(directory):
            if not filename.endswith(".json"):
                continue
            try:
                character = self._read(os.path.join(directory, filename))
                result.append({
                    "id": character.get("id", filename[:-5]),
                    "name": character.get("name", "未命名角色"),
                    "description": character.get("description", ""),
                    "profile": character.get("profile", {}),
                    "hero": character.get("images", {}).get("hero"),
                    "updatedAt": character.get("updatedAt", 0),
                })
            except (OSError, ValueError, json.JSONDecodeError):
                continue
        return sorted(result, key=lambda item: (-int(item.get("updatedAt", 0) or 0), item["id"]))

    def get_character(self, request, character_id: str) -> dict[str, Any]:
        path = self._path(request, character_id)
        if path is None or not os.path.isfile(path):
            raise FileNotFoundError("角色不存在")
        return self._read(path)

    def add_routes(self, routes):
        @routes.get("/characters")
        async def list_characters(request):
            try:
                return web.json_response(self.list_characters(request))
            except (KeyError, OSError, ValueError) as error:
                return web.json_response({"error": str(error)}, status=400)

        @routes.post("/characters")
        async def create_character(request):
            try:
                body = await request.json()
                character_id = _character_id(body.get("id") or uuid.uuid4().hex)
                if self._path(request, character_id) and os.path.exists(self._path(request, character_id)):
                    return web.json_response({"error": "角色已存在"}, status=409)
                character = self._build(character_id, body)
                self._write(request, character)
                return web.json_response(character, status=201)
            except (KeyError, OSError, PermissionError, ValueError, json.JSONDecodeError) as error:
                return web.json_response({"error": str(error)}, status=400)

        @routes.get("/characters/{character_id}")
        async def get_character(request):
            try:
                return web.json_response(self.get_character(request, request.match_info["character_id"]))
            except (KeyError, FileNotFoundError, OSError, ValueError) as error:
                return web.json_response({"error": str(error)}, status=404 if isinstance(error, FileNotFoundError) else 400)

        @routes.put("/characters/{character_id}")
        async def update_character(request):
            try:
                character_id = _character_id(request.match_info["character_id"])
                existing = self.get_character(request, character_id)
                character = self._build(character_id, await request.json(), existing)
                self._write(request, character)
                return web.json_response(character)
            except (KeyError, FileNotFoundError, OSError, PermissionError, ValueError, json.JSONDecodeError) as error:
                return web.json_response({"error": str(error)}, status=404 if isinstance(error, FileNotFoundError) else 400)

        @routes.delete("/characters/{character_id}")
        async def delete_character(request):
            try:
                path = self._path(request, request.match_info["character_id"])
                if path is None or not os.path.isfile(path):
                    return web.json_response({"error": "角色不存在"}, status=404)
                os.remove(path)
                return web.Response(status=204)
            except (KeyError, OSError, ValueError) as error:
                return web.json_response({"error": str(error)}, status=400)

        @routes.post("/characters/{character_id}/images")
        async def save_character_image(request):
            try:
                character = self.get_character(request, request.match_info["character_id"])
                body = await request.json()
                slot = body.get("slot") if isinstance(body, dict) else None
                if slot not in IMAGE_SLOTS:
                    raise ValueError("slot 无效")
                image = body.get("image")
                if not isinstance(image, dict) or not image.get("filename"):
                    raise ValueError("image 必须包含 filename")
                character["images"][slot] = copy.deepcopy(image)
                character["updatedAt"] = int(time.time() * 1000)
                self._write(request, character)
                return web.json_response(character)
            except (KeyError, FileNotFoundError, OSError, PermissionError, ValueError, json.JSONDecodeError) as error:
                return web.json_response({"error": str(error)}, status=404 if isinstance(error, FileNotFoundError) else 400)

        @routes.post("/characters/{character_id}/confirm")
        async def confirm_character(request):
            try:
                character = self.get_character(request, request.match_info["character_id"])
                hero = character.get("images", {}).get("hero")
                if not hero:
                    return web.json_response({"error": "请先生成角色主视觉"}, status=409)
                character["identity"]["confirmed"] = True
                character["identity"]["referenceImages"] = [copy.deepcopy(hero)]
                character["updatedAt"] = int(time.time() * 1000)
                self._write(request, character)
                return web.json_response(character)
            except (KeyError, FileNotFoundError, OSError, PermissionError, ValueError) as error:
                return web.json_response({"error": str(error)}, status=404 if isinstance(error, FileNotFoundError) else 400)
