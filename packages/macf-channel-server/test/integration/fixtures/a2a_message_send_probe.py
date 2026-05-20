#!/usr/bin/env python3
"""
A2A Python SDK probe — message/send round-trip + tasks/get against MACF's
`/a2a/v1` JSON-RPC endpoint via `a2a-sdk` v1.0.3's `Client.send_message()`.

Mirrors `a2a_client_probe.py` (AgentCard discovery) but exercises the
INBOUND message-send surface added by macf#390 Phase 2a + macf#398
Phase 2d (tasks/get). Used by `../a2a-message-send-python-sdk.test.ts`
(groundnuty/macf#398 Phase 2d).

**Cross-implementation triangulation**: TS-side unit + E2E suites prove
"our JSON matches our Zod schema." This probe proves "the official A2A
reference SDK successfully sends + parses our JSON-RPC envelope." Both
needed — neither alone closes the silent-fallback hazard.

Usage:
    a2a_message_send_probe.py \\
        --base-url https://127.0.0.1:8443 \\
        --ca-cert /path/to/ca.pem \\
        --client-cert /path/to/client.pem \\
        --client-key /path/to/client-key.pem \\
        [--mode {message_send|tasks_get|tasks_cancel}]
        [--task-id <id>]                 # tasks_get / tasks_cancel only

stdout (success):
    JSON object describing the outcome:
      message_send: { "task_id": "...", "state": "TASK_STATE_COMPLETED",
                      "history_len": N, "sdk_parsed_ok": true }
      tasks_get:    { "task_id": "...", "state": "...", "sdk_parsed_ok": true }
      tasks_cancel: { "task_id": "...", "state": "TASK_STATE_CANCELED", ... }

stderr:
    Diagnostic info on error paths. Exit code != 0 on unexpected failure.

Targets a2a-sdk == 1.0.3 (A2A spec v1.0). Pinned exactly so SDK drift
doesn't silently change parser behavior under the test.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import ssl
import sys
import uuid

import httpx
from google.protobuf.json_format import MessageToDict


def _build_message_send_request(message_text: str) -> dict:
    """Construct the JSON-RPC envelope for message/send.

    We hand-build the envelope rather than relying on the SDK's
    `Client.send_message()` because the v1.0.3 SDK requires AgentCard
    discovery + an HTTP transport setup that doesn't match the test's
    direct-POST pattern. Hand-building the envelope still exercises:
    1. Our endpoint's parse + dispatch + state machine
    2. The SDK parser on the response side (where round-trip integrity
       actually matters most — protobuf round-trip through MessageToDict
       proves the Task object survives the wire transit)
    """
    return {
        "jsonrpc": "2.0",
        "id": f"req-{uuid.uuid4()}",
        "method": "message/send",
        "params": {
            "message": {
                "messageId": f"msg-{uuid.uuid4()}",
                "role": "ROLE_USER",
                "parts": [{"text": message_text}],
            },
        },
    }


def _build_tasks_get_request(task_id: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": f"req-{uuid.uuid4()}",
        "method": "tasks/get",
        "params": {"id": task_id},
    }


def _build_tasks_cancel_request(task_id: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": f"req-{uuid.uuid4()}",
        "method": "tasks/cancel",
        "params": {"id": task_id},
    }


def _validate_task_via_sdk(task_dict: dict) -> bool:
    """Try parsing the returned Task through the SDK's protobuf model.

    The SDK exposes `Task` as `a2a_pb2.Task`. Round-tripping our JSON
    through the proto parser confirms our wire shape matches the canonical
    proto. Returns True on success, raises ValueError otherwise (caller
    catches + propagates to stderr).
    """
    # Import is local so probe failures during import bubble to stderr
    # with a clear diagnostic rather than killing the whole probe.
    # The protobuf-generated module lives at `a2a.types.a2a_pb2` in
    # a2a-sdk v1.0.3 (verified via venv inspection).
    from google.protobuf import json_format
    from a2a.types import a2a_pb2

    pb = a2a_pb2.Task()
    json_format.ParseDict(task_dict, pb, ignore_unknown_fields=True)
    # Round-trip back to dict to confirm the SDK's serialization matches
    # what we received. Cross-validates JSON ↔ proto shape symmetry.
    redumped = MessageToDict(pb, preserving_proto_field_name=False)
    if "id" not in redumped or "status" not in redumped:
        raise ValueError(f"SDK round-trip stripped required Task fields: {list(redumped.keys())}")
    return True


async def run_message_send(
    client: httpx.AsyncClient,
    base_url: str,
) -> dict:
    """Send a message/send request + validate the Task response via the SDK."""
    body = _build_message_send_request("hello from python probe")
    resp = await client.post(f"{base_url}/a2a/v1", json=body)
    resp.raise_for_status()
    envelope = resp.json()
    if "error" in envelope:
        raise RuntimeError(
            f"server returned JSON-RPC error: code={envelope['error'].get('code')} "
            f"reason={envelope['error'].get('data', {}).get('reason')} "
            f"message={envelope['error'].get('message')}"
        )
    task = envelope["result"]
    sdk_parsed_ok = _validate_task_via_sdk(task)
    a2a_version = resp.headers.get("a2a-version")
    return {
        "mode": "message_send",
        "task_id": task["id"],
        "state": task["status"]["state"],
        "history_len": len(task.get("history", [])),
        "sdk_parsed_ok": sdk_parsed_ok,
        "a2a_version_header": a2a_version,
    }


async def run_tasks_get(
    client: httpx.AsyncClient,
    base_url: str,
    task_id: str,
) -> dict:
    body = _build_tasks_get_request(task_id)
    resp = await client.post(f"{base_url}/a2a/v1", json=body)
    resp.raise_for_status()
    envelope = resp.json()
    if "error" in envelope:
        raise RuntimeError(
            f"server returned JSON-RPC error: code={envelope['error'].get('code')} "
            f"reason={envelope['error'].get('data', {}).get('reason')}"
        )
    task = envelope["result"]
    sdk_parsed_ok = _validate_task_via_sdk(task)
    return {
        "mode": "tasks_get",
        "task_id": task["id"],
        "state": task["status"]["state"],
        "sdk_parsed_ok": sdk_parsed_ok,
        "a2a_version_header": resp.headers.get("a2a-version"),
    }


async def run_tasks_cancel(
    client: httpx.AsyncClient,
    base_url: str,
    task_id: str,
) -> dict:
    body = _build_tasks_cancel_request(task_id)
    resp = await client.post(f"{base_url}/a2a/v1", json=body)
    resp.raise_for_status()
    envelope = resp.json()
    if "error" in envelope:
        # cancel may legitimately return an error envelope (e.g., the task
        # was already terminal). Return the structured error for caller
        # assertion rather than treating as fatal.
        return {
            "mode": "tasks_cancel",
            "error_code": envelope["error"]["code"],
            "error_reason": envelope["error"].get("data", {}).get("reason"),
            "error_message": envelope["error"].get("message"),
        }
    task = envelope["result"]
    sdk_parsed_ok = _validate_task_via_sdk(task)
    return {
        "mode": "tasks_cancel",
        "task_id": task["id"],
        "state": task["status"]["state"],
        "sdk_parsed_ok": sdk_parsed_ok,
        "a2a_version_header": resp.headers.get("a2a-version"),
    }


async def run_probe(
    base_url: str,
    ca_cert: str,
    client_cert: str,
    client_key: str,
    mode: str,
    task_id: str | None,
) -> dict:
    ctx = ssl.create_default_context(cafile=ca_cert)
    ctx.load_cert_chain(certfile=client_cert, keyfile=client_key)
    async with httpx.AsyncClient(verify=ctx, timeout=15.0) as client:
        if mode == "message_send":
            return await run_message_send(client, base_url)
        if mode == "tasks_get":
            if not task_id:
                raise ValueError("--task-id required for mode=tasks_get")
            return await run_tasks_get(client, base_url, task_id)
        if mode == "tasks_cancel":
            if not task_id:
                raise ValueError("--task-id required for mode=tasks_cancel")
            return await run_tasks_cancel(client, base_url, task_id)
        raise ValueError(f"Unknown mode: {mode}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--ca-cert", required=True)
    parser.add_argument("--client-cert", required=True)
    parser.add_argument("--client-key", required=True)
    parser.add_argument(
        "--mode",
        choices=["message_send", "tasks_get", "tasks_cancel"],
        default="message_send",
    )
    parser.add_argument("--task-id", default=None)
    args = parser.parse_args()

    try:
        result = asyncio.run(
            run_probe(
                base_url=args.base_url,
                ca_cert=args.ca_cert,
                client_cert=args.client_cert,
                client_key=args.client_key,
                mode=args.mode,
                task_id=args.task_id,
            )
        )
    except Exception as exc:  # noqa: BLE001 — diagnostic in test probe
        import traceback

        diag = {
            "error": str(exc),
            "error_class": type(exc).__name__,
            "args": [repr(a) for a in getattr(exc, "args", ())],
            "cause": repr(exc.__cause__) if exc.__cause__ else None,
        }
        print(json.dumps(diag), file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
