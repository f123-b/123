import pytest
from aiohttp import web

from app.project_manager import ProjectManager


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
    manager = ProjectManager(FakeUserManager(tmp_path / "default"))
    app = web.Application()
    routes = web.RouteTableDef()
    manager.add_routes(routes)
    app.add_routes(routes)
    return app


async def test_project_crud_and_item_references(aiohttp_client, app):
    client = await aiohttp_client(app)
    response = await client.post(
        "/projects",
        json={"id": "social-campaign", "name": "社媒宣传", "tags": ["小红书"]},
    )
    assert response.status == 201
    project = await response.json()
    assert project["items"] == []

    response = await client.post(
        "/projects/social-campaign/items",
        json={
            "id": "cover-v1",
            "type": "image",
            "label": "封面初稿",
            "asset_id": "asset-123",
            "prompt_id": "prompt-123",
        },
    )
    assert response.status == 201
    assert (await response.json())["asset_id"] == "asset-123"

    response = await client.get("/projects/social-campaign")
    project = await response.json()
    assert response.status == 200
    assert project["items"][0]["id"] == "cover-v1"

    response = await client.get("/projects")
    assert response.status == 200
    assert (await response.json())[0]["item_count"] == 1

    response = await client.delete("/projects/social-campaign/items/cover-v1")
    assert response.status == 204

    response = await client.delete("/projects/social-campaign")
    assert response.status == 204
    assert (await client.get("/projects/social-campaign")).status == 404


async def test_project_rejects_invalid_item_type(aiohttp_client, app):
    client = await aiohttp_client(app)
    await client.post("/projects", json={"id": "demo", "name": "Demo"})

    response = await client.post(
        "/projects/demo/items", json={"type": "not-a-project-item"}
    )

    assert response.status == 400
    assert "type" in (await response.json())["error"]


async def test_project_update_rejects_malformed_items(aiohttp_client, app):
    client = await aiohttp_client(app)
    await client.post("/projects", json={"id": "demo", "name": "Demo"})

    response = await client.put(
        "/projects/demo",
        json={"items": [{"id": "bad", "type": "image", "metadata": []}]},
    )

    assert response.status == 400
    assert "metadata" in (await response.json())["error"]
