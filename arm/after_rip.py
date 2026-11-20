#!/usr/bin/env python3
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


def match_episodes(minutes, episodes):
    """Which episode each title is, by length: a list of episode numbers in the titles' order, or None.

    A disc holds episodes that follow one another, so every run of that many episodes is tried, the
    longest title against the longest episode. The best run has to be close in every title, clearly
    better than the next run, and unchanged by swapping two titles, or nothing is matched.
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
        return None
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


def show_of(text):
    """A disc's title with its season and disc taken off: "Fallout Season One Disc 1" is "Fallout"."""
    return re.split(r"[ _.-]+(?:season|series|disc|s\d{1,2}[ _.-]*d\d)\b", text or "", maxsplit=1, flags=re.I)[0].replace("_", " ").strip()


# --- talking to ARM, Radarr and Sonarr -------------------------------------------------------


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
    remove_if_empty(folder)
    remove_if_empty(job["path"])
    log("Radarr's import of %s: %s%s" % (name, status, "" if not os.path.isdir(folder) else ". Radarr left it in Downloads: it keeps the copy it has"))


# --- a show ----------------------------------------------------------------------------------


def place_show(job):
    files = unique_titles([probe(path) for path in videos_in(job["path"])])
    if not files:
        raise Held("the rip has no video file")
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
    numbers = match_episodes([item["seconds"] / 60 for item in files], episodes)
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
                "episodes": match_episodes(asked["lengths"], asked["episodes"]) if "lengths" in asked else None,
                "season": season_of(*asked.get("discs", [])),
                "show": show_of(asked["discs"][0]) if asked.get("discs") else None,
            }))
        else:
            main()
    except Exception as error:  # noqa: BLE001
        log("after-rip failed: %r" % error)
