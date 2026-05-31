"""
DashTrack — library API routes.

GET  /api/library                       list all indexed clips
GET  /api/library/session/{session_id}  both clips in a session with GPX
GET  /api/library/{clip_id}             single clip metadata + GPX
GET  /api/footage/{clip_id}             stream video file (Range-request capable)
"""

import asyncio
import concurrent.futures
import logging
import os
import re
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from db import Clip, get_engine
from scanner import apply_gps_metadata, extract_and_cache

router = APIRouter()


# ── Response models ───────────────────────────────────────────────────────────


class ClipResponse(BaseModel):
    id: str
    filename: str
    channel: str
    session_id: str | None
    recorded_at: str | None
    duration_sec: float | None
    size_bytes: int
    lat_min: float | None
    lat_max: float | None
    lon_min: float | None
    lon_max: float | None
    max_speed_kmh: float | None
    point_count: int | None
    status: str
    peer_clip_id: str | None = None


class ClipDetailResponse(ClipResponse):
    gpx: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────


def _to_response(clip: Clip, peer_id: str | None = None) -> ClipResponse:
    return ClipResponse(
        id=clip.id,
        filename=clip.filename,
        channel=clip.channel,
        session_id=clip.session_id,
        recorded_at=clip.recorded_at.isoformat() if clip.recorded_at else None,
        duration_sec=clip.duration_sec,
        size_bytes=clip.size_bytes,
        lat_min=clip.lat_min,
        lat_max=clip.lat_max,
        lon_min=clip.lon_min,
        lon_max=clip.lon_max,
        max_speed_kmh=clip.max_speed_kmh,
        point_count=clip.point_count,
        status=clip.status,
        peer_clip_id=peer_id,
    )


def _to_detail(clip: Clip, peer_id: str | None = None) -> ClipDetailResponse:
    gpx = None
    if clip.gpx_path:
        p = Path(clip.gpx_path)
        if p.exists():
            gpx = p.read_text(encoding="utf-8")
    base = _to_response(clip, peer_id)
    return ClipDetailResponse(**base.model_dump(), gpx=gpx)


def _peer_id(clip: Clip, sess: Session) -> str | None:
    if not clip.session_id:
        return None
    peers = sess.exec(
        select(Clip).where(
            Clip.session_id == clip.session_id,
            Clip.id != clip.id,
            Clip.status == "indexed",
        )
    ).all()
    return peers[0].id if peers else None


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/api/library", response_model=list[ClipResponse])
async def list_clips(
    date_from: str | None = None,
    date_to: str | None = None,
    status: str = "indexed",
    limit: int = 100,
    offset: int = 0,
):
    """List indexed clips ordered by recorded_at DESC, paginated."""
    from datetime import datetime as dt

    with Session(get_engine()) as sess:
        stmt = select(Clip).where(Clip.status == status)
        if date_from:
            try:
                stmt = stmt.where(
                    Clip.recorded_at
                    >= dt.strptime(date_from, "%Y-%m-%d").replace(hour=0, minute=0, second=0)
                )
            except ValueError:
                pass
        if date_to:
            try:
                stmt = stmt.where(
                    Clip.recorded_at
                    <= dt.strptime(date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
                )
            except ValueError:
                pass
        stmt = stmt.order_by(Clip.recorded_at.desc()).offset(offset).limit(limit)  # type: ignore
        clips = sess.exec(stmt).all()

        # Build peer map from session groups
        session_groups: dict[str, list[Clip]] = {}
        for c in clips:
            if c.session_id:
                session_groups.setdefault(c.session_id, []).append(c)

        results = []
        for c in clips:
            peer_id = None
            if c.session_id and c.session_id in session_groups:
                peers = [p for p in session_groups[c.session_id] if p.id != c.id]
                peer_id = peers[0].id if peers else None
            results.append(_to_response(c, peer_id))
    return results


class BatchRequest(BaseModel):
    ids: list[str]


@router.post("/api/library/batch", response_model=list[ClipDetailResponse])
async def get_clips_batch(body: BatchRequest):
    """Return metadata + GPX for multiple clips in a single request."""
    if not body.ids:
        return []
    with Session(get_engine()) as sess:
        clips = sess.exec(select(Clip).where(Clip.id.in_(body.ids))).all()

        # Build peer map for all relevant sessions in one query
        session_ids = {c.session_id for c in clips if c.session_id}
        peer_map: dict[str, str] = {}
        if session_ids:
            session_clips = sess.exec(select(Clip).where(Clip.session_id.in_(session_ids))).all()
            groups: dict[str, list[str]] = {}
            for c in session_clips:
                if c.session_id:
                    groups.setdefault(c.session_id, []).append(c.id)
            for grp_ids in groups.values():
                if len(grp_ids) == 2:
                    peer_map[grp_ids[0]] = grp_ids[1]
                    peer_map[grp_ids[1]] = grp_ids[0]

        clip_by_id = {c.id: c for c in clips}
        # Preserve request order
        return [
            _to_detail(clip_by_id[id_], peer_map.get(id_)) for id_ in body.ids if id_ in clip_by_id
        ]


class DayEntry(BaseModel):
    date: str
    count: int


@router.get("/api/library/days", response_model=list[DayEntry])
async def list_days(
    date_from: str | None = None,
    date_to: str | None = None,
    status: str = "indexed",
    limit: int = 100,
    offset: int = 0,
):
    """List distinct recording days with clip counts, ordered newest first."""
    from datetime import datetime as dt

    from sqlalchemy import func

    with Session(get_engine()) as sess:
        stmt = select(
            func.date(Clip.recorded_at).label("day"),
            func.count(func.distinct(func.coalesce(Clip.session_id, Clip.id))).label("cnt"),
        ).where(Clip.status == status)
        if date_from:
            try:
                stmt = stmt.where(
                    Clip.recorded_at
                    >= dt.strptime(date_from, "%Y-%m-%d").replace(hour=0, minute=0, second=0)
                )
            except ValueError:
                pass
        if date_to:
            try:
                stmt = stmt.where(
                    Clip.recorded_at
                    <= dt.strptime(date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
                )
            except ValueError:
                pass
        stmt = (
            stmt.group_by(func.date(Clip.recorded_at))
            .order_by(func.date(Clip.recorded_at).desc())
            .offset(offset)
            .limit(limit)
        )
        rows = sess.exec(stmt).all()
        return [DayEntry(date=str(row.day), count=row.cnt) for row in rows]


@router.get("/api/library/session/{session_id}", response_model=list[ClipDetailResponse])
async def get_session_clips(session_id: str):
    """Return all clips in a session (front + rear) with full GPX."""
    with Session(get_engine()) as sess:
        clips = sess.exec(
            select(Clip).where(
                Clip.session_id == session_id,
                Clip.status == "indexed",
            )
        ).all()
        if not clips:
            raise HTTPException(404, f"Session {session_id} not found")

        # Sort: front first, rear second
        clips = sorted(clips, key=lambda c: (0 if c.channel == "front" else 1))
        peer_map = {clips[0].id: clips[1].id, clips[1].id: clips[0].id} if len(clips) == 2 else {}
        return [_to_detail(c, peer_map.get(c.id)) for c in clips]


@router.get("/api/library/{clip_id}/minitrack")
async def get_minitrack(clip_id: str, points: int = 20):
    """Return a decimated lat/lon track for thumbnail rendering.

    Response is immutable (GPS data never changes) so we cache aggressively.
    """
    import re as _re

    with Session(get_engine()) as sess:
        clip = sess.get(Clip, clip_id)
        if not clip:
            raise HTTPException(404, "Clip not found")
        if not clip.gpx_path:
            return []
        p = Path(clip.gpx_path)
        if not p.exists():
            return []

    # Fast regex extraction — avoids XML namespace headaches entirely
    gpx_text = p.read_text(encoding="utf-8")
    all_pts = [
        [float(m.group(1)), float(m.group(2))]
        for m in _re.finditer(r'<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"', gpx_text)
    ]

    if not all_pts:
        return JSONResponse([], headers={"Cache-Control": "public, max-age=86400, immutable"})
    if len(all_pts) <= points:
        return JSONResponse(all_pts, headers={"Cache-Control": "public, max-age=86400, immutable"})

    # Uniform decimation, always include first and last
    step = (len(all_pts) - 1) / (points - 1)
    result = [all_pts[round(i * step)] for i in range(points)]
    result[-1] = all_pts[-1]
    return JSONResponse(result, headers={"Cache-Control": "public, max-age=86400, immutable"})


@router.get("/api/library/{clip_id}", response_model=ClipDetailResponse)
async def get_clip(clip_id: str):
    """Return a single clip's metadata and GPX."""
    with Session(get_engine()) as sess:
        clip = sess.get(Clip, clip_id)
        if not clip:
            raise HTTPException(404, "Clip not found")
        peer_id = _peer_id(clip, sess)
        return _to_detail(clip, peer_id)


@router.get("/api/footage/{clip_id}")
async def stream_footage(clip_id: str, request: Request):
    """Stream MP4 video file with HTTP 206 Range request support for seeking."""
    with Session(get_engine()) as sess:
        clip = sess.get(Clip, clip_id)
        if not clip:
            raise HTTPException(404, "Clip not found")
        path = Path(clip.path)
        if not path.exists():
            raise HTTPException(404, "Video file not found on disk")

    file_size = path.stat().st_size
    range_header = request.headers.get("range", "")

    m = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if m:
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else file_size - 1
        end = min(end, file_size - 1)
        length = end - start + 1

        def _iter():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            _iter(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(length),
                "Accept-Ranges": "bytes",
            },
        )

    # No Range header — send full file, but advertise range support
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
    )


# ── Re-index ─────────────────────────────────────────────────────────────────

_reindex_logger = logging.getLogger("dashtrack.reindex")
_reindex_lock = threading.Lock()
_reindex_state: dict = {
    "running": False,
    "total": 0,
    "done": 0,
    "errors": 0,
    "skipped": 0,
    "error_details": [],
}

REINDEX_WORKERS = int(os.getenv("REINDEX_WORKERS", "4"))


def _reindex_one(cid: str, mp4_path: str, filename: str) -> dict:
    """Re-extract GPS from a single clip. Runs in a thread."""
    try:
        mp4 = Path(mp4_path)
        if not mp4.exists():
            return {"id": cid, "status": "skip", "reason": f"File not found: {mp4_path}"}

        points, gpx_path = extract_and_cache(mp4, cid, filename)
        if not points:
            return {"id": cid, "status": "error", "reason": f"No GPS data in {filename}"}

        return {"id": cid, "status": "ok", "points": points, "gpx_path": gpx_path}
    except Exception as e:
        return {"id": cid, "status": "error", "reason": f"{filename}: {type(e).__name__}: {e}"}


async def _run_reindex():
    """Background task: re-extract all indexed clips in parallel."""
    global _reindex_state

    with Session(get_engine()) as sess:
        clips = sess.exec(select(Clip)).all()
        work = [(c.id, c.path, c.filename) for c in clips]

    _reindex_state = {
        "running": True,
        "total": len(work),
        "done": 0,
        "errors": 0,
        "skipped": 0,
        "error_details": [],
    }
    _reindex_logger.info("Re-indexing %d clips with %d workers", len(work), REINDEX_WORKERS)

    loop = asyncio.get_event_loop()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=REINDEX_WORKERS)

    futures = [loop.run_in_executor(executor, _reindex_one, *w) for w in work]

    for fut in asyncio.as_completed(futures):
        result = await fut
        cid = result["id"]

        if result["status"] == "ok":
            with Session(get_engine()) as sess:
                clip = sess.get(Clip, cid)
                if clip:
                    apply_gps_metadata(clip, result["points"], result["gpx_path"])
                    sess.add(clip)
                    sess.commit()
            _reindex_state["done"] += 1
        elif result["status"] == "skip":
            _reindex_state["skipped"] += 1
            _reindex_state["done"] += 1
            _reindex_logger.warning("Skipped %s: %s", cid, result["reason"])
            _reindex_state["error_details"].append(result["reason"])
        else:
            _reindex_state["errors"] += 1
            _reindex_state["done"] += 1
            _reindex_logger.warning("Re-index failed: %s", result["reason"])
            _reindex_state["error_details"].append(result["reason"])

        if _reindex_state["done"] % 50 == 0:
            _reindex_logger.info(
                "Re-index progress: %d/%d (errors: %d, skipped: %d)",
                _reindex_state["done"],
                _reindex_state["total"],
                _reindex_state["errors"],
                _reindex_state["skipped"],
            )

    executor.shutdown(wait=False)
    _reindex_state["running"] = False
    _reindex_logger.info(
        "Re-index complete: %d ok, %d errors, %d skipped out of %d total",
        _reindex_state["done"] - _reindex_state["errors"] - _reindex_state["skipped"],
        _reindex_state["errors"],
        _reindex_state["skipped"],
        _reindex_state["total"],
    )


@router.post("/api/library/reindex")
async def start_reindex():
    """Re-extract GPS from all clips using the latest extractor logic."""
    with _reindex_lock:
        if _reindex_state.get("running"):
            return {"status": "already_running", **_reindex_state}
        asyncio.create_task(_run_reindex())
        return {"status": "started", "message": "Re-indexing all clips in background"}


@router.get("/api/library/reindex")
async def reindex_status():
    """Check re-index progress, including error details."""
    pct = (
        round(_reindex_state["done"] / _reindex_state["total"] * 100)
        if _reindex_state["total"] > 0
        else 0
    )
    return {**_reindex_state, "percent": pct}
