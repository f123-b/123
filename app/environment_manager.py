import platform
import sys
import importlib
import importlib.util
import copy
import json
from importlib.metadata import version

from aiohttp import web
from packaging.version import InvalidVersion, parse as parse_version

from utils.install_util import (
    get_missing_requirements_message,
    get_required_packages_versions,
)


# These packages are required by the runtime but are intentionally unpinned in
# requirements.txt, so they do not appear in get_required_packages_versions().
CORE_PACKAGES = {
    "aiohttp",
    "comfy-aimdo",
    "comfy-kitchen",
    "einops",
    "numpy",
    "Pillow",
    "safetensors",
    "torch",
    "torchvision",
    "transformers",
}

NON_BLOCKING_PACKAGES = {
    "comfyui-embedded-docs",
    "comfyui-frontend-package",
    "comfyui-workflow-templates",
}

IMPORT_PROBES = {
    "aiohttp": "aiohttp",
    "comfy-aimdo": "comfy_aimdo",
    "einops": "einops",
    "numpy": "numpy",
    "Pillow": "PIL",
    "safetensors": "safetensors",
    "torch": "torch",
    "transformers": "transformers",
}

# These packages contain native extensions. Importing them during diagnostics
# can terminate the interpreter when their binary dependencies are incompatible.
# Checking their module spec still catches a missing module without executing it.
MODULE_PROBES = {
    "comfy-kitchen": "comfy_kitchen",
    "torchvision": "torchvision",
}


def build_hardware_recommendation(devices: list[dict]) -> dict:
    gpu_devices = [
        device for device in devices
        if device.get("type") not in {None, "cpu"}
        and isinstance(device.get("vram_total"), (int, float))
        and device["vram_total"] > 0
    ]
    if not gpu_devices:
        return {
            "tier": "cpu",
            "summary": "未检测到可用 GPU，建议使用低分辨率和 CPU Offload",
            "recommended": {
                "precision": "fp32",
                "batch_size": 1,
                "max_resolution": 512,
                "vae_tiling": True,
                "cpu_offload": True,
            },
        }

    device = max(gpu_devices, key=lambda item: item["vram_total"])
    vram_gb = device["vram_total"] / (1024 ** 3)
    free_vram = device.get("vram_free")
    free_vram_gb = (
        free_vram / (1024 ** 3)
        if isinstance(free_vram, (int, float)) and free_vram > 0
        else None
    )
    if vram_gb < 6:
        tier = "low_vram"
        recommendation = {
            "precision": "fp16",
            "quantization": "fp8_or_4bit",
            "batch_size": 1,
            "max_resolution": 768,
            "vae_tiling": True,
            "cpu_offload": True,
        }
        summary = "显存较小，建议优先使用量化模型并开启低显存策略"
    elif vram_gb < 12:
        tier = "standard"
        recommendation = {
            "precision": "fp16",
            "quantization": "fp8_or_4bit",
            "batch_size": 1,
            "max_resolution": 1024,
            "vae_tiling": True,
            "cpu_offload": True,
        }
        summary = "建议使用量化模型并开启 CPU Offload，复杂工作流保持 Batch 1"
    else:
        tier = "high_vram"
        recommendation = {
            "precision": "fp16",
            "batch_size": 1,
            "max_resolution": 1536,
            "vae_tiling": False,
            "cpu_offload": False,
        }
        summary = "显存充足，可优先提高分辨率或并行比较多个模型"

    if free_vram_gb is not None and free_vram_gb < 8 and tier == "high_vram":
        recommendation["vae_tiling"] = True
        recommendation["cpu_offload"] = True
        recommendation["max_resolution"] = min(recommendation["max_resolution"], 1024)
        summary = "当前可用显存较少，建议暂时开启 CPU Offload 和 VAE Tiling"

    return {
        "tier": tier,
        "summary": summary,
        "device": device.get("name"),
        "vram_gb": round(vram_gb, 2),
        "vram_free_gb": round(free_vram_gb, 2) if free_vram_gb is not None else None,
        "recommended": recommendation,
    }


def _package_status(
    installed: str | None,
    required: str | None,
    import_error: str | None = None,
) -> str:
    if installed is None:
        return "missing"
    if import_error:
        return "broken"
    if required is None:
        return "installed"
    try:
        return "outdated" if parse_version(installed) < parse_version(required) else "installed"
    except InvalidVersion:
        return "unknown"


def build_environment_diagnosis(
    installed_versions: dict[str, str | None],
    required_versions: dict[str, str] | None = None,
    *,
    import_errors: dict[str, str] | None = None,
    python_version: str | None = None,
    executable: str | None = None,
    platform_name: str | None = None,
) -> dict:
    required_versions = required_versions or {}
    import_errors = import_errors or {}
    package_names = sorted(set(required_versions) | CORE_PACKAGES, key=str.casefold)
    packages = []
    for name in package_names:
        installed = installed_versions.get(name)
        required = required_versions.get(name)
        import_error = import_errors.get(name)
        packages.append({
            "name": name,
            "installed": installed,
            "required": required,
            "blocking": name not in NON_BLOCKING_PACKAGES,
            "status": _package_status(installed, required, import_error),
        })
        if import_error:
            packages[-1]["import_error"] = import_error

    issues = [
        package for package in packages
        if package["status"] in {"missing", "outdated", "broken"}
    ]
    blocking_issues = [package for package in issues if package["blocking"]]
    if issues:
        summary = f"检测到 {len(issues)} 个环境问题"
        next_steps = [{
            "action": "install_requirements",
            "label": "安装或更新依赖",
            "detail": get_missing_requirements_message(),
        }]
        status = "attention"
    else:
        summary = "环境检查通过"
        next_steps = []
        status = "ready"

    return {
        "status": status,
        "summary": summary,
        "python": {
            "version": python_version or platform.python_version(),
            "executable": executable or sys.executable,
            "platform": platform_name or sys.platform,
        },
        "packages": packages,
        "issues": issues,
        "blocking_issues": blocking_issues,
        "runtime_ready": not blocking_issues,
        "next_steps": next_steps,
        "local_only": True,
    }


def collect_environment_diagnosis() -> dict:
    required_versions = get_required_packages_versions() or {}
    package_names = set(required_versions) | CORE_PACKAGES
    installed_versions = {}
    import_errors = {}
    for name in package_names:
        try:
            installed_versions[name] = version(name)
        except Exception:
            installed_versions[name] = None
        import_name = IMPORT_PROBES.get(name)
        if installed_versions[name] is not None and import_name:
            try:
                importlib.import_module(import_name)
            except BaseException as ex:
                import_errors[name] = str(ex)
        module_name = MODULE_PROBES.get(name)
        if installed_versions[name] is not None and module_name:
            try:
                if importlib.util.find_spec(module_name) is None:
                    import_errors[name] = f"找不到模块 {module_name}"
            except BaseException as ex:
                import_errors[name] = str(ex)
    return build_environment_diagnosis(
        installed_versions,
        required_versions,
        import_errors=import_errors,
    )


class EnvironmentManager:
    def __init__(self, runtime_provider=None):
        self.runtime_provider = runtime_provider
        self._diagnosis_cache = None

    def diagnose(self, refresh: bool = False) -> dict:
        if self._diagnosis_cache is not None and not refresh:
            return copy.deepcopy(self._diagnosis_cache)
        diagnosis = collect_environment_diagnosis()
        if self.runtime_provider is not None:
            try:
                diagnosis["hardware"] = self.runtime_provider()
            except Exception as ex:
                diagnosis["hardware"] = {
                    "status": "unavailable",
                    "error": str(ex),
                }
        self._diagnosis_cache = diagnosis
        return copy.deepcopy(diagnosis)

    def add_routes(self, routes):
        @routes.get("/environment/diagnose")
        async def diagnose_environment(request):
            refresh = request.rel_url.query.get("refresh", "").lower() in {
                "1", "true", "yes"
            }
            return web.json_response(self.diagnose(refresh=refresh))


def main() -> int:
    diagnosis = collect_environment_diagnosis()
    print(json.dumps(diagnosis, ensure_ascii=False, indent=2))
    return 0 if diagnosis.get("runtime_ready", False) else 1


if __name__ == "__main__":
    raise SystemExit(main())
