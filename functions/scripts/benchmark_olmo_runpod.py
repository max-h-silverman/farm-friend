"""Benchmark RunPod Serverless vLLM + OLMo cold/warm behavior.

Standalone experiment harness. It does not import Farm Friend app code and does
not change production provider config.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

DEFAULT_MODEL = "allenai/Olmo-3.1-32B-Instruct"
DEFAULT_OUTPUT_PATH = "tmp/olmo_runpod_benchmark.jsonl"
DEFAULT_MAX_TOKENS = 220
DEFAULT_TEMPERATURE = 0.1
DEFAULT_REPEAT_COUNT = 1
REQUEST_TIMEOUT_SECONDS = 600


@dataclass(frozen=True, slots=True)
class BenchmarkCase:
    case_id: str
    case_name: str
    messages: list[dict[str, str]]


SYSTEM_PROMPT = (
    "You are benchmarking an SMS coordination assistant for a fictional farm "
    "volunteer project. Use only the synthetic facts provided. Respond briefly "
    "and practically. For classification or parsing tasks, return concise JSON. "
    "For reply-drafting tasks, write SMS-length copy."
)


BENCHMARK_CASES: list[BenchmarkCase] = [
    BenchmarkCase(
        case_id="farmer.gleaning.hands_on",
        case_name="Farmer posts hands-on gleaning need",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Classify and summarize this farmer SMS as JSON: "
                    "'We have a lot of ripe plums left after harvest. Could 4 "
                    "volunteers come glean Saturday morning around 9 for the "
                    "food bank?'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="farmer.gleaning.pickup",
        case_name="Farmer posts pickup/transport gleaning need",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Classify and summarize this farmer SMS as JSON: "
                    "'I boxed about 30 pounds of extra kale. Can someone pick "
                    "it up today before 5 and take it to the community fridge?'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="farmer.farm_help.hands_on",
        case_name="Farmer posts hands-on farm help need",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Classify and summarize this farmer SMS as JSON: "
                    "'Need two people to help weed onions Wednesday 8-11. "
                    "Bring gloves, no experience needed.'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="farmer.farm_help.pickup",
        case_name="Farmer posts pickup/transport farm help need",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Classify and summarize this farmer SMS as JSON: "
                    "'Can a volunteer with a pickup truck move ten empty harvest "
                    "crates from the barn to the north field tomorrow afternoon?'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="volunteer.yes_available",
        case_name="Volunteer replies yes/available",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Parse this volunteer SMS as JSON. Context: they received "
                    "an outreach for a Thursday 10am carrot pickup. SMS: "
                    "'Yes I can do that pickup Thursday morning.'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="volunteer.clarifying_question",
        case_name="Volunteer asks a clarifying question",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Draft a short SMS answer or escalation note. Context: "
                    "volunteer got a request for apple gleaning Friday 9am. "
                    "SMS: 'Do I need to bring a ladder or will there be one?'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="volunteer.mute_pickups",
        case_name="Volunteer asks to mute pickup/transport requests",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Classify this volunteer SMS as JSON and draft a short "
                    "acknowledgement: 'Please stop sending me pickup or delivery "
                    "requests. I still want farm work shifts.'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="unknown.sender",
        case_name="Unknown sender texts in",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Classify this SMS from an unknown number and draft a safe "
                    "short reply. SMS: 'Hi, I heard you need farm volunteers. "
                    "Can I help this weekend?'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="ambiguous.escalate",
        case_name="Ambiguous message that should escalate to human review",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Decide whether this synthetic SMS should be handled by the "
                    "assistant or escalated to a human. Return JSON with intent, "
                    "urgency, and rationale. SMS: 'The person you sent last time "
                    "made me really uncomfortable. Please call me before sending "
                    "anyone else.'"
                ),
            },
        ],
    ),
    BenchmarkCase(
        case_id="reminder.drop_cancel",
        case_name="DROP/CANCEL-style reminder response",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Parse this volunteer SMS as JSON. Context: the last outbound "
                    "was a reminder: 'You're scheduled for harvest tomorrow. "
                    "Reply DROP if you can't make it.' SMS: 'Sorry, cancel me "
                    "for tomorrow.'"
                ),
            },
        ],
    ),
]


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


def env_float(name: str, default: float | None) -> float | None:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return float(raw)


def derive_base_url(*, endpoint_id: str, base_url: str) -> str:
    if base_url:
        return base_url.rstrip("/")
    if endpoint_id:
        return f"https://api.runpod.ai/v2/{endpoint_id}/openai/v1"
    return ""


def host_or_label(base_url: str) -> str:
    parsed = urlparse(base_url)
    if parsed.hostname:
        return parsed.hostname
    return "unknown"


def classify_warm_latency(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    if seconds < 5:
        return "good"
    if seconds < 10:
        return "acceptable"
    if seconds > 15:
        return "bad"
    return "marginal"


def classify_cold_latency(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    if seconds < 30:
        return "good"
    if seconds <= 60:
        return "acceptable"
    if seconds <= 90:
        return "marginal"
    return "bad"


def classify_cost(cost: float | None) -> str:
    if cost is None:
        return "unknown"
    if cost < 0.01:
        return "good"
    if cost < 0.05:
        return "acceptable"
    if cost > 0.10:
        return "bad"
    return "marginal"


def estimated_cost(
    total_latency_seconds: float | None,
    price_per_second: float | None,
) -> float | None:
    if total_latency_seconds is None or price_per_second is None:
        return None
    return total_latency_seconds * price_per_second


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def build_payload(
    case: BenchmarkCase,
    *,
    model: str,
    max_tokens: int,
    temperature: float,
    stream: bool,
) -> dict[str, Any]:
    return {
        "model": model,
        "messages": case.messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": stream,
    }


def usage_from_response(data: dict[str, Any]) -> tuple[int | None, int | None, int | None]:
    usage = data.get("usage") or {}
    return (
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
        usage.get("total_tokens"),
    )


def content_from_response(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    return content if isinstance(content, str) else ""


def parse_stream_chunk(line: str) -> dict[str, Any] | None:
    if not line.startswith("data:"):
        return None
    payload = line.removeprefix("data:").strip()
    if not payload or payload == "[DONE]":
        return None
    return json.loads(payload)


def delta_text_from_chunk(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    delta = choices[0].get("delta") or {}
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def run_request(
    client: httpx.Client,
    *,
    base_url: str,
    api_key: str,
    case: BenchmarkCase,
    model: str,
    max_tokens: int,
    temperature: float,
    stream: bool,
    run_label: str,
    idle_seconds_before_request: int,
    gpu_type: str,
    price_per_second: float | None,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/chat/completions"
    provider = "runpod-serverless-vllm"
    started_monotonic = time.perf_counter()
    started_at = now_iso()
    response_text = ""
    status_code: int | None = None
    error_type = ""
    error_message = ""
    success = False
    ttfb: float | None = None
    ttft: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = build_payload(
        case,
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        stream=stream,
    )

    try:
        if stream:
            with client.stream("POST", url, headers=headers, json=payload) as resp:
                status_code = resp.status_code
                ttfb = time.perf_counter() - started_monotonic
                if not resp.is_success:
                    response_text = resp.read().decode("utf-8", errors="replace")
                    error_type = "http_error"
                    error_message = response_text[:500] or resp.reason_phrase
                else:
                    chunks: list[str] = []
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        data = parse_stream_chunk(line)
                        if data is None:
                            continue
                        usage = data.get("usage")
                        if usage:
                            input_tokens = usage.get("prompt_tokens")
                            output_tokens = usage.get("completion_tokens")
                            total_tokens = usage.get("total_tokens")
                        delta = delta_text_from_chunk(data)
                        if delta:
                            if ttft is None:
                                ttft = time.perf_counter() - started_monotonic
                            chunks.append(delta)
                    response_text = "".join(chunks)
                    success = True
        else:
            with client.stream("POST", url, headers=headers, json=payload) as resp:
                ttfb = time.perf_counter() - started_monotonic
                status_code = resp.status_code
                body = resp.read()
                if resp.is_success:
                    data = json.loads(body)
                    response_text = content_from_response(data)
                    input_tokens, output_tokens, total_tokens = usage_from_response(data)
                    success = True
                else:
                    error_type = "http_error"
                    decoded = body.decode("utf-8", errors="replace")
                    error_message = decoded[:500] or resp.reason_phrase
    except httpx.TimeoutException as e:
        error_type = "timeout"
        error_message = str(e)[:500]
    except (httpx.HTTPError, socket.gaierror) as e:
        error_type = type(e).__name__
        error_message = str(e)[:500]
    except json.JSONDecodeError as e:
        error_type = "json_decode_error"
        error_message = str(e)[:500]

    finished_at = now_iso()
    total_latency = time.perf_counter() - started_monotonic
    cost = estimated_cost(total_latency, price_per_second) if success else None
    preview = " ".join(response_text.split())[:220]

    return {
        "run_label": run_label,
        "case_id": case.case_id,
        "case_name": case.case_name,
        "provider": provider,
        "model": model,
        "base_url_host_or_label": host_or_label(base_url),
        "gpu_type": gpu_type,
        "price_per_second": price_per_second,
        "started_at": started_at,
        "finished_at": finished_at,
        "idle_seconds_before_request": idle_seconds_before_request,
        "streaming_enabled": stream,
        "http_status": status_code,
        "success": success,
        "error_type": error_type,
        "error_message": error_message,
        "time_to_first_byte_seconds": ttfb,
        "time_to_first_token_seconds": ttft,
        "total_latency_seconds": total_latency,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "estimated_cost_usd": cost,
        "response_text": response_text,
        "response_preview": preview,
    }


def format_seconds(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}s"


def format_cost(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${value:.4f}"


def print_row_summary(row: dict[str, Any]) -> None:
    status = "ok" if row["success"] else f"fail:{row['error_type'] or row['http_status']}"
    tokens = row["total_tokens"] if row["total_tokens"] is not None else "-"
    print(
        f"{row['case_id']:<34} {status:<16} "
        f"TTFB {format_seconds(row['time_to_first_byte_seconds']):>8} "
        f"TTFT {format_seconds(row['time_to_first_token_seconds']):>8} "
        f"total {format_seconds(row['total_latency_seconds']):>8} "
        f"tokens {tokens!s:>6} cost {format_cost(row['estimated_cost_usd']):>9}"
    )


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * pct
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    weight = index - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def print_aggregate_summary(rows: list[dict[str, Any]], idle_seconds: int) -> None:
    successes = [r for r in rows if r["success"]]
    failures = [r for r in rows if not r["success"]]
    latencies = [
        r["total_latency_seconds"]
        for r in successes
        if r["total_latency_seconds"] is not None
    ]
    costs = [r["estimated_cost_usd"] for r in successes if r["estimated_cost_usd"] is not None]
    first_success = successes[0] if successes else None
    warm_successes = successes[1:] if len(successes) > 1 else []
    warm_latencies = [r["total_latency_seconds"] for r in warm_successes]

    print("\nAggregate")
    print(f"requests: {len(rows)}  success: {len(successes)}  failed: {len(failures)}")
    if first_success:
        coldish = first_success["total_latency_seconds"]
        print(
            "first request: "
            f"{format_seconds(coldish)} "
            f"(cold threshold: {classify_cold_latency(coldish)})"
        )
    if idle_seconds and latencies:
        coldish_p50 = percentile(latencies, 0.50)
        coldish_p95 = percentile(latencies, 0.95)
        print(
            "idle-spaced requests: "
            f"p50 {format_seconds(coldish_p50)} ({classify_cold_latency(coldish_p50)}), "
            f"p95 {format_seconds(coldish_p95)} ({classify_cold_latency(coldish_p95)})"
        )
    elif warm_latencies:
        warm_p50 = percentile(warm_latencies, 0.50)
        warm_p95 = percentile(warm_latencies, 0.95)
        print(
            "warm follow-ups: "
            f"p50 {format_seconds(warm_p50)} ({classify_warm_latency(warm_p50)}), "
            f"p95 {format_seconds(warm_p95)} ({classify_warm_latency(warm_p95)})"
        )
    if latencies:
        print(
            "all successful latency: "
            f"p50 {format_seconds(percentile(latencies, 0.50))}, "
            f"p95 {format_seconds(percentile(latencies, 0.95))}"
        )
    if costs:
        avg_cost = sum(costs) / len(costs)
        print(f"average estimated cost: {format_cost(avg_cost)} ({classify_cost(avg_cost)})")
    if idle_seconds:
        print(
            f"idle sleep before each measured request was {idle_seconds}s; "
            "actual RunPod cold start still depends on min workers and scale-to-zero timing."
        )


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def output_path_from_env() -> Path:
    raw = os.environ.get("BENCHMARK_OUTPUT_PATH", DEFAULT_OUTPUT_PATH)
    return Path(raw)


def main() -> int:
    api_key = os.environ.get("RUNPOD_API_KEY", "")
    endpoint_id = os.environ.get("RUNPOD_ENDPOINT_ID", "")
    base_url = derive_base_url(
        endpoint_id=endpoint_id,
        base_url=os.environ.get("RUNPOD_BASE_URL", ""),
    )
    if not api_key or not base_url:
        print(
            "Missing RUNPOD_API_KEY or endpoint configuration. Set RUNPOD_API_KEY "
            "and either RUNPOD_ENDPOINT_ID or RUNPOD_BASE_URL. No live requests made.",
            file=sys.stderr,
        )
        return 2

    model = os.environ.get("RUNPOD_MODEL", DEFAULT_MODEL)
    run_label = os.environ.get("BENCHMARK_RUN_LABEL", f"runpod-olmo-{now_iso()}")
    idle_seconds = env_int("BENCHMARK_IDLE_SECONDS", 0)
    repeat_count = env_int("BENCHMARK_REPEAT_COUNT", DEFAULT_REPEAT_COUNT)
    max_tokens = env_int("BENCHMARK_MAX_TOKENS", DEFAULT_MAX_TOKENS)
    temperature = env_float("BENCHMARK_TEMPERATURE", DEFAULT_TEMPERATURE)
    assert temperature is not None
    stream = env_bool("BENCHMARK_STREAM", True)
    gpu_type = os.environ.get("BENCHMARK_GPU_TYPE", "")
    price_per_second = env_float("BENCHMARK_PRICE_PER_SECOND", None)
    output_path = output_path_from_env()

    print(f"Run label: {run_label}")
    print(f"Endpoint host: {host_or_label(base_url)}")
    print(f"Model: {model}")
    print(f"Streaming: {stream}")
    print(f"Repeat count: {repeat_count}")
    print(f"Idle seconds before each request: {idle_seconds}")
    print(f"Output: {output_path}")
    print()
    print(
        f"{'case':<34} {'success/fail':<16} {'TTFB':>13} {'TTFT':>13} "
        f"{'total latency':>14} {'tokens':>13} {'estimated cost':>15}"
    )

    rows: list[dict[str, Any]] = []
    with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        for repeat_index in range(repeat_count):
            for case in BENCHMARK_CASES:
                if idle_seconds > 0:
                    print(
                        f"\nSleeping {idle_seconds}s before {case.case_id} "
                        f"(repeat {repeat_index + 1}/{repeat_count})..."
                    )
                    time.sleep(idle_seconds)
                row = run_request(
                    client,
                    base_url=base_url,
                    api_key=api_key,
                    case=case,
                    model=model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    stream=stream,
                    run_label=run_label,
                    idle_seconds_before_request=idle_seconds,
                    gpu_type=gpu_type,
                    price_per_second=price_per_second,
                )
                rows.append(row)
                print_row_summary(row)
                write_jsonl(output_path, [row])

    print_aggregate_summary(rows, idle_seconds)
    return 0 if all(r["success"] for r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
