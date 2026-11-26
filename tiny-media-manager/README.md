# Tiny Media Manager

## Adding your libraries as data sources

Your libraries are mounted inside the app under `/media/`:

- **Movies** → `/media/Movies`
- **TV Shows** → `/media/Shows`

They are mounted under `/media/` (tinyMediaManager's recommended location) rather
than at the container root **on purpose**: tinyMediaManager refuses to add a
top-level mount as a data source, and it also blocks "dangerous" system paths, so
the libraries are nested under `/media/` to make them selectable.

After installing, in tinyMediaManager:

1. **Movies** → Settings → **Add data source** → browse to `/media/Movies`.
2. **TV shows** → Settings → **Add data source** → browse to `/media/Shows`.

This one-time "add data source" step can't be pre-configured by the install
script — tinyMediaManager stores its data sources in its own config, which HexOS
has no way to set.

## tinyMediaManager license (PRO)

If you have a tinyMediaManager (PRO) license, paste the code into the **"tinyMediaManager
license code"** field during install — an `onAfterInstall` hook writes it to `/data/tmm.lic`
(where tinyMediaManager reads its license) and restarts the app so it activates
automatically. The license is per-user, so it works on any number of installs.

Leave the field blank to run the free version; you can still register later in the app
(Info → Register), and an existing `tmm.lic` is left untouched on reinstall.
