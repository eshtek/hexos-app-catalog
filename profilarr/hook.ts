/// <reference path="../../env.d.ts" />

import type { HookContext } from "../../hexos-app-catalog/_lib/hook_context";



const READINESS_ATTEMPTS = 24;
const READINESS_INTERVAL_MS = 5000;
const AUTO_RETRIES = 5;
const AUTO_RETRY_DELAY_MS = 5000;
const RADDARR_PORT = 30025;
const SONARR_PORT = 30113;

const ARR_CHECKPOINT_IDS: Record<ArrType, string> = {
  radarr: "radarrConfigured",
  sonarr: "sonarrConfigured",
};

export async function onAfterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "profilarrReady", message: "Waiting for Profilarr to become ready" },
    { id: "radarrConfigured", message: "Configure Radarr" },
    { id: "sonarrConfigured", message: "Configure Sonarr" },
    { id: "done", message: "Finished test" }
  ]);



  await waitForProfilarr(ctx);
  await ctx.emitCheckpoint("profilarrReady", "Profilarr is ready");
  await setNewArr(ctx, [SONARR_PORT, RADDARR_PORT]);
  await ctx.emitCheckpoint("done", "Completed");
}

async function waitForProfilarr(ctx: HookContext) {
  ctx.log("Waiting for Profilarr to become ready...");
  await ctx.waitForApp("/auth/setup", {
    expectedStatus: 200,
    maxAttempts: READINESS_ATTEMPTS,
    initialDelayMs: READINESS_INTERVAL_MS,
    timeoutMs: 5000,
  });

}

export type ArrType = "radarr" | "sonarr";
export type ArrInformation = {
  type: ArrType;
  url: string;
  externalUrl: string;
  tags: string[];
  apiKey: string;
  libraryRefreshInterval: number;
};

async function setNewArr(ctx: HookContext, ports: number[]) {
  for (const port of ports) {
    const arrInfo = await getArrInformation(ctx, port);
    const checkpointId = ARR_CHECKPOINT_IDS[arrInfo.type];
    const targetUrl = ctx.baseUrl;

    if (!targetUrl) {
      throw new Error("Host and port must be defined in the context");
    }

    const requestHeaders: HeadersInit = {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: targetUrl,
      Referer: `${targetUrl}/`,
    };

    while (true) {
      let lastError = "Unknown error";
      let configured = false;

      for (let attempt = 0; attempt < AUTO_RETRIES; attempt++) {
        if (attempt > 0) {
          await ctx.sleep(AUTO_RETRY_DELAY_MS);
        }

        await ctx.updateCheckpointMessage(
          checkpointId,
          attempt === 0
            ? `Configuring ${arrInfo.type}...`
            : `Configuring ${arrInfo.type}... (retry ${attempt}/${AUTO_RETRIES})`,
        );

        try {
          const response1 = await sendRequest({
            url: `${targetUrl}/arr/validate`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: targetUrl,
              Referer: `${targetUrl}/`,
            },
            body: {
              mode: "json",
              urlencoded: [
                { key: "type", value: arrInfo.type },
                { key: "url", value: arrInfo.url },
                { key: "apiKey", value: arrInfo.apiKey },
              ],
            },
          });

          if (!response1.ok) {
            const validateErrorText = await responseTextOrStatus(response1);
            throw new Error(`Validation failed: ${validateErrorText}`);
          }

          const response = await sendRequest({
            url: `${targetUrl}/arr/new`,
            method: "POST",
            headers: requestHeaders,
            body: {
              mode: "urlencoded",
              urlencoded: [
                { key: "name", value: arrInfo.type },
                { key: "type", value: arrInfo.type },
                { key: "url", value: arrInfo.url },
                { key: "external_url", value: arrInfo.externalUrl },
                { key: "api_key", value: arrInfo.apiKey },
                { key: "tags", value: JSON.stringify(arrInfo.tags) },
                { key: "library_refresh_interval", value: arrInfo.libraryRefreshInterval.toString() },
              ],
            },
          });

          if (!response.ok) {
            const errorText = await responseTextOrStatus(response);
            throw new Error(errorText);
          }
          console.log(`Successfully configured ${arrInfo.type} response: ${await response.text()}`);

          await ctx.emitCheckpoint(checkpointId, `Configured ${arrInfo.type}`);
          configured = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          ctx.log(
            `Failed to configure ${arrInfo.type} on attempt ${attempt + 1}/${AUTO_RETRIES}: ${lastError}`,
          );
        }
      }

      if (configured) {
        break;
      }

      const action = await ctx.awaitCheckpointRetry(
        checkpointId,
        `Failed to configure ${arrInfo.type}: ${lastError}`,
        [
          { label: "Endpoint", value: `POST ${targetUrl}/arr/new` },
          { label: "Error", value: lastError },
        ],
      );

      if (action === "skip") {
        await ctx.skipCheckpoint(checkpointId, `Configure ${arrInfo.type} - skipped`);
        break;
      }
    }
  }



  ctx.log("New arr configured successfully");
}

async function sendRequest(arg1: {
  url: string;
  method: "POST" | "GET";
  headers: HeadersInit;
  body: { mode: "json" | "urlencoded"; urlencoded: { key: string; value: unknown }[] };
}) {
  const urlencoded = new URLSearchParams();
  for (const { key, value } of arg1.body.urlencoded) {
    urlencoded.append(key, String(value));
  }

  const jsonBody = JSON.stringify(
    arg1.body.urlencoded.reduce<Record<string, unknown>>((acc, { key, value }) => {
      acc[key] = value;
      return acc;
    }, {}),
  );

  console.log(`Sending request ${JSON.stringify({
    method: arg1.method,
    headers: arg1.headers,
    body: arg1.body.mode === "urlencoded" ? urlencoded.toString() : jsonBody,
  })}`);

  const response = await fetch(arg1.url, {
    method: arg1.method,
    headers: arg1.headers,
    body: arg1.body.mode === "urlencoded" ? urlencoded.toString() : jsonBody,
  });

  return response;
}

async function responseTextOrStatus(response: Response): Promise<string> {
  const text = await response.text();
  return text || `${response.status} ${response.statusText}`;
}

async function getArrInformation(ctx: HookContext, port: number): Promise<ArrInformation> {
  const baseUrl = `http://${ctx.host}:${port}`;
  const response = await fetch(`${baseUrl}/initialize.json`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch arr information from port ${port}`);
  }

  const data = (await response.json()) as any;
  ctx.log(`Fetched arr information from port ${port}: ${JSON.stringify(data)}`);
  return {
    type: data.instanceName.toLowerCase(),
    url: baseUrl,
    externalUrl: "",
    tags: [],
    apiKey: data.apiKey || "",
    libraryRefreshInterval: 0
  };
}

