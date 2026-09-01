// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

// Scrutiny's summary API is unauthenticated on the LAN port: one GET carries
// every device's identity, S.M.A.R.T. verdict, and live temperature.
interface ScrutinySummaryEntry {
  device?: {
    device_name?: string;
    model_name?: string;
    capacity?: number;
    archived?: boolean;
    /** 0 = passed; bit 1 = failed S.M.A.R.T., bit 2 = failed Scrutiny thresholds. */
    device_status?: number;
  };
  smart?: {
    temp?: number;
    power_on_hours?: number;
  };
}

function capacityText(bytes: number | undefined): string | undefined {
  if (!bytes) return undefined;
  const tb = bytes / 1_000_000_000_000;
  if (tb >= 1) return `${tb >= 10 ? Math.round(tb) : Math.round(tb * 10) / 10} TB`;
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const base = `http://${ctx.host}:${ctx.port ?? 31054}`;

  const response = await fetch(`${base}/api/summary`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Scrutiny summary query failed (${response.status})`);
  const body = (await response.json()) as { data?: { summary?: Record<string, ScrutinySummaryEntry> } };

  const devices = Object.values(body.data?.summary ?? {}).filter((entry) => !entry.device?.archived);
  const failing = devices.filter((entry) => (entry.device?.device_status ?? 0) !== 0);

  // Failing disks lead the list — the whole point of the glance.
  const ordered = [...failing, ...devices.filter((entry) => !failing.includes(entry))];

  return {
    fields: {
      passing: {
        type: "stat",
        label: "Disks passing",
        value: `${devices.length - failing.length}/${devices.length}`,
      },
      disks: {
        type: "list",
        // Cap at the platform's per-list ceiling (20) so a large array can't
        // fail result validation; failing disks sort first, so the cap never
        // hides a problem, and only the top few actually render.
        entries: ordered.slice(0, 20).map((entry) => ({
          title: entry.device?.model_name || entry.device?.device_name || "Unknown disk",
          subtitle: [entry.device?.device_name, capacityText(entry.device?.capacity)]
            .filter(Boolean)
            .join(" · ") || undefined,
          meta: [
            (entry.device?.device_status ?? 0) !== 0 ? "FAILING" : undefined,
            entry.smart?.temp !== undefined ? `${entry.smart.temp}°C` : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        })),
      },
      status: {
        type: "text",
        text:
          devices.length === 0
            ? "Waiting for the first disk report"
            : failing.length === 0
              ? `All ${devices.length} disks passing`
              : `${failing.length} of ${devices.length} disks FAILING`,
      },
    },
  };
}
