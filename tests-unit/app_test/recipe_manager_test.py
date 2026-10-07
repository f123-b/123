import pytest
from aiohttp import web

from app.recipe_manager import RecipeManager


pytestmark = pytest.mark.asyncio


class FakeUserManager:
    def __init__(self, root):
        self.root = root

    def get_request_user_filepath(self, request, file, type="userdata", create_dir=True):
        assert type == "userdata"
        path = self.root if file is None else self.root / file
        if create_dir:
            path.parent.mkdir(parents=True, exist_ok=True)
        return str(path)


@pytest.fixture
def app(tmp_path):
    manager = RecipeManager(FakeUserManager(tmp_path / "default"))
    app = web.Application()
    app["recipe_manager"] = manager
    routes = web.RouteTableDef()
    manager.add_routes(routes)
    app.add_routes(routes)
    return app


async def test_recipe_crud_normalizes_workflow(aiohttp_client, app):
    client = await aiohttp_client(app)
    workflow = {"1": {"class_type": "LoadImage", "inputs": {}}}

    response = await client.post(
        "/recipes",
        json={
            "id": "product-white",
            "name": "商品白底图",
            "category": "电商",
            "workflow": workflow,
            "parameters": {
                "background": {
                    "node_id": "1",
                    "input": "image",
                    "default": "white.png",
                },
            },
        },
    )
    assert response.status == 201
    created = await response.json()
    assert created["workflow"] == workflow

    response = await client.get("/recipes")
    assert response.status == 200
    summaries = await response.json()
    assert summaries[0]["name"] == "商品白底图"
    assert "workflow" not in summaries[0]

    response = await client.get("/recipes/product-white")
    assert response.status == 200
    assert (await response.json())["parameters"] == {
        "background": {
            "node_id": "1",
            "input": "image",
            "default": "white.png",
        },
    }

    response = await client.post(
        "/recipes/product-white/prepare",
        json={"values": {"background": "input.png"}},
    )
    assert response.status == 200
    prepared = await response.json()
    assert prepared["prompt"]["1"]["inputs"]["image"] == "input.png"
    assert prepared["applied_parameters"] == ["background"]

    response = await client.post("/recipes/product-white/prepare", json={"values": {}})
    assert response.status == 200
    assert (await response.json())["prompt"]["1"]["inputs"]["image"] == "white.png"

    response = await client.put(
        "/recipes/product-white",
        json={"name": "商品白底图 V2", "workflow": workflow},
    )
    assert response.status == 200
    assert (await response.json())["name"] == "商品白底图 V2"

    response = await client.delete("/recipes/product-white")
    assert response.status == 204
    assert (await client.get("/recipes/product-white")).status == 404


async def test_recipe_fork_preserves_workflow_and_allows_metadata_override(aiohttp_client, app):
    client = await aiohttp_client(app)
    workflow = {"1": {"class_type": "LoadImage", "inputs": {}}}
    await client.post(
        "/recipes",
        json={
            "id": "source",
            "name": "原始配方",
            "workflow": workflow,
            "parameters": {"image": {"node_id": "1", "input": "image"}},
        },
    )

    response = await client.post(
        "/recipes/source/fork",
        json={"id": "source-v2", "name": "第二版", "tags": ["迭代"]},
    )

    assert response.status == 201
    forked = await response.json()
    assert forked["id"] == "source-v2"
    assert forked["name"] == "第二版"
    assert forked["tags"] == ["迭代"]
    assert forked["workflow"] == workflow
    assert forked["parameters"]["image"]["node_id"] == "1"


async def test_recipe_applies_explicit_model_and_lora_bindings(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "bound-assets",
            "workflow": {
                "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
                "2": {"class_type": "LoraLoader", "inputs": {}},
            },
            "model": {
                "node_id": "1",
                "input": "ckpt_name",
                "value": "flux.safetensors",
            },
            "loras": [{
                "node_id": "2",
                "input": "lora_name",
                "name": "cinematic.safetensors",
            }],
        },
    )
    assert response.status == 201

    response = await client.post("/recipes/bound-assets/prepare", json={"values": {}})
    assert response.status == 200
    prompt = (await response.json())["prompt"]
    assert prompt["1"]["inputs"]["ckpt_name"] == "flux.safetensors"
    assert prompt["2"]["inputs"]["lora_name"] == "cinematic.safetensors"


async def test_recipe_execution_metadata_preserves_values_and_recovery():
    values = {"prompt": {"text": "cinematic"}}
    metadata = RecipeManager.build_execution_metadata(
        "poster",
        values,
        batch_index=2,
        recovery={"applied_changes": [{"change": "batch_size"}]},
    )
    values["prompt"]["text"] = "changed-after-queue"

    assert metadata == {
        "recipe_id": "poster",
        "recipe_values": {"prompt": {"text": "cinematic"}},
        "batch_index": 2,
        "recipe_recovery": {"applied_changes": [{"change": "batch_size"}]},
    }


async def test_recipe_history_filter_uses_execution_metadata():
    history = {
        "job-1": {"prompt": [0, "job-1", {}, {"recipe_id": "poster", "recipe_values": {"seed": 1}}]},
        "job-2": {"prompt": [1, "job-2", {}, {"recipe_id": "other", "recipe_values": {}}]},
        "job-3": {"prompt": [2, "job-3", {}, {"recipe_id": "poster", "recipe_values": {"seed": 3}}]},
    }

    selected, total = RecipeManager.filter_execution_history(
        history, "poster", offset=1, limit=1
    )

    assert total == 2
    assert list(selected) == ["job-3"]


async def test_recipe_recommendation_ranks_local_candidates(aiohttp_client, app):
    client = await aiohttp_client(app)
    workflow = {"1": {"class_type": "Canvas", "inputs": {}}}
    for recipe in (
        {
            "id": "portrait",
            "name": "电影感人像",
            "category": "人物",
            "description": "生成电影感人物海报",
            "tags": ["人像", "海报"],
            "workflow": workflow,
        },
        {
            "id": "product",
            "name": "商品白底图",
            "category": "电商",
            "description": "生成商品摄影棚图片",
            "tags": ["商品", "白底"],
            "workflow": workflow,
        },
    ):
        response = await client.post("/recipes", json=recipe)
        assert response.status == 201

    response = await client.get("/recipes/recommend?task=帮我做电影感人物海报")
    assert response.status == 200
    recommendation = await response.json()
    assert recommendation["local_only"] is True
    assert recommendation["results"][0]["id"] == "portrait"
    assert recommendation["results"][0]["score"] > recommendation["results"][1]["score"]
    assert "名称匹配" in recommendation["results"][0]["reasons"]

    response = await client.get("/recipes/recommend?task=图片&category=电商")
    assert response.status == 200
    assert [item["id"] for item in (await response.json())["results"]] == ["product"]


async def test_recipe_rejects_path_like_ids(aiohttp_client, app):
    client = await aiohttp_client(app)

    response = await client.post(
        "/recipes",
        json={
            "id": "../outside",
            "name": "非法配方",
            "workflow": {"1": {"class_type": "LoadImage", "inputs": {}}},
        },
    )

    assert response.status == 400


async def test_recipe_renders_prompt_template(aiohttp_client, app):
    client = await aiohttp_client(app)
    workflow = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "old"}},
    }

    response = await client.post(
        "/recipes",
        json={
            "id": "poster",
            "prompt_template": "a {subject} on a {background} background",
            "workflow": workflow,
            "parameters": {
                "prompt": {"node_id": "1", "input": "text", "template": True},
                "subject": {},
                "background": {"default": "white"},
            },
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/poster/prepare",
        json={"values": {"subject": "product", "background": "gray"}},
    )
    assert response.status == 200
    prepared = await response.json()
    assert prepared["prompt"]["1"]["inputs"]["text"] == "a product on a gray background"


async def test_recipe_reports_missing_prompt_template_value(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "poster-missing",
            "prompt_template": "a {subject}",
            "workflow": {"1": {"class_type": "CLIPTextEncode", "inputs": {}}},
            "parameters": {
                "prompt": {"node_id": "1", "input": "text", "template": True},
                "subject": {},
            },
        },
    )
    assert response.status == 201

    response = await client.post("/recipes/poster-missing/prepare", json={"values": {}})
    assert response.status == 400
    assert "subject" in (await response.json())["error"]


async def test_recipe_rejects_values_outside_declared_choices(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "ratio",
            "workflow": {"1": {"class_type": "Canvas", "inputs": {}}},
            "parameters": {
                "ratio": {
                    "node_id": "1",
                    "input": "ratio",
                    "choices": ["1:1", "16:9"],
                    "default": "1:1",
                },
            },
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/ratio/prepare",
        json={"values": {"ratio": "4:3"}},
    )
    assert response.status == 400
    assert "ratio" in (await response.json())["error"]


async def test_recipe_reports_missing_required_parameter(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "required-subject",
            "workflow": {"1": {"class_type": "Canvas", "inputs": {}}},
            "parameters": {
                "subject": {
                    "node_id": "1",
                    "input": "subject",
                    "required": True,
                },
            },
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/required-subject/prepare",
        json={"values": {}},
    )
    assert response.status == 400
    assert "subject" in (await response.json())["error"]


async def test_recipe_validates_declared_parameter_type(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "typed-size",
            "workflow": {"1": {"class_type": "Canvas", "inputs": {}}},
            "parameters": {
                "width": {
                    "node_id": "1",
                    "input": "width",
                    "type": "integer",
                    "default": 1024,
                },
            },
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/typed-size/prepare",
        json={"values": {"width": "1024"}},
    )
    assert response.status == 400
    assert "width" in (await response.json())["error"]

    response = await client.post(
        "/recipes/typed-size/prepare",
        json={"values": {"width": 768}},
    )
    assert response.status == 200
    assert (await response.json())["prompt"]["1"]["inputs"]["width"] == 768


async def test_recipe_accepts_simple_mode_asset_input_types(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "asset-input",
            "workflow": {"1": {"class_type": "LoadImage", "inputs": {}}},
            "parameters": {
                "image": {
                    "node_id": "1",
                    "input": "image",
                    "type": "image",
                    "required": True,
                },
            },
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/asset-input/prepare",
        json={"values": {"image": "input.png"}},
    )
    assert response.status == 200
    assert (await response.json())["prompt"]["1"]["inputs"]["image"] == "input.png"


async def test_recipe_resolves_explicit_asset_reference_with_local_resolver(tmp_path):
    manager = RecipeManager(
        FakeUserManager(tmp_path / "default"),
        asset_resolver=lambda parameter_type, value: "uploaded.png [input]",
    )
    request = object()
    recipe = manager._build_recipe(
        "asset-resolve",
        {
            "workflow": {"1": {"class_type": "LoadImage", "inputs": {}}},
            "parameters": {
                "image": {
                    "node_id": "1",
                    "input": "image",
                    "type": "image",
                    "required": True,
                },
            },
        },
    )
    prompt, applied, unknown = manager._prepare_prompt(
        recipe, {"image": "asset:00000000-0000-0000-0000-000000000001"}
    )

    assert prompt["1"]["inputs"]["image"] == "uploaded.png [input]"
    assert applied == ["image"]
    assert unknown == []


async def test_recipe_prepares_batch_with_per_item_results(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "batch-size",
            "workflow": {"1": {"class_type": "Canvas", "inputs": {}}},
            "parameters": {
                "width": {
                    "node_id": "1",
                    "input": "width",
                    "type": "integer",
                    "required": True,
                },
            },
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/batch-size/prepare-batch",
        json={"values": [{"width": 512}, {"width": "bad"}, {}]},
    )
    assert response.status == 200
    prepared = await response.json()
    assert prepared["count"] == 3
    assert prepared["valid_count"] == 1
    assert prepared["items"][0]["prompt"]["1"]["inputs"]["width"] == 512
    assert "width" in prepared["items"][1]["error"]
    assert "width" in prepared["items"][2]["error"]


async def test_recipe_rejects_empty_batch(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "empty-batch",
            "workflow": {"1": {"class_type": "Canvas", "inputs": {}}},
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/empty-batch/prepare-batch",
        json={"values": []},
    )
    assert response.status == 400
    assert "不能为空" in (await response.json())["error"]


async def test_recipe_schema_exposes_simple_mode_inputs(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "schema-recipe",
            "prompt_template": "a {subject}",
            "workflow": {"1": {"class_type": "Canvas", "inputs": {}}},
            "parameters": {
                "subject": {
                    "node_id": "1",
                    "input": "text",
                    "label": "主体",
                    "description": "要生成的主体",
                    "type": "string",
                    "required": True,
                },
                "ratio": {
                    "node_id": "1",
                    "input": "ratio",
                    "type": "string",
                    "default": "1:1",
                    "choices": ["1:1", "16:9"],
                    "role": "ratio",
                },
            },
        },
    )
    assert response.status == 201

    response = await client.get("/recipes/schema-recipe/schema")
    assert response.status == 200
    schema = await response.json()
    assert schema["prompt_template"] == "a {subject}"
    assert schema["inputs"] == [
        {
            "name": "subject",
            "label": "主体",
            "description": "要生成的主体",
            "type": "string",
            "required": True,
        },
        {
            "name": "ratio",
            "label": "ratio",
            "description": "",
            "type": "string",
            "required": False,
            "role": "ratio",
            "default": "1:1",
            "choices": ["1:1", "16:9"],
        },
    ]


async def test_recipe_prepares_oom_recovery_values(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/recipes",
        json={
            "id": "recovery-recipe",
            "workflow": {
                "1": {"class_type": "Canvas", "inputs": {}},
            },
            "parameters": {
                "width": {"node_id": "1", "input": "width", "type": "integer", "default": 1024, "role": "width"},
                "height": {"node_id": "1", "input": "height", "type": "integer", "default": 1024, "role": "height"},
                "batch": {"node_id": "1", "input": "batch", "type": "integer", "default": 4, "role": "batch_size"},
                "seed": {"node_id": "1", "input": "seed", "type": "integer", "default": 42},
            },
        },
    )
    assert response.status == 201

    response = await client.post(
        "/recipes/recovery-recipe/prepare-recovery",
        json={
            "values": {},
            "recovery": {
                "action": "reduce_resolution",
                "changes": {"resolution_scale": 0.75, "batch_size": 1, "vae_tiling": True},
            },
        },
    )
    assert response.status == 200
    prepared = await response.json()
    assert prepared["values"] == {"width": 768, "height": 768, "batch": 1}
    assert len(prepared["applied_changes"]) == 3
    assert prepared["ignored_changes"] == ["vae_tiling"]

    prepared_for_queue = app["recipe_manager"].prepare_for_queue(
        None,
        "recovery-recipe",
        {},
        {
            "changes": {
                "resolution_scale": 0.5,
                "batch_size": 1,
            },
        },
    )
    assert prepared_for_queue["values"] == {"width": 512, "height": 512, "batch": 1}
    assert len(prepared_for_queue["applied_changes"]) == 3

    response = await client.post(
        "/recipes/recovery-recipe/prepare-batch",
        json={
            "values": [{}, {"width": 640, "height": 480, "batch": 2}],
            "recovery": {"changes": {"resolution_scale": 0.5, "batch_size": 1}},
        },
    )
    assert response.status == 200
    prepared_batch = await response.json()
    assert prepared_batch["valid_count"] == 2
    assert prepared_batch["items"][0]["prompt"]["1"]["inputs"]["width"] == 512
    assert prepared_batch["items"][1]["prompt"]["1"]["inputs"]["width"] == 320
    assert len(prepared_batch["items"][0]["applied_changes"]) == 3
