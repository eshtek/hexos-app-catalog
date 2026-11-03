# The Lounge on HexOS

This script installs the [official The Lounge Docker image](https://github.com/thelounge/thelounge-docker) at stable version 4.5.2, pinned to its published multi-platform digest. It runs in The Lounge's default private mode. HexOS asks for an account name and password, then the after-install hook creates that account in The Lounge's own user directory. The hook retains an existing account with the same name and does not reset its password.

The app listens on container port 9000. HexOS publishes it on a movable host port starting at 30900 and provides a Web UI Launch link. The link uses HTTP on the server's LAN, so login credentials are not encrypted in transit. Use an HTTPS reverse proxy on an untrusted network and never forward the HTTP port directly to the internet. IRC servers are reached with outbound connections; no inbound IRC port is required.

All configuration, account files, message databases and text logs are stored in the Applications Performance location at `the-lounge/data`, mounted at `/var/opt/thelounge`. HexOS snapshots this folder for updates. The container runs as UID/GID 568 (`apps`), and HexOS assigns the folder to `apps`. The official image supports running as a different non-root user. The after-install hook creates account files owned by UID 568. HexOS folders carry an inherited NFSv4 ACL, so those files, like everything The Lounge writes there, read as mode 0770 with group root; the hook refuses a folder or account file that anyone else, or a group other than root and apps, can reach. The Lounge's default configuration stores message history in SQLite and text logs; users can change their logging preference in the app.

To add another user later, open the TrueNAS shell, identify The Lounge's container, and run `docker exec --user 568:568 -it <container> thelounge add <name>`. Use `thelounge reset <name>` in the same way to reset a password. These commands must run as the same UID as the app. Back up the entire `the-lounge/data` folder, including `users`, `logs`, `storage`, and `config.js`. Restoring that folder to the same mount preserves accounts and chat history. Keep ownership at 568:568 after restoration.

The HexOS sign-in must have a username made of letters, numbers, dots, underscores or hyphens and a non-empty password of at most 72 UTF-8 bytes, matching The Lounge's bcrypt password limit. If the chosen username already exists, the hook preserves its current password and history. Change an existing password through The Lounge's UI or the reset command.

## Checking a change on a HexOS server

1. Install from the catalog with a test sign-in, and confirm the Set up admin account step completes and Launch opens the login page on the published port.
2. Sign in, join a test IRC network, send a message, then restart the app and confirm the account, network, and history remain.
3. Confirm the container runs as UID/GID 568, that the account file in `the-lounge/data/users` is owned by 568, and that its ACL grants nothing to other users.
4. Run the setup step again over existing data and confirm it keeps the existing account and history.

Icon: The Lounge's `client/public/img/logo-grey-bg.svg` from the MIT-licensed [v4.5.2 source](https://github.com/thelounge/thelounge/tree/v4.5.2).

Catalog screenshots were captured from the official 4.5.2 Docker image running locally with a disposable account. The chat screenshot uses sample messages from a local IRC server. They show The Lounge's UI, not a HexOS installation or Launch test.
