// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import type { WidgetContext, WidgetFieldValue, WidgetQueryResult } from "../_lib/widget_context";

// Who's on the farm, the day it is there, and the invite code friends join with. The card folds
// back to the plain one while nobody is on, as Valheim's does.
//
// Everything comes from the server's own HTTP API. It publishes no port, so it's reached at the
// server container's address on the app's network, which the HexOS container opens from the host's
// network and nothing off the box can. The address and the API key come from Docker over the
// socket the HexOS container has for its host commands. A box without the socket keeps the plain card.

const DOCKER_SOCKET = "/var/run/docker.sock";
const SERVICE = "server";
const API_PORT = 8080;
/** Docker and the API share the widget's 5 s timeout, so a stuck one reads as nothing rather than failing the card. */
const DOCKER_TIMEOUT_MS = 1500;
const API_TIMEOUT_MS = 2000;

export interface FarmStatus {
  isOnline?: boolean;
  isReady?: boolean;
  playerCount?: number;
  maxPlayers?: number;
  inviteCode?: string | null;
  connectionStatusCode?: string;
  farmName?: string;
  season?: string;
  day?: number;
  year?: number;
}

interface PlayersAnswer {
  players?: Array<{ name?: string; isOnline?: boolean }>;
}

const SEASONS: Record<string, string> = { spring: "Spring", summer: "Summer", fall: "Fall", winter: "Winter" };

/** The in-game date as the game writes it: "Summer 12, Year 2". */
export function farmDate(status: FarmStatus): string | null {
  const season = SEASONS[status.season?.toLowerCase() ?? ""];
  if (!season || !status.day || !status.year) return null;
  return `${season} ${status.day}, Year ${status.year}`;
}

/** Who's online in a line: "Abigail, Sam, and 3 more". */
export function playersLine(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/** The names of the farmhands online, without the server's own host, who has no name. */
export function onlineNames(answer: PlayersAnswer | null): string[] {
  return (answer?.players ?? [])
    .filter((player) => player.isOnline && player.name?.trim())
    .map((player) => player.name!.trim());
}

/** The invite code while players can use it; null while it's still coming. */
export function usableCode(status: FarmStatus): string | null {
  const ready = status.connectionStatusCode === "ready" || status.connectionStatusCode === "steamRelayPending";
  return ready && status.inviteCode ? status.inviteCode : null;
}

/** The card's fields from what the server answered. */
export function farmFields(status: FarmStatus, names: string[]): Record<string, WidgetFieldValue> {
  const farm = status.farmName?.trim() ? `${status.farmName.trim()} Farm` : "The farm";
  const date = farmDate(status);
  const count = names.length || status.playerCount || 0;
  return {
    // One entry while anyone's on: the farm in bold, the players under it, the day as its caption
    online: {
      type: "list",
      entries: count
        ? [
            {
              title: farm,
              subtitle: names.length ? playersLine(names) : `${count} ${count === 1 ? "player" : "players"}`,
              ...(date ? { subtitles: [date] } : {}),
            },
          ]
        : [],
    },
    count: { type: "stat", label: "Players", value: status.maxPlayers ? `${count}/${status.maxPlayers}` : `${count}` },
    // Empty until the server has one, which the Settings tab shows as still to come
    code: { type: "stat", label: "Invite code", value: usableCode(status) ?? "" },
  };
}

async function docker<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`http://docker${path}`, {
      unix: DOCKER_SOCKET,
      signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
    } as RequestInit);
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null; // a box with no socket yet
  }
}

/** The server container's address and its API key, by the compose project TrueNAS names after the app. */
async function server(appId: string): Promise<{ address: string; apiKey: string } | null> {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=ix-${appId}`, `com.docker.compose.service=${SERVICE}`] }),
  );
  const listed = await docker<Array<{ Id: string; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }>>(
    `/containers/json?filters=${filters}`,
  );
  const found = listed?.[0];
  if (!found) return null;
  const address = Object.values(found.NetworkSettings?.Networks ?? {})
    .map((network) => network.IPAddress)
    .find(Boolean);
  const inspect = await docker<{ Config?: { Env?: string[] } }>(`/containers/${found.Id}/json`);
  const apiKey = inspect?.Config?.Env?.find((entry) => entry.startsWith("API_KEY="))?.slice("API_KEY=".length);
  return address && apiKey ? { address, apiKey } : null;
}

async function api<T>(base: string, path: string, apiKey: string): Promise<T | null> {
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const found = await server(ctx.appId);
  if (!found) return { needsSetup: true, reason: "The farm shows here once the server is running." };
  const base = `http://${found.address}:${API_PORT}`;
  const [status, players] = await Promise.all([
    api<FarmStatus>(base, "/status", found.apiKey),
    api<PlayersAnswer>(base, "/players", found.apiKey),
  ]);
  // Still downloading the game or waiting on the Steam sign-in: the API isn't the mod's yet
  if (!status?.isOnline) {
    return { needsSetup: true, reason: "The farm shows here once the server has signed in to Steam and started." };
  }
  return { fields: farmFields(status, onlineNames(players)) };
}
