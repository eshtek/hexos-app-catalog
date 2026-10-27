# hexos-app-catalog

Community-maintained install scripts for deploying apps on [HexOS](https://hexos.com).

Install scripts are JSON configurations that automate app deployment on HexOS — handling storage mounts, directory creation, permissions, networking, and resource allocation with a single click.

## Available Scripts

| App | Description |
|-----|-------------|
| [AFFiNE](affine.json) | Knowledge base software |
| [Actual Budget](actual-budget.json) | Financial planning software |
| [Bazarr](bazarr.json) | Subtitle management for Sonarr & Radarr |
| [BentoPDF](bentopdf.json) | PDF editing toolkit |
| [Blinko](blinko.json) | Self-hosted bookmarking and note-taking |
| [Deluge](deluge.json) | BitTorrent client, lightweight |
| [Donetick](dozzle.json) | Smart task manager |
| [Dozzle](dozzle.json) | Real-time Docker log viewer |
| [Draw.io](drawio.json) | Diagram and whiteboard editor |
| [Emby](emby.json) | Media server |
| [Excalidraw](excalidraw.json) | Virtual whiteboard for sketching |
| [FileFlows](fileflows.json) | Automated media file conversion |
| [Firefly III](firefly-iii.json) | Financial planning software |
| [Fladder](fladder.json) | Front-end interface for Jellyfin |
| [Handbrake](handbrake.json) | Video transcoder |
| [Home Assistant](home-assistant.json) | Home automation platform |
| [Immich](immich.json) | Self-hosted photo & video management |
| [Jellyfin](jellyfin.json) | Free media server |
| [Jellystat](jellystat.json) | Statistics App for Jellyfin |
| [Kodi](kodi.json) | Media player on the TV plugged into the server |
| [Lidarr](lidarr.json) | Music collection manager |
| [Linkwarden](linkwarden.json) | Webpage archiving utility |
| [LubeLogger](lubelogger.json) | Vehicle maintenance tracker |
| [Mealie](mealie.json) | Recipe Management |
| [Memos](memos.json) | Note taking tool |
| [MKVToolNix](mkvtoolnix.json) | A set of tools to create, alter and inspect Matroska files |
| [Navidrome](navidrome.json) | Music server and streamer |
| [NZBGet](nzbget.json) | Usenet downloader, lightweight |
| [Nextcloud](nextcloud.json) | File sync and collaboration |
| [PairDrop](pairdrop.json) | Transfer files cross-clatform |
| [Palworld Server](palworld.json) | Creates a Multiplayer Palworld Server |
| [Paperless-ngx](paperless-ngx.json) | Document management system |
| [Peanut](peanut.json) | UPS monitoring dashboard |
| [Plex](plex.json) | Media server with Plex Pass support |
| [Portracker](portracker.json) | Docker port tracking dashboard |
| [Profilarr](profilarr.json) | Quality profiles for Radarr & Sonarr |
| [Prowlarr](prowlarr.json) | Indexer manager for Sonarr & Radarr |
| [qBittorrent](qbittorrent.json) | BitTorrent client |
| [qui](qui.json) | A qBittorrent web UI |
| [Rackula](rackula.json) | A drag and drop rack visualizer |
| [Radarr](radarr.json) | Movie collection manager |
| [Ratelog](radarr.json) | App for rating movies and TV shows |
| [RomM](romm.json) | Game ROM collection manager and player |
| [SABnzbd](sabnzbd.json) | Usenet downloader |
| [Scrutiny](scrutiny.json) | Hard drive S.M.A.R.T. monitoring |
| [Seerr](seerr.json) | Request management and media discovery tool |
| [SnapOtter](snapotter.json) | File editing toolkit |
| [Sonarr](sonarr.json) | TV series collection manager |
| [Sportarr](sportarr.json) | Sports collection manager |
| [Sure](sure.json) | Financial planning software |
| [Swiparr](swiparr.json) | Collaborative content watching decision software |
| [Syncthing](syncthing.json) | Continuous file synchronization |
| [Tautulli](tautulli.json) | Watch history and stats for Plex |
| [Warracker](warracker.json) | warranty tracker |
| [Wiki.js](wiki-js.json) | Open source Wiki software |

For schema documentation, macros reference, and contribution guidelines, see [docs.hexos.com](https://docs.hexos.com).

## Requirement specifications

`requirements.specifications` values are parametric — any sensible number works without a platform change. The accepted patterns:

| Pattern | Meaning | Examples |
|---------|---------|----------|
| `{n}CORE` | Minimum CPU cores | `2CORE`, `4CORE`, `6CORE` |
| `{n}MB` / `{n}GB` | Approximate storage needed for installation | `256MB`, `1GB`, `30GB` |
| `{n}MBRAM` / `{n}GBRAM` | Minimum memory | `512MBRAM`, `8GBRAM` |
| `GPU` | GPU recommended | `GPU` |

Every value must match `^(\d+)(MBRAM|GBRAM|MB|GB|CORE)$` or be the literal `GPU` — anything else fails the catalog sync for that app. Use the largest natural unit (`1GB`, not `1024MB`; `8GBRAM`, not `8192MBRAM`) so the rendered text reads cleanly.

```json
"requirements": {
  "specifications": ["4CORE", "30GB", "16GBRAM"]
}
```

## Collections

A collection is a curated set of apps installed in one walk ("Media library": a media server, the *arr apps and a download client). Each is a JSON file in `_collections/`, named after its id (`media-management.json`). The catalog sync reads them alongside the install scripts, and HexOS shows them in the app catalog to accounts with the `app-collections` feature.

```json
{
  "type": "collection",
  "version": 1,
  "name": "Media library",
  "description": "Get started with all the apps you need for managing your own media collection.",
  "requirements": { "specifications": ["GPU"] },
  "groups": [
    { "id": "download", "type": "multiple", "min": 1, "title": "Download clients",
      "options": [{ "app": "qbittorrent", "default": true }, { "app": "sabnzbd" }] },
    { "id": "managers", "type": "multiple", "min": 1, "title": "Media managers",
      "options": [{ "app": "radarr", "default": true }, { "app": "sonarr", "default": true }] },
    { "id": "indexer", "type": "fixed", "title": "Indexer manager", "options": [{ "app": "prowlarr" }] },
    { "id": "player", "type": "single", "title": "Media server",
      "options": [{ "app": "jellyfin", "default": true }, { "app": "plex" }, { "app": "emby" }] },
    { "id": "stats", "type": "multiple", "title": "Watch statistics",
      "options": [{ "app": "tautulli", "requires": ["plex"] }] }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `groups` | Asked in this order. Media library asks for the media server last, so the steps that may need more from the owner (a Plex sign-in) come at the end, and the media server's extras after it; a group with nothing on offer for the picks so far has no step |
| `groups[].type` | `fixed`: every app is installed. `single`: the owner picks one (the `default`, else the first, is picked to start). `multiple`: the owner picks any, starting from the ones marked `default` |
| `options[].app` | An app with an install script in this catalog |
| `options[].summary` | A few words on what the app is for in this collection ("Torrents", "Movies"), shown under its name in the walk. Without it the walk shows the app's catalog description |
| `options[].requires` | Offered only when all of these apps are picked in an earlier group. This is what makes the walk branch |
| `options[].requiresAny` | Offered only when at least one of these apps is picked in an earlier group (Bazarr beside Radarr or Sonarr) |
| `options[].answers` | The app's install questions the collection answers itself, by question key, so the walk doesn't ask what the picks already say: Jellystat beside Jellyfin answers `{ "is_emby_api": "false" }`. Each key must be a question the app asks, and a select's answer one of its options |
| `groups[].min` | A `multiple` group the owner can't leave with fewer picks than this, while it offers that many |
| `requirements.specifications` | Lines the collection adds to its apps' own requirements, in the same patterns |
| `image` | Optional card art, a path in this repo. Without it the card shows the apps' icons |
| `internal` | Left out of the `prod` catalog, as an internal install script is |

Each app appears once in a collection. Apps install one after another, in the order the file lists them, and one with data from an earlier install reuses it. An app the owner already has, and picks, is brought up to date and set up to work with the others, as one the collection installs would be. `bun run validate` checks every collection against these rules and the catalog's own apps.

The links between a collection's apps are the apps' own pairing hooks: a hook on one app whose conditions name another (Prowlarr's `connect-radarr`). HexOS runs each one whose apps are all in the collection once those apps are in, in the order the file lists the apps. A link out of an app waits for the links into it, since one may be what sets the app up: Jellyfin's `connect-seerr` signs Seerr in before Seerr's own links act as that account. Two links into the same app keep the file's order too, so list first the app whose link changes what a later one reads: Media library lists Profilarr before Seerr, so Radarr has Profilarr's profiles before Seerr picks its default one. A link that needs its own app set up first names that hook in `requiresHooks`; one that takes that setup's answers declares inputs with the same ids (Plex's `connect-seerr` takes the Plex sign-in Pre-configure Plex was given, `plex_login`), and, in a collection, the run goes back to that setup first when it didn't finish in the run (nobody signed in to Plex while it installed, or Plex was there before), asking again, so the link takes its answers; from the card, a link asks for them itself when that setup didn't run. A setup a link can go back to runs from the app's card too (`userAction`, `rerun: converge`), as Pre-configure Jellyfin, Emby and Plex do; Pre-configure Plex keeps the name of a server that was already claimed. A link that finds the owner skipped what it needs (Plex's sign-in, so Seerr was never set up) ends with `ctx.skip(message)` rather than `ctx.fail`: a collection skips it with the message instead of offering a Try again that can't help, and a run from the app's card fails with the same message. A box from before `ctx.skip` doesn't have it, so call it as `if (ctx.skip) ctx.skip(message);` followed by `ctx.fail(message);`. A hook reaches an app at the box's address and the app's `requirements.ports[0]`, so every app that runs a hook or is named by one pins its web port in `app_values.network` and declares that same port first: the port TrueNAS publishes, not the one inside the container. `bun run validate` refuses a mismatch and warns when nothing is pinned.

An app a collection installs opens ready, with nothing left for the owner but their own accounts (indexers, Usenet servers). An app with a sign-in of its own declares `sign_in` (`{ "username": true }`; `false` for Deluge, whose page asks only for a password; `adds_user` for Jellyfin and Emby, which have users of their own), and the owner chooses that sign-in once, for every such app the install or collection sets up. Its hooks get it as `ctx.signIn` and set it before the app's first start where the app reads one from its settings (`seed-sign-in` for Radarr, Sonarr and Lidarr, `seed-webui` for qBittorrent and Deluge, `seed-settings` for SABnzbd), or from its setup hook once it is up (Prowlarr, NZBGet, Profilarr, Jellyfin, Emby), and the home network gets in without it wherever the app allows that (SABnzbd asks only from outside, with External internet access at its full web interface with a sign-in from outside; Profilarr 2.3 and Deluge always ask). Jellyfin's and Emby's administrator is that sign-in, and so is Seerr's through them, and Jellystat's. An app the owner already had gets the same sign-in when a collection brings it in: a new administrator where the app has users of its own (and, in Seerr, an administrator imported from the media server), the app's own sign-in replaced everywhere else (Profilarr keeps its username, since it can't rename its account). HexOS gets in with what it can read itself (an API key, the app's own settings file, an administrator's key in Jellyfin's or Emby's database, read-only) and asks the owner with `ctx.askForInputs` only when nothing works. The owner's password is never written to a file of HexOS's own; links that need a client's password take `ctx.signIn`, then the one the client's own settings hold (NZBGet), and ask last. With no sign-in chosen (a deck from before the choice), an app gets admin/admin (Profilarr's password is `adminadmin`, as it refuses one under 8 characters), kept in `hexos/` beside its settings so a later run knows it's HexOS's, and a run from the app's card leaves a sign-in as it is.

Each download client keeps its downloads in its own folder of the Downloads location, mounted in the client at the path Radarr, Sonarr and Lidarr see it at (they mount the whole location at `/downloads`, and qBittorrent's folder at `/config/Downloads` too), so the links add no remote path mapping, which would belong to the box's address rather than to one client. Deluge's and NZBGet's charts fix their own `/downloads` mount, so their folder is mounted again at `/downloads/<app>`, which leaves an empty folder of that name inside it. Every client keeps a download in progress apart from finished ones, inside its own folder: qBittorrent in `incomplete` and `complete`, Deluge in `incomplete` and `complete` (its own default and the managers' Download and Move Completed folders), SABnzbd in `incomplete` and `complete`, NZBGet in its stock `intermediate` and `completed`. A client the owner already had keeps folders they chose. Prowlarr gets each client too, for what the owner grabs in Prowlarr's own search, under a `prowlarr` category that no manager imports from, and qBittorrent hands it a new sign-in as it does the managers.

## Jellyfin pairing actions

Jellyfin offers optional connections to Jellystat and Seerr, plus a read-only Fladder/Jellyfin reachability check. Jellystat and Seerr depend on Pre-configure Jellyfin (`requiresHooks`), whose administrator they sign in with: the sign-in the owner chose for the install or collection (`ctx.signIn`), else the answers an older Pre-configure Jellyfin was given, and asked for last. Pre-configure Jellyfin remains optional.

An existing Jellystat account must authenticate; the connector only creates an account when Jellystat reports a fresh setup. Both connectors refuse to replace a different existing media-server binding, a Seerr on the same Jellyfin at another port, protocol or URL path included, and in a collection they step aside (`ctx.skip`) rather than wait on a Try again. Fladder's check does not change its configured server address.

Run the mocked API and password-hash compatibility tests with `bun test _lib/`, then the catalog validator with `bun _lib/validate.ts`. The hook tests make no network requests.

## Contributing

1. Fork this repository
2. Create your install script JSON in the root directory
3. Test it in HexOS by loading it as a custom install script
4. Submit a pull request with a description of any special requirements (GPU, unique mounts, environment variables, etc.)
