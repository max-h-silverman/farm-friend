"""Modal vLLM + OLMo cold-start experiment.

CONCLUSION (2026-05-31): NOT VIABLE for synchronous SMS, and this dead end has
already been measured — do not re-run expecting a different answer. Even with
Modal CPU/GPU memory snapshots + vLLM `/sleep`, the cold restore was TTFT
~213.6s / total ~215.1s — same ~3.5min class as RunPod's forced-zero cold start.
The bottleneck is loading a 64GB 32B model onto a cold H100; snapshotting did not
help. See docs/runpod-olmo-benchmark.md for the full verdict.

Kept as reusable infrastructure ONLY for re-testing a SMALLER OLMo (7B/13B),
which is the actually-promising path (small weights should restore in seconds).
If you point this at a small model and it clears the hard gates (true cold <30s,
warm <5s), that's worth pursuing; the 32B is settled.

Deploys an OpenAI-compatible vLLM server on Modal with H100, cache volumes,
scale-to-zero, and Modal CPU/GPU memory snapshots enabled.

Usage:
  modal deploy scripts/modal_olmo_vllm_snapshot.py
  python scripts/modal_olmo_vllm_snapshot.py
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time

import aiohttp
import modal
import modal.experimental

# Model + GPU are env-overridable so the SAME snapshot/sleep machinery can probe
# different OLMo sizes without forking the script. The 32B run (the recorded
# dead end) used the defaults below. To test the small variant — the promising
# path — set:
#   OLMO_MODEL=allenai/Olmo-3-7B-Instruct  OLMO_GPU=A10G  modal deploy ...
# A 7B (~14GB bf16) fits on a 24GB A10G/L4, far cheaper than H100 and should
# restore from cold in a fraction of the 32B's ~3.5min. There is no OLMo 13B —
# the OLMo 3 family is 7B and 32B only (verified 2026-06-01).
MODEL_NAME = os.environ.get("OLMO_MODEL", "allenai/Olmo-3.1-32B-Instruct")
GPU_TYPE = os.environ.get("OLMO_GPU", "H100")
# 0.95 suited the 32B-on-H100 case. A 7B's weights are a larger *fraction* of a
# small GPU, so leave headroom (KV cache + CUDA graphs) — the A10G (22GB usable)
# OOM'd at 0.95. L40S (48GB) at a lower util is the right small-model target.
GPU_MEM_UTIL = os.environ.get("OLMO_GPU_MEM_UTIL", "0.90")
# 4096 (the 32B run's value) is TOO SMALL for Farm Friend: the agent prompt is
# ~3073 input tokens + 1024 output = 4097, which 400'd every eval case. OLMo-3
# supports 65K context; 8192 gives comfortable headroom for prompt + output.
MAX_MODEL_LEN = os.environ.get("OLMO_MAX_MODEL_LEN", "8192")
APP_NAME = os.environ.get("OLMO_APP_NAME", "farm-friend-olmo-modal-snapshot")
CLASS_NAME = "OlmoVllmInference"
VLLM_PORT = 8000
MINUTES = 60
REGION = "us-east"

vllm_image = (
    modal.Image.from_registry("vllm/vllm-openai:v0.20.2")
    .entrypoint([])
    .run_commands("ln -s $(which python3) /usr/bin/python")
    .env(
        {
            "HF_HUB_CACHE": "/root/.cache/huggingface",
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "HF_XET_HIGH_PERFORMANCE": "1",
            "VLLM_SERVER_DEV_MODE": "1",
            "TORCH_CPP_LOG_LEVEL": "FATAL",
            # CRITICAL: bake the model into the IMAGE env so the *container*
            # sees it. The OLMO_* shell vars only exist on the deploying machine;
            # without this, the container's module import falls back to the 32B
            # default and OOMs. (This was the L40S OOM — it was silently loading
            # the 32B, not the 7B.)
            "OLMO_MODEL": MODEL_NAME,
            "OLMO_GPU_MEM_UTIL": GPU_MEM_UTIL,
            "OLMO_MAX_MODEL_LEN": MAX_MODEL_LEN,
        }
    )
)

hf_cache_vol = modal.Volume.from_name("farm-friend-huggingface-cache", create_if_missing=True)
vllm_cache_vol = modal.Volume.from_name("farm-friend-vllm-cache", create_if_missing=True)

app = modal.App(APP_NAME)

with vllm_image.imports():
    import requests


def check_running(process: subprocess.Popen) -> None:
    if (return_code := process.poll()) is not None:
        raise subprocess.CalledProcessError(return_code, cmd=process.args)


def wait_ready(process: subprocess.Popen, timeout: int = 15 * MINUTES) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            check_running(process)
            requests.get(f"http://127.0.0.1:{VLLM_PORT}/health", timeout=10).raise_for_status()
            return
        except (
            subprocess.CalledProcessError,
            requests.exceptions.ConnectionError,
            requests.exceptions.HTTPError,
            requests.exceptions.Timeout,
        ):
            time.sleep(5)
    raise TimeoutError(f"vLLM server not ready within {timeout} seconds")


def warmup() -> None:
    payload = {
        "model": "llm",
        "messages": [{"role": "user", "content": "Reply with one short sentence."}],
        "max_tokens": 16,
        "temperature": 0.1,
    }
    for _ in range(2):
        requests.post(
            f"http://127.0.0.1:{VLLM_PORT}/v1/chat/completions",
            json=payload,
            timeout=120,
        ).raise_for_status()


def sleep_vllm(level: int = 1) -> None:
    requests.post(f"http://127.0.0.1:{VLLM_PORT}/sleep?level={level}", timeout=180).raise_for_status()


def wake_vllm() -> None:
    requests.post(f"http://127.0.0.1:{VLLM_PORT}/wake_up", timeout=60).raise_for_status()


@app.cls(
    image=vllm_image,
    gpu=GPU_TYPE,
    # 60s for the cold-start measurement; raise (e.g. 600) via OLMO_SCALEDOWN to
    # keep the container warm through a multi-minute eval run so individual cases
    # don't race a scale-from-zero 503.
    scaledown_window=int(os.environ.get("OLMO_SCALEDOWN", "60")),
    timeout=15 * MINUTES,
    volumes={
        "/root/.cache/huggingface": hf_cache_vol,
        "/root/.cache/vllm": vllm_cache_vol,
    },
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    region=REGION,
    min_containers=0,
)
@modal.experimental.http_server(
    port=VLLM_PORT,
    proxy_regions=[REGION],
    exit_grace_period=5,
)
@modal.concurrent(target_inputs=1)
class OlmoVllmInference:
    @modal.enter(snap=True)
    def startup(self) -> None:
        cmd = [
            "vllm",
            "serve",
            MODEL_NAME,
            "--served-model-name",
            "llm",
            "--host",
            "0.0.0.0",
            "--port",
            str(VLLM_PORT),
            "--dtype",
            "bfloat16",
            "--max-model-len",
            MAX_MODEL_LEN,
            "--tensor-parallel-size",
            "1",
            "--gpu-memory-utilization",
            GPU_MEM_UTIL,
            "--max-num-seqs",
            "8",
            "--enable-sleep-mode",
            "--safetensors-load-strategy",
            "prefetch",
            "--generation-config",
            "vllm",
        ]
        print(" ".join(cmd))
        self.process = subprocess.Popen(cmd)
        wait_ready(self.process)
        warmup()
        sleep_vllm(level=1)

    @modal.enter(snap=False)
    def restore(self) -> None:
        wake_vllm()

    @modal.exit()
    def stop(self) -> None:
        self.process.terminate()


async def _probe(url: str) -> None:
    started = time.perf_counter()
    attempts = 0
    messages = [
        {
            "role": "user",
            "content": "Classify this SMS as JSON: 'Can 3 people glean apples Saturday morning?'",
        }
    ]
    payload = {
        "model": "llm",
        "messages": messages,
        "stream": True,
        "max_tokens": 120,
        "temperature": 0.1,
    }
    first_token_at: float | None = None
    text = ""
    async with aiohttp.ClientSession(base_url=url) as session:
        while True:
            try:
                async with session.post(
                    "/v1/chat/completions",
                    json=payload,
                    headers={"Accept": "text/event-stream"},
                    timeout=10 * MINUTES,
                ) as resp:
                    if resp.status == 503:
                        attempts += 1
                        if attempts == 1 or attempts % 6 == 0:
                            elapsed = time.perf_counter() - started
                            print(f"endpoint not ready yet: {elapsed:.1f}s elapsed")
                        await asyncio.sleep(10)
                        continue
                    resp.raise_for_status()
                    async for raw in resp.content:
                        line = raw.decode("utf-8", errors="ignore").strip()
                        if not line or not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        try:
                            event = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        delta = (event.get("choices") or [{}])[0].get("delta") or {}
                        chunk = delta.get("content")
                        if chunk:
                            if first_token_at is None:
                                first_token_at = time.perf_counter()
                            text += chunk
                    break
            except (aiohttp.ClientError, TimeoutError):
                await asyncio.sleep(1)
                if time.perf_counter() - started > 10 * MINUTES:
                    raise
    finished = time.perf_counter()
    ttft = None if first_token_at is None else first_token_at - started
    print(f"url={url}")
    print(f"ttft_seconds={ttft}")
    print(f"total_seconds={finished - started}")
    print(f"preview={text[:300]}")


if __name__ == "__main__":
    cls = modal.Cls.from_name(APP_NAME, CLASS_NAME)

    async def main() -> None:
        url = (await cls._experimental_get_flash_urls.aio())[0]
        await _probe(url)

    asyncio.run(main())
