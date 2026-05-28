from __future__ import annotations

import argparse
import json
import sys


class HookContext:
    """Runtime context provided to every hook script by the HexOS platform.

    The platform spawns the hook as: python3 <script> --entrypoint <fn> --context '<json>'
    The script calls HookContext.run() which parses args, creates the context, and calls the entrypoint.

    Resource-agnostic: uses resourceType/resourceId instead of appId.
    Apps are the first consumer but the engine supports any resource type.

    Fields use snake_case per Python convention (PEP 8). The JSON context
    from the platform uses camelCase — mapped here in the constructor.
    """

    def __init__(self, data: dict):
        self.payload = data
        self.resource_type = data.get("resourceType", "")
        self.resource_id = data.get("resourceId", "")
        self.event = data.get("event", "")
        self.from_version = data.get("fromVersion")
        self.to_version = data.get("toVersion")
        self.config_path = data.get("configPath")
        self.mounts = data.get("mounts", {})

        self.host = data.get("host", "localhost")
        self.port = data.get("port", 0)
        self.base_url = f"http://{self.host}:{self.port}" if self.port else ""

        self.inputs = data.get("inputs", {})

    def log(self, msg: str):
        print(json.dumps({"type": "log", "message": msg}), flush=True)

    def emit_checkpoint(self, checkpoint_id: str, message: str = "", progress: int | None = None):
        data = {
            "type": "checkpoint",
            "id": checkpoint_id,
            "message": message,
        }
        if progress is not None:
            data["progress"] = progress
        print(json.dumps(data), flush=True)

    def emit_error(self, message: str):
        print(json.dumps({"type": "error", "message": message}), flush=True)

    @staticmethod
    def run():
        parser = argparse.ArgumentParser()
        parser.add_argument("--entrypoint", required=True)
        parser.add_argument("--context", required=True)
        args = parser.parse_args()

        if args.entrypoint.startswith("_") or not args.entrypoint.isidentifier():
            raise ValueError(f"Invalid entrypoint: {args.entrypoint}")

        ctx = HookContext(json.loads(args.context))
        fn = getattr(sys.modules["__main__"], args.entrypoint, None)

        if fn is None or not callable(fn):
            raise ValueError(f"Entrypoint not found or not callable: {args.entrypoint}")

        fn(ctx)
