#!/usr/bin/env python3
"""
A2A Python SDK server fixture — spins up an `a2a-sdk` v1.0.3 server using
the canonical `LegacyRequestHandler` + Starlette JSON-RPC routes wired with
a trivial echo agent. Listens on mTLS HTTPS for one or more requests, then
exits cleanly on SIGTERM.

groundnuty/macf#396 — A2A Phase 3 outbound integration test fixture. Mirror
of `a2a_client_probe.py` (Phase 1 #385) inverted to put Python on the
SERVER side; MACF channel-server acts as the A2A client.

Usage (called from `../a2a-python-sdk-server.test.ts`):
    a2a_server_probe.py \\
        --port <PORT> \\
        --ca-cert /path/to/ca.pem \\
        --server-cert /path/to/server.pem \\
        --server-key /path/to/server-key.pem \\
        [--agent-name echo-test]

The server exits with status 0 on SIGTERM. Stderr emits structured JSON
diagnostics for test-side debugging on failure.

Targets a2a-sdk == 1.0.3 (A2A spec v1.0). Pinned exactly via the venv's
`a2a-sdk` install (the integration test's `ensureA2aVenv()` helper).

**Import note**: a2a-sdk v1.0.3 exposes protobuf-generated message types
at `a2a.types.a2a_pb2`; the top-level `a2a.types` namespace re-exports
only a subset. Field names follow proto snake_case convention
(`message_id`, `context_id`, `protocol_binding`, etc.). Construct via
`Part(text="...")` for the oneof text variant — no separate `TextPart`
wrapper class.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import ssl
import sys
import uuid

import uvicorn

# a2a-sdk v1.0.3 protobuf message types live in a2a.types.a2a_pb2.
# Snake_case field names per proto canonical convention.
from a2a.types.a2a_pb2 import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentProvider,
    AgentSkill,
    Message,
    Part,
    Role,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)
from a2a.server.agent_execution.agent_executor import AgentExecutor
from a2a.server.agent_execution.context import RequestContext
from a2a.server.events.event_queue_v2 import EventQueue
from a2a.server.request_handlers.default_request_handler import LegacyRequestHandler
from a2a.server.routes.agent_card_routes import create_agent_card_routes
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from starlette.applications import Starlette


class EchoAgentExecutor(AgentExecutor):
    """Trivial agent — emits TaskStatusUpdateEvent transitioning the task
    through WORKING → COMPLETED with a synthetic agent reply echoing the
    inbound user text.

    Tests on the MACF side assert the client-received Task has state
    TASK_STATE_COMPLETED + an agent reply Message in `status.message`.
    """

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        msg = context.message
        user_text = ""
        if msg and msg.parts:
            for part in msg.parts:
                # Protobuf oneof — the active variant has its field set.
                # Access via direct attribute (`part.text`) which returns
                # "" if the variant isn't text.
                if part.text:
                    user_text = part.text
                    break

        task_id = context.task_id or str(uuid.uuid4())

        agent_reply = Message(
            message_id=f"agent-reply-{uuid.uuid4()}",
            role=Role.ROLE_AGENT,
            parts=[Part(text=f"echo: {user_text}")],
        )

        # WORKING then COMPLETED. Framework composes these into the final
        # Task returned synchronously to the JSON-RPC caller.
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=task_id,
                context_id=context.context_id or "",
                status=TaskStatus(state=TaskState.TASK_STATE_WORKING),
                final=False,
            )
        )
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=task_id,
                context_id=context.context_id or "",
                status=TaskStatus(
                    state=TaskState.TASK_STATE_COMPLETED,
                    message=agent_reply,
                ),
                final=True,
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        task_id = context.task_id or str(uuid.uuid4())
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=task_id,
                context_id=context.context_id or "",
                status=TaskStatus(state=TaskState.TASK_STATE_CANCELED),
                final=True,
            )
        )


def build_agent_card(port: int, name: str) -> AgentCard:
    return AgentCard(
        name=name,
        description="Echo test agent for MACF Phase 3 integration test",
        supported_interfaces=[
            AgentInterface(
                url=f"https://127.0.0.1:{port}/a2a/v1",
                protocol_binding="JSONRPC",
                protocol_version="1.0",
            ),
        ],
        version="1.0.0-test",
        provider=AgentProvider(organization="macf-test-fixture"),
        capabilities=AgentCapabilities(),
        default_input_modes=["application/json"],
        default_output_modes=["application/json"],
        skills=[
            AgentSkill(
                id="echo",
                name="echo",
                description="Echo the user message",
                tags=["test"],
            ),
        ],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ca-cert", required=True)
    parser.add_argument("--server-cert", required=True)
    parser.add_argument("--server-key", required=True)
    parser.add_argument("--agent-name", default="echo-test")
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    executor = EchoAgentExecutor()
    task_store = InMemoryTaskStore()
    agent_card = build_agent_card(args.port, args.agent_name)
    handler = LegacyRequestHandler(
        agent_executor=executor,
        task_store=task_store,
        agent_card=agent_card,
    )

    # IMPORTANT: enable_v0_3_compat=True activates the slash-namespaced
    # method-name dispatch (message/send, tasks/get, tasks/cancel) that
    # the A2A v1.0 spec § 9 documents. The SDK's primary JSON-RPC
    # dispatcher uses gRPC-style PascalCase names (SendMessage, GetTask)
    # natively; the slash-namespaced names are routed through the
    # v0.3 backward-compat adapter. MACF's `A2aClient.sendMessage()`
    # emits `"message/send"` per the spec text + Phase 2a/2b/2c/2d
    # consistency, so the server fixture needs to accept that form too.
    #
    # See `feedback_a2a_method_name_compat_layer.md` (TBD memory file) for
    # the SDK-vs-spec inconsistency observation worth tracking.
    jsonrpc_routes = create_jsonrpc_routes(
        request_handler=handler,
        rpc_url="/a2a/v1",
        enable_v0_3_compat=True,
    )
    # Also serve the AgentCard at /.well-known/agent-card.json so the
    # MACF client's getAgentCard() discovery call succeeds.
    agent_card_routes_list = create_agent_card_routes(agent_card)
    app = Starlette(routes=[*jsonrpc_routes, *agent_card_routes_list])

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=args.port,
        ssl_keyfile=args.server_key,
        ssl_certfile=args.server_cert,
        ssl_ca_certs=args.ca_cert,
        ssl_cert_reqs=ssl.CERT_REQUIRED,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)

    async def serve_with_ready_signal() -> None:
        task = asyncio.create_task(server.serve())
        # Wait for socket bind (uvicorn doesn't expose a "ready" hook in
        # the public API; poll the .started flag).
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        print(f"a2a-server-ready port={args.port}", flush=True)
        await task

    def shutdown_handler(*_args: object) -> None:
        server.should_exit = True

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    try:
        asyncio.run(serve_with_ready_signal())
    except Exception as exc:  # noqa: BLE001 — diagnostic in test fixture
        import traceback

        diag = {
            "error": str(exc),
            "error_class": type(exc).__name__,
        }
        print(json.dumps(diag), file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
