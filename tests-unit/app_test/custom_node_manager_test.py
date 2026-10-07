import pytest
import sys
from aiohttp import web
from unittest.mock import patch
from app.custom_node_manager import CustomNodeManager
import json

pytestmark = (
    pytest.mark.asyncio
)  # This applies the asyncio mark to all test functions in the module


@pytest.fixture
def custom_node_manager():
    return CustomNodeManager()


@pytest.fixture
def app(custom_node_manager):
    app = web.Application()
    routes = web.RouteTableDef()
    custom_node_manager.add_routes(
        routes, app, [("ComfyUI-TestExtension1", "ComfyUI-TestExtension1")]
    )
    app.add_routes(routes)
    return app


async def test_get_workflow_templates(aiohttp_client, app, tmp_path):
    client = await aiohttp_client(app)
    # Setup temporary custom nodes file structure with 1 workflow file
    custom_nodes_dir = tmp_path / "custom_nodes"
    example_workflows_dir = (
        custom_nodes_dir / "ComfyUI-TestExtension1" / "example_workflows"
    )
    example_workflows_dir.mkdir(parents=True)
    template_file = example_workflows_dir / "workflow1.json"
    template_file.write_text("")

    with patch(
        "folder_paths.folder_names_and_paths",
        {"custom_nodes": ([str(custom_nodes_dir)], None)},
    ):
        response = await client.get("/workflow_templates")
        assert response.status == 200
        workflows_dict = await response.json()
        assert isinstance(workflows_dict, dict)
        assert "ComfyUI-TestExtension1" in workflows_dict
        assert isinstance(workflows_dict["ComfyUI-TestExtension1"], list)
        assert workflows_dict["ComfyUI-TestExtension1"][0] == "workflow1"


async def test_get_custom_node_catalog_reports_install_state(aiohttp_client, app, tmp_path):
    custom_nodes_dir = tmp_path / "custom_nodes"
    (custom_nodes_dir / "loaded-node").mkdir(parents=True)
    (custom_nodes_dir / "loaded-node" / "requirements.txt").write_text(
        "example-dependency\n", encoding="utf-8"
    )
    (custom_nodes_dir / "disabled-node.disabled").mkdir(parents=True)
    (custom_nodes_dir / "single_node.py").write_text("NODE_CLASS_MAPPINGS = {}")

    with patch(
        "folder_paths.get_folder_paths", return_value=[str(custom_nodes_dir)]
    ):
        loaded_catalog = CustomNodeManager.get_node_catalog([
            ("single_node.py", str(custom_nodes_dir)),
        ])
        failed_catalog = CustomNodeManager.get_node_catalog(
            [],
            [("loaded-node", {
                "path": str(custom_nodes_dir / "loaded-node"),
                "error_type": "ModuleNotFoundError",
                "message": "No module named 'example_dep'",
            })],
        )
        client = await aiohttp_client(app)
        response = await client.get("/custom_nodes/catalog")

    assert response.status == 200
    catalog = {entry["name"]: entry["status"] for entry in await response.json()}
    assert catalog["loaded-node"] == "installed"
    assert catalog["disabled-node"] == "disabled"
    assert catalog["single_node"] == "installed"
    assert {entry["name"]: entry["status"] for entry in loaded_catalog}["single_node"] == "loaded"
    failed_entry = {entry["name"]: entry for entry in failed_catalog}["loaded-node"]
    assert failed_entry["status"] == "failed"
    assert failed_entry["error_type"] == "ModuleNotFoundError"
    assert failed_entry["error"] == "节点依赖缺失"
    assert failed_entry["error_detail"] == "No module named 'example_dep'"
    assert failed_entry["missing_dependency"] == "example_dep"
    assert failed_entry["requirements_available"] is True


async def test_enable_custom_node_renames_disabled_package(aiohttp_client, app, tmp_path):
    custom_nodes_dir = tmp_path / "custom_nodes"
    disabled_path = custom_nodes_dir / "disabled-node.disabled"
    disabled_path.mkdir(parents=True)

    with patch(
        "folder_paths.get_folder_paths", return_value=[str(custom_nodes_dir)]
    ):
        client = await aiohttp_client(app)
        response = await client.post("/custom_nodes/disabled-node/enable")

    assert response.status == 200
    assert await response.json() == {
        "name": "disabled-node",
        "status": "enabled",
        "requires_restart": True,
    }
    assert not disabled_path.exists()
    assert (custom_nodes_dir / "disabled-node").is_dir()


async def test_get_custom_node_requirements_reads_local_manifest(aiohttp_client, app, tmp_path):
    custom_nodes_dir = tmp_path / "custom_nodes"
    node_dir = custom_nodes_dir / "example-node"
    node_dir.mkdir(parents=True)
    (node_dir / "requirements.txt").write_text(
        "# local dependency\nexample-package>=1.0\n\nsecond-package==2.0\n",
        encoding="utf-8",
    )

    with patch(
        "folder_paths.get_folder_paths", return_value=[str(custom_nodes_dir)]
    ):
        client = await aiohttp_client(app)
        response = await client.get("/custom_nodes/example-node/requirements")

    assert response.status == 200
    payload = await response.json()
    assert payload == {
        "name": "example-node",
        "requirements_file": "requirements.txt",
        "packages": ["example-package>=1.0", "second-package==2.0"],
        "package_status": [
            {
                "requirement": "example-package>=1.0",
                "name": "example-package",
                "installed": None,
                "status": "missing",
            },
            {
                "requirement": "second-package==2.0",
                "name": "second-package",
                "installed": None,
                "status": "missing",
            },
        ],
        "missing_packages": ["example-package", "second-package"],
        "python": sys.executable,
        "local_only": True,
    }


async def test_build_translations_empty_when_no_locales(custom_node_manager, tmp_path):
    custom_nodes_dir = tmp_path / "custom_nodes"
    custom_nodes_dir.mkdir(parents=True)

    with patch("folder_paths.get_folder_paths", return_value=[str(custom_nodes_dir)]):
        translations = custom_node_manager.build_translations()
        assert translations == {}


async def test_build_translations_loads_all_files(custom_node_manager, tmp_path):
    # Setup test directory structure
    custom_nodes_dir = tmp_path / "custom_nodes" / "test-extension"
    locales_dir = custom_nodes_dir / "locales" / "en"
    locales_dir.mkdir(parents=True)

    # Create test translation files
    main_content = {"title": "Test Extension"}
    (locales_dir / "main.json").write_text(json.dumps(main_content))

    node_defs = {"node1": "Node 1"}
    (locales_dir / "nodeDefs.json").write_text(json.dumps(node_defs))

    commands = {"cmd1": "Command 1"}
    (locales_dir / "commands.json").write_text(json.dumps(commands))

    settings = {"setting1": "Setting 1"}
    (locales_dir / "settings.json").write_text(json.dumps(settings))

    with patch(
        "folder_paths.get_folder_paths", return_value=[tmp_path / "custom_nodes"]
    ):
        translations = custom_node_manager.build_translations()

        assert translations == {
            "en": {
                "title": "Test Extension",
                "nodeDefs": {"node1": "Node 1"},
                "commands": {"cmd1": "Command 1"},
                "settings": {"setting1": "Setting 1"},
            }
        }


async def test_build_translations_handles_invalid_json(custom_node_manager, tmp_path):
    # Setup test directory structure
    custom_nodes_dir = tmp_path / "custom_nodes" / "test-extension"
    locales_dir = custom_nodes_dir / "locales" / "en"
    locales_dir.mkdir(parents=True)

    # Create valid main.json
    main_content = {"title": "Test Extension"}
    (locales_dir / "main.json").write_text(json.dumps(main_content))

    # Create invalid JSON file
    (locales_dir / "nodeDefs.json").write_text("invalid json{")

    with patch(
        "folder_paths.get_folder_paths", return_value=[tmp_path / "custom_nodes"]
    ):
        translations = custom_node_manager.build_translations()

        assert translations == {
            "en": {
                "title": "Test Extension",
            }
        }


async def test_build_translations_merges_multiple_extensions(
    custom_node_manager, tmp_path
):
    # Setup test directory structure for two extensions
    custom_nodes_dir = tmp_path / "custom_nodes"
    ext1_dir = custom_nodes_dir / "extension1" / "locales" / "en"
    ext2_dir = custom_nodes_dir / "extension2" / "locales" / "en"
    ext1_dir.mkdir(parents=True)
    ext2_dir.mkdir(parents=True)

    # Create translation files for extension 1
    ext1_main = {"title": "Extension 1", "shared": "Original"}
    (ext1_dir / "main.json").write_text(json.dumps(ext1_main))

    # Create translation files for extension 2
    ext2_main = {"description": "Extension 2", "shared": "Override"}
    (ext2_dir / "main.json").write_text(json.dumps(ext2_main))

    with patch("folder_paths.get_folder_paths", return_value=[str(custom_nodes_dir)]):
        translations = custom_node_manager.build_translations()

        assert translations == {
            "en": {
                "title": "Extension 1",
                "description": "Extension 2",
                "shared": "Override",  # Second extension should override first
            }
        }
