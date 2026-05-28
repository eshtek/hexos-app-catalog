from hexos_hooks import HookContext
import requests
import time


def after_install(ctx):
    auth_token = ctx.inputs.get("plex_login", {}).get("authToken", "")
    if not auth_token:
        raise RuntimeError("No Plex auth token provided")

    _wait_for_ready(ctx)
    ctx.emit_checkpoint("plex_ready", "Plex server started", progress=20)

    _claim_server(auth_token, ctx)
    ctx.emit_checkpoint("server_claimed", "Server claimed to Plex account", progress=45)

    _set_preferences(auth_token, ctx)
    ctx.emit_checkpoint("prefs_set", "Preferences configured", progress=65)

    _create_libraries(auth_token, ctx)
    ctx.emit_checkpoint("libraries_created", "Media libraries created", progress=95)


def _wait_for_ready(ctx):
    ctx.log("Waiting for Plex to start...")
    interval = 5.0
    for attempt in range(40):
        try:
            resp = requests.get(
                f"{ctx.base_url}/identity",
                headers={"Accept": "application/json"},
                timeout=5,
            )
            if resp.status_code == 200:
                ctx.log("Plex is ready.")
                return
        except requests.RequestException:
            pass
        time.sleep(interval)
        interval = min(interval + 2.0, 15.0)
    raise RuntimeError("Plex did not become ready in time")


def _claim_server(auth_token, ctx):
    ctx.log("Claiming Plex server...")
    headers = {
        "X-Plex-Token": auth_token,
        "X-Plex-Client-Identifier": "hexos-platform",
        "Accept": "application/json",
    }

    claim_resp = requests.get(
        "https://plex.tv/api/claim/token.json",
        headers=headers,
        timeout=10,
    )
    claim_resp.raise_for_status()
    claim_token = claim_resp.json().get("token", "")
    if not claim_token:
        raise RuntimeError("Failed to obtain claim token from plex.tv")

    for attempt in range(3):
        try:
            resp = requests.post(
                f"{ctx.base_url}/myplex/claim",
                params={"token": claim_token},
                headers={"X-Plex-Token": auth_token},
                timeout=15,
            )
            if resp.ok:
                ctx.log("Server claimed successfully.")
                return
            ctx.log(f"Claim attempt {attempt + 1} returned {resp.status_code}")
        except requests.RequestException as e:
            ctx.log(f"Claim attempt {attempt + 1} error: {e}")
        time.sleep(5)

    ctx.log("Claim via /myplex/claim failed, trying preference injection...")
    requests.put(
        f"{ctx.base_url}/:/prefs",
        params={"X-Plex-Token": auth_token, "PlexOnlineToken": auth_token},
        timeout=10,
    )
    ctx.log("Fallback claim applied.")


def _set_preferences(auth_token, ctx):
    prefs = {
        "AcceptedEULA": 1,
        "PublishServerOnPlexOnlineKey": 1,
        "FriendlyName": "HexOS Plex",
    }
    for key, value in prefs.items():
        for attempt in range(3):
            try:
                resp = requests.put(
                    f"{ctx.base_url}/:/prefs",
                    params={"X-Plex-Token": auth_token, key: value},
                    timeout=5,
                )
                if resp.ok:
                    ctx.log(f"Set preference: {key}")
                    break
            except requests.RequestException:
                pass
            time.sleep(3)


def _create_libraries(auth_token, ctx):
    libraries = [
        {
            "name": "Movies", "type": "movie", "location": "/movies",
            "agent": "tv.plex.agents.movie", "scanner": "Plex Movie",
        },
        {
            "name": "TV Shows", "type": "show", "location": "/shows",
            "agent": "tv.plex.agents.series", "scanner": "Plex TV Series",
        },
        {
            "name": "Music", "type": "artist", "location": "/music",
            "agent": "tv.plex.agents.music", "scanner": "Plex Music",
        },
        {
            "name": "Photos", "type": "photo", "location": "/photos",
            "agent": "com.plexapp.agents.none", "scanner": "Plex Photo Scanner",
        },
        {
            "name": "Videos", "type": "movie", "location": "/videos",
            "agent": "tv.plex.agents.movie", "scanner": "Plex Movie",
        },
    ]

    time.sleep(5)

    for lib in libraries:
        created = False
        backoff = 5.0
        for attempt in range(10):
            try:
                resp = requests.post(
                    f"{ctx.base_url}/library/sections",
                    params={
                        "X-Plex-Token": auth_token,
                        "name": lib["name"],
                        "type": lib["type"],
                        "agent": lib["agent"],
                        "scanner": lib["scanner"],
                        "language": "en-US",
                        "location": lib["location"],
                    },
                    timeout=15,
                )
                if resp.ok:
                    ctx.log(f"Created library: {lib['name']}")
                    created = True
                    break
                ctx.log(f"{lib['name']} attempt {attempt + 1}: {resp.status_code}")
            except requests.RequestException as e:
                ctx.log(f"{lib['name']} attempt {attempt + 1}: {e}")
            time.sleep(backoff)
            backoff = min(backoff * 1.5, 20.0)

        if not created:
            ctx.emit_error(f"Failed to create library {lib['name']} after 10 attempts")


if __name__ == "__main__":
    HookContext.run()
