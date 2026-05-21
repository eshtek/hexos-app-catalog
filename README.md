# hexos-app-catalog

Community-maintained install scripts for deploying apps on [HexOS](https://hexos.com).

Install scripts are JSON configurations that automate app deployment on HexOS — handling storage mounts, directory creation, permissions, networking, and resource allocation with a single click.

## Available Scripts

| App | Description |
|-----|-------------|
| [Bazarr](bazarr.json) | Subtitle management for Sonarr & Radarr |
| [Blinko](blinko.json) | Self-hosted bookmarking and note-taking |
| [Dozzle](dozzle.json) | Real-time Docker log viewer |
| [Draw.io](drawio.json) | Diagram and whiteboard editor |
| [Emby](emby.json) | Media server |
| [Excalidraw](excalidraw.json) | Virtual whiteboard for sketching |
| [Handbrake](handbrake.json) | Video transcoder |
| [Home Assistant](home-assistant.json) | Home automation platform |
| [Immich](immich.json) | Self-hosted photo & video management |
| [Jellyfin](jellyfin.json) | Free media server |
| [Lidarr](lidarr.json) | Music collection manager |
| [LubeLogger](lubelogger.json) | Vehicle maintenance tracker |
| [Navidrome](navidrome.json) | Music server and streamer |
| [Nextcloud](nextcloud.json) | File sync and collaboration |
| [Peanut](peanut.json) | UPS monitoring dashboard |
| [Plex](plex.json) | Media server with Plex Pass support |
| [Portracker](portracker.json) | Docker port tracking dashboard |
| [Prowlarr](prowlarr.json) | Indexer manager for Sonarr & Radarr |
| [qBittorrent](qbittorrent.json) | BitTorrent client |
| [Radarr](radarr.json) | Movie collection manager |
| [Scrutiny](scrutiny.json) | Hard drive S.M.A.R.T. monitoring |
| [Sonarr](sonarr.json) | TV series collection manager |
| [Syncthing](syncthing.json) | Continuous file synchronization |

For schema documentation, macros reference, and contribution guidelines, see [docs.hexos.com](https://docs.hexos.com).

## Contributing

1. Fork this repository
2. Create your install script JSON in the root directory
3. Test it in HexOS by loading it as a custom install script
4. Submit a pull request with a description of any special requirements (GPU, unique mounts, environment variables, etc.)