"""
DashTrack — footage directory scanner and file watcher.

Scans /footage for MP4 files, extracts GPS, caches GPX files,
and maintains the SQLite clips index.
"""

import asyncio
import logging
import os
import re
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, select

from db import Clip, clip_id, get_engine
from extractor import GPSPoint, extract_points, points_to_gpx

logger = logging.getLogger(__name__)

FOOTAGE_DIR = Path(os.getenv("FOOTAGE_DIR", "/dashtrack/footage"))
GPX_CACHE_DIR = Path(os.getenv("GPX_DIR", "/dashtrack/gpx"))


def parse_viofo_filename(filename: str) -> dict:
    """
    Parse Viofo filename: 2026_0314_114143_025729F.MP4
    Returns dict with session_id, recorded_at, channel.
    """
    m = re.match(r"(\d{4}_\d{4}_\d{6})_\d+([FR])\.MP4", filename, re.IGNORECASE)
    if m:
        try:
            recorded_at = datetime.strptime(m.group(1), "%Y_%m%d_%H%M%S")
        except ValueError:
            recorded_at = None
        return {
            "session_id": m.group(1),
            "recorded_at": recorded_at,
            "channel": "front" if m.group(2).upper() == "F" else "rear",
        }
    return {"session_id": None, "recorded_at": None, "channel": "unknown"}


def extract_and_cache(
    mp4_path: Path, cid: str, filename: str
) -> tuple[list[GPSPoint], Path | None]:
    """Extract GPS from an MP4, write GPX cache file. Returns (points, gpx_path).

    This is the shared core used by both initial indexing and re-indexing.
    Runs synchronously — callers are responsible for threading.
    """
    GPX_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    points = list(extract_points(str(mp4_path)))
    if not points:
        return [], None

    gpx_str = points_to_gpx(points, source_name=filename)
    gpx_path = GPX_CACHE_DIR / f"{cid}.gpx"
    gpx_path.write_text(gpx_str, encoding="utf-8")
    return points, gpx_path


def apply_gps_metadata(clip: Clip, points: list[GPSPoint], gpx_path: Path) -> None:
    """Populate a Clip's GPS metadata fields from extracted points."""
    lats = [p.lat for p in points]
    lons = [p.lon for p in points]
    speeds = [p.speed_kmh for p in points if p.speed_kmh > 0]

    clip.status = "indexed"
    clip.gpx_path = str(gpx_path)
    clip.point_count = len(points)
    clip.duration_sec = points[-1].video_sec
    clip.lat_min = min(lats)
    clip.lat_max = max(lats)
    clip.lon_min = min(lons)
    clip.lon_max = max(lons)
    clip.max_speed_kmh = round(max(speeds), 1) if speeds else None
    clip.indexed_at = datetime.utcnow()


async def index_file(path: Path) -> None:
    """Extract GPS from an MP4 file, write GPX cache, upsert Clip row."""
    cid = clip_id(str(path))

    with Session(get_engine()) as sess:
        existing = sess.get(Clip, cid)
        if existing and existing.status == "indexed":
            return

    meta = parse_viofo_filename(path.name)
    clip = Clip(
        id=cid,
        path=str(path),
        filename=path.name,
        channel=meta["channel"],
        session_id=meta["session_id"],
        recorded_at=meta["recorded_at"],
        size_bytes=path.stat().st_size,
        status="pending",
    )

    try:
        loop = asyncio.get_event_loop()
        points, gpx_path = await loop.run_in_executor(None, extract_and_cache, path, cid, path.name)

        if not points:
            clip.status = "error"
            clip.error_msg = "No GPS data found"
        else:
            apply_gps_metadata(clip, points, gpx_path)

    except Exception as e:
        logger.error("Failed to index %s: %s", path, e)
        clip.status = "error"
        clip.error_msg = str(e)

    with Session(get_engine()) as sess:
        sess.merge(clip)
        sess.commit()

    logger.info("Indexed %s → %s (%s pts)", path.name, clip.status, clip.point_count)


async def scan_footage_dir() -> None:
    """Scan FOOTAGE_DIR for all MP4s and index any not yet indexed."""
    if not FOOTAGE_DIR.exists():
        logger.warning("Footage dir %s does not exist", FOOTAGE_DIR)
        return

    mp4_files = list(FOOTAGE_DIR.rglob("*.MP4")) + list(FOOTAGE_DIR.rglob("*.mp4"))
    # Deduplicate (case-insensitive filesystems may double-count)
    seen: set[str] = set()
    unique_files = []
    for f in mp4_files:
        k = str(f).lower()
        if k not in seen:
            seen.add(k)
            unique_files.append(f)

    logger.info("Found %d MP4 files in %s", len(unique_files), FOOTAGE_DIR)

    with Session(get_engine()) as sess:
        indexed_ids = set(sess.exec(select(Clip.id).where(Clip.status == "indexed")).all())

    to_index = [f for f in unique_files if clip_id(str(f)) not in indexed_ids]
    logger.info("Indexing %d new files", len(to_index))

    for path in to_index:
        await index_file(path)


async def watch_footage_dir() -> None:
    """Watch FOOTAGE_DIR for new/modified MP4 files and index them."""
    if not FOOTAGE_DIR.exists():
        logger.warning("Footage dir %s does not exist, watcher not started", FOOTAGE_DIR)
        return

    try:
        from watchfiles import Change, awatch

        logger.info("Watching %s for new footage", FOOTAGE_DIR)
        async for changes in awatch(str(FOOTAGE_DIR)):
            for change_type, path_str in changes:
                path = Path(path_str)
                if path.suffix.upper() == ".MP4" and change_type in (Change.added, Change.modified):
                    logger.info("Detected new/modified file: %s", path.name)
                    await index_file(path)
    except Exception as e:
        logger.error("File watcher error: %s", e)
