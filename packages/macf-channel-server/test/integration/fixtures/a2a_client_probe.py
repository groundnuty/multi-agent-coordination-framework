#!/usr/bin/env python3
"""
A2A Python SDK probe — fetches MACF's /.well-known/agent-card.json
through `a2a-sdk` v1.0.3's `A2ACardResolver` and dumps the parsed
AgentCard as JSON to stdout. Used by the TS-side integration test in
`../a2a-python-sdk.test.ts` (groundnuty/macf#376).

This is cross-implementation triangulation: the TS-side unit + E2E
suites prove "our JSON matches our Zod schema." This probe proves "the
official A2A reference SDK parses our JSON without error." Both are
needed — neither alone closes the silent-fallback hazard that internal-
schema-only validation creates.

Usage:
    a2a_client_probe.py \\
        --base-url https://127.0.0.1:8443 \\
        --ca-cert /path/to/ca.pem \\
        --client-cert /path/to/client.pem \\
        --client-key /path/to/client-key.pem \\
        [--expect-404]

stdout (success):
    JSON object: parsed AgentCard.model_dump(by_alias=True) — preserves
    spec field names like `protocolVersion`, `securitySchemes`.

stdout (--expect-404):
    JSON object: {"status": "404-as-expected", "error_class": "..."}

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

import httpx
from a2a.client.card_resolver import A2ACardResolver
from a2a.client.errors import AgentCardResolutionError
# a2a-sdk v1.0 uses protobuf-generated message types (not pydantic).
# `AgentCard` resolves to `a2a_pb2.AgentCard`. To serialize back to a
# JSON-shaped dict we use the protobuf json_format helper.
from google.protobuf.json_format import MessageToDict


async def fetch_and_parse(
    base_url: str,
    ca_cert: str,
    client_cert: str,
    client_key: str,
    expect_404: bool,
) -> dict:
    # mTLS context: trust the test CA + present the test client cert.
    # `ssl.create_default_context(cafile=...)` produces a context that
    # validates the server cert against the supplied CA. `load_cert_chain`
    # adds the client-side cert+key for mTLS handshake.
    ctx = ssl.create_default_context(cafile=ca_cert)
    ctx.load_cert_chain(certfile=client_cert, keyfile=client_key)
    # The test server's cert SAN is `IP:127.0.0.1,DNS:localhost`. We
    # don't disable hostname check; just route through 127.0.0.1 which
    # the cert covers via SAN.

    async with httpx.AsyncClient(verify=ctx) as client:
        resolver = A2ACardResolver(httpx_client=client, base_url=base_url)
        try:
            card = await resolver.get_agent_card()
        except AgentCardResolutionError as exc:
            # The resolver wraps underlying HTTP errors. For 404 we want
            # the test to confirm it raised AgentCardResolutionError with
            # a 404 status_code attribute (per a2a-python v1.0.3 source).
            status_code = getattr(exc, "status_code", None)
            if expect_404 and status_code == 404:
                return {
                    "status": "404-as-expected",
                    "error_class": type(exc).__name__,
                    "status_code": status_code,
                }
            raise

    if expect_404:
        # We expected 404 but got success. That's a test-side bug.
        raise RuntimeError(
            "expected 404 from absent-config server, got successful card"
        )

    # `card` is a protobuf message (a2a_pb2.AgentCard). MessageToDict
    # converts it to a JSON-shaped dict preserving the proto-defined
    # field names. `preserving_proto_field_name=False` (default) emits
    # the lowerCamelCase JSON names per the proto spec — matching what
    # MACF emits on the wire.
    return MessageToDict(card, preserving_proto_field_name=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--ca-cert", required=True)
    parser.add_argument("--client-cert", required=True)
    parser.add_argument("--client-key", required=True)
    parser.add_argument("--expect-404", action="store_true")
    args = parser.parse_args()

    try:
        result = asyncio.run(
            fetch_and_parse(
                base_url=args.base_url,
                ca_cert=args.ca_cert,
                client_cert=args.client_cert,
                client_key=args.client_key,
                expect_404=args.expect_404,
            )
        )
    except Exception as exc:  # noqa: BLE001 — diagnostic in test probe
        import traceback

        # Two-line stderr: structured JSON first (machine-readable),
        # then full traceback (human-readable for debugging).
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
