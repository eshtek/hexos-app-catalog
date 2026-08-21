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
| [Dozzle](dozzle.json) | Real-time Docker log viewer |
| [Draw.io](drawio.json) | Diagram and whiteboard editor |
| [Emby](emby.json) | Media server |
| [Excalidraw](excalidraw.json) | Virtual whiteboard for sketching |
| [Firefly III](firefly-iii.json) | Financial planning software |
| [Fladder](fladder.json) | Front-end interface for Jellyfin |
| [Handbrake](handbrake.json) | Video transcoder |
| [Home Assistant](home-assistant.json) | Home automation platform |
| [Immich](immich.json) | Self-hosted photo & video management |
| [Jellyfin](jellyfin.json) | Free media server |
| [Jellystat](jellystat.json) | Statistics App for Jellyfin |
| [Lidarr](lidarr.json) | Music collection manager |
| [Linkwarden](linkwarden.json) | Webpage archiving utility |
| [LubeLogger](lubelogger.json) | Vehicle maintenance tracker |
| [Mealie](mealie.json) | Recipe Management |
| [Memos](memos.json) | Note taking tool |
| [MKVToolNix](mkvtoolnix.json) | A set of tools to create, alter and inspect Matroska files |
| [Navidrome](navidrome.json) | Music server and streamer |
| [Nextcloud](nextcloud.json) | File sync and collaboration |
| [PairDrop](pairdrop.json) | Transfer files cross-clatform |
| [Palworld Server](palworld.json) | Creates a Multiplayer Palworld Server |
| [Paperless-ngx](paperless-ngx.json) | Document management system |
| [Peanut](peanut.json) | UPS monitoring dashboard |
| [Plex](plex.json) | Media server with Plex Pass support |
| [Portracker](portracker.json) | Docker port tracking dashboard |
| [Prowlarr](prowlarr.json) | Indexer manager for Sonarr & Radarr |
| [qBittorrent](qbittorrent.json) | BitTorrent client |
| [qui](qui.json) | A qBittorrent web UI |
| [Rackula](rackula.json) | A drag and drop rack visualizer |
| [Radarr](radarr.json) | Movie collection manager |
| [Ratelog](radarr.json) | App for rating movies and TV shows |
| [Scrutiny](scrutiny.json) | Hard drive S.M.A.R.T. monitoring |
| [Seerr](seerr.json) | Request management and media discovery tool |
| [SnapOtter](snapotter.json) | File editing toolkit |
| [Sonarr](sonarr.json) | TV series collection manager |
| [Sportarr](sportarr.json) | Sports collection manager |
| [Sure](sure.json) | Financial planning software |
| [Swiparr](swiparr.json) | Collaborative content watching decision software |
| [Syncthing](syncthing.json) | Continuous file synchronization |
| [Warracker](warracker.json) | warranty tracker |
| [Wiki.js](wiki-js.json) | Open source Wiki software |

For schema documentation, macros reference, and contribution guidelines, see [docs.hexos.com](https://docs.hexos.com).

## Contributing

1. Fork this repository
2. Create your install script JSON in the root directory
3. Test it in HexOS by loading it as a custom install script
4. Submit a pull request with a description of any special requirements (GPU, unique mounts, environment variables, etc.)
