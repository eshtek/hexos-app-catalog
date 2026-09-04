import { HookContext } from "../../hexos-app-catalog/_lib/hook_context";
import { createTrueNasApi } from "../_lib/truenas_api";

/**
 * Tries to configure hardlinks between Radarr and qBittorrent. This is an optional step that can be skipped if the user does not want to use hardlinks.
 * To enable hardlinks the qbittorent container and radar container must use the same dataset to store the downloads and movies. This is because hardlinks can only be created within the same truenas dataset.
 * 
 * To make this work this function wil try to connect to the TrueNAS API and update qbittorrent's configuration to mount the movies folder. 
 * 
 * @param ctx 
 */
export async function afterInstall(ctx: HookContext) {

  const checkpoints = [
    { id: "Testing TrueNAS API", message: "Connected To TrueNAS API" },
    { id: "qbittorrentConfig", message: "Creating qbittorrent downloads directory" },
    { id: "qbitorrentDownloadFolder", message: "Creating qbittorrent downloads folder" },
    { id: "done", message: "Finished configuring hardlinks between Radarr and qBittorrent" }
  ];

  await ctx.registerCheckpoints(checkpoints);

  // Using Symbol.dispose to ensure the TrueNAS API client is properly closed after use
  await using client = await createTrueNasApi(ctx);

  await ctx.emitCheckpoint(checkpoints[0].id, "TrueNAS API is connected.");

  let qbittorentConfig = null;
  while (qbittorentConfig === null) {
    qbittorentConfig = await client.rpc("app.config", ["qbittorrent"]).catch(async (error) => {
      if (error.message.includes("-32602: Invalid params")) {
        ctx.log(`Error fetching config for 'qbittorrent'. The qbittorrent app is not installed.`);
        const action = await ctx.awaitCheckpointRetry(checkpoints[0].id, `The qbittorrent app is not installed. Please install it and try again.`, [
          { label: "Skip", value: "skip" },
          { label: "Cancel", value: "retry" }
        ]);
        if (action === "retry") {
          qbittorentConfig = null; // Reset result to null to retry the loop
        } else if (action === "skip") {
          await ctx.skipCheckpoint(checkpoints[0].id, "Cancelled configuring hardlinks between Radarr and qBittorrent.");
          return; // Exit the function if the user chooses to skip
        }
      }
    });
  }
  ctx.log(`qbittorrent config: ${JSON.stringify(qbittorentConfig, null, 2)}`);

  let radarrConfig = await client.rpc("app.config", ["radarr"]).catch((error) => {
    if (error.message.includes("-32602: Invalid params")) {
      ctx.log(`Error fetching config for 'radarr'. The radarr app is not installed.`);
    }
  });

  const radarrConfigStorage = radarrConfig["storage"]["additional_storage"];
  const radarrMoviesStorageConfig = (radarrConfigStorage.find((storage: any) => storage["mount_path"] === "/movies"));
  const radarrMoviesHostPath = radarrMoviesStorageConfig ? radarrMoviesStorageConfig["host_path_config"]["path"] : null;
  const qbittorentConfigStorage = qbittorentConfig["storage"]["additional_storage"];
  const qbittorentDownloadsStorageConfig = (qbittorentConfigStorage.find((storage: any) => storage["mount_path"] === radarrMoviesHostPath));
  const QbAlreadyHasMoviesMountPath = qbittorentConfigStorage.find((storage: any) => storage["mount_path"] === "/movies");
  const QbAlreadyHasMoviesHostMountPath = qbittorentConfigStorage.find((storage: any) => storage["host_path_config"]?.["path"] === radarrMoviesHostPath);

  if (!qbittorentDownloadsStorageConfig && !QbAlreadyHasMoviesMountPath && !QbAlreadyHasMoviesHostMountPath) {
    ctx.log(`The qbittorrent app does not have a storage configuration for the radarr movies path: ${radarrMoviesHostPath}.`);

    radarrMoviesStorageConfig["mount_path"] = "/movies";
    const result = await client.rpc("app.update", ["qbittorrent", {
      "values": {
        "storage": {
          ...qbittorentConfig["storage"],
          "additional_storage": [
            ...qbittorentConfigStorage,
            radarrMoviesStorageConfig
          ]
        }
      }
    }]);


    ctx.log(`movies path: ${JSON.stringify(result, null, 2)}`);
    await ctx.emitCheckpoint(checkpoints[1].id, `movies path configured.`);
  } else {
    await ctx.emitCheckpoint(checkpoints[1].id, `qbittorrent already has a storage configuration for the radarr movies path: ${radarrMoviesHostPath}.`);
  }
  const qbittorentDownloadsHostPath = String(radarrMoviesStorageConfig["host_path_config"]["path"]) + "/qbittorrent";
  ctx.log(`qbittorrent downloads path: ${qbittorentDownloadsHostPath}`);
  await client.rpc("filesystem.mkdir", [{
    path: qbittorentDownloadsHostPath, "options": {
      "mode": "755",
      "raise_chmod_error": false
    }
  }]).catch((error) => {
    ctx.log(`Error creating directory: ${error.message}`);
  });

  await client.uploadFile(qbittorentDownloadsHostPath + "/.ignore", "").catch((error) => {
    ctx.log(`Error creating .ignore file: ${error.message}`);
  });

  await ctx.emitCheckpoint(checkpoints[2].id, `qbittorrent downloads folder created.`);
  const qbitport = qbittorentConfig["network"]?.["web_port"]?.["port_number"] || 31189;;
  const body = {
    "headers": {
      "accept": "*/*",
      "cache-control": "no-cache",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "pragma": "no-cache",
      "Referer": `http://${ctx.host}:${qbitport}/newcategory.html?v=4b23xy&action=edit&categoryName=radarr`
    },
    "body": `category=radarr&savePath=${encodeURIComponent(radarrMoviesStorageConfig["mount_path"] + "/qbittorrent")}`,
    "method": "POST"
  }
  const response = await fetch(`http://${ctx.host}:${qbitport}/api/v2/torrents/editCategory`, body);
  const responseText = await response.text();
  if (responseText.includes("Category does not exist")) {
    await fetch(`http://${ctx.host}:${qbitport}/api/v2/torrents/createCategory`, body);
  }
  console.log(`qbittorrent editCategory response: ${response.status} ${response.statusText} ${responseText}`);
  await ctx.emitCheckpoint(checkpoints[3].id, `Finished configuring hardlinks between Radarr and qBittorrent.`);

}

