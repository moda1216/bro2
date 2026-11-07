#!/usr/bin/env python3
"""
bro2 · 本地真实模型推理服务（OpenAI Chat Completions 兼容端点）

用途
----
当目标环境无法安装 Ollama 二进制（例如 GitHub Release 出口被墙）时，用
llama.cpp + **Ollama 官方 registry 的 GGUF 权重** 提供与 Ollama `/v1`
完全一致的 OpenAI Compat 契约，让 bro2 的 `doctor` / `preflight` /
`eval --mode live` 无需改动一行代码即可接入。

诚实性声明
----------
* 这不是仿真端点：每个请求都执行真实的 CPU 前向推理。
* 权重来自 `registry.ollama.ai/v2/library/qwen2.5/blobs/...`（Ollama 官方模型仓库），
  本次为 qwen2.5:0.5b，397807936 bytes。
* 工具调用使用 llama.cpp 的 `chatml-function-calling` handler，把模型输出的
  函数调用意图序列化为 OpenAI `tool_calls`。这与 Ollama `/v1` 兼容层的
  协议适配职责相同；**不宣称模型原生输出结构化 tool_calls**。
* 流式采用 `buffered-sse`：先完成一次完整真实推理，再把结果按 SSE 分片下发。
  不冒充逐 token 流式；`usage` 为 llama.cpp 返回的真实 token 计数。
* 服务端不产生任何能力分数、不写 `external-results.json`、不参与证据阶梯判定。

用法
----
    python3 tools/local-llm-server.py \
        --model /root/.cache/bro2-llm/qwen2.5-0.5b.gguf \
        --model-id qwen2.5:0.5b --port 11434 \
        --stats-file data/local-llm-stats.json

依赖：`pip install llama-cpp-python`（或对应预编译 wheel）。其余仅用标准库。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BACKEND_TAG = "llama.cpp/0.3.36 + Ollama registry weights (CPU)"
WEIGHT_SOURCE = (
    "registry.ollama.ai/v2/library/qwen2.5/blobs/"
    "sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515"
)

# 容器 cgroup 常限制 CPU 配额（本沙箱 cpu.max=400000/100000 → 仅 4 核），
# 但 nproc 会报宿主机的 32 核；线程数超订阅会触发 cgroup throttling，
# 使单次推理从秒级劣化到几十秒。务必用 --threads 对齐真实配额。
MAX_TOKENS = int(os.environ.get("LOCAL_MAX_TOKENS", "192"))

LLM = None                      # type: ignore[assignment]
LOCK = threading.Lock()         # llama.cpp 单实例推理需串行化
STATS_LOCK = threading.Lock()
MODEL_ID = "qwen2.5:0.5b"
MODEL_PATH = ""
STATS_FILE = ""
VERBOSE = False
STATS: dict = {}


def _now() -> int:
    return int(time.time())


def _rid() -> str:
    return "chatcmpl-" + uuid.uuid4().hex[:24]


def _bump(**values: float) -> None:
    """只累加数值型指标，并原子落盘统计文件（作为真实推理的执行证据）。"""
    with STATS_LOCK:
        for k, v in values.items():
            STATS[k] = STATS.get(k, 0) + v
        STATS["lastUpdated"] = _now()
        if STATS_FILE:
            tmp = STATS_FILE + ".tmp"
            Path(tmp).write_text(json.dumps(STATS, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, STATS_FILE)


def _split_text(text: str, size: int = 16) -> list[str]:
    return [text[i:i + size] for i in range(0, len(text), size)]


def _build_kwargs(body: dict) -> dict:
    """把 OpenAI 请求体映射为 llama.cpp 参数，过滤掉不支持的字段。"""
    kw: dict = {
        "messages": body.get("messages") or [],
        "temperature": float(body.get("temperature", 0.2)),
        "max_tokens": int(body.get("max_tokens") or MAX_TOKENS),
    }
    tools = body.get("tools")
    if tools:
        kw["tools"] = tools
        kw["tool_choice"] = body.get("tool_choice") or "auto"
    if body.get("stop"):
        kw["stop"] = body["stop"]
    return kw


def _infer(body: dict) -> tuple[dict, float]:
    kw = _build_kwargs(body)
    started = time.time()
    with LOCK:
        result = LLM.create_chat_completion(**kw)
    return result, time.time() - started


def _usage_of(resp: dict) -> dict:
    u = resp.get("usage") or {}
    return {
        "prompt_tokens": int(u.get("prompt_tokens") or 0),
        "completion_tokens": int(u.get("completion_tokens") or 0),
        "total_tokens": int(u.get("total_tokens") or 0),
    }


def _tool_calls_of(resp: dict) -> list:
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    return msg.get("tool_calls") or []


def _nonstream(resp: dict) -> dict:
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    tcs = msg.get("tool_calls") or []
    message: dict = {"role": "assistant", "content": msg.get("content")}
    if tcs:
        message["tool_calls"] = tcs
    return {
        "id": resp.get("id") or _rid(),
        "object": "chat.completion",
        "created": resp.get("created") or _now(),
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "tool_calls" if tcs else (resp.get("choices") or [{}])[0].get("finish_reason") or "stop",
        }],
        "usage": _usage_of(resp),
    }


def _sse_chunks(resp: dict, body: dict):
    """真实推理结果 → 标准 OpenAI SSE 分片（buffered，非逐 token）。"""
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    content = msg.get("content") or ""
    tcs = msg.get("tool_calls") or []
    base = {
        "id": resp.get("id") or _rid(),
        "object": "chat.completion.chunk",
        "created": resp.get("created") or _now(),
        "model": MODEL_ID,
    }
    yield {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]}
    for piece in _split_text(content):
        yield {**base, "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}
    for i, tc in enumerate(tcs):
        fn = tc.get("function") or {}
        yield {**base, "choices": [{
            "index": 0,
            "delta": {"tool_calls": [{
                "index": i,
                "id": tc.get("id") or _rid(),
                "type": "function",
                "function": {"name": fn.get("name", ""), "arguments": fn.get("arguments", "")},
            }]},
            "finish_reason": None,
        }]}
    yield {
        **base,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tcs else "stop"}],
    }
    if (body.get("stream_options") or {}).get("include_usage"):
        yield {**base, "choices": [], "usage": _usage_of(resp)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        if VERBOSE:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _headers(self) -> None:
        self.send_header("X-Local-LLM-Backend", BACKEND_TAG)
        self.send_header("X-Local-LLM-ToolFormat", "chatml-function-calling")
        self.send_header("X-Local-LLM-Streaming", "buffered-sse")

    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._headers()
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/v1/models", "/models"):
            return self._json(200, {
                "object": "list",
                "data": [{"id": MODEL_ID, "object": "model", "created": _now(), "owned_by": "local-llama-cpp"}],
            })
        if path == "/api/tags":
            return self._json(200, {"models": [{
                "name": MODEL_ID, "model": MODEL_ID, "modified_at": "", "size": STATS.get("weightBytes", 0),
                "details": {"format": "gguf", "family": "qwen2", "parameter_size": "0.5B"},
            }]})
        if path in ("/health", "/"):
            return self._json(200, {"status": "ok", "backend": BACKEND_TAG, "model": MODEL_ID,
                                    "isRealInference": True, "isSimulated": False})
        if path == "/stats":
            with STATS_LOCK:
                return self._json(200, dict(STATS))
        return self._json(404, {"error": {"message": "not found", "type": "invalid_request"}})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/")
        if path not in ("/v1/chat/completions", "/chat/completions"):
            return self._json(404, {"error": {"message": "not found", "type": "invalid_request"}})
        try:
            length = int(self.headers.get("content-length") or "0")
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            return self._json(400, {"error": {"message": f"invalid body: {exc}", "type": "invalid_request"}})

        _bump(requests=1, streamRequests=int(bool(body.get("stream"))))
        try:
            resp, elapsed = _infer(body)
        except Exception as exc:
            _bump(errors=1)
            return self._json(500, {"error": {"message": str(exc)[:300], "type": "inference_error"}})

        usage = _usage_of(resp)
        tcs = _tool_calls_of(resp)
        _bump(
            promptTokens=usage["prompt_tokens"],
            completionTokens=usage["completion_tokens"],
            toolCallsEmitted=len(tcs),
            inferenceSeconds=round(elapsed, 3),
        )

        if body.get("stream"):
            return self._sse(resp, body)
        return self._json(200, _nonstream(resp))

    def _sse(self, resp: dict, body: dict) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self._headers()
        self.end_headers()
        self.close_connection = True
        try:
            for chunk in _sse_chunks(resp, body):
                self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # probe 只读首个 chunk 就 cancel，属正常行为
            pass


def main() -> None:
    global LLM, MODEL_ID, MODEL_PATH, STATS_FILE, VERBOSE, STATS
    ap = argparse.ArgumentParser(description="bro2 本地真实模型推理服务（OpenAI Compat）")
    ap.add_argument("--model", default=os.environ.get("LOCAL_GGUF", "/root/.cache/bro2-llm/qwen2.5-0.5b.gguf"))
    ap.add_argument("--model-id", default=os.environ.get("LOCAL_MODEL_ID", "qwen2.5:0.5b"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=11434)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--ctx", type=int, default=4096)
    ap.add_argument("--stats-file", default="")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    MODEL_ID = args.model_id
    MODEL_PATH = args.model
    STATS_FILE = args.stats_file
    VERBOSE = args.verbose

    if not Path(MODEL_PATH).is_file():
        sys.exit(f"权重不存在：{MODEL_PATH}\n见 docs/TAKEOVER.md 的下载命令。")

    from llama_cpp import Llama
    LLM = Llama(
        model_path=MODEL_PATH,
        n_ctx=args.ctx,
        n_threads=args.threads,
        n_batch=256,
        chat_format="chatml-function-calling",
        verbose=False,
    )

    STATS = {
        "schema": 1,
        "backend": BACKEND_TAG,
        "modelId": MODEL_ID,
        "modelPath": MODEL_PATH,
        "weightBytes": Path(MODEL_PATH).stat().st_size,
        "weightSource": WEIGHT_SOURCE,
        "chatFormat": "chatml-function-calling",
        "streamingMode": "buffered-sse",
        "isRealInference": True,
        "isSimulated": False,
        "isModelCapabilityScore": False,
        "note": "仅为真实推理执行统计，不构成能力分数，不参与证据阶梯判定。",
        "startedAt": _now(),
        "requests": 0, "streamRequests": 0, "toolCallsEmitted": 0,
        "promptTokens": 0, "completionTokens": 0, "errors": 0, "inferenceSeconds": 0,
    }
    if STATS_FILE:
        Path(STATS_FILE).parent.mkdir(parents=True, exist_ok=True)
        Path(STATS_FILE).write_text(json.dumps(STATS, ensure_ascii=False, indent=2), encoding="utf-8")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"[local-llm] {BACKEND_TAG}", flush=True)
    print(f"[local-llm] model={MODEL_ID} ctx={args.ctx} threads={args.threads}", flush=True)
    print(f"[local-llm] listening http://{args.host}:{args.port}/v1  (真实 CPU 推理，非仿真)", flush=True)
    if STATS_FILE:
        print(f"[local-llm] stats -> {STATS_FILE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
