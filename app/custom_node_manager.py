import os
import folder_paths
import glob
from aiohttp import web
import json
import logging
import re
import sys
from importlib.metadata import version as distribution_version
from functools import lru_cache
from typing import Any

from utils.json_util import merge_json_recursive


# Extra locale files to load into main.json
EXTRA_LOCALE_FILES = [
    "nodeDefs.json",
    "commands.json",
    "settings.json",
]
_NODE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_NODE_FAILURE_MESSAGES = {
    "ModuleNotFoundError": "节点依赖缺失",
    "ImportError": "节点依赖导入失败",
    "SyntaxError": "节点代码存在语法错误",
    "InvalidEntrypoint": "节点入口无效",
    "InvalidEntrypointResult": "节点入口返回值无效",
    "InvalidNodeList": "节点入口未返回有效节点列表",
    "MissingNodeDefinition": "节点包缺少节点定义",
}
_MISSING_MODULE = re.compile(r"no module named ['\"]([^'\"]+)['\"]", re.IGNORECASE)
_REQUIREMENT_NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)")


def safe_load_json_file(file_path: str) -> dict:
    if not os.path.exists(file_path):
        return {}

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError:
        logging.error(f"Error loading {file_path}")
        return {}


class CustomNodeManager:
    @staticmethod
    def _find_disabled_node(node_name: str) -> tuple[str, str] | None:
        if not isinstance(node_name, str) or not _NODE_NAME.fullmatch(node_name):
            raise ValueError("节点包名称不合法")

        for root in folder_paths.get_folder_paths("custom_nodes"):
            disabled_path = os.path.abspath(os.path.join(root, f"{node_name}.disabled"))
            enabled_path = os.path.abspath(os.path.join(root, node_name))
            if not folder_paths.is_within_directory(root, disabled_path):
                continue
            if os.path.exists(disabled_path):
                return disabled_path, enabled_path
        return None

    @staticmethod
    def get_node_catalog(
        loaded_modules,
        failed_modules=None,
    ) -> list[dict[str, Any]]:
        loaded_modules = list(loaded_modules)
        loaded_paths = {
            os.path.normcase(os.path.abspath(module_dir)): module_name
            for module_name, module_dir in loaded_modules
        }
        loaded_names = {
            os.path.splitext(os.path.basename(str(module_name)))[0].casefold()
            for module_name, _ in loaded_modules
        }
        failed_by_paths = {}
        failed_by_names = {}
        for module_name, details in failed_modules or []:
            if not isinstance(details, dict):
                continue
            failed_name = os.path.splitext(os.path.basename(str(module_name)))[0].casefold()
            failed_by_names[failed_name] = details
            failed_path = details.get("path")
            if isinstance(failed_path, str):
                failed_by_paths[os.path.normcase(os.path.abspath(failed_path))] = details
        catalog = []
        for root in folder_paths.get_folder_paths("custom_nodes"):
            try:
                entries = sorted(os.scandir(root), key=lambda entry: entry.name.casefold())
            except OSError:
                continue

            for entry in entries:
                name = entry.name
                if name.startswith(".") or name == "__pycache__":
                    continue
                if name.endswith(".disabled"):
                    module_name = name[:-9]
                    status = "disabled"
                elif entry.is_dir():
                    module_name = name
                    status = "installed"
                elif name.endswith(".py"):
                    module_name = os.path.splitext(name)[0]
                    status = "installed"
                else:
                    continue

                entry_path = os.path.normcase(os.path.abspath(entry.path))
                requirements_available = entry.is_dir() and os.path.isfile(
                    os.path.join(entry.path, "requirements.txt")
                )
                failure = failed_by_paths.get(entry_path) or failed_by_names.get(module_name.casefold())
                if failure is not None:
                    result = {
                        "name": module_name,
                        "status": "failed",
                        "requirements_available": requirements_available,
                    }
                    if failure.get("error_type"):
                        result["error_type"] = failure["error_type"]
                    if failure.get("message"):
                        result["error"] = _NODE_FAILURE_MESSAGES.get(
                            failure.get("error_type"), "节点加载失败"
                        )
                        result["error_detail"] = failure["message"]
                        match = _MISSING_MODULE.search(failure["message"])
                        if match:
                            result["missing_dependency"] = match.group(1)
                    catalog.append(result)
                    continue

                loaded_name = loaded_paths.get(entry_path)
                if loaded_name is None and module_name.casefold() in loaded_names:
                    loaded_name = module_name
                if loaded_name is not None:
                    module_name = loaded_name
                    status = "loaded"
                catalog.append({
                    "name": module_name,
                    "status": status,
                    "requirements_available": requirements_available,
                })
        return catalog

    def enable_node(self, node_name: str) -> dict[str, Any]:
        paths = self._find_disabled_node(node_name)
        if paths is None:
            raise FileNotFoundError("找不到待启用的节点包")
        disabled_path, enabled_path = paths
        if os.path.exists(enabled_path):
            raise FileExistsError("同名节点包已存在")
        os.replace(disabled_path, enabled_path)
        return {
            "name": node_name,
            "status": "enabled",
            "requires_restart": True,
        }

    @staticmethod
    def get_node_requirements(node_name: str) -> dict[str, Any]:
        if not isinstance(node_name, str) or not _NODE_NAME.fullmatch(node_name):
            raise ValueError("节点包名称不合法")

        for root in folder_paths.get_folder_paths("custom_nodes"):
            for directory_name in (node_name, f"{node_name}.disabled"):
                node_root = os.path.abspath(os.path.join(root, directory_name))
                if not folder_paths.is_within_directory(root, node_root):
                    continue
                if not os.path.isdir(node_root):
                    continue

                requirements_path = os.path.abspath(os.path.join(node_root, "requirements.txt"))
                if not folder_paths.is_within_directory(node_root, requirements_path):
                    continue
                if not os.path.isfile(requirements_path):
                    continue

                with open(requirements_path, "r", encoding="utf-8", errors="replace") as file:
                    content = file.read(256 * 1024)
                packages = [
                    line.strip()
                    for line in content.splitlines()
                    if line.strip() and not line.lstrip().startswith("#")
                ]
                package_status = []
                for requirement in packages:
                    if requirement.startswith(("-", "git+", "http://", "https://")):
                        continue
                    match = _REQUIREMENT_NAME.match(requirement)
                    if match is None:
                        continue
                    package_name = match.group(1)
                    try:
                        installed = distribution_version(package_name)
                    except Exception:
                        installed = None
                    package_status.append({
                        "requirement": requirement,
                        "name": package_name,
                        "installed": installed,
                        "status": "installed" if installed else "missing",
                    })
                return {
                    "name": node_name,
                    "requirements_file": "requirements.txt",
                    "packages": packages,
                    "package_status": package_status,
                    "missing_packages": [
                        item["name"]
                        for item in package_status
                        if item["status"] == "missing"
                    ],
                    "python": sys.executable,
                    "local_only": True,
                }

        raise FileNotFoundError("节点包没有 requirements.txt")

    @lru_cache(maxsize=1)
    def build_translations(self):
        """Load all custom nodes translations during initialization. Translations are
        expected to be loaded from `locales/` folder.

        The folder structure is expected to be the following:
        - custom_nodes/
            - custom_node_1/
                - locales/
                    - en/
                        - main.json
                        - commands.json
                        - settings.json

        returned translations are expected to be in the following format:
        {
            "en": {
                "nodeDefs": {...},
                "commands": {...},
                "settings": {...},
                ...{other main.json keys}
            }
        }
        """

        translations = {}

        for folder in folder_paths.get_folder_paths("custom_nodes"):
            # Sort glob results for deterministic ordering
            for custom_node_dir in sorted(glob.glob(os.path.join(folder, "*/"))):
                locales_dir = os.path.join(custom_node_dir, "locales")
                if not os.path.exists(locales_dir):
                    continue

                for lang_dir in glob.glob(os.path.join(locales_dir, "*/")):
                    lang_code = os.path.basename(os.path.dirname(lang_dir))

                    if lang_code not in translations:
                        translations[lang_code] = {}

                    # Load main.json
                    main_file = os.path.join(lang_dir, "main.json")
                    node_translations = safe_load_json_file(main_file)

                    # Load extra locale files
                    for extra_file in EXTRA_LOCALE_FILES:
                        extra_file_path = os.path.join(lang_dir, extra_file)
                        key = extra_file.split(".")[0]
                        json_data = safe_load_json_file(extra_file_path)
                        if json_data:
                            node_translations[key] = json_data

                    if node_translations:
                        translations[lang_code] = merge_json_recursive(
                            translations[lang_code], node_translations
                        )

        return translations

    def add_routes(self, routes, webapp, loadedModules, failedModules=None):
        loaded_modules = list(loadedModules)
        failed_modules = list(failedModules or [])

        example_workflow_folder_names = ["example_workflows", "example", "examples", "workflow", "workflows"]

        @routes.get("/custom_nodes/catalog")
        async def get_custom_node_catalog(request):
            return web.json_response(self.get_node_catalog(
                loaded_modules,
                failed_modules,
            ))

        @routes.post("/custom_nodes/{node_name}/enable")
        async def enable_custom_node(request):
            try:
                return web.json_response(self.enable_node(request.match_info["node_name"]))
            except FileNotFoundError:
                return web.Response(status=404)
            except FileExistsError as ex:
                return web.json_response({"error": str(ex)}, status=409)
            except ValueError as ex:
                return web.json_response({"error": str(ex)}, status=400)
            except OSError:
                return web.json_response({"error": "节点包启用失败"}, status=409)

        @routes.get("/custom_nodes/{node_name}/requirements")
        async def get_custom_node_requirements(request):
            try:
                return web.json_response(self.get_node_requirements(
                    request.match_info["node_name"]
                ))
            except ValueError as ex:
                return web.json_response({"error": str(ex)}, status=400)
            except FileNotFoundError as ex:
                return web.json_response({"error": str(ex)}, status=404)
            except OSError as ex:
                return web.json_response({"error": str(ex)}, status=409)

        @routes.get("/workflow_templates")
        async def get_workflow_templates(request):
            """Returns a web response that contains the map of custom_nodes names and their associated workflow templates. The ones without templates are omitted."""

            files = []

            for folder in folder_paths.get_folder_paths("custom_nodes"):
                for folder_name in example_workflow_folder_names:
                    pattern = os.path.join(folder, f"*/{folder_name}/*.json")
                    matched_files = glob.glob(pattern)
                    files.extend(matched_files)

            workflow_templates_dict = (
                {}
            )  # custom_nodes folder name -> example workflow names
            for file in files:
                custom_nodes_name = os.path.basename(
                    os.path.dirname(os.path.dirname(file))
                )
                workflow_name = os.path.splitext(os.path.basename(file))[0]
                workflow_templates_dict.setdefault(custom_nodes_name, []).append(
                    workflow_name
                )
            return web.json_response(workflow_templates_dict)

        # Serve workflow templates from custom nodes.
        for module_name, module_dir in loaded_modules:
            for folder_name in example_workflow_folder_names:
                workflows_dir = os.path.join(module_dir, folder_name)

                if os.path.exists(workflows_dir):
                    if folder_name != "example_workflows":
                        logging.debug(
                            "Found example workflow folder '%s' for custom node '%s', consider renaming it to 'example_workflows'",
                            folder_name, module_name)

                    webapp.add_routes(
                        [
                            web.static(
                                "/api/workflow_templates/" + module_name, workflows_dir
                            )
                        ]
                    )

        @routes.get("/i18n")
        async def get_i18n(request):
            """Returns translations from all custom nodes' locales folders."""
            return web.json_response(self.build_translations())
