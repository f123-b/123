from app.workflow_repair import apply_local_repair_actions


class FakeNodeReplacements:
    def has_replacement(self, class_type):
        return class_type == "OldNode"

    def apply_replacements(self, prompt, node_ids=None):
        for node_id in node_ids or prompt:
            if prompt[node_id]["class_type"] == "OldNode":
                prompt[node_id]["class_type"] = "NewNode"


class FakeCustomNodes:
    def __init__(self):
        self.enabled = []

    def enable_node(self, node_name):
        self.enabled.append(node_name)
        return {
            "name": node_name,
            "status": "enabled",
            "requires_restart": True,
        }


class FakeModels:
    def search_models(self, name, folder):
        if name == "missing.safetensors":
            return [{"name": "flux-dev.safetensors", "folder": folder, "match": "partial"}]
        return [{"name": "flux-dev.safetensors", "folder": folder, "match": "exact"}]


def test_apply_local_repairs_orders_replacements_before_model_selection():
    prompt = {
        "1": {"class_type": "OldNode", "inputs": {}},
        "2": {"class_type": "Loader", "inputs": {"ckpt_name": "old.safetensors"}},
    }

    result = apply_local_repair_actions(
        prompt,
        [
            {
                "action": "select_local_model",
                "node_id": "2",
                "input_name": "ckpt_name",
                "model_name": "flux",
                "model_folder": "checkpoints",
            },
            {"action": "replace_node", "node_id": "1"},
            {"action": "enable_custom_node", "node_name": "example-node"},
        ],
        FakeNodeReplacements(),
        FakeCustomNodes(),
        FakeModels(),
    )

    assert prompt["1"]["class_type"] == "NewNode"
    assert prompt["2"]["inputs"]["ckpt_name"] == "flux-dev.safetensors"
    assert [item["status"] for item in result["actions"]] == [
        "applied", "applied", "applied"
    ]
    assert result["requires_restart"] is True


def test_apply_local_repairs_requires_selected_candidate_for_partial_model():
    prompt = {"1": {"class_type": "Loader", "inputs": {}}}

    result = apply_local_repair_actions(
        prompt,
        [
            {
                "action": "select_local_model",
                "node_id": "1",
                "input_name": "ckpt_name",
                "model_name": "missing.safetensors",
                "model_folder": "checkpoints",
            },
            {"action": "install_model", "model_name": "missing.safetensors"},
        ],
        FakeNodeReplacements(),
        FakeCustomNodes(),
        FakeModels(),
    )

    assert result["actions"][0]["status"] == "failed"
    assert "选择候选模型" in result["actions"][0]["message"]
    assert prompt["1"]["inputs"] == {}


def test_apply_local_repairs_only_replaces_confirmed_nodes():
    prompt = {
        "1": {"class_type": "OldNode", "inputs": {}},
        "2": {"class_type": "OldNode", "inputs": {}},
    }

    result = apply_local_repair_actions(
        prompt,
        [{"action": "replace_node", "node_id": "1"}],
        FakeNodeReplacements(),
        FakeCustomNodes(),
        FakeModels(),
    )

    assert result["actions"][0]["status"] == "applied"
    assert prompt["1"]["class_type"] == "NewNode"
    assert prompt["2"]["class_type"] == "OldNode"


def test_apply_local_repairs_rejects_unknown_replacement_target():
    prompt = {"1": {"class_type": "OldNode", "inputs": {}}}

    result = apply_local_repair_actions(
        prompt,
        [{"action": "replace_node", "node_id": "missing"}],
        FakeNodeReplacements(),
        FakeCustomNodes(),
        FakeModels(),
    )

    assert result["actions"][0]["status"] == "failed"
    assert "不存在" in result["actions"][0]["message"]
    assert prompt["1"]["class_type"] == "OldNode"


def test_apply_local_repairs_rejects_stale_replacement_class_type():
    prompt = {"1": {"class_type": "NewNode", "inputs": {}}}

    result = apply_local_repair_actions(
        prompt,
        [{
            "action": "replace_node",
            "node_id": "1",
            "class_type": "OldNode",
        }],
        FakeNodeReplacements(),
        FakeCustomNodes(),
        FakeModels(),
    )

    assert result["actions"][0]["status"] == "failed"
    assert "不匹配" in result["actions"][0]["message"]
    assert prompt["1"]["class_type"] == "NewNode"


def test_apply_local_repairs_accepts_selected_local_candidate():
    prompt = {"1": {"class_type": "Loader", "inputs": {}}}

    result = apply_local_repair_actions(
        prompt,
        [{
            "action": "select_local_model",
            "node_id": "1",
            "input_name": "ckpt_name",
            "model_name": "missing.safetensors",
            "model_folder": "checkpoints",
            "selected_model": {
                "name": "flux-dev.safetensors",
                "folder": "checkpoints",
            },
        }],
        FakeNodeReplacements(),
        FakeCustomNodes(),
        FakeModels(),
    )

    assert result["actions"][0]["status"] == "applied"
    assert prompt["1"]["inputs"]["ckpt_name"] == "flux-dev.safetensors"


def test_apply_local_repairs_still_rejects_external_install():
    prompt = {"1": {"class_type": "Loader", "inputs": {}}}

    result = apply_local_repair_actions(
        prompt,
        [{"action": "install_model", "model_name": "missing.safetensors"}],
        FakeNodeReplacements(),
        FakeCustomNodes(),
        FakeModels(),
    )

    assert result["actions"][0]["status"] == "unavailable"


def test_apply_local_repairs_defers_node_enable_until_prompt_actions():
    events = []
    prompt = {
        "1": {"class_type": "Loader", "inputs": {}},
    }

    class OrderedCustomNodes:
        def enable_node(self, node_name):
            events.append(prompt["1"]["inputs"].get("ckpt_name"))
            return {"name": node_name, "status": "enabled", "requires_restart": True}

    result = apply_local_repair_actions(
        prompt,
        [
            {"action": "enable_custom_node", "node_name": "example-node"},
            {
                "action": "select_local_model",
                "node_id": "1",
                "input_name": "ckpt_name",
                "model_name": "missing.safetensors",
                "model_folder": "checkpoints",
                "selected_model_name": "flux-dev.safetensors",
            },
        ],
        FakeNodeReplacements(),
        OrderedCustomNodes(),
        FakeModels(),
    )

    assert result["actions"][-1]["action"] == "enable_custom_node"
    assert events == ["flux-dev.safetensors"]


def test_apply_local_repairs_skips_node_enable_after_failed_action():
    custom_nodes = FakeCustomNodes()
    prompt = {"1": {"class_type": "Loader", "inputs": {}}}

    result = apply_local_repair_actions(
        prompt,
        [
            {"action": "enable_custom_node", "node_name": "example-node"},
            {"action": "install_model", "model_name": "missing.safetensors"},
        ],
        FakeNodeReplacements(),
        custom_nodes,
        FakeModels(),
    )

    assert custom_nodes.enabled == []
    assert result["actions"][-1]["status"] == "failed"
    assert "前置修复未完成" in result["actions"][-1]["message"]
