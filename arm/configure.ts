import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/** The env the script carries the owner's OMDb key in, so this hook can read the current answer. */
export const OMDB_KEY_ENV = "HEXOS_OMDB_API_KEY";
/** The user ARM runs its rips as (ARM_UID in the script). */
const APPS_UID = 568;
/** Where ARM sees its settings folder, and the script it runs after each notice. */
const CONFIG_PATH = "/etc/arm/config";
export const AFTER_RIP_SCRIPT = `${CONFIG_PATH}/hexos/after-rip.sh`;

/**
 * Files a finished rip (ARM 2.24). ARM names a movie's folder and file "Title (Year)" with the
 * title's spaces as hyphens and has no setting for either, so the naming is done after the rip.
 * Python because the image has it and no other runtime; standard library only.
 */
export const AFTER_RIP_PY = String.raw`#!/usr/bin/env python3
"""HexOS: files a finished Automatic Ripping Machine rip in the library.

ARM runs BASH_SCRIPT with a title and a body at every notice it sends. Only the notice a job ends
with ("<title> processing complete.") is acted on. A movie goes to Radarr when the link file is
there, and Radarr names and files it. Otherwise its folder moves to Movies. A show's files move
to its folder in Shows. Nothing is overwritten and nothing is deleted: a name that is taken
leaves the rip where it is, and only a folder this emptied is removed.
"""
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request

DONE = "processing complete."
DB = os.environ.get("HEXOS_ARM_DB", "/home/arm/db/arm.db")
COMPLETED = os.environ.get("HEXOS_ARM_COMPLETED", "/home/arm/media/completed")
MOVIES = os.environ.get("HEXOS_ARM_MOVIES", "/movies")
SHOWS = os.environ.get("HEXOS_ARM_SHOWS", "/shows")
LINK = os.environ.get("HEXOS_ARM_RADARR", "/etc/arm/config/hexos/radarr.json")
LOG = os.environ.get("HEXOS_ARM_LOG", "/home/arm/logs/hexos-after-rip.log")
IMPORT_SECONDS = int(os.environ.get("HEXOS_ARM_IMPORT_SECONDS", str(6 * 3600)))
POLL_SECONDS = float(os.environ.get("HEXOS_ARM_POLL_SECONDS", "10"))
VIDEO = (".mkv", ".mp4", ".m4v")
JOB = ("job_id", "title", "title_manual", "year", "video_type", "imdb_id", "disctype", "label", "path")


class Left(Exception):
    """The rip stays where ARM put it."""


def log(message):
    try:
        with open(LOG, "a", encoding="utf-8") as out:
            out.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")
    except OSError:
        pass


def latest_job(title):
    db = sqlite3.connect("file:" + urllib.parse.quote(DB) + "?mode=ro", uri=True, timeout=30)
    try:
        row = db.execute(
            "SELECT " + ", ".join(JOB) + " FROM job WHERE title = ? AND path IS NOT NULL ORDER BY job_id DESC LIMIT 1",
            (title,),
        ).fetchone()
    finally:
        db.close()
    return dict(zip(JOB, row)) if row else None


def inside(path, parent):
    path, parent = os.path.realpath(path), os.path.realpath(parent)
    return path != parent and os.path.commonpath([path, parent]) == parent


def clean(text):
    # ARM keeps a title with its spaces as hyphens
    text = (text or "").replace("-", " ")
    text = "".join(ch for ch in text if ch not in '\\/:*?"<>|')
    return " ".join(text.split()).strip(". ")


def imdb_id(job):
    found = job.get("imdb_id") or ""
    return found if re.fullmatch(r"tt\d{5,12}", found) else ""


def library_name(job):
    name = clean(job.get("title_manual") or job.get("title"))
    year = re.sub(r"\D", "", str(job.get("year") or ""))
    if len(year) == 4 and year != "0000":
        name += " (%s)" % year
    if imdb_id(job):
        name += " [imdbid-%s]" % imdb_id(job)
    return name


def main_file(folder):
    files = [os.path.join(folder, name) for name in os.listdir(folder) if name.lower().endswith(VIDEO)]
    files = [path for path in files if os.path.isfile(path)]
    return max(files, key=os.path.getsize) if files else None


def remove_if_empty(folder):
    try:
        os.rmdir(folder)
    except OSError:
        pass


def file_movie(job):
    name = library_name(job)
    target = os.path.join(MOVIES, name)
    if not name or os.path.lexists(target):
        raise Left("Movies already has %r" % name)
    shutil.move(job["path"], target)
    main = main_file(target)
    if main:
        renamed = os.path.join(target, name + os.path.splitext(main)[1])
        if not os.path.lexists(renamed):
            os.rename(main, renamed)
    log("Filed %s in Movies" % name)


def file_show(job):
    name = library_name(job)
    if not name:
        raise Left("the show has no title")
    target = os.path.join(SHOWS, name)
    os.makedirs(target, exist_ok=True)
    disc = clean(job.get("label")) or "disc %s" % job["job_id"]
    for entry in sorted(os.listdir(job["path"])):
        source = os.path.join(job["path"], entry)
        if not os.path.isfile(source):
            continue
        wanted = os.path.join(target, "%s - %s - %s" % (clean(job.get("title_manual") or job.get("title")), disc, entry))
        if os.path.lexists(wanted):
            log("Shows already has %r, so %r stays where it is" % (wanted, source))
            continue
        shutil.move(source, wanted)
    remove_if_empty(job["path"])
    log("Filed %s in Shows" % name)


def read_link():
    try:
        with open(LINK, encoding="utf-8") as source:
            link = json.load(source)
    except (OSError, ValueError):
        return None
    wanted = ("url", "apiKey", "downloads", "library")
    return link if isinstance(link, dict) and all(link.get(key) for key in wanted) else None


def api(link, method, path, body=None):
    request = urllib.request.Request(
        link["url"].rstrip("/") + "/api/v3" + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"X-Api-Key": link["apiKey"], "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        text = response.read().decode()
    return json.loads(text) if text else None


RELEASE_GROUP = "MyOwnMedia"
CHANNELS = {1: "1.0", 2: "2.0", 3: "2.1", 6: "5.1", 7: "6.1", 8: "7.1"}
VIDEO_CODECS = {"hevc": "HEVC", "h264": "AVC", "mpeg2video": "MPEG-2", "vc1": "VC-1", "mpeg1video": "MPEG-1"}


def dolby_vision(head):
    """Whether a Matroska file's first bytes hold a Dolby Vision configuration record.

    The record is a BlockAddIDType element (41 E7), four bytes long, holding its name. The image's
    ffprobe (4.4) reports none of it.
    """
    return re.search(rb"\x41\xe7\x84(dvcC|dvvC|dvwC)", head) is not None


def truehd_atmos(data):
    """Whether Dolby TrueHD audio in these bytes carries Atmos.

    A TrueHD major sync (F8 72 6F BA) with four substreams and the 16-channel presentation flag is
    Atmos (FFmpeg's mlp_parse.c). The image's ffprobe reports TrueHD with no profile.
    """
    found = [at.start() for at in re.finditer(rb"\xf8\x72\x6f\xba", data)]
    frames = [(data[at + 16] >> 4, data[at + 17]) for at in found if at + 18 <= len(data)]
    return bool(frames) and sum(1 for substreams, info in frames if substreams == 4 and info & 0x80) * 2 > len(frames)


def audio_tag(stream, atmos=False):
    codec, profile = stream.get("codec_name") or "", stream.get("profile") or ""
    channels = CHANNELS.get(int(stream.get("channels") or 0), "")
    if codec == "truehd":
        return ".".join(part for part in ("TrueHD", channels, "Atmos" if atmos else "") if part)
    if codec == "dts":
        name = "DTS-HD.MA" if "MA" in profile else "DTS-HD.HRA" if "HRA" in profile else "DTS"
    else:
        name = {"ac3": "DD", "eac3": "DDP", "flac": "FLAC", "mp2": "MP2", "aac": "AAC"}.get(codec) or ("LPCM" if codec.startswith("pcm_") else codec.upper())
    return ".".join(part for part in (name, channels) if part)


def media_tags(streams, disctype, dv=False, atmos=False):
    """What a release name says about a rip, in the order release names use: an untouched copy of the disc."""
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    tags = []
    if width >= 3800 or height >= 2000:
        tags += ["2160p", "UHD", "BluRay"]
    elif disctype == "dvd" or (height and height <= 576):
        tags += ["DVD"]
    else:
        tags += ["1080p" if width >= 1900 or height >= 1000 else "720p", "BluRay"]
    tags.append("REMUX")
    transfer = video.get("color_transfer")
    if dv:
        tags.append("DV")
    if transfer == "smpte2084":
        tags.append("HDR")
    elif transfer == "arib-std-b67":
        tags.append("HLG")
    codec = VIDEO_CODECS.get(video.get("codec_name") or "")
    if codec:
        tags.append(codec)
    if audio:
        tags.append(audio_tag(audio, atmos))
    return tags


def release_title(text):
    """A title as a release name writes it: its words joined by dots."""
    text = (text or "").replace("&", "and").replace("-", " ").replace("_", " ")
    text = re.sub(r"[^\w ]", "", text)
    return ".".join(text.split())


def release_name(title, year, tags, episode=""):
    """Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-MyOwnMedia"""
    parts = [release_title(title)]
    year = re.sub(r"\D", "", str(year or ""))
    if episode:
        parts.append(episode)
    elif len(year) == 4 and year != "0000":
        parts.append(year)
    return ".".join(part for part in parts + list(tags) if part) + "-" + RELEASE_GROUP


def probe(path):
    """A rip's streams and tags, as ffprobe and the file's own bytes give them."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path],
        capture_output=True, text=True, timeout=300, check=False,
    ).stdout
    info = json.loads(out or "{}")
    streams = info.get("streams") or []
    with open(path, "rb") as source:
        data = source.read(64 * 1024 * 1024)
    main_audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
    return {
        "streams": streams,
        "title": ((info.get("format") or {}).get("tags") or {}).get("title") or "",
        "seconds": float((info.get("format") or {}).get("duration") or 0),
        "dv": dolby_vision(data[: 4 * 1024 * 1024]),
        "atmos": main_audio.get("codec_name") == "truehd" and truehd_atmos(data),
    }


def remapped(path, ours, theirs):
    ours, theirs = ours.rstrip("/"), theirs.rstrip("/")
    if path != ours and not path.startswith(ours + "/"):
        raise Left("%r is outside %r" % (path, ours))
    return theirs + path[len(ours):]


def quality_name(job, path):
    """Radarr's name for an untouched copy of this disc."""
    height = 0
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=120, check=False,
        ).stdout
        height = int((out.strip().splitlines() or ["0"])[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    if height > 1200:
        return "Remux-2160p"
    if job.get("disctype") == "bluray" or height > 600:
        return "Remux-1080p"
    return "DVD"


def to_radarr(job, link, sent):
    if not imdb_id(job):
        raise LookupError("the rip has no IMDb id")
    found = api(link, "GET", "/movie/lookup/imdb?imdbId=" + imdb_id(job))
    if not isinstance(found, dict) or not found.get("tmdbId"):
        raise LookupError("Radarr doesn't know %s" % imdb_id(job))
    have = api(link, "GET", "/movie?tmdbId=%d" % found["tmdbId"])
    if have:
        movie = have[0]
    else:
        profiles = api(link, "GET", "/qualityprofile")
        movie = api(link, "POST", "/movie", dict(
            found,
            rootFolderPath=link["library"]["radarr"],
            qualityProfileId=profiles[0]["id"],
            monitored=False,
            minimumAvailability="released",
            addOptions={"searchForMovie": False},
        ))
    if movie.get("hasFile"):
        raise Left("Radarr already has %s" % movie.get("title"))

    main = main_file(job["path"])
    if not main:
        raise Left("the rip has no video file")
    folder = remapped(job["path"], link["downloads"]["arm"], link["downloads"]["radarr"])
    listed = api(link, "GET", "/manualimport?filterExistingFiles=false&folder=" + urllib.parse.quote(folder, safe=""))
    item = next((entry for entry in listed or [] if entry.get("path") == folder.rstrip("/") + "/" + os.path.basename(main)), None)
    if not item:
        raise LookupError("Radarr can't see %s" % folder)
    quality = item.get("quality")
    wanted = quality_name(job, main)
    for definition in api(link, "GET", "/qualitydefinition") or []:
        if definition.get("quality", {}).get("name") == wanted:
            quality = {"quality": definition["quality"], "revision": {"version": 1, "real": 0, "isRepack": False}}

    sent.append(True)
    command = api(link, "POST", "/command", {
        "name": "ManualImport",
        "importMode": "move",
        "files": [{
            "path": item["path"],
            "movieId": movie["id"],
            "quality": quality,
            "languages": item.get("languages") or [],
            "releaseGroup": "",
        }],
    })
    deadline = time.time() + IMPORT_SECONDS
    while time.time() < deadline:
        status = (api(link, "GET", "/command/%d" % command["id"]) or {}).get("status")
        if status in ("completed", "failed", "aborted", "cancelled", "orphaned"):
            break
        time.sleep(POLL_SECONDS)
    movie = api(link, "GET", "/movie/%d" % movie["id"])
    if not movie.get("hasFile"):
        raise Left("Radarr didn't import %s (%s)" % (movie.get("title"), status))

    # Radarr takes the movie alone. Its extras follow it to the folder Radarr filed it in.
    extras = os.path.join(job["path"], "extras")
    theirs = remapped(movie["path"], link["library"]["radarr"], link["library"]["arm"])
    if os.path.isdir(extras) and os.path.isdir(theirs) and not os.path.lexists(os.path.join(theirs, "extras")):
        shutil.move(extras, os.path.join(theirs, "extras"))
    remove_if_empty(job["path"])
    log("Radarr filed %s" % movie.get("title"))


def main(argv):
    body = argv[2].strip() if len(argv) > 2 else ""
    if not body.endswith(DONE):
        return
    job = latest_job(body[: -len(DONE)].strip())
    if not job or not os.path.isdir(job["path"] or ""):
        return
    try:
        if job["video_type"] == "movie" and inside(job["path"], os.path.join(COMPLETED, "movies")):
            link, sent = read_link(), []
            if link:
                try:
                    to_radarr(job, link, sent)
                    return
                except Left:
                    raise
                except Exception as error:  # noqa: BLE001
                    if sent:
                        raise Left("Radarr's import didn't finish: %r" % error) from error
                    log("Radarr didn't take %s (%r), so it goes to Movies" % (job["title"], error))
            file_movie(job)
        elif job["video_type"] == "series" and inside(job["path"], os.path.join(COMPLETED, "tv")):
            file_show(job)
    except Left as why:
        log("%s stays in %s: %s" % (job["title"], job["path"], why))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--release-name":
            # For the catalog's tests: the name for streams as ffprobe reports them
            asked = json.loads(sys.argv[2])
            print(release_name(asked["title"], asked.get("year"), media_tags(asked["streams"], asked.get("disctype"), asked.get("dv"), asked.get("atmos")), asked.get("episode", "")))
            sys.exit(0)
        if len(sys.argv) == 3 and sys.argv[1] == "--detect":
            # For the catalog's tests: what the file's own bytes say, with no ffprobe
            with open(sys.argv[2], "rb") as source:
                raw = source.read()
            print(json.dumps({"dv": dolby_vision(raw[: 4 * 1024 * 1024]), "atmos": truehd_atmos(raw)}))
            sys.exit(0)
        main(sys.argv)
    except Exception as error:  # noqa: BLE001
        log("after-rip failed: %r" % error)
`;

/** ARM waits for BASH_SCRIPT, and Radarr's copy of a UHD rip can take an hour, so the work is handed off. */
export const AFTER_RIP_SH = `#!/bin/bash
setsid nohup python3 ${CONFIG_PATH}/hexos/after_rip.py "$@" >/dev/null 2>&1 &
`;

/**
 * What HexOS sets in arm.yaml. ARM puts a finished rip in COMPLETED_PATH/movies, /tv or
 * /unidentified (`convert_job_type`, arm/ripper/utils.py), and after_rip.py files it from there.
 */
export const wantedSettings = (omdbKey: string, current = ""): Record<string, string | boolean> => {
  const theirs = current.match(/^BASH_SCRIPT:\s*["']?([^"'\n]*)["']?\s*$/m)?.[1]?.trim() ?? "";
  return {
    // HandBrake would re-encode every rip, which takes hours and drops a UHD disc's HDR
    SKIP_TRANSCODE: true,
    RIPMETHOD: "mkv",
    COMPLETED_PATH: "/home/arm/media/completed/",
    // The notice a job ends with is what after_rip.py acts on
    NOTIFY_TRANSCODE: true,
    // A script the owner put there themselves stays
    ...(theirs === "" || theirs === AFTER_RIP_SCRIPT ? { BASH_SCRIPT: AFTER_RIP_SCRIPT } : {}),
    ...(omdbKey ? { METADATA_PROVIDER: "omdb", OMDB_API_KEY: omdbKey } : {}),
  };
};

/** Sets top-level keys of arm.yaml in place, so ARM's comments and every other setting stay. */
export const applySettings = (yaml: string, settings: Record<string, string | boolean>): string => {
  let next = yaml;
  for (const [key, value] of Object.entries(settings)) {
    const line = `${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`;
    const existing = new RegExp(`^${key}:.*$`, "m");
    next = existing.test(next) ? next.replace(existing, () => line) : `${next.replace(/\n*$/, "\n")}${line}\n`;
  }
  return next;
};

export const omdbKeyFromValues = (values: Record<string, unknown> | null | undefined): string => {
  const envs = values?.envs;
  if (!Array.isArray(envs)) return "";
  const env = envs.find((item) => item?.name === OMDB_KEY_ENV);
  return typeof env?.value === "string" ? env.value.trim() : "";
};

/** Writes a file ARM's own user can read, only when its text changed. */
export const writeForArm = (path: string, text: string, mode: number) => {
  const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  if (current !== text) writeFileSync(path, text, { mode });
  chownSync(path, APPS_UID, APPS_UID);
};

export const hexosFolder = (configLocalPath: string) => {
  const folder = `${configLocalPath}/hexos`;
  mkdirSync(folder, { recursive: true, mode: 0o750 });
  chownSync(folder, APPS_UID, APPS_UID);
  return folder;
};

/**
 * ARM's image stops at its start unless its home and settings folders belong to the user it rips
 * as, by user and by group (arm_user_files_setup.sh reads both with stat). HexOS lets apps into a
 * folder with an ACL entry and leaves root as its owner, so the two folders are handed over here.
 */
export async function prepare(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "folders", message: "Folders ready" }]);
  const folders = [
    { at: CONFIG_PATH, host: /\/arm(-\d+)?\/config$/ },
    { at: "/home/arm", host: /\/arm(-\d+)?\/home$/ },
  ];
  for (const folder of folders) {
    const mount = ctx.mounts.find((item) => item.containerPath === folder.at) ?? ctx.mounts.find((item) => folder.host.test(item.hostPath));
    if (!mount) ctx.fail("HexOS couldn't find Automatic Ripping Machine's folders.");
    chownSync(mount.localPath, APPS_UID, APPS_UID);
  }
  await ctx.emitCheckpoint("folders");
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Automatic Ripping Machine started" },
    { id: "settings", message: "Rip settings saved" },
  ]);

  const config =
    ctx.mounts.find((mount) => mount.containerPath === CONFIG_PATH) ?? ctx.mounts.find((mount) => /\/arm(-\d+)?\/config$/.test(mount.hostPath));
  if (!config) ctx.fail("HexOS couldn't find Automatic Ripping Machine's settings folder.");

  const omdbKey = omdbKeyFromValues(await ctx.getAppValues?.().catch(() => null));
  if (!/^[A-Za-z0-9]{0,64}$/.test(omdbKey)) ctx.fail("The OMDb API key holds letters and numbers only. Check it and run this again.");

  // ARM copies its default arm.yaml into an empty settings folder on its first start
  const path = `${config.localPath}/arm.yaml`;
  await ctx.waitForApp("/", { maxAttempts: 40, initialDelayMs: 3000, expectedStatus: 200 }).catch(() => undefined);
  for (let attempt = 0; attempt < 30 && !existsSync(path); attempt++) await ctx.sleep(2000);
  if (!existsSync(path)) ctx.fail("Automatic Ripping Machine hasn't written its settings file yet. Wait for it to start, then run this again.");
  await ctx.emitCheckpoint("start");

  const folder = hexosFolder(config.localPath);
  writeForArm(`${folder}/after_rip.py`, AFTER_RIP_PY, 0o640);
  writeForArm(`${folder}/after-rip.sh`, AFTER_RIP_SH, 0o750);

  const current = readFileSync(path, "utf-8");
  const next = applySettings(current, wantedSettings(omdbKey, current));
  if (next !== current) {
    writeFileSync(path, next);
    // A rip reads arm.yaml as it starts, but ARM's own settings page holds what it read at start
    await ctx.restartApp?.();
  }
  await ctx.emitCheckpoint("settings");
}
