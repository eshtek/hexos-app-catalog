import { HookContext } from "../_lib/hook_context";
import { cloneJsonValue, getRequestTemplate, buildRequestInit } from "../_lib/helpers";
import { getJellyfinApiKey } from "./getJellyfinApiKey";

const RETRY_ATTEMPTS = 3;


import requestTosend from "./request_to_sent.jsonc" with { type: "json" };

type RequestTemplate = {
    id: string;
    urlpath: string;
    requestInit: {
        method?: NonNullable<RequestInit["method"]>;
        headers?: Record<string, string>;
        body?: unknown;
    };
};

const typedRequestToSend = requestTosend as RequestTemplate[];



export async function afterInstall(ctx: HookContext) {
    const getTemplate = getRequestTemplate.bind(null, typedRequestToSend);
    const checkpoints = [
        { id: "Wait for app", message: "Wait for Radarr to be ready" },
        { id: "Update config", message: "Update Radarr configuration" },
        { id: "radarr-config-update", message: "Updating Radarr configuration" },
        { id: "connectToJellyfin", message: "Connecting to Jellyfin" },
    ];
    await ctx.registerCheckpoints(checkpoints);
    ctx.log("Starting Radarr configuration after installation.");
    await ctx.updateCheckpointMessage(checkpoints[0].id, "Waiting for Radarr to be ready...");
    const response = await ctx.waitForApp("/initialize.json", {
        expectedStatus: 200,
        maxAttempts: 24,
        initialDelayMs: 5000,
        timeoutMs: 5000,
        headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "cache-control": "no-cache",
            "Referer": `${ctx.baseUrl}/`
        }
    });

    await ctx.emitCheckpoint(checkpoints[0].id, "Radarr is ready.");
    ctx.log(`Radarr is ready. Response status: ${response.status}`);
    const data = await response.json();
    const apiRoot = data?.apiRoot || "/api/v3";
    const apiKey = data?.apiKey;
    if (!apiKey) {
        throw new Error("API key not found in initialize.json response.");
    }
    ctx.log(data);

    await ctx.updateCheckpointMessage(checkpoints[1].id, "API key retrieved successfully.");
    const host = ctx.host;
    const port = ctx.port;
    const baseUrl = `http://${host}:${port}`;


    const baseHeaders: Record<string, string> = {
        "accept": "application/json",
        "content-type": "application/json",
        "cache-control": "no-cache",
        "Referer": `${baseUrl}/`,
        "x-api-key": String(apiKey),
    };

    const hostTemplate = getTemplate("host-config");
    const hostTemplateBody = cloneJsonValue(hostTemplate.requestInit.body) as Record<string, unknown>;
    hostTemplateBody.username = ctx.inputs.admin_username || "admin"; // Default username is "admin".
    hostTemplateBody.password = ctx.inputs.admin_password || "changeme";
    hostTemplateBody.passwordConfirmation = ctx.inputs.admin_password || "changeme";
    hostTemplateBody.apiKey = apiKey;

    const hostRequestInit = buildRequestInit(baseHeaders, hostTemplate, hostTemplateBody);


    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const putResponse = await fetch(`${baseUrl}${apiRoot}${hostTemplate.urlpath}`, hostRequestInit);
        if (await checkResponseOk(ctx, putResponse, hostRequestInit, "Failed to update Radarr configuration.", checkpoints[1].id))
            break;
        await ctx.updateCheckpointMessage(checkpoints[1].id, `Trying Radarr host configuration. Attempt ${attempt + 1}`);
    }
    ctx.log(`Radarr configuration updated successfully.`);
    await ctx.updateCheckpointMessage(checkpoints[1].id, "Set Radarr host configuration.");

    const rootFolderTemplate = getTemplate("root-folder");
    const rootFolderRequestInit = buildRequestInit(baseHeaders, rootFolderTemplate);

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const putResponse = await fetch(`${baseUrl}${apiRoot}${rootFolderTemplate.urlpath}`, rootFolderRequestInit);
        if (await checkResponseOk(ctx, putResponse, rootFolderRequestInit, "Failed to update Radarr configuration.", checkpoints[1].id))
            break;
        await ctx.updateCheckpointMessage(checkpoints[1].id, `Trying Radarr host configuration. Attempt ${attempt + 1}`);
    }

    const indexerTemplate = getTemplate("indexer-config");
    const indexerRequestInit = buildRequestInit(baseHeaders, indexerTemplate);

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const indexerResponse = await fetch(`${baseUrl}${apiRoot}${indexerTemplate.urlpath}`, indexerRequestInit);
        if (await checkResponseOk(ctx, indexerResponse, indexerRequestInit, "Failed to update allowHardcodedSubs configuration.", checkpoints[1].id))
            break;
        await ctx.updateCheckpointMessage(checkpoints[1].id, `Trying Radarr allowHardcodedSubs configuration. Attempt ${attempt + 1}`);
    }
    ctx.log(`allowHardcodedSubs updated successfully.`);
    await ctx.updateCheckpointMessage(checkpoints[1].id, "Set Radarr allowHardcodedSubs configuration.");

    const skipQB = await checkIfqBittorrentAlreadyIsAdded(ctx, apiKey, baseUrl, apiRoot, checkpoints[1].id);


    const downloadClientTemplate = getTemplate("download-client-qbittorrent");
    const downloadClientBody = cloneJsonValue(downloadClientTemplate.requestInit.body) as Record<string, unknown>;
    const fields = downloadClientBody.fields;
    if (Array.isArray(fields)) {
        for (const field of fields) {
            if (field && typeof field === "object" && (field as Record<string, unknown>).name === "host") {
                (field as Record<string, unknown>).value = ctx.host;
            }
        }
    }
    const downloadClientRequestInit = buildRequestInit(baseHeaders, downloadClientTemplate, downloadClientBody);

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        if (skipQB) break;
        const indexerResponse = await fetch(`${baseUrl}${apiRoot}${downloadClientTemplate.urlpath}`, downloadClientRequestInit);
        if (await checkResponseOk(ctx, indexerResponse, downloadClientRequestInit, "Failed to add qBittorrent download client.", checkpoints[1].id))
            break;
        await ctx.updateCheckpointMessage(checkpoints[1].id, `Trying to add qBittorrent download client. Attempt ${attempt + 1}`);
    }
    ctx.log(`qBittorrent download client added successfully.`);
    await ctx.updateCheckpointMessage(checkpoints[1].id, `Adding qBittorrent download client to Radarr configuration...`);

    const JELLYFIN_URL = `http://${ctx.host}:8096`;
    //@ts-ignore
    const JELLYFIN_USERNAME: string = ctx.inputs.admin_username || 'admin';
    //@ts-ignore
    const JELLYFIN_PASSWORD: string = ctx.inputs.admin_password || 'admin';
    const apiKeyJelly = await getJellyfinApiKey(ctx, JELLYFIN_URL, JELLYFIN_USERNAME, JELLYFIN_PASSWORD);

    const conectionTemplate = getTemplate("jellyfin-connection");
    const conectionBody = cloneJsonValue(conectionTemplate.requestInit.body) as Record<string, unknown>;
    // Update the fields in the connection body with the actual values
    // @ts-ignore
    conectionBody.fields = conectionBody.fields.map((field: any) => {
        if (field.name === "host") {
            return { ...field, value: ctx.host };
        } else if (field.name === "apiKey") {
            return { ...field, value: apiKeyJelly };
        }
        return field;
    });
    const conectionRequestInit = buildRequestInit(baseHeaders, conectionTemplate, conectionBody);

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const conectionResponse = await fetch(`${baseUrl}${apiRoot}${conectionTemplate.urlpath}`, conectionRequestInit);
        if (await checkResponseOk(ctx, conectionResponse, conectionRequestInit, "Failed to connect to Jellyfin.", checkpoints[1].id))
            break;
        await ctx.updateCheckpointMessage(checkpoints[1].id, `Trying to connect to Jellyfin. Attempt ${attempt + 1}`);
    }
    ctx.log(`Connected to Jellyfin successfully.`);
    await ctx.updateCheckpointMessage(checkpoints[1].id, `Connecting to Jellyfin...`);

    await ctx.emitCheckpoint(checkpoints[1].id, `Radarr configuration updated successfully.`);
}


async function checkResponseOk(ctx: HookContext, response: Response, requestInit: RequestInit, errorMessage: string, checkpointId: string): Promise<boolean> {
    if (!response.ok) {
        const responseData = await response.json();
        ctx.log(`Error response data: ${JSON.stringify(responseData)}`);
        const action = await ctx.awaitCheckpointRetry(checkpointId, `${errorMessage} Status: ${response.status}, Message: ${responseData?.message || response.statusText}`);
        const message = [errorMessage, [
            { label: "Endpoint", value: `${requestInit.method} ${response.url}` },
            { label: "Status", value: `Status: ${response.status}` },
            { label: "Response", value: errorMessage },
        ]];
        ctx.log(`Request failed: ${JSON.stringify(message, null, 2)}`);
        if (action === "skip") {
            ctx.skipCheckpoint(checkpointId, `Skipped due to error: ${JSON.stringify(message, null, 2)}`);
            return true; // Skip the checkpoint and continue
        }
        ctx.log(`Retrying Radarr configuration update due to error: ${errorMessage} (Checkpoint: ${checkpointId})`);
        return false;
    }
    return true;
}

async function checkIfqBittorrentAlreadyIsAdded(ctx: HookContext, apiKey: any, baseUrl: string, apiRoot: any, id: string) {
    try {
        const getRequestInit: RequestInit = {
            method: "GET",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "cache-control": "no-cache",
                "Referer": `${baseUrl}/`,
                "x-api-key": apiKey
            }
        };

        const response = await fetch(`${baseUrl}${apiRoot}/downloadclient`, getRequestInit);
        if (!response.ok) {
            ctx.log(`Failed to fetch download clients: ${response.status}`);
            return false;
        }

        const downloadClients = await response.json();
        const qBittorrentExists = Array.isArray(downloadClients) &&
            downloadClients.some((client: any) => client.name === "qBittorrent");

        if (qBittorrentExists) {
            ctx.log("qBittorrent download client already exists. Skipping creation.");
        }

        return qBittorrentExists;
    } catch (error) {
        ctx.log(`Error checking for qBittorrent client: ${error}`);
        return false;
    }
}
