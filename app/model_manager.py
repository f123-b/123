import os
import base64
import json
import time
import logging
import folder_paths
import glob
import comfy.utils
from aiohttp import web
from PIL import Image
from io import BytesIO
from folder_paths import map_legacy, filter_files_extensions, filter_files_content_types


_TASK_HINTS = {
    "video": ("video", "wan", "hunyuan", "ltx", "animatediff", "视频"),
    "edit": ("edit", "inpaint", "qwen", "flux", "修复", "编辑", "换背景"),
    "anime": ("anime", "cartoon", "pony", "二次元", "动漫"),
    "portrait": ("portrait", "realistic", "face", "人像", "人物"),
    "image": ("image", "sdxl", "sd1", "sd3", "flux", "qwen", "图片"),
}
_HARDWARE_HINTS = {
    "cpu": ("gguf", "q4", "q5", "int8", "4bit", "quant"),
    "low_vram": ("fp8", "gguf", "q4", "q5", "int8", "4bit", "quant"),
    "standard": ("fp8", "gguf", "q4", "q5", "int8", "4bit", "quant"),
    "high_vram": ("fp16", "bf16", "full"),
}


class ModelFileManager:
    def __init__(self) -> None:
        self.cache: dict[str, tuple[list[dict], dict[str, float], float]] = {}

    def get_cache(self, key: str, default=None) -> tuple[list[dict], dict[str, float], float] | None:
        return self.cache.get(key, default)

    def set_cache(self, key: str, value: tuple[list[dict], dict[str, float], float]):
        self.cache[key] = value

    def clear_cache(self):
        self.cache.clear()

    def search_models(self, query: str, folder_name: str | None = None) -> list[dict]:
        query = query.casefold()
        folder_black_list = {"configs", "custom_nodes"}
        if folder_name is not None:
            if folder_name in folder_black_list or folder_name not in folder_paths.folder_names_and_paths:
                raise ValueError("模型目录不存在")
            folder_names = [folder_name]
        else:
            folder_names = [
                name for name in folder_paths.folder_names_and_paths
                if name not in folder_black_list
            ]

        matches = []
        for name in folder_names:
            for model in self.get_model_file_list(name):
                model_name = model.get("name")
                if not isinstance(model_name, str):
                    continue
                normalized_name = model_name.casefold()
                normalized_basename = os.path.basename(model_name).casefold()
                if query == normalized_name or query == normalized_basename:
                    match_type = "exact"
                elif query in normalized_name:
                    match_type = "partial"
                else:
                    continue

                result = dict(model)
                result["folder"] = name
                result["match"] = match_type
                matches.append(result)

        matches.sort(key=lambda item: (
            0 if item["match"] == "exact" else 1,
            item["folder"].casefold(),
            item["name"].casefold(),
        ))
        return matches

    @staticmethod
    def recommend_models(
        models: list[dict],
        task: str,
        hardware_tier: str | None = None,
        limit: int = 10,
    ) -> list[dict]:
        task_text = task.casefold()
        task_key = None
        task_hints = ()
        for key, hints in _TASK_HINTS.items():
            if any(hint.casefold() in task_text for hint in hints):
                task_key = key
                task_hints = hints
                break
        hardware_hints = _HARDWARE_HINTS.get(hardware_tier, ())

        ranked = []
        for model in models:
            name = model.get("name")
            if not isinstance(name, str):
                continue
            name_text = name.casefold()
            score = 0
            reasons = []
            task_matches = [hint for hint in task_hints if hint.casefold() in name_text]
            if task_matches:
                score += 3 * len(task_matches)
                reasons.append(f"任务匹配：{task_key or task_matches[0]}")
            hardware_matches = [hint for hint in hardware_hints if hint in name_text]
            if hardware_matches:
                score += 2 * len(hardware_matches)
                reasons.append(f"硬件匹配：{hardware_tier}")
            ranked.append({
                **model,
                "score": score,
                "reasons": reasons or ["本地模型候选"],
            })

        ranked.sort(key=lambda item: (-item["score"], item["name"].casefold()))
        return ranked[:limit]

    def list_local_models(self) -> list[dict]:
        models = []
        for folder_name in folder_paths.folder_names_and_paths:
            if folder_name in {"configs", "custom_nodes"}:
                continue
            for model in self.get_model_file_list(folder_name):
                entry = dict(model)
                entry["folder"] = folder_name
                models.append(entry)
        return models

    def add_routes(self, routes):
        # NOTE: This is an experiment to replace `/models`
        @routes.get("/experiment/models")
        async def get_model_folders(request):
            model_types = list(folder_paths.folder_names_and_paths.keys())
            folder_black_list = ["configs", "custom_nodes"]
            output_folders: list[dict] = []
            for folder in model_types:
                if folder in folder_black_list:
                    continue
                output_folders.append({
                    "name": folder,
                    "folders": folder_paths.get_folder_paths(folder),
                    "extensions": sorted(folder_paths.folder_names_and_paths[folder][1]),
                })
            return web.json_response(output_folders)

        @routes.get("/experiment/models/catalog")
        async def get_model_catalog(request):
            folder_black_list = ["configs", "custom_nodes"]
            catalog = []
            for folder_name, (folders, extensions) in folder_paths.folder_names_and_paths.items():
                if folder_name in folder_black_list:
                    continue

                files = self.get_model_file_list(folder_name)
                catalog.append({
                    "name": folder_name,
                    "extensions": sorted(extensions or []),
                    "file_count": len(files),
                    "total_size": sum(file["size"] for file in files),
                })
            return web.json_response(catalog)

        @routes.get("/experiment/models/recommend")
        async def recommend_model_files(request):
            task = request.rel_url.query.get("task", "").strip()
            if not task:
                return web.json_response({"error": "task 参数不能为空"}, status=400)
            if len(task) > 512:
                return web.json_response({"error": "task 参数过长"}, status=400)

            hardware_tier = request.rel_url.query.get("hardware_tier")
            try:
                limit = int(request.rel_url.query.get("limit", "10"))
            except ValueError:
                return web.json_response({"error": "limit 必须是整数"}, status=400)
            if limit < 1 or limit > 100:
                return web.json_response({"error": "limit 必须在 1-100 之间"}, status=400)

            return web.json_response({
                "task": task,
                "hardware_tier": hardware_tier,
                "local_only": True,
                "results": self.recommend_models(
                    self.list_local_models(), task, hardware_tier, limit
                ),
            })

        @routes.get("/experiment/models/search")
        async def search_model_files(request):
            query = request.rel_url.query.get("name", "").strip()
            if not query:
                return web.json_response({"error": "name 参数不能为空"}, status=400)
            if len(query) > 512:
                return web.json_response({"error": "name 参数过长"}, status=400)

            folder_name = request.rel_url.query.get("folder")
            if folder_name in {"configs", "custom_nodes"}:
                return web.Response(status=404)
            if folder_name is not None and folder_name not in folder_paths.folder_names_and_paths:
                return web.Response(status=404)

            try:
                results = self.search_models(query, folder_name)
            except ValueError:
                return web.Response(status=404)
            return web.json_response({
                "query": query,
                "folder": folder_name,
                "results": results[:100],
            })

        # NOTE: This is an experiment to replace `/models/{folder}`
        @routes.get("/experiment/models/{folder}")
        async def get_all_models(request):
            folder = request.match_info.get("folder", None)
            if folder not in folder_paths.folder_names_and_paths:
                return web.Response(status=404)
            files = self.get_model_file_list(folder)
            return web.json_response(files)

        @routes.get("/experiment/models/preview/{folder}/{path_index}/{filename:.*}")
        async def get_model_preview(request):
            folder_name = request.match_info.get("folder", None)
            filename = request.match_info.get("filename", None)

            if folder_name not in folder_paths.folder_names_and_paths:
                return web.Response(status=404)

            # The "{filename:.*}" capture also matches the empty string, which
            # would resolve to the folder itself; reject it explicitly.
            if not filename:
                return web.Response(status=400)

            try:
                path_index = int(request.match_info.get("path_index", None))
            except (TypeError, ValueError):
                return web.Response(status=400)

            folders = folder_paths.folder_names_and_paths[folder_name]
            if path_index < 0 or path_index >= len(folders[0]):
                return web.Response(status=404)
            folder = folders[0][path_index]
            full_filename = os.path.normpath(os.path.join(folder, filename))

            # Prevent path traversal: the requested file must stay within the
            # configured model folder. `filename` is an unrestricted ".*" capture,
            # so values like "../../../../etc/passwd" would otherwise escape it.
            if not folder_paths.is_within_directory(folder, full_filename):
                return web.Response(status=403)

            previews = self.get_model_previews(full_filename)
            default_preview = previews[0] if len(previews) > 0 else None
            if default_preview is None or (isinstance(default_preview, str) and not os.path.isfile(default_preview)):
                return web.Response(status=404)

            # The preview is selected by a glob inside get_model_previews, so a
            # companion file (e.g. "model.preview.png") could itself be a symlink
            # resolving outside the model folder. Re-validate the file actually
            # opened: is_within_directory realpaths it, catching symlink escape.
            if isinstance(default_preview, str) and not folder_paths.is_within_directory(folder, default_preview):
                return web.Response(status=403)

            try:
                with Image.open(default_preview) as img:
                    img_bytes = BytesIO()
                    img.save(img_bytes, format="WEBP")
                    img_bytes.seek(0)
                    return web.Response(body=img_bytes.getvalue(), content_type="image/webp")
            except:
                return web.Response(status=404)

    def get_model_file_list(self, folder_name: str):
        folder_name = map_legacy(folder_name)
        folders = folder_paths.folder_names_and_paths[folder_name]
        output_list: list[dict] = []

        for index, folder in enumerate(folders[0]):
            if not os.path.isdir(folder):
                continue
            out = self.cache_model_file_list_(folder)
            if out is None:
                out = self.recursive_search_models_(folder, index)
                self.set_cache(folder, out)
            output_list.extend(out[0])

        return output_list

    def cache_model_file_list_(self, folder: str):
        model_file_list_cache = self.get_cache(folder)

        if model_file_list_cache is None:
            return None
        if not os.path.isdir(folder):
            return None
        if os.path.getmtime(folder) != model_file_list_cache[1]:
            return None
        for x in model_file_list_cache[1]:
            time_modified = model_file_list_cache[1][x]
            folder = x
            if os.path.getmtime(folder) != time_modified:
                return None

        return model_file_list_cache

    def recursive_search_models_(self, directory: str, pathIndex: int) -> tuple[list[str], dict[str, float], float]:
        if not os.path.isdir(directory):
            return [], {}, time.perf_counter()

        excluded_dir_names = [".git"]
        # TODO use settings
        include_hidden_files = False

        result: list[str] = []
        dirs: dict[str, float] = {}

        for dirpath, subdirs, filenames in os.walk(directory, followlinks=True, topdown=True):
            subdirs[:] = [d for d in subdirs if d not in excluded_dir_names]
            if not include_hidden_files:
                subdirs[:] = [d for d in subdirs if not d.startswith(".")]
                filenames = [f for f in filenames if not f.startswith(".")]

            filenames = filter_files_extensions(filenames, folder_paths.supported_pt_extensions)

            for file_name in filenames:
                try:
                    full_path = os.path.join(dirpath, file_name)
                    relative_path = os.path.relpath(full_path, directory)

                    # Get file metadata
                    file_info = {
                        "name": relative_path,
                        "pathIndex": pathIndex,
                        "modified": os.path.getmtime(full_path),  # Add modification time
                        "created": os.path.getctime(full_path),   # Add creation time
                        "size": os.path.getsize(full_path)        # Add file size
                    }
                    result.append(file_info)

                except Exception as e:
                    logging.warning(f"Warning: Unable to access {file_name}. Error: {e}. Skipping this file.")
                    continue

            for d in subdirs:
                path: str = os.path.join(dirpath, d)
                try:
                    dirs[path] = os.path.getmtime(path)
                except FileNotFoundError:
                    logging.warning(f"Warning: Unable to access {path}. Skipping this path.")
                    continue

        return result, dirs, time.perf_counter()

    def get_model_previews(self, filepath: str) -> list[str | BytesIO]:
        dirname = os.path.dirname(filepath)

        if not os.path.exists(dirname):
            return []

        basename = os.path.splitext(filepath)[0]
        match_files = glob.glob(f"{basename}.*", recursive=False)
        image_files = filter_files_content_types(match_files, "image")
        safetensors_file = next(filter(lambda x: x.endswith(".safetensors"), match_files), None)
        safetensors_metadata = {}

        result: list[str | BytesIO] = []

        for filename in image_files:
            _basename = os.path.splitext(filename)[0]
            if _basename == basename:
                result.append(filename)
            if _basename == f"{basename}.preview":
                result.append(filename)

        if safetensors_file:
            safetensors_filepath = os.path.join(dirname, safetensors_file)
            header = comfy.utils.safetensors_header(safetensors_filepath, max_size=8*1024*1024)
            if header:
                safetensors_metadata = json.loads(header)
        safetensors_images = safetensors_metadata.get("__metadata__", {}).get("ssmd_cover_images", None)
        if safetensors_images:
            safetensors_images = json.loads(safetensors_images)
            for image in safetensors_images:
                result.append(BytesIO(base64.b64decode(image)))

        return result

    def __exit__(self, exc_type, exc_value, traceback):
        self.clear_cache()
