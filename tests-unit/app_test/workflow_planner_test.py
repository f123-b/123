import pytest

from app.workflow_planner import build_workflow_plan, infer_intent


def test_infer_intent_prioritizes_video_over_generic_image_terms():
    intent = infer_intent("把这张图片做成短视频")

    assert intent["type"] == "video"
    assert "视频" in intent["matched_keywords"]


def test_build_workflow_plan_selects_local_candidates_and_hardware_policy():
    plan = build_workflow_plan(
        "生成商品白底图",
        [{"id": "product-white", "score": 14, "name": "商品白底图"}],
        [{"name": "qwen_image_fp8.safetensors", "score": 5}],
        {
            "runtime_ready": True,
            "hardware": {
                "recommendation": {"tier": "standard", "batch_size": 1}
            },
        },
    )

    assert plan["intent"]["type"] == "product"
    assert plan["recommended"]["recipe_id"] == "product-white"
    assert plan["recommended"]["model"] == "qwen_image_fp8.safetensors"
    assert plan["runtime_ready"] is True


def test_build_workflow_plan_reports_local_only_next_steps_without_candidates():
    plan = build_workflow_plan(
        "做一个电影感人物海报",
        [],
        [],
        {"runtime_ready": False, "hardware": {}},
    )

    assert plan["selected_recipe"] is None
    assert plan["selected_model"] is None
    assert plan["local_only"] is True
    assert {step["action"] for step in plan["next_steps"]} == {
        "choose_recipe", "choose_model", "diagnose_environment"
    }


def test_build_workflow_plan_falls_back_to_first_available_recipe():
    plan = build_workflow_plan(
        "一个女生在海边",
        [{"id": "text-to-image-basic", "score": 0, "source": "template"}],
        [],
        {"runtime_ready": True, "hardware": {}},
    )

    assert plan["selected_recipe"]["id"] == "text-to-image-basic"
    assert {step["action"] for step in plan["next_steps"]} == {"prepare_recipe", "choose_model"}


def test_infer_intent_rejects_empty_task():
    with pytest.raises(ValueError, match="task 不能为空"):
        infer_intent(" ")
