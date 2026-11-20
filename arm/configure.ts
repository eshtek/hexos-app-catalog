import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Sets up Automatic Ripping Machine as HexOS ships it: ARM "neu" (uprightbass360's fork), a ripper
 * and its dashboard in one app. The ripper answers on its own network only, so everything here
 * goes through the dashboard, which passes /api/v1 on to it... except that the dashboard has an
 * API of its own shape, so the ripper is reached at its container's address instead.
 */

/** The env the script carries the owner's OMDb key in, so this hook can read the current answer. */
export const OMDB_KEY_ENV = "HEXOS_OMDB_API_KEY";
/** The user ARM runs its rips as (ARM_UID in the script). */
const APPS_UID = 568;
const RIPPER = "ripper";
const RIPPER_PORT = 8080;
/** Where the ripper sees its settings folder, and the script it runs when a rip completes. */
const CONFIG_PATH = "/etc/arm/config";
export const AFTER_RIP_SCRIPT = `${CONFIG_PATH}/hexos/after-rip.sh`;
const CHANNEL = "HexOS: hand rips to Radarr and Sonarr";

/**
 * Names a finished rip and hands it to Radarr or Sonarr. Kept as arm/after_rip.py, which a test
 * holds this copy to: a hook is compiled alone, so it can't read a file beside it on a server.
 * Python because the image has it and no other runtime; standard library only.
 */
export const AFTER_RIP_PY = String.raw`#!/usr/bin/env python3
"""HexOS: names a finished rip as a release and hands it to Radarr or Sonarr.

ARM runs this when a job's rip completes (a bash notification channel, with the job's id in
ARM_JOB_ID). A movie is named Title.Year.2160p.UHD.BluRay.REMUX...-MyOwnMedia from what the file
holds, and Radarr is told to import its folder as it would a finished download, so Radarr's own
rules decide: it names and files the movie, and takes it over a copy it already has when the rip
ranks higher. A show's titles are matched to episodes by length against Sonarr's episode list,
named Show.S01E02..., and handed to Sonarr the same way.

Nothing is deleted and nothing is overwritten here. A rip that can't be placed for certain (a
title Radarr can't confirm, episodes too alike in length to tell apart) stays in Downloads under
a clear name, and the log says why.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

API = os.environ.get("HEXOS_ARM_API", "http://127.0.0.1:8080/api/v1")
LINKS = os.environ.get("HEXOS_ARM_LINKS", "/etc/arm/config/hexos")
COMPLETED = os.environ.get("HEXOS_ARM_COMPLETED", "/home/arm/media/completed")
LOG = os.environ.get("HEXOS_ARM_LOG", "/home/arm/logs/hexos-after-rip.log")
JOB_SECONDS = int(os.environ.get("HEXOS_ARM_JOB_SECONDS", str(2 * 3600)))
IMPORT_SECONDS = int(os.environ.get("HEXOS_ARM_IMPORT_SECONDS", str(6 * 3600)))
POLL_SECONDS = float(os.environ.get("HEXOS_ARM_POLL_SECONDS", "10"))
# Plex and Jellyfin both list what is in this folder under the movie, and Radarr ignores it
EXTRAS_FOLDER = "Featurettes"
EPISODE_SECONDS = 600
VIDEO = (".mkv", ".mp4", ".m4v")
RELEASE_GROUP = "MyOwnMedia"
CHANNELS = {1: "1.0", 2: "2.0", 3: "2.1", 6: "5.1", 7: "6.1", 8: "7.1"}
VIDEO_CODECS = {"hevc": "HEVC", "h264": "AVC", "mpeg2video": "MPEG-2", "vc1": "VC-1", "mpeg1video": "MPEG-1"}
WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


class Held(Exception):
    """The rip stays in Downloads, for the owner to place."""


def log(message):
    try:
        with open(LOG, "a", encoding="utf-8") as out:
            out.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")
    except OSError:
        pass


# --- what the file holds ---------------------------------------------------------------------


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
        "path": path,
        "bytes": os.path.getsize(path),
        "streams": streams,
        "title": ((info.get("format") or {}).get("tags") or {}).get("title") or "",
        "seconds": float((info.get("format") or {}).get("duration") or 0),
        "dv": dolby_vision(data[: 4 * 1024 * 1024]),
        "atmos": main_audio.get("codec_name") == "truehd" and truehd_atmos(data),
    }


def tags_of(found, disctype):
    return media_tags(found["streams"], disctype, found["dv"], found["atmos"])


# --- which movie, which episodes -------------------------------------------------------------


def plain(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def pick_movie(candidates, titles, minutes):
    """The lookup result this rip is, or None when that isn't certain.

    A candidate counts only when its title is one of the rip's own (the disc's title, ARM's). With
    several of the same title, the one whose runtime is the rip's wins, and only when it is close.
    """
    wanted = {plain(title) for title in titles if plain(title)}
    named = {movie["tmdbId"]: movie for movie in candidates if movie.get("tmdbId") and (plain(movie.get("title")) in wanted or plain(movie.get("originalTitle")) in wanted)}
    named = list(named.values())
    if not named:
        return None
    if len(named) == 1:
        return named[0]
    timed = sorted(((abs(movie["runtime"] - minutes), movie) for movie in named if movie.get("runtime")), key=lambda pair: pair[0])
    if not timed or not minutes:
        return None
    off, movie = timed[0]
    return movie if off <= max(6, minutes * 0.08) and (len(timed) == 1 or timed[1][0] - off >= 4) else None


def unique_titles(found):
    """A disc repeats its episodes under other playlists. One file for each length, the largest."""
    kept = []
    for item in sorted(found, key=lambda entry: -entry["bytes"]):
        if item["seconds"] and not any(abs(item["seconds"] - other["seconds"]) <= 3 for other in kept):
            kept.append(item)
    return kept


def match_episodes(minutes, episodes, disc=None):
    """Which episode each title is, by length: a list of episode numbers in the titles' order, or None.

    A disc holds episodes that follow one another, so every run of that many episodes is tried, the
    longest title against the longest episode. The best run has to be close in every title, clearly
    better than the next run, and unchanged by swapping two titles, or nothing is matched. When two
    runs are close, a disc that says its number settles it: disc 2 of a season holding three episodes
    a disc starts at episode 4, so the run that starts there is taken when it is one of the close ones.
    """
    episodes = sorted((episode for episode in episodes if episode.get("runtime")), key=lambda episode: episode["episodeNumber"])
    count = len(minutes)
    if not count or len(episodes) < count:
        return None
    order = sorted(range(count), key=lambda at: minutes[at])
    runs = []
    for start in range(len(episodes) - count + 1):
        run = sorted(episodes[start : start + count], key=lambda episode: episode["runtime"])
        offs = [abs(minutes[at] - run[rank]["runtime"]) for rank, at in enumerate(order)]
        if all(off <= max(6, run[rank]["runtime"] * 0.12) for rank, off in enumerate(offs)):
            runs.append((sum(offs), start, run))
    if not runs:
        return None
    runs.sort(key=lambda entry: entry[0])
    cost, _start, run = runs[0]
    if len(runs) > 1 and runs[1][0] - cost < 2 * count:
        close = [entry for entry in runs if entry[0] - cost < 2 * count]
        expected = [entry for entry in close if disc and episodes[entry[1]]["episodeNumber"] == (disc - 1) * count + 1]
        if not expected:
            return None
        cost, _start, run = expected[0]
    # Two titles, or two episodes, alike in length can't be told apart
    for rank in range(count - 1):
        if run[rank + 1]["runtime"] - run[rank]["runtime"] < 2 or minutes[order[rank + 1]] - minutes[order[rank]] < 1:
            return None
    numbers = [0] * count
    for rank, at in enumerate(order):
        numbers[at] = run[rank]["episodeNumber"]
    return numbers


def season_of(*texts):
    """The season a disc says it is: "Season One Disc 1", "FALLOUT_S1_D1", "Season 2"."""
    for text in texts:
        found = re.search(r"season[ _.-]*(\d{1,2}|" + "|".join(WORDS) + r")\b", text or "", re.I) or re.search(r"(?<![a-z0-9])s(\d{1,2})(?=[ _.-]*d(?:isc)?[ _.-]*\d|\b)", text or "", re.I)
        if found:
            value = found.group(1).lower()
            return WORDS.get(value) or int(value)
    return None


def disc_of(*texts):
    """The number a disc says it is: "Season One Disc 2", "FALLOUT_S1_D2"."""
    for text in texts:
        found = re.search(r"dis[ck][ _.-]*(\d{1,2})\b", text or "", re.I) or re.search(r"(?<![a-z0-9])s\d{1,2}[ _.-]*d(\d{1,2})(?![a-z0-9])", text or "", re.I)
        if found:
            return int(found.group(1))
    return None


def show_of(text):
    """A disc's title with its season and disc taken off: "Fallout Season One Disc 1" is "Fallout"."""
    return re.split(r"[ _.-]+(?:season|series|disc|s\d{1,2}[ _.-]*d\d)\b", text or "", maxsplit=1, flags=re.I)[0].replace("_", " ").strip()


# --- talking to ARM, Radarr and Sonarr -------------------------------------------------------


def bonus_of(*texts):
    """The movie a bonus disc belongs to: "INTERSTELLAR_BONUS_DISC" is "INTERSTELLAR". None for any other disc."""
    for text in texts:
        found = re.match(r"(.+?)[ _.-]+(?:bonus|extras?|special[ _.-]*features?|supplements?)(?:[ _.-]*(?:dis[ck]|material|content|features?))?(?:[ _.-]*\d+)?$", (text or "").strip(), re.I)
        if found:
            return found.group(1).replace("_", " ").strip()
    return None


def fetch(url, method="GET", body=None, headers=None, timeout=60):
    request = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        text = response.read().decode()
    return json.loads(text) if text else None


def manager(link, method, path, body=None):
    return fetch(link["url"].rstrip("/") + "/api/v3" + path, method, body, {"X-Api-Key": link["apiKey"]})


def read_link(name):
    try:
        with open(os.path.join(LINKS, name + ".json"), encoding="utf-8") as source:
            link = json.load(source)
    except (OSError, ValueError):
        return None
    return link if isinstance(link, dict) and all(link.get(key) for key in ("url", "apiKey", "downloads", "rootFolder")) else None


def finished_job(job_id):
    """The job once ARM has moved its files, or None when it failed or never finished."""
    deadline = time.time() + JOB_SECONDS
    while True:
        detail = fetch("%s/jobs/%s/detail" % (API, job_id))
        job = (detail or {}).get("job") or {}
        if job.get("status") == "success" and job.get("path") and os.path.isdir(job["path"]):
            return job
        if job.get("status") in ("fail", "failed") or time.time() > deadline:
            return None
        time.sleep(POLL_SECONDS)


def videos_in(folder):
    found = []
    for root, _dirs, names in os.walk(folder):
        found += [os.path.join(root, name) for name in names if name.lower().endswith(VIDEO)]
    return sorted(found)


def seen_by(link, path):
    ours, theirs = link["downloads"]["arm"].rstrip("/"), link["downloads"]["manager"].rstrip("/")
    if path != ours and not path.startswith(ours + "/"):
        raise Held("%s is outside the folder %s can see" % (path, link["url"]))
    return theirs + path[len(ours):]


def in_library(link, path):
    """A folder in the manager's library as ARM sees it, or None when ARM has no way to it."""
    library = link.get("library") or {}
    ours, theirs = (library.get("arm") or "").rstrip("/"), (library.get("manager") or "").rstrip("/")
    if not ours or not theirs or not (path == theirs or path.startswith(theirs + "/")):
        return None
    return ours + path[len(theirs):]


def file_extras(link, movie, extras):
    """Moves a disc's extras into the movie's own folder, where Plex and Jellyfin list them under the movie.

    Both read a "Featurettes" folder beside the movie file, and Radarr leaves that folder alone.
    Returns how many were filed. Nothing is overwritten, and with no way to the library they stay put.
    """
    if not extras:
        return 0
    known = manager(link, "GET", "/movie/%d" % movie["id"]) or {}
    folder = in_library(link, (known.get("path") or "").rstrip("/"))
    if not folder or not os.path.isdir(folder):
        log("%d extra(s) of %s stay in Downloads: the movie has no folder in the library yet" % (len(extras), movie.get("title")))
        return 0
    target = os.path.join(folder, EXTRAS_FOLDER)
    os.makedirs(target, exist_ok=True)
    for item in extras:
        stem, ending = os.path.splitext(os.path.basename(item["path"]))
        place, at = os.path.join(target, stem + ending), 1
        while os.path.lexists(place):
            at += 1
            place = os.path.join(target, "%s (%d)%s" % (stem, at, ending))
        shutil.move(item["path"], place)
    log("Filed %d extra(s) under %s" % (len(extras), os.path.join(known.get("path") or "", EXTRAS_FOLDER)))
    return len(extras)


def run_command(link, name, path):
    """Has Radarr or Sonarr import a folder as a finished download, and waits for it."""
    command = manager(link, "POST", "/command", {"name": name, "path": seen_by(link, path), "importMode": "Move"})
    deadline = time.time() + IMPORT_SECONDS
    while time.time() < deadline:
        status = (manager(link, "GET", "/command/%d" % command["id"]) or {}).get("status")
        if status in ("completed", "failed", "aborted", "cancelled", "orphaned"):
            return status
        time.sleep(POLL_SECONDS)
    return "still running"


def new_folder(kind, name):
    """A folder for a named rip beside ARM's own, never one that is there already."""
    base = os.path.join(COMPLETED, kind)
    target, at = os.path.join(base, name), 1
    while os.path.lexists(target):
        at += 1
        target = os.path.join(base, "%s.%d" % (name, at))
    os.makedirs(target)
    return target


def remove_if_empty(folder):
    for root, _dirs, _names in os.walk(folder, topdown=False):
        try:
            os.rmdir(root)
        except OSError:
            pass


# --- a movie ---------------------------------------------------------------------------------


def place_movie(job):
    files = [probe(path) for path in videos_in(job["path"])]
    if not files:
        raise Held("the rip has no video file")
    main = max(files, key=lambda item: item["bytes"])
    link = read_link("radarr")
    title, year, movie = job.get("title_manual") or job.get("title") or main["title"], job.get("year"), None
    if link:
        candidates = []
        if re.fullmatch(r"tt\d{5,12}", job.get("imdb_id") or ""):
            found = manager(link, "GET", "/movie/lookup/imdb?imdbId=" + job["imdb_id"])
            candidates += [found] if isinstance(found, dict) and found.get("tmdbId") else []
        for term in dict.fromkeys(text for text in (main["title"], title) if text):
            candidates += manager(link, "GET", "/movie/lookup?term=" + urllib.parse.quote(term)) or []
        movie = pick_movie(candidates, [main["title"], title], main["seconds"] / 60)
        if not movie:
            raise Held("Radarr couldn't confirm which movie %r is" % (main["title"] or title))
        title, year = movie["title"], movie.get("year")

    name = release_name(title, year, tags_of(main, job.get("disctype")))
    folder = new_folder("movies", name)
    os.rename(main["path"], os.path.join(folder, name + os.path.splitext(main["path"])[1]))
    log("Named %s" % name)
    if not link:
        return
    have = manager(link, "GET", "/movie?tmdbId=%d" % movie["tmdbId"])
    if not have:
        profiles = manager(link, "GET", "/qualityprofile")
        manager(link, "POST", "/movie", dict(movie, rootFolderPath=link["rootFolder"], qualityProfileId=profiles[0]["id"], monitored=False, minimumAvailability="released", addOptions={"searchForMovie": False}))
    status = run_command(link, "DownloadedMoviesScan", folder)
    known = (manager(link, "GET", "/movie?tmdbId=%d" % movie["tmdbId"]) or [None])[0]
    if known:
        file_extras(link, known, [item for item in files if item is not main])
    remove_if_empty(folder)
    remove_if_empty(job["path"])
    log("Radarr's import of %s: %s%s" % (name, status, "" if not os.path.isdir(folder) else ". Radarr left it in Downloads: it keeps the copy it has"))


def place_bonus(job, base):
    """A bonus disc holds no movie. Its titles go under the movie it names, once that movie is in the library."""
    files = [probe(path) for path in videos_in(job["path"])]
    if not files:
        raise Held("the rip has no video file")
    link = read_link("radarr")
    if not link:
        raise Held("Radarr isn't connected, and a bonus disc needs its movie's folder")
    named = [movie for movie in manager(link, "GET", "/movie") or [] if plain(movie.get("title")) == plain(base) or plain(movie.get("originalTitle")) == plain(base)]
    if len(named) != 1:
        raise Held("%s in your library is called %r. Rip or add the movie first" % ("no movie" if not named else "more than one movie", base))
    if not file_extras(link, named[0], files):
        raise Held("%r has no folder in the library yet. Rip or add the movie first" % named[0].get("title"))
    remove_if_empty(job["path"])


# --- a show ----------------------------------------------------------------------------------


def place_show(job):
    # A title under ten minutes is an extra, not an episode. It stays where ARM put it.
    files = unique_titles([item for item in (probe(path) for path in videos_in(job["path"])) if item["seconds"] >= EPISODE_SECONDS])
    if not files:
        raise Held("the rip has no title long enough to be an episode")
    link = read_link("sonarr")
    if not link:
        raise Held("Sonarr isn't connected, and a disc's titles carry no episode numbers")
    disc = files[0]["title"] or job.get("label") or ""
    season = job.get("season_manual") or job.get("season") or season_of(disc, job.get("label"))
    if not season:
        raise Held("the disc doesn't say which season it is")
    show = job.get("title_manual") or show_of(disc) or job.get("title")
    found = [series for term in dict.fromkeys(text for text in (show, job.get("title")) if text) for series in manager(link, "GET", "/series/lookup?term=" + urllib.parse.quote(term)) or []]
    named = [series for series in found if plain(series.get("title")) in {plain(show), plain(job.get("title"))}]
    if not named:
        raise Held("Sonarr couldn't find the show %r" % show)
    series = named[0]
    if not series.get("id"):
        profiles = manager(link, "GET", "/qualityprofile")
        series = manager(link, "POST", "/series", dict(series, rootFolderPath=link["rootFolder"], qualityProfileId=profiles[0]["id"], monitored=False, seasonFolder=True, addOptions={"searchForMissingEpisodes": False, "monitor": "none"}))
    episodes = [episode for episode in manager(link, "GET", "/episode?seriesId=%d&seasonNumber=%d" % (series["id"], int(season))) or [] if episode.get("seasonNumber") == int(season)]
    numbers = match_episodes([item["seconds"] / 60 for item in files], episodes, disc_of(disc, job.get("label")))
    if not numbers:
        raise Held("the titles' lengths don't settle which episodes of season %s they are" % season)

    folder = new_folder("tv", "%s.S%02d.%s" % (release_title(series["title"]), int(season), RELEASE_GROUP))
    for item, number in zip(files, numbers):
        name = release_name(series["title"], None, tags_of(item, job.get("disctype")), "S%02dE%02d" % (int(season), number))
        os.rename(item["path"], os.path.join(folder, name + os.path.splitext(item["path"])[1]))
        log("Named %s" % name)
    status = run_command(link, "DownloadedEpisodesScan", folder)
    remove_if_empty(folder)
    remove_if_empty(job["path"])
    log("Sonarr's import of %s season %s: %s" % (series["title"], season, status))


def main():
    job_id = os.environ.get("ARM_JOB_ID") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not re.fullmatch(r"\d+", job_id or ""):
        return
    job = finished_job(job_id)
    if not job:
        return
    try:
        kind = job.get("video_type_manual") or job.get("video_type")
        base = bonus_of(job.get("label"), job.get("title"))
        if base and kind != "series":
            place_bonus(job, base)
            return
        # ARM leaves a disc it found no match for as "unknown". One that names its season is a show.
        if kind not in ("movie", "series") and season_of(job.get("title"), job.get("label")):
            kind = "series"
        if kind == "movie":
            place_movie(job)
        elif kind == "series":
            place_show(job)
        else:
            raise Held("ARM couldn't tell whether it is a movie or a show")
    except Held as why:
        log("Job %s (%s) stays in %s: %s" % (job_id, job.get("title"), job.get("path"), why))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--release-name":
            # For the catalog's tests: the name for streams as ffprobe reports them
            asked = json.loads(sys.argv[2])
            print(release_name(asked["title"], asked.get("year"), media_tags(asked["streams"], asked.get("disctype"), asked.get("dv"), asked.get("atmos")), asked.get("episode", "")))
        elif len(sys.argv) == 3 and sys.argv[1] == "--detect":
            # For the catalog's tests: what the file's own bytes say, with no ffprobe
            with open(sys.argv[2], "rb") as source:
                raw = source.read()
            print(json.dumps({"dv": dolby_vision(raw[: 4 * 1024 * 1024]), "atmos": truehd_atmos(raw)}))
        elif len(sys.argv) == 3 and sys.argv[1] == "--decide":
            # For the catalog's tests: the choices made from lengths and lookups, with no files
            asked = json.loads(sys.argv[2])
            print(json.dumps({
                "movie": (pick_movie(asked["candidates"], asked["titles"], asked["minutes"]) or {}).get("tmdbId") if "candidates" in asked else None,
                "episodes": match_episodes(asked["lengths"], asked["episodes"], disc_of(*asked.get("discs", []))) if "lengths" in asked else None,
                "season": season_of(*asked.get("discs", [])),
                "show": show_of(asked["discs"][0]) if asked.get("discs") else None,
            }))
        else:
            main()
    except Exception as error:  # noqa: BLE001
        log("after-rip failed: %r" % error)
`;

/** ARM waits 30 seconds for a channel's script, and an import of a UHD rip takes far longer, so the work is handed off. */
export const AFTER_RIP_SH = `#!/bin/bash
setsid nohup python3 ${CONFIG_PATH}/hexos/after_rip.py >/dev/null 2>&1 &
`;

/** What HexOS sets in arm.yaml. A rip is kept as the disc has it: a transcode takes hours and drops a UHD disc's HDR. */
export const wantedSettings = (omdbKey: string): Record<string, string | boolean> => ({
  SKIP_TRANSCODE: true,
  RIPMETHOD: "mkv",
  ...(omdbKey ? { METADATA_PROVIDER: "omdb", OMDB_API_KEY: omdbKey } : {}),
});

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
  const env = ((values?.services as Record<string, { environment?: Record<string, unknown> }> | undefined)?.[RIPPER]?.environment ?? {})[OMDB_KEY_ENV];
  return typeof env === "string" ? env.trim() : "";
};

/**
 * The drives MakeMKV has no LibreDrive data for, from its debug log: "No  SDF v0a6: <drive id>".
 * MakeMKV 1.18 on Linux hangs at "Scanning CD-ROM devices" when such a drive holds a disc, with one
 * thread at full load (seen on two Pioneer BDR-S11, 2026-11-18). Naming the drive in sdf_Stop stops it.
 */
export const drivesWithoutSdf = (debugLog: string): string[] => [
  ...new Set([...debugLog.matchAll(/^No\s+SDF v\w+: (\S+)\s*$/gm)].map((found) => found[1]).filter((id) => /^[\w.+-]+$/.test(id))),
];

/** MakeMKV's settings with those drives in sdf_Stop, beside any the owner or an earlier run put there. */
export const withSdfStop = (settings: string, drives: readonly string[]): string => {
  const line = settings.match(/^sdf_Stop[ \t]*=[ \t]*"([^"]*)"[ \t]*$/m);
  const all = [...new Set([...(line?.[1] ?? "").split(/\s+/).filter(Boolean), ...drives])];
  if (all.length === 0) return settings;
  const next = `sdf_Stop = "${all.join(" ")}"`;
  return line ? settings.replace(line[0], next) : `${settings.replace(/\n*$/, settings.trim() ? "\n" : "")}${next}\n`;
};

const mountAt = (mounts: ContextMount[], containerPath: string, host: RegExp) =>
  mounts.find((mount) => mount.containerPath === containerPath) ?? mounts.find((mount) => host.test(mount.hostPath));

/**
 * ARM's image stops at its start unless its settings folder belongs to the user it rips as, by
 * user and by group (arm_user_files_setup.sh reads both with stat). HexOS lets apps into a folder
 * with an ACL entry and leaves root as its owner, so ARM's folders are handed over here.
 */
export async function prepare(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "folders", message: "Folders ready" }]);
  const owned = ctx.mounts.filter((mount) => /\/ripping-machine(-\d+)?\/(config|logs|db|makemkv)$/.test(mount.hostPath));
  if (owned.length === 0) ctx.fail("HexOS couldn't find Automatic Ripping Machine's folders.");
  for (const mount of owned) chownSync(mount.localPath, APPS_UID, APPS_UID);
  await ctx.emitCheckpoint("folders");
}

/** Writes a file ARM's own user can read, only when its text changed. */
const writeForArm = (path: string, text: string, mode: number) => {
  if (!existsSync(path) || readFileSync(path, "utf-8") !== text) writeFileSync(path, text, { mode });
  chownSync(path, APPS_UID, APPS_UID);
};

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Automatic Ripping Machine started" },
    { id: "settings", message: "Rip settings saved" },
    { id: "drives", message: "Disc drives checked" },
    { id: "handoff", message: "Finished rips go to Radarr and Sonarr" },
  ]);

  const config = mountAt(ctx.mounts, CONFIG_PATH, /\/ripping-machine(-\d+)?\/config$/);
  const makemkv = mountAt(ctx.mounts, "/home/arm/.MakeMKV", /\/ripping-machine(-\d+)?\/makemkv$/);
  if (!config || !makemkv) ctx.fail("HexOS couldn't find Automatic Ripping Machine's settings folders.");

  const omdbKey = omdbKeyFromValues(await ctx.getAppValues?.().catch(() => null));
  if (!/^[A-Za-z0-9]{0,64}$/.test(omdbKey)) ctx.fail("The OMDb API key holds letters and numbers only. Check it and run this again.");

  // The ripper copies its default arm.yaml into an empty settings folder on its first start
  const path = `${config.localPath}/arm.yaml`;
  let ripper = await ripperUrl(ctx);
  for (let attempt = 0; attempt < 60 && !(ripper && existsSync(path) && (await answers(ripper))); attempt++) {
    await ctx.sleep(3000);
    ripper = await ripperUrl(ctx);
  }
  if (!ripper || !existsSync(path)) ctx.fail("Automatic Ripping Machine hasn't started yet. Wait a minute, then run this again.");
  await ctx.emitCheckpoint("start");

  const folder = `${config.localPath}/hexos`;
  mkdirSync(folder, { recursive: true, mode: 0o750 });
  chownSync(folder, APPS_UID, APPS_UID);
  writeForArm(`${folder}/after_rip.py`, AFTER_RIP_PY, 0o640);
  writeForArm(`${folder}/after-rip.sh`, AFTER_RIP_SH, 0o750);

  const current = readFileSync(path, "utf-8");
  const next = applySettings(current, wantedSettings(omdbKey));
  let restart = next !== current;
  if (restart) writeFileSync(path, next);
  await ctx.emitCheckpoint("settings");

  // MakeMKV names each drive it has no LibreDrive data for while it lists the drives
  const drives = drivesWithoutSdf(await makemkvDebugLog(ctx).catch(() => ""));
  const settingsPath = `${makemkv.localPath}/settings.conf`;
  const settings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "";
  const stopped = withSdfStop(settings, drives);
  if (stopped !== settings) {
    writeForArm(settingsPath, stopped, 0o640);
    restart = true;
    await ctx.emitCheckpoint("drives", `${drives.length} ${drives.length === 1 ? "drive needs" : "drives need"} a MakeMKV workaround, now set`);
  } else await ctx.emitCheckpoint("drives");

  if (restart) {
    // The ripper reads arm.yaml and MakeMKV's settings at its start
    await ctx.restartApp?.();
    for (let attempt = 0; attempt < 60; attempt++) {
      ripper = await ripperUrl(ctx);
      if (ripper && (await answers(ripper))) break;
      await ctx.sleep(3000);
    }
    if (!ripper) ctx.fail("Automatic Ripping Machine didn't come back after its settings changed. Run this again.");
  }

  // The dashboard holds every visitor at its setup wizard until it is told setup is done
  await fetch(`${ctx.baseUrl}/api/setup/complete`, { method: "POST", signal: AbortSignal.timeout(15000) }).catch(() => undefined);

  const channels = await ripperJson<Array<{ name?: string }>>(ripper, "/notifications/channels").catch(() => []);
  if (!channels.some((channel) => channel.name === CHANNEL)) {
    const made = await fetch(`${ripper}/api/v1/notifications/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bash", name: CHANNEL, enabled: true, config: { type: "bash", script_path: AFTER_RIP_SCRIPT }, subscribed_events: ["job.rip_complete"] }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => undefined);
    if (!made?.ok) ctx.fail("Automatic Ripping Machine didn't take the step that hands rips to Radarr and Sonarr. Run this again.");
  }
  await ctx.emitCheckpoint("handoff");
}

/** The ripper's own address: it publishes no port, and HexOS reaches a container on the app's network. */
async function ripperUrl(ctx: HookContext): Promise<string | undefined> {
  const containers = (await ctx.appContainers?.().catch(() => [])) ?? [];
  const address = containers.find((container) => container.service === RIPPER && container.state === "running")?.addresses?.[0];
  return address ? `http://${address}:${RIPPER_PORT}` : undefined;
}

const answers = (ripper: string) =>
  fetch(`${ripper}/api/v1/system/info`, { signal: AbortSignal.timeout(5000) }).then(
    (response) => response.ok,
    () => false,
  );

async function ripperJson<T>(ripper: string, path: string): Promise<T> {
  const response = await fetch(`${ripper}/api/v1${path}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`ARM answered ${response.status}`);
  return (await response.json()) as T;
}

const DOCKER_SOCKET = "/var/run/docker.sock";
// MakeMKV writes its debug log here whatever path --debug names (1.18.3, seen 2026-11-18)
const DEBUG_LOG = "/home/arm/MakeMKV_log.txt";

/**
 * Runs MakeMKV's drive scan once in the ripper with its debug log on, and returns the log. ARM's
 * own script fetches MakeMKV's key first: on a new install there is none until the first rip, and
 * without one MakeMKV stops before it looks at a drive. The scan is stopped after 25 seconds: with a disc in a drive that needs the workaround it would
 * hang, and the drive's line is in the log before it does.
 */
async function makemkvDebugLog(ctx: HookContext): Promise<string> {
  const containers = (await ctx.appContainers?.()) ?? [];
  const id = containers.find((container) => container.service === RIPPER && container.state === "running")?.id;
  if (!id) return "";
  const run = async (command: string[]): Promise<string> => {
    const made = await fetch(`http://docker/containers/${id}/exec`, {
      unix: DOCKER_SOCKET,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ AttachStdout: true, AttachStderr: true, Tty: true, User: "arm", Cmd: command }),
      signal: AbortSignal.timeout(15000),
    } as RequestInit);
    if (!made.ok) throw new Error(`Docker answered ${made.status}`);
    const exec = (await made.json()) as { Id: string };
    const started = await fetch(`http://docker/exec/${exec.Id}/start`, {
      unix: DOCKER_SOCKET,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false, Tty: true }),
      signal: AbortSignal.timeout(120000),
    } as RequestInit);
    return started.text();
  };
  await run(["sh", "-c", `rm -f ${DEBUG_LOG}; cd /home/arm && (timeout 60 bash /opt/arm/scripts/update_key.sh; timeout -s KILL 25 makemkvcon -r --debug --cache=1 info disc:9999) >/dev/null 2>&1; true`]);
  return run(["sh", "-c", `cat ${DEBUG_LOG} 2>/dev/null; rm -f ${DEBUG_LOG}`]);
}
