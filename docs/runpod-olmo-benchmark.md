# OLMo serverless benchmark — RunPod & Modal

## FINAL VERDICT (2026-06-01) — RESOLVED: no viable self-hosted OLMo path at pilot scale

We tested both OLMo sizes on scale-to-zero serverless GPU. **Neither works for
Farm Friend's pilot**, for two different reasons, and there is no third option
because **no provider hosts OLMo** (DeepInfra substitutes Gemma; OpenRouter has
no live OLMo instruct endpoint).

| Model | Warm | True cold | Quality (eval) | Verdict |
|---|---|---|---|---|
| **OLMo 32B** (RunPod H100 / Modal H100) | ~2–3s ✓ | **~215–255s ✗** | (good enough) | cold start fatal |
| **OLMo 7B** (Modal L40S, scale-to-zero) | 2.86s ✓ | **34.5s ✓** | **~40/55 scorable ✗** | quality fatal |

- **32B is smart enough but can't scale-to-zero** — loading 64GB onto a cold GPU
  is ~3.5–4 min regardless of provider or snapshot tricks. The only fix is a
  warm worker (`min_workers=1`), which at pilot scale (2–5 farms) costs
  ~$400–800/mo — indefensible against the ~$30/mo budget.
- **7B scales-to-zero fine but isn't smart enough** — cold start drops to 34.5s
  (engine snapshot wake ~1.9s; JSON compliance perfect under vLLM guided
  decoding), warm 2.86s, ~$0.0015/req. But it scores ~40/55 on the eval
  (vs. Mistral 24B's 57/63), failing on window/multi-day posts and complex
  action-selection — exactly the multi-constraint judgment a 7B is weak at.

**The structural squeeze:** open-weight (OLMo specifically) + scale-to-zero
economics + good-enough quality — you can have any two. Pilot scale is what makes
it bite; at larger scale a warm 32B amortizes fine.

**Decision (2026-06-01):** Production stays on the pragmatic open-weight model
(Mistral Small 3.2 via DeepInfra, `LLM_PROVIDER=mistral-deepinfra`). This is a
**deliberate, evidence-backed constitutional tradeoff**, not a default of
convenience: the constitution's architectural goals (portability, no data moat,
neutral host, no Meta, human-in-the-loop, one-env-var swappability) are all met;
only the strict "run fully-open OLMo specifically" aspiration is unmet, and the
table above is the documented reason. **Revisit if** (a) the project grows enough
to amortize a warm 32B, or (b) a neutral provider lists an OLMo *instruct* model.

The async-ack architecture (immediate "Got it, I'll text back shortly" + a
background OLMo call) remains the documented path *if* OLMo is ever pursued — it
is the only design that reconciles all three constraints — but it's a real
re-architecture, not a pilot move. The Modal script
(`functions/scripts/modal_olmo_vllm_snapshot.py`) is kept as the seed for that.

---

## Original 32B detail

**Scale-to-zero OLMo 32B has a ~3.5–4 minute true cold start. It is NOT a viable
synchronous live-SMS provider.** Two independent providers converged on the same
result, so this is a property of loading a 64GB model onto a cold H100, not a
tuning gap — snapshot/sleep tricks did not meaningfully help.

| Provider | Warm latency | True cold start | Cold UX |
|---|---|---|---|
| RunPod Serverless vLLM (H100) | ~2–3s ✓ | ~255s total (~4m12s queue + 2.8s exec) | unacceptable |
| Modal (H100, CPU/GPU snapshot + vLLM sleep) | warm good | TTFT ~213.6s, total ~215.1s | unacceptable |

Against the thresholds below: **warm = good on both; true cold = bad on both.**
The RunPod 15-min idle probe returned in ~3.6s, suggesting FlashBoot keeps a
worker warm for a while — so *real-world* cold hits may be rarer than the
forced-delete worst case, but the worst case is still disqualifying for a
synchronous webhook (Telnyx times out; the user is waiting).

**Decisions taken:**
- Keep the current practical provider as production default. Do NOT wire RunPod
  or Modal OLMo into `LLM_PROVIDER` / `app/llm/` config.
- OLMo 32B stays the constitution's ethical/future benchmark, not a live option.
- The smaller-OLMo experiment (7B) was subsequently run — see the FINAL VERDICT
  at the top. It cleared the latency/cost gates (34.5s cold, 2.86s warm) but
  failed quality (~40/55 eval). There is no OLMo 13B (the family is 7B and 32B
  only). So this thread is closed, not open.
- If a fast small OLMo doesn't materialize, the fallback shape is an **async-ack
  architecture**: immediate "Got it, checking — I'll text back shortly", a
  background OLMo call, and fallback to the current provider / human review after
  45–90s. Farm Friend suits this: only the inbound *reply* path needs <5s; the
  scheduled ticks (outreach, reminders, review) are background already.

The methodology, setup, and raw thresholds that produced this verdict follow.

## Purpose

This is a standalone experiment to measure whether RunPod Serverless running
vLLM can serve `allenai/Olmo-3.1-32B-Instruct` quickly and reliably enough for
Farm Friend-style SMS coordination work.

The benchmark measures cold-ish startup timing, warm latency, reliability,
token usage when returned by the OpenAI-compatible endpoint, and estimated
request cost when you provide a per-second GPU price.

It uses only synthetic prompts. Do not paste real farm, volunteer, phone, or
community data into this benchmark.

## Not Production Integration

This does not wire RunPod into Farm Friend's live provider config. It does not
change `LLM_PROVIDER`, business logic, Firebase Functions, Firestore, Telnyx, or
the production `app/llm/` routing. Treat results as evidence for a later
provider decision, not as a deployment change.

## RunPod Endpoint Setup

Create the endpoint manually in RunPod:

- Product: Serverless
- Worker: vLLM OpenAI-compatible worker
- Model: `allenai/Olmo-3.1-32B-Instruct`
- Min workers: `0`
- Max workers: `1`
- GPU: A100 80GB or H100 80GB

Recommended vLLM environment:

```text
MODEL_NAME=allenai/Olmo-3.1-32B-Instruct
MAX_MODEL_LEN=4096
TENSOR_PARALLEL_SIZE=1
GPU_MEMORY_UTILIZATION=0.95
MAX_NUM_SEQS=8
OPENAI_SERVED_MODEL_NAME_OVERRIDE=allenai/Olmo-3.1-32B-Instruct
```

The expected OpenAI-compatible base URL is:

```text
https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1
```

The script derives that URL from `RUNPOD_ENDPOINT_ID` unless you set
`RUNPOD_BASE_URL` explicitly.

## Local Environment

Required:

```bash
cd functions

export RUNPOD_API_KEY="<your-runpod-api-key>"
export RUNPOD_ENDPOINT_ID="<endpoint-id>"
export RUNPOD_MODEL="allenai/Olmo-3.1-32B-Instruct"
export BENCHMARK_RUN_LABEL="runpod-olmo-32b-cold-001"
export BENCHMARK_STREAM=true
export BENCHMARK_IDLE_SECONDS=0

venv/bin/python scripts/benchmark_olmo_runpod.py
```

Optional knobs:

```text
RUNPOD_BASE_URL
BENCHMARK_OUTPUT_PATH
BENCHMARK_REPEAT_COUNT
BENCHMARK_MAX_TOKENS
BENCHMARK_TEMPERATURE
BENCHMARK_GPU_TYPE
BENCHMARK_PRICE_PER_SECOND
```

Default output path:

```text
functions/tmp/olmo_runpod_benchmark.jsonl
```

## Warm And Cold Runs

Warm follow-up, immediately after the first run:

```bash
BENCHMARK_RUN_LABEL="runpod-olmo-32b-warm-001" BENCHMARK_IDLE_SECONDS=0 venv/bin/python scripts/benchmark_olmo_runpod.py
```

Cold-ish run after 15 minutes idle:

```bash
BENCHMARK_RUN_LABEL="runpod-olmo-32b-idle-15m-001" BENCHMARK_IDLE_SECONDS=900 venv/bin/python scripts/benchmark_olmo_runpod.py
```

Other useful idle intervals:

```bash
BENCHMARK_IDLE_SECONDS=0 venv/bin/python scripts/benchmark_olmo_runpod.py
BENCHMARK_IDLE_SECONDS=60 venv/bin/python scripts/benchmark_olmo_runpod.py
BENCHMARK_IDLE_SECONDS=300 venv/bin/python scripts/benchmark_olmo_runpod.py
BENCHMARK_IDLE_SECONDS=900 venv/bin/python scripts/benchmark_olmo_runpod.py
```

For repeated cold-ish probes:

```bash
BENCHMARK_RUN_LABEL="runpod-olmo-32b-idle-repeat" BENCHMARK_IDLE_SECONDS=900 BENCHMARK_REPEAT_COUNT=3 venv/bin/python scripts/benchmark_olmo_runpod.py
```

For an overnight cold test, leave the endpoint idle with min workers set to `0`,
then run once:

```bash
BENCHMARK_RUN_LABEL="runpod-olmo-32b-overnight-001" BENCHMARK_IDLE_SECONDS=0 venv/bin/python scripts/benchmark_olmo_runpod.py
```

The script cannot force RunPod to scale to zero. True cold-start behavior depends
on endpoint min workers, RunPod's idle timeout, image/model cache state, and
whether another request kept the worker warm.

## Cost Estimate

Set `BENCHMARK_PRICE_PER_SECOND` to the effective GPU price per second for the
RunPod worker. For example, if the GPU is `$3.00/hour`:

```bash
export BENCHMARK_PRICE_PER_SECOND="$(python - <<'PY'
print(3.00 / 3600)
PY
)"
```

The script records:

```text
estimated_cost_usd = total_latency_seconds * BENCHMARK_PRICE_PER_SECOND
```

This is a rough per-request estimate. It does not model batching, idle billing
windows, retries, storage, or provider-specific minimum billing increments.

## Output And Metrics

Each request appends one JSONL row with:

```text
run_label
case_id
case_name
provider
model
base_url_host_or_label
gpu_type
price_per_second
started_at
finished_at
idle_seconds_before_request
streaming_enabled
http_status
success
error_type
error_message
time_to_first_byte_seconds
time_to_first_token_seconds
total_latency_seconds
input_tokens
output_tokens
total_tokens
estimated_cost_usd
response_text
response_preview
```

The printed table shows case, success/failure, TTFB, TTFT, total latency, tokens,
and estimated cost. Streaming mode measures TTFT as the first non-empty streamed
delta. Non-streaming mode records TTFB but usually cannot measure first token.

## Thresholds

Warm request:

```text
good: <5s
acceptable: <10s
bad: >15s
```

Cold request:

```text
good: <30s
acceptable: 30-60s
marginal: 60-90s
bad: >90s
```

Routine SMS-class cost:

```text
good: <$0.01/request
acceptable: <$0.05/request
bad: >$0.10/request
```

## Decision Rule (the thresholds that produced the FINAL VERDICT above)

> Resolved — see the FINAL VERDICT at the top. This is the rule that was applied,
> kept for methodology. 32B cold (~215s+) fell in the "do not use" band; 7B cold
> (34.5s) passed this latency rule but failed on quality instead.

If cold complete response is consistently under 30-45s and cost is reasonable,
OLMo may be viable for live SMS paths (latency-wise).

If cold is 45-90s but warm is good, OLMo may be viable only with keep-warm or
async acknowledgment.

If cold is over 90s, do not use OLMo for live SMS paths.

If cost is too high for routine flows, keep the current practical provider as
default and treat OLMo as a future/ethical benchmark.

If output quality is worse than the current default model, do not switch the
default provider even if latency is acceptable. Run the existing live eval suite
before any production provider change:

```bash
cd functions
python -m tests.evals.runner --live
```
