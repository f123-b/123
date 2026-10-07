import pytest
from aiohttp import web

from app.environment_manager import (
    EnvironmentManager,
    build_environment_diagnosis,
    build_hardware_recommendation,
    main,
)


@pytest.fixture
def app():
    app = web.Application()
    routes = web.RouteTableDef()
    EnvironmentManager().add_routes(routes)
    app.add_routes(routes)
    return app


def test_environment_diagnosis_reports_missing_and_outdated_packages():
    diagnosis = build_environment_diagnosis(
        {
            "aiohttp": "3.10.0",
            "torch": None,
            "transformers": "4.50.3",
        },
        {"aiohttp": "3.11.8", "transformers": "4.50.3"},
        python_version="3.12.4",
        executable="python",
        platform_name="test",
    )

    packages = {item["name"]: item for item in diagnosis["packages"]}
    assert diagnosis["status"] == "attention"
    assert packages["aiohttp"]["status"] == "outdated"
    assert packages["torch"]["status"] == "missing"
    assert packages["transformers"]["status"] == "installed"
    assert diagnosis["python"] == {
        "version": "3.12.4",
        "executable": "python",
        "platform": "test",
    }
    assert diagnosis["next_steps"][0]["action"] == "install_requirements"
    assert diagnosis["local_only"] is True
    assert diagnosis["runtime_ready"] is False
    assert len(diagnosis["blocking_issues"]) >= 1


def test_environment_diagnosis_reports_installed_but_broken_imports():
    diagnosis = build_environment_diagnosis(
        {"comfy-kitchen": "0.2.36"},
        import_errors={"comfy-kitchen": "No module named 'comfy_kitchen'"},
    )

    package = next(item for item in diagnosis["packages"] if item["name"] == "comfy-kitchen")
    assert package["status"] == "broken"
    assert package["import_error"] == "No module named 'comfy_kitchen'"
    assert package in diagnosis["blocking_issues"]


def test_environment_diagnosis_is_ready_without_issues():
    diagnosis = build_environment_diagnosis(
        {name: "1.0.0" for name in {
            "aiohttp", "comfy-aimdo", "comfy-kitchen", "einops", "numpy",
            "Pillow", "safetensors", "torch", "torchvision", "transformers",
        }},
    )

    assert diagnosis["status"] == "ready"
    assert diagnosis["summary"] == "环境检查通过"
    assert diagnosis["issues"] == []
    assert diagnosis["blocking_issues"] == []
    assert diagnosis["runtime_ready"] is True
    assert diagnosis["next_steps"] == []


def test_hardware_recommendation_is_conservative_for_8gb_gpu():
    recommendation = build_hardware_recommendation([{
        "name": "RTX 4060",
        "type": "cuda",
        "vram_total": 8 * 1024 ** 3,
        "vram_free": 7 * 1024 ** 3,
    }])

    assert recommendation["tier"] == "standard"
    assert recommendation["device"] == "RTX 4060"
    assert recommendation["vram_free_gb"] == 7.0
    assert recommendation["recommended"] == {
        "precision": "fp16",
        "quantization": "fp8_or_4bit",
        "batch_size": 1,
        "max_resolution": 1024,
        "vae_tiling": True,
        "cpu_offload": True,
    }


def test_hardware_recommendation_handles_cpu_only_runtime():
    recommendation = build_hardware_recommendation([{
        "name": "CPU",
        "type": "cpu",
        "vram_total": 0,
    }])

    assert recommendation["tier"] == "cpu"
    assert recommendation["recommended"]["cpu_offload"] is True


def test_environment_manager_caches_diagnosis_until_refresh(monkeypatch):
    calls = []

    def collect():
        calls.append(True)
        return {"status": "ready", "packages": []}

    monkeypatch.setattr("app.environment_manager.collect_environment_diagnosis", collect)
    manager = EnvironmentManager()

    assert manager.diagnose()["status"] == "ready"
    assert manager.diagnose()["status"] == "ready"
    assert manager.diagnose(refresh=True)["status"] == "ready"
    assert len(calls) == 2


def test_environment_manager_cli_prints_json(monkeypatch, capsys):
    monkeypatch.setattr(
        "app.environment_manager.collect_environment_diagnosis",
        lambda: {"status": "ready", "runtime_ready": True},
    )

    assert main() == 0
    output = capsys.readouterr().out
    assert '"status": "ready"' in output


@pytest.mark.asyncio
async def test_environment_diagnosis_route_is_local_json(aiohttp_client, app, monkeypatch):
    monkeypatch.setattr(
        "app.environment_manager.collect_environment_diagnosis",
        lambda: {"status": "ready", "local_only": True},
    )
    client = await aiohttp_client(app)

    response = await client.get("/environment/diagnose")

    assert response.status == 200
    assert await response.json() == {"status": "ready", "local_only": True}
