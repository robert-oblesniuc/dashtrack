"""
DashTrack — single container FastAPI backend.

Serves:
  /          → React SPA (built frontend in ./static)
  /api/*     → REST + WebSocket

Endpoints:
  GET  /api/health
  POST /api/extract/start   upload MP4, returns {job_id}
  WS   /api/ws/extract/{id} stream progress, final msg contains GPX
  GET  /api/library         list indexed clips
  GET  /api/library/{id}    single clip + GPX
  GET  /api/footage/{id}    stream video file
"""

import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import aiofiles
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from extractor import GPSPoint, extract_points, points_to_gpx

logging.basicConfig(level=logging.INFO)

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/tmp/dashtrack"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR = Path(__file__).parent / "static"

# In-memory job store
jobs: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(_cleanup_loop())
    try:
        from scanner import scan_footage_dir, watch_footage_dir

        asyncio.create_task(scan_footage_dir())
        asyncio.create_task(watch_footage_dir())
    except Exception as e:
        logging.warning("Library scanner unavailable: %s", e)
    yield


app = FastAPI(title="DashTrack", version="2.0.0", docs_url="/api/docs", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["*"])

try:
    from routers.library import router as library_router

    app.include_router(library_router)
except Exception as e:
    logging.warning("Library router unavailable: %s", e)


# ── HEALTH ────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok"}


# ── CLIENT CONFIG (runtime secrets) ──────────────────────────
@app.get("/api/config")
async def config():
    return {"mapboxToken": os.getenv("VITE_MAPBOX_TOKEN", "")}


# ── START EXTRACTION JOB ──────────────────────────────────────
@app.post("/api/extract/start")
async def extract_start(file: UploadFile = File(...)):
    suffix = Path(file.filename or "video.mp4").suffix.lower()
    if suffix not in (".mp4", ".mov", ".avi", ".mkv"):
        raise HTTPException(400, f"Unsupported file type: {suffix}")

    job_id = str(uuid.uuid4())
    tmp_path = UPLOAD_DIR / f"{job_id}{suffix}"

    async with aiofiles.open(tmp_path, "wb") as f:
        while chunk := await file.read(2 * 1024 * 1024):
            await f.write(chunk)

    jobs[job_id] = {
        "status": "queued",
        "points_done": 0,
        "points": [],
        "gpx": None,
        "filename": file.filename,
        "tmp_path": str(tmp_path),
        "error": None,
    }

    asyncio.create_task(_run_extraction(job_id))
    return {"job_id": job_id, "file_size": tmp_path.stat().st_size}


async def _run_extraction(job_id: str):
    job = jobs[job_id]
    try:
        job["status"] = "extracting"
        loop = asyncio.get_event_loop()
        points: list[GPSPoint] = await loop.run_in_executor(
            None, lambda: list(extract_points(job["tmp_path"]))
        )
        if not points:
            job["status"] = "error"
            job["error"] = (
                "No GPS data found. Make sure this is an original unmodified "
                "Viofo clip — re-encoded or merged files lose the GPS track."
            )
            return
        job["status"] = "done"
        job["points_done"] = len(points)
        job["points"] = points
        job["gpx"] = points_to_gpx(points, source_name=job["filename"] or "dashcam")
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
    finally:
        p = Path(job["tmp_path"])
        if p.exists():
            p.unlink()


# ── WEBSOCKET PROGRESS ────────────────────────────────────────
@app.websocket("/api/ws/extract/{job_id}")
async def ws_extract(websocket: WebSocket, job_id: str):
    await websocket.accept()
    if job_id not in jobs:
        await websocket.send_json({"type": "error", "message": "Job not found"})
        await websocket.close()
        return
    try:
        while True:
            job = jobs.get(job_id)
            if not job:
                await websocket.send_json({"type": "error", "message": "Job expired"})
                break
            status = job["status"]
            if status in ("queued", "extracting"):
                await websocket.send_json(
                    {"type": "progress", "status": status, "points": job["points_done"]}
                )
                await asyncio.sleep(0.25)
            elif status == "done":
                pts = job["points"]
                await websocket.send_json(
                    {
                        "type": "done",
                        "gpx": job["gpx"],
                        "stats": {
                            "points": len(pts),
                            "duration_sec": pts[-1].video_sec if pts else 0,
                            "max_speed_kmh": round(max((p.speed_kmh for p in pts), default=0), 1),
                        },
                    }
                )
                del jobs[job_id]
                break
            elif status == "error":
                await websocket.send_json({"type": "error", "message": job["error"]})
                del jobs[job_id]
                break
    except WebSocketDisconnect:
        pass
    finally:
        await websocket.close()


# ── SERVE REACT SPA ───────────────────────────────────────────
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        return FileResponse(STATIC_DIR / "index.html")
else:

    @app.get("/")
    async def no_fe():
        return Response("Frontend not built yet. Run: npm run build", status_code=503)


async def _cleanup_loop():
    while True:
        await asyncio.sleep(600)
        for f in UPLOAD_DIR.glob("*"):
            try:
                f.unlink()
            except Exception:
                pass
