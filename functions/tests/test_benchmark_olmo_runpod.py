from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def load_benchmark_module():
    script = Path(__file__).parents[1] / "scripts" / "benchmark_olmo_runpod.py"
    spec = importlib.util.spec_from_file_location("benchmark_olmo_runpod", script)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_derive_base_url_from_endpoint_id():
    mod = load_benchmark_module()
    assert (
        mod.derive_base_url(endpoint_id="abc123", base_url="")
        == "https://api.runpod.ai/v2/abc123/openai/v1"
    )


def test_explicit_base_url_wins_and_strips_trailing_slash():
    mod = load_benchmark_module()
    assert (
        mod.derive_base_url(endpoint_id="abc123", base_url="https://example.test/v1/")
        == "https://example.test/v1"
    )


def test_threshold_classifiers():
    mod = load_benchmark_module()
    assert mod.classify_warm_latency(4.9) == "good"
    assert mod.classify_warm_latency(9.9) == "acceptable"
    assert mod.classify_warm_latency(16.0) == "bad"
    assert mod.classify_cold_latency(29.9) == "good"
    assert mod.classify_cold_latency(60.0) == "acceptable"
    assert mod.classify_cold_latency(90.0) == "marginal"
    assert mod.classify_cold_latency(90.1) == "bad"
    assert mod.classify_cost(0.009) == "good"
    assert mod.classify_cost(0.049) == "acceptable"
    assert mod.classify_cost(0.101) == "bad"


def test_parse_stream_chunk_and_delta_text():
    mod = load_benchmark_module()
    chunk = mod.parse_stream_chunk(
        'data: {"choices":[{"delta":{"content":"hello"}}]}'
    )
    assert mod.delta_text_from_chunk(chunk) == "hello"
    assert mod.parse_stream_chunk("data: [DONE]") is None
