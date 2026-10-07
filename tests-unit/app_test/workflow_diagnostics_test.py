import pytest

from app.workflow_diagnostics import (
    add_environment_state,
    attach_runtime_diagnosis,
    add_local_dependency_state,
    build_repair_plan,
    build_diagnosis,
    build_repair_report,
    build_runtime_diagnosis,
    capture_repair_state,
    extract_prompt,
)


def test_extract_prompt_accepts_prompt_envelope():
    prompt = {"1": {"class_type": "LoadImage", "inputs": {}}}

    assert extract_prompt({"prompt": prompt}) == prompt


def test_extract_prompt_accepts_direct_prompt_graph():
    prompt = {"prompt": {"class_type": "LoadImage", "inputs": {}}}

    assert extract_prompt(prompt) == prompt


def test_extract_prompt_accepts_wrapped_graph_with_prompt_node_id():
    prompt = {"prompt": {"class_type": "LoadImage", "inputs": {}}}

    assert extract_prompt({"workflow": prompt}) == prompt


def test_extract_prompt_normalizes_ui_workflow_nodes_and_links():
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "SourceNode",
                "inputs": [
                    {"name": "value", "type": "STRING", "widget": {"name": "value"}},
                ],
                "widgets_values": ["hello"],
            },
            {
                "id": 2,
                "type": "OutputNode",
                "title": "输出",
                "properties": {"cnr_id": "example-pack"},
                "inputs": [
                    {"name": "value", "type": "STRING", "link": 9},
                ],
                "widgets_values": [],
            },
        ],
        "links": [[9, 1, 0, 2, 0, "STRING"]],
    }

    assert extract_prompt({"workflow": workflow}) == {
        "1": {"class_type": "SourceNode", "inputs": {"value": "hello"}},
        "2": {
            "class_type": "OutputNode",
            "inputs": {"value": ["1", 0]},
            "_meta": {"title": "输出", "node_pack": "example-pack"},
        },
    }


def test_extract_prompt_rejects_ui_link_to_unknown_node():
    workflow = {
        "nodes": [{
            "id": 2,
            "type": "OutputNode",
            "inputs": [{"name": "value", "link": 9}],
        }],
        "links": [[9, 1, 0, 2, 0, "STRING"]],
    }

    with pytest.raises(ValueError, match="指向不存在的节点"):
        extract_prompt(workflow)


def test_build_repair_report_describes_replaced_nodes():
    before = {"1": "OldNode"}
    prompt = {"1": {"class_type": "NewNode", "inputs": {}}}

    assert build_repair_report(before, prompt)[0]["message"] == "已自动替换节点：OldNode → NewNode"
    assert capture_repair_state(prompt) == {"1": "NewNode"}


def test_build_runtime_diagnosis_classifies_oom():
    diagnosis = build_runtime_diagnosis("torch.OutOfMemoryError", "CUDA out of memory")

    assert diagnosis["code"] == "gpu_oom"
    assert diagnosis["retryable"] is True
    assert diagnosis["next_steps"][0]["action"] == "reduce_resolution"
    assert diagnosis["recovery_plan"][0] == {
        "action": "reduce_resolution",
        "changes": {"resolution_scale": 0.75},
        "message": "将宽高缩小到当前的 75% 后重试",
    }


def test_build_runtime_diagnosis_classifies_missing_dependency():
    diagnosis = build_runtime_diagnosis("ModuleNotFoundError", "No module named 'example'")

    assert diagnosis["code"] == "python_dependency_missing"
    assert diagnosis["retryable"] is False
    assert diagnosis["next_steps"][0]["action"] == "inspect_node_requirements"
    assert diagnosis["dependency"] == "example"


def test_build_runtime_diagnosis_classifies_execution_blocked():
    diagnosis = build_runtime_diagnosis("ExecutionBlocked", "Execution Blocked: condition")

    assert diagnosis["code"] == "execution_blocked"
    assert diagnosis["next_steps"][0]["action"] == "review_blocking_condition"


def test_build_runtime_diagnosis_classifies_device_mismatch():
    diagnosis = build_runtime_diagnosis(
        "RuntimeError",
        "Expected all tensors to be on the same device, but found at least two devices",
    )

    assert diagnosis["code"] == "device_mismatch"
    assert diagnosis["retryable"] is True
    assert diagnosis["next_steps"][0]["action"] == "review_device_placement"


def test_build_runtime_diagnosis_classifies_unavailable_gpu():
    diagnosis = build_runtime_diagnosis(
        "RuntimeError",
        "Found no NVIDIA driver on your system",
    )

    assert diagnosis["code"] == "gpu_unavailable"
    assert diagnosis["retryable"] is False
    assert diagnosis["next_steps"][0]["action"] == "review_hardware"


def test_attach_runtime_diagnosis_reuses_existing_diagnosis():
    data = {
        "exception_type": "RuntimeError",
        "exception_message": "CUDA out of memory",
    }

    result = attach_runtime_diagnosis(data)
    assert result is data
    assert result["diagnosis"]["code"] == "gpu_oom"

    existing = {"diagnosis": {"code": "custom"}}
    assert attach_runtime_diagnosis(existing)["diagnosis"]["code"] == "custom"


def test_build_diagnosis_collects_missing_nodes_and_models():
    prompt = {
        "1": {
            "class_type": "MissingNode",
            "_meta": {"title": "模型加载器", "node_pack": "missing-pack"},
        },
        "2": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "flux.safetensors"}},
    }
    validation = (
        False,
        {"type": "prompt_outputs_failed_validation", "message": "failed", "details": ""},
        [],
        {
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "errors": [{
                    "type": "value_not_in_list",
                    "message": "Value not in list",
                    "details": "ckpt_name: 'flux.safetensors'",
                    "extra_info": {
                        "input_name": "ckpt_name",
                        "received_value": "flux.safetensors",
                    },
                }],
            }
        },
    )

    diagnosis = build_diagnosis(prompt, validation, {"CheckpointLoaderSimple": object()})

    assert diagnosis["can_run"] is False
    assert diagnosis["summary"] == {"missing_nodes": 1, "missing_models": 1, "errors": 0, "repairs": 0}
    assert diagnosis["missing_nodes"][0]["message"] == "缺少节点：模型加载器"
    assert diagnosis["missing_nodes"][0]["node_pack"] == "missing-pack"
    assert diagnosis["missing_models"][0]["model_folder"] == "checkpoints"
    assert [step["type"] for step in diagnosis["next_steps"]] == [
        "node_dependency",
        "model_dependency",
    ]
    assert diagnosis["next_steps"][0]["action"] == "install_or_enable"


def test_build_diagnosis_exposes_validation_errors_in_user_facing_shape():
    prompt = {"1": {"class_type": "Node", "inputs": {}}}
    validation = (
        False,
        {"type": "prompt_outputs_failed_validation", "message": "failed", "details": ""},
        [],
        {
            "1": {
                "class_type": "Node",
                "errors": [{
                    "type": "required_input_missing",
                    "details": "prompt",
                    "extra_info": {"input_name": "prompt"},
                }],
            }
        },
    )

    diagnosis = build_diagnosis(prompt, validation, {"Node": object()})

    assert diagnosis["summary"]["errors"] == 1
    assert diagnosis["errors"][0]["message"] == "缺少必填参数：prompt"
    assert diagnosis["next_steps"][0]["action"] == "review_input"


def test_build_diagnosis_does_not_treat_linked_model_as_missing_file():
    prompt = {"1": {"class_type": "ApplyModel", "inputs": {"model": ["0", 0]}}}
    validation = (
        False,
        {"type": "prompt_outputs_failed_validation", "message": "failed", "details": ""},
        [],
        {
            "1": {
                "class_type": "ApplyModel",
                "errors": [{
                    "type": "value_not_in_list",
                    "details": "model: invalid",
                    "extra_info": {"input_name": "model", "received_value": "invalid"},
                }],
            }
        },
    )

    diagnosis = build_diagnosis(prompt, validation, {"ApplyModel": object()})

    assert diagnosis["missing_models"] == []
    assert diagnosis["summary"]["errors"] == 1


def test_build_diagnosis_marks_valid_workflow_ready_without_next_steps():
    prompt = {"1": {"class_type": "OutputNode", "inputs": {}}}
    validation = (True, None, ["1"], {})

    diagnosis = build_diagnosis(prompt, validation, {"OutputNode": object()})

    assert diagnosis["status"] == "ready"
    assert diagnosis["can_run"] is True
    assert diagnosis["next_steps"] == []


def test_build_diagnosis_keeps_completed_repairs_out_of_next_steps():
    prompt = {"1": {"class_type": "NewNode", "inputs": {}}}
    validation = (True, None, ["1"], {})
    repairs = [{"node_id": "1", "from": "OldNode", "to": "NewNode"}]

    diagnosis = build_diagnosis(prompt, validation, {"NewNode": object()}, repairs)

    assert diagnosis["summary"]["repairs"] == 1
    assert diagnosis["next_steps"] == []


def test_add_environment_state_exposes_runtime_preflight_without_rewriting_can_run():
    prompt = {"1": {"class_type": "OutputNode", "inputs": {}}}
    validation = (True, None, ["1"], {})
    diagnosis = build_diagnosis(prompt, validation, {"OutputNode": object()})

    add_environment_state(diagnosis, {
        "status": "attention",
        "runtime_ready": False,
        "next_steps": [{
            "action": "install_requirements",
            "label": "安装或更新依赖",
        }],
    })

    assert diagnosis["can_run"] is True
    assert diagnosis["execution_ready"] is False
    assert diagnosis["status"] == "needs_attention"
    assert diagnosis["summary"]["environment_issues"] == 1
    assert diagnosis["environment"]["status"] == "attention"
    assert diagnosis["next_steps"][-1] == {
        "type": "environment",
        "action": "install_requirements",
        "label": "安装或更新依赖",
    }


def test_build_repair_plan_separates_confirmable_and_blocked_actions():
    diagnosis = {
        "repairs": [{"node_id": "1", "message": "节点替换已应用"}],
        "missing_nodes": [
            {"node_id": "2", "class_type": "DisabledNode", "local_status": "disabled"},
            {"node_id": "3", "class_type": "MissingNode", "local_status": "missing"},
        ],
        "missing_models": [
            {
                "node_id": "4",
                "input_name": "ckpt_name",
                "model_name": "flux.safetensors",
                "model_folder": "checkpoints",
                "local_candidates": [{"name": "flux-dev.safetensors"}],
            },
        ],
        "errors": [],
        "environment": {
            "runtime_ready": False,
            "next_steps": [{"action": "install_requirements", "label": "安装或更新依赖"}],
        },
    }

    plan = build_repair_plan(diagnosis, {
        "MissingNode": [{"new_node_id": "ReplacementNode"}],
    })
    actions = {item["action"]: item for item in plan}

    assert actions["node_replacement"]["status"] == "applied"
    assert actions["enable_custom_node"]["requires_confirmation"] is True
    assert actions["replace_node"]["status"] == "available"
    assert actions["select_local_model"]["status"] == "available"
    assert actions["install_requirements"]["status"] == "blocked"


def test_add_local_dependency_state_exposes_node_and_model_options():
    prompt = {
        "1": {
            "class_type": "MissingNode",
            "_meta": {"node_pack": "example-pack"},
        },
        "2": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
    }
    validation = (
        False,
        {"type": "prompt_outputs_failed_validation", "message": "failed", "details": ""},
        [],
        {
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "errors": [{
                    "type": "value_not_in_list",
                    "extra_info": {
                        "input_name": "ckpt_name",
                        "received_value": "flux.safetensors",
                    },
                }],
            },
        },
    )
    diagnosis = build_diagnosis(prompt, validation, {"CheckpointLoaderSimple": object()})

    add_local_dependency_state(
        diagnosis,
        [{"name": "example-pack", "status": "disabled"}],
        {("checkpoints", "flux.safetensors"): [{"name": "flux-dev.safetensors"}]},
        {},
    )

    assert diagnosis["missing_nodes"][0]["local_status"] == "disabled"
    assert diagnosis["missing_models"][0]["local_candidates"] == [{"name": "flux-dev.safetensors"}]
    assert diagnosis["next_steps"][0]["action"] == "enable_custom_node"


def test_add_local_dependency_state_exposes_failed_node_reason():
    prompt = {
        "1": {
            "class_type": "MissingNode",
            "_meta": {"node_pack": "broken-pack"},
        },
    }
    validation = (
        False,
        {"type": "missing_node_type", "message": "missing", "details": ""},
        [],
        {},
    )
    diagnosis = build_diagnosis(prompt, validation, {})

    add_local_dependency_state(
        diagnosis,
        [{
            "name": "broken-pack",
            "status": "failed",
            "error_type": "ModuleNotFoundError",
            "error": "节点依赖缺失",
            "requirements_available": True,
        }],
        {},
        {
            "broken-pack": {
                "packages": ["example_dep>=1"],
                "package_status": [{
                    "requirement": "example_dep>=1",
                    "name": "example_dep",
                    "installed": None,
                    "status": "missing",
                }],
                "missing_packages": ["example_dep"],
            },
        },
    )

    assert diagnosis["missing_nodes"][0]["local_error_type"] == "ModuleNotFoundError"
    assert diagnosis["missing_nodes"][0]["local_missing_packages"] == ["example_dep"]
    assert diagnosis["next_steps"][0]["message"] == "查看节点 requirements.txt，确认缺失的 Python 依赖"
    assert diagnosis["next_steps"][0]["action"] == "inspect_node_requirements"
    assert diagnosis["next_steps"][0]["missing_packages"] == ["example_dep"]


def test_build_repair_plan_points_to_failed_node_requirements():
    plan = build_repair_plan({
        "repairs": [],
        "missing_nodes": [{
            "node_id": "1",
            "class_type": "MissingNode",
            "local_status": "failed",
            "local_requirements_available": True,
        }],
        "missing_models": [],
        "errors": [],
        "environment": {},
    })

    assert plan[0]["action"] == "inspect_node_requirements"
    assert plan[0]["status"] == "available"
    assert plan[0]["requirements_url"] == "/custom_nodes/MissingNode/requirements"


def test_build_repair_plan_includes_missing_node_packages():
    plan = build_repair_plan({
        "repairs": [],
        "missing_nodes": [{
            "node_id": "1",
            "class_type": "MissingNode",
            "local_status": "failed",
            "local_requirements_available": True,
            "local_missing_packages": ["example_dep"],
        }],
        "missing_models": [],
        "errors": [],
        "environment": {},
    })

    assert plan[0]["missing_packages"] == ["example_dep"]
    assert "example_dep" in plan[0]["message"]
