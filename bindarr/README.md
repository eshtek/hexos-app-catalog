# Bindarr on HexOS

This script installs the [official Bindarr image](https://github.com/thenotoriousJeremy/bindarr) at version 1.9.0, pinned to its published multi-platform digest. TrueNAS's catalog doesn't carry Bindarr, so it runs as a custom app.

Bindarr serves the same app on two ports. HexOS publishes plain HTTP on a movable host port starting at 30470, and Launch opens that one. HTTPS is published on a movable host port starting at 30471. Card scanning with a phone camera only works at the HTTPS address, because browsers refuse camera access over plain HTTP. Its certificate is self-signed, so each device shows a warning once.

The first visit asks the owner to create the admin account. HexOS sets no password.

Everything Bindarr keeps is in the Applications Performance location at `bindarr/data`, mounted at `/app/database`: the SQLite database, its daily backups, the scan models and catalogs, and the HTTPS certificate. HexOS snapshots this folder for updates. The container starts as root, the way the image ships. Its entrypoint gives the folder to the image's `node` user (UID 1000) and then runs the server as that user.

The install asks for a pokemontcgapi.com API key, which is optional. It is passed to the container as `POKEMONTCGAPI_KEY`, and the owner can change it later from the app's settings in HexOS. The key does nothing until pokemontcgapi.com is chosen as the Pokémon card source in Bindarr's Admin panel.

Card scanning needs two things the image doesn't ship. The two scan models are AGPL-3.0, so Bindarr leaves fetching them to the owner: run `docker exec <container> node scripts/fetch-models.mjs` from the TrueNAS shell, then restart the app. A scan catalog for each game is then built from Admin, Catalogs in Bindarr.

## Checking a change on a HexOS server

1. Install from the catalog with the API key left empty, and confirm Launch opens the page that creates the owner account.
2. Create the account, add a card, restart the app and confirm the account and the card remain.
3. Open the HTTPS address on a phone and confirm the page loads after the certificate warning.
4. Set an API key from the app's settings and confirm the container has `POKEMONTCGAPI_KEY` after it restarts.

Icon: Bindarr's `frontend/public/logo.svg` from the MIT-licensed [v1.9.0 source](https://github.com/thenotoriousJeremy/bindarr/tree/v1.9.0). Its colours were CSS variables with fallbacks. The icon carries the fallback colours directly, so it draws the same wherever it is shown.
