from hexos_hooks import HookContext


def before_install(ctx):
    assert ctx.resource_type == "app", f"Wrong resourceType: {ctx.resource_type}"
    assert ctx.resource_id == "hexos-test", f"Wrong resourceId: {ctx.resource_id}"
    assert ctx.event == "onBeforeInstall", f"Wrong event: {ctx.event}"
    ctx.emit_checkpoint("before_install_done", "Pre-install validation passed")


def after_install(ctx):
    oauth = ctx.inputs.get("test_oauth", {})
    assert oauth.get("authToken"), "Missing OAuth authToken"

    password = ctx.inputs.get("test_password")
    assert password, "Missing password input"

    choice = ctx.inputs.get("test_select")
    assert choice in ("a", "b"), f"Invalid select value: {choice}"

    ctx.emit_checkpoint("inputs_validated", "All inputs received and valid")

    import time
    import requests
    for i in range(20):
        try:
            resp = requests.get(f"{ctx.base_url}/", timeout=3)
            if resp.status_code == 200:
                ctx.emit_checkpoint("app_reachable", "Test app responded")
                break
        except requests.RequestException:
            pass
        time.sleep(2)

    ctx.emit_checkpoint("after_install_done", "Post-install complete")


def before_upgrade(ctx):
    ctx.log(f"Upgrading from {ctx.from_version} to {ctx.to_version}")
    ctx.emit_checkpoint("before_upgrade_done", "Pre-upgrade patch applied")


def after_upgrade(ctx):
    ctx.emit_checkpoint("after_upgrade_done", "Post-upgrade cleanup complete")


def optional_fail(ctx):
    ctx.log("This hook intentionally fails")
    raise RuntimeError("Intentional failure for testing optional hook behavior")


if __name__ == "__main__":
    HookContext.run()
