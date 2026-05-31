"""
DashTrack — library API routes.

GET  /api/library                       list all indexed clips
GET  /api/library/session/{session_id}  both clips in a session with GPX
GET  /api/library/{clip_id}             single clip metadata + GPX
GET  /api/footage/{clip_id}             stream video file (Range-request capable)
"""

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from db import Clip, get_engine

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
    """Return a decimated lat/lon track for thumbnail rendering."""
    import xml.etree.ElementTree as ET

    with Session(get_engine()) as sess:
        clip = sess.get(Clip, clip_id)
        if not clip:
            raise HTTPException(404, "Clip not found")
        if not clip.gpx_path:
            return []
        p = Path(clip.gpx_path)
        if not p.exists():
            return []

    tree = ET.parse(p)
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    trkpts = tree.findall(".//g:trkpt", ns)
    if not trkpts:
        # Try without namespace (our GPX files may not use one)
        trkpts = tree.findall(".//{http://www.topografix.com/GPX/1/1}trkpt")
    if not trkpts:
        trkpts = tree.findall(".//trkpt")
    if not trkpts:
        return []

    all_pts = []
    for tp in trkpts:
        lat = tp.get("lat")
        lon = tp.get("lon")
        if lat and lon:
            all_pts.append([float(lat), float(lon)])

    if len(all_pts) <= points:
        return all_pts

    # Uniform decimation, always include first and last
    step = (len(all_pts) - 1) / (points - 1)
    result = [all_pts[round(i * step)] for i in range(points)]
    result[-1] = all_pts[-1]
    return result


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
