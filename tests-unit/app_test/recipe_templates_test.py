import pytest
from aiohttp import web

from app.recipe_manager import RecipeManager
from app.recipe_templates import get_template, list_templates


pytestmark = pytest.mark.asyncio


class FakeUserManager:
    def __init__(self, root):
        self.root = root

    def get_request_user_filepath(self, request, file, type="userdata", create_dir=True):
        path = self.root if file is None else self.root / file
        if create_dir:
            path.parent.mkdir(parents=True, exist_ok=True)
        return str(path)


@pytest.fixture
def app(tmp_path):
    manager = RecipeManager(FakeUserManager(tmp_path / "default"))
    app = web.Application()
    routes = web.RouteTableDef()
    manager.add_routes(routes)
    app.add_routes(routes)
    return app


async def test_template_catalog_includes_safe_unavailable_video_entry():
    templates = {item["id"]: item for item in list_templates()}

    assert templates["text-to-image-basic"]["available"] is True
    assert templates["wan-video-first-frame"]["available"] is False
    assert "workflow" not in templates["text-to-image-basic"]
    assert get_template("text-to-image-basic")["workflow"]["4"]["class_type"] == "CheckpointLoaderSimple"


async def test_copy_recipe_template_creates_local_recipe(aiohttp_client, app):
    client = await aiohttp_client(app)

    response = await client.post(
        "/recipes/templates/text-to-image-basic/copy",
        json={"id": "basic-local", "name": "我的文生图"},
    )

    assert response.status == 201
    recipe = await response.json()
    assert recipe["id"] == "basic-local"
    assert recipe["name"] == "我的文生图"
    assert recipe["workflow"]["3"]["class_type"] == "KSampler"


async def test_copy_unavailable_video_template_is_blocked(aiohttp_client, app):
    client = await aiohttp_client(app)

    response = await client.post("/recipes/templates/wan-video-first-frame/copy", json={})

    assert response.status == 409
