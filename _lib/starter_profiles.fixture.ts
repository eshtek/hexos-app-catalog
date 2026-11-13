// The six quality profiles Radarr and Sonarr make at their first start, built the way the managers
// build them, for the tests of the links that take them out. This follows upstream's own lists
// rather than the scripts' tables, so a slip in either shows: Quality.DefaultQualityDefinitions
// (each quality's id, name, weight and group), the AddDefaultProfile calls and GetDefaultProfile in
// QualityProfileService, and QualityProfileResource, read at Radarr 6.4.4 and Sonarr 5.0.0.

type ManagerId = "radarr" | "sonarr";

/** A quality as the manager defines it: id, name, weight, and the group it shares a weight with. */
type Definition = [id: number, name: string, weight: number, group?: string];

const DEFINITIONS: Record<ManagerId, Definition[]> = {
  radarr: [
    [0, "Unknown", 1],
    [24, "WORKPRINT", 2],
    [25, "CAM", 3],
    [26, "TELESYNC", 4],
    [27, "TELECINE", 5],
    [29, "REGIONAL", 6],
    [28, "DVDSCR", 7],
    [1, "SDTV", 8],
    [2, "DVD", 9],
    [23, "DVD-R", 10],
    [8, "WEBDL-480p", 11, "WEB 480p"],
    [12, "WEBRip-480p", 11, "WEB 480p"],
    [20, "Bluray-480p", 12],
    [21, "Bluray-576p", 13],
    [4, "HDTV-720p", 14],
    [5, "WEBDL-720p", 15, "WEB 720p"],
    [14, "WEBRip-720p", 15, "WEB 720p"],
    [6, "Bluray-720p", 16],
    [9, "HDTV-1080p", 17],
    [3, "WEBDL-1080p", 18, "WEB 1080p"],
    [15, "WEBRip-1080p", 18, "WEB 1080p"],
    [7, "Bluray-1080p", 19],
    [30, "Remux-1080p", 20],
    [16, "HDTV-2160p", 21],
    [18, "WEBDL-2160p", 22, "WEB 2160p"],
    [17, "WEBRip-2160p", 22, "WEB 2160p"],
    [19, "Bluray-2160p", 23],
    [31, "Remux-2160p", 24],
    [22, "BR-DISK", 25],
    [10, "Raw-HD", 26],
  ],
  sonarr: [
    [0, "Unknown", 1],
    [1, "SDTV", 2],
    [12, "WEBRip-480p", 3, "WEB 480p"],
    [8, "WEBDL-480p", 3, "WEB 480p"],
    [2, "DVD", 4],
    [13, "Bluray-480p", 5],
    [22, "Bluray-576p", 6],
    [4, "HDTV-720p", 7],
    [9, "HDTV-1080p", 8],
    [10, "Raw-HD", 9],
    [14, "WEBRip-720p", 10, "WEB 720p"],
    [5, "WEBDL-720p", 10, "WEB 720p"],
    [6, "Bluray-720p", 11],
    [15, "WEBRip-1080p", 12, "WEB 1080p"],
    [3, "WEBDL-1080p", 12, "WEB 1080p"],
    [7, "Bluray-1080p", 13],
    [20, "Bluray-1080p Remux", 14],
    [16, "HDTV-2160p", 15],
    [17, "WEBRip-2160p", 16, "WEB 2160p"],
    [18, "WEBDL-2160p", 16, "WEB 2160p"],
    [19, "Bluray-2160p", 17],
    [21, "Bluray-2160p Remux", 18],
  ],
};

/** Each AddDefaultProfile call: the name, the cutoff, then every quality it allows. */
const MADE: Record<ManagerId, Array<[name: string, cutoff: string, allowed: string]>> = {
  radarr: [
    [
      "Any",
      "Bluray-480p",
      "WORKPRINT CAM TELESYNC TELECINE DVDSCR REGIONAL SDTV DVD DVD-R HDTV-720p HDTV-1080p HDTV-2160p WEBDL-480p WEBRip-480p WEBDL-720p WEBRip-720p WEBDL-1080p WEBRip-1080p WEBDL-2160p WEBRip-2160p Bluray-480p Bluray-576p Bluray-720p Bluray-1080p Bluray-2160p Remux-1080p Remux-2160p BR-DISK",
    ],
    ["SD", "Bluray-480p", "WORKPRINT CAM TELESYNC TELECINE DVDSCR REGIONAL SDTV DVD WEBDL-480p WEBRip-480p Bluray-480p Bluray-576p"],
    ["HD-720p", "Bluray-720p", "HDTV-720p WEBDL-720p WEBRip-720p Bluray-720p"],
    ["HD-1080p", "Bluray-1080p", "HDTV-1080p WEBDL-1080p WEBRip-1080p Bluray-1080p Remux-1080p"],
    ["Ultra-HD", "Remux-2160p", "HDTV-2160p WEBDL-2160p WEBRip-2160p Bluray-2160p Remux-2160p"],
    ["HD - 720p/1080p", "Bluray-720p", "HDTV-720p HDTV-1080p WEBDL-720p WEBRip-720p WEBDL-1080p WEBRip-1080p Bluray-720p Bluray-1080p Remux-1080p"],
  ],
  sonarr: [
    [
      "Any",
      "SDTV",
      "SDTV WEBRip-480p WEBDL-480p DVD Bluray-480p Bluray-576p HDTV-720p HDTV-1080p WEBRip-720p WEBDL-720p WEBRip-1080p WEBDL-1080p Bluray-720p Bluray-1080p",
    ],
    ["SD", "SDTV", "SDTV WEBRip-480p WEBDL-480p DVD Bluray-480p Bluray-576p"],
    ["HD-720p", "HDTV-720p", "HDTV-720p WEBRip-720p WEBDL-720p Bluray-720p"],
    ["HD-1080p", "HDTV-1080p", "HDTV-1080p WEBRip-1080p WEBDL-1080p Bluray-1080p"],
    ["Ultra-HD", "HDTV-2160p", "HDTV-2160p WEBRip-2160p WEBDL-2160p Bluray-2160p"],
    ["HD - 720p/1080p", "HDTV-720p", "HDTV-720p HDTV-1080p WEBRip-720p WEBDL-720p WEBRip-1080p WEBDL-1080p Bluray-720p Bluray-1080p"],
  ],
};

export interface QualityItem {
  id?: number;
  name?: string;
  quality?: { id: number; name: string };
  items: QualityItem[];
  allowed: boolean;
}

export interface StarterProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: QualityItem[];
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
  formatItems: Array<{ format: number; name: string; score: number }>;
  language?: { id: number; name: string };
}

export const STARTER_NAMES = MADE.radarr.map(([name]) => name);

/** A starter profile as the manager's own API lists it, untouched, with the id it is given here. */
export function starterProfile(managerId: ManagerId, name: string, id: number): StarterProfile {
  const made = MADE[managerId].find(([each]) => each === name);
  if (!made) throw new Error(`${managerId} makes no profile named ${name}`);
  const allowed = made[2].split(" ");
  const weights = [...new Set(DEFINITIONS[managerId].map(([, , weight]) => weight))];
  let groupId = 1000;
  let cutoff = DEFINITIONS[managerId].find(([, quality]) => quality === made[1])?.[0] as number;
  const items: QualityItem[] = [];
  for (const weight of weights) {
    const group = DEFINITIONS[managerId].filter((each) => each[2] === weight);
    if (group.length === 1) {
      const [qualityId, quality] = group[0];
      items.push({ quality: { id: qualityId, name: quality }, items: [], allowed: allowed.includes(quality) });
      continue;
    }
    const groupAllowed = group.some(([, quality]) => allowed.includes(quality));
    items.push({
      id: groupId,
      name: group[0][3],
      items: group.map(([qualityId, quality]) => ({ quality: { id: qualityId, name: quality }, items: [], allowed: groupAllowed })),
      allowed: groupAllowed,
    });
    if (group.some(([qualityId]) => qualityId === cutoff)) cutoff = groupId;
    groupId++;
  }
  return {
    id,
    name,
    upgradeAllowed: false,
    cutoff,
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    // A custom format Profilarr adds joins every profile at 0 (CustomFormatAddedEvent)
    formatItems: [{ format: 1, name: "Not English", score: 0 }],
    ...(managerId === "radarr" ? { language: { id: -2, name: "Original" } } : {}),
  };
}

/** The same profile with one quality, by name, ticked or unticked, as the owner would in the manager's form. */
export function withQuality(profile: StarterProfile, quality: string, allowed: boolean): StarterProfile {
  const next = structuredClone(profile);
  const item = next.items.find((each) => each.quality?.name === quality || each.items.some((member) => member.quality?.name === quality));
  if (!item) throw new Error(`${profile.name} has no quality named ${quality}`);
  item.allowed = allowed;
  return next;
}

/** The same profile stopping at another quality. */
export function withCutoff(profile: StarterProfile, quality: string): StarterProfile {
  const item = profile.items.find((each) => each.quality?.name === quality);
  if (!item?.quality) throw new Error(`${profile.name} has no single quality named ${quality}`);
  return { ...structuredClone(profile), cutoff: item.quality.id };
}
