# ntfy

## Authentication must be set up manually (current HexOS limitation)

This app installs ntfy **open** — by default anyone who can reach it can publish and
subscribe. It does **not** create a login user during installation. That's a current
HexOS limitation rather than an ntfy one, and it affects any app whose users are
created by a CLI inside the container:

- A HexOS install script configures an app's values but cannot run a command inside
  the container, and install/upgrade **hooks have no `exec`** — so nothing can run
  ntfy's `ntfy user add` CLI, which is the only way to create a user.
- ntfy has **no admin HTTP API** for creating users (only self-service signup, which
  creates a non-admin account and would have to be left open), and its
  `NTFY_AUTH_USERS` variable needs a **bcrypt hash**, which an install script has no
  way to produce from a typed password.

If HexOS later lets hooks run a command in the container, this can be automated.

## Setting up a user yourself

1. In the app's **Environment Variables** (Edit the app), enable auth:
   - `NTFY_AUTH_FILE` — a file path in the **same directory as ntfy's `cache.db`**
     (your data mount), e.g. `<that directory>/user.db`, so it persists.
   - `NTFY_AUTH_DEFAULT_ACCESS` = `deny-all` (makes the server private)
   - `NTFY_ENABLE_LOGIN` = `true`
2. Restart the app so ntfy creates the auth database.
3. From the TrueNAS shell, find the ntfy container (`docker ps`) and create an admin:
   ```
   docker exec -it <ntfy-container> ntfy user add --role=admin <username>
   ```
   You'll be prompted for the password.
4. Log in at the ntfy web UI.

See the ntfy access-control docs for details:
https://docs.ntfy.sh/config/#access-control
