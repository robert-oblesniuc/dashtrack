"""
Viofo freeGPS binary extractor.
Reads GPS records embedded in Novatek/Viofo MP4 files.

Each GPS record is stored as a 'freeGPS ' block interleaved in the mdat,
one block per second. Structure (confirmed via binary inspection):

  Offset  Size  Field
  0       4     'GPS ' magic
  4       4     record size (uint32 LE, typically 0x38 = 56)
  8       4     counter (uint32 LE, increments each second)
  12      20    unknown / padding
  32      1     active: 'A' = fix, 'V' = no fix
  33      1     N/S hemisphere
  34      1     E/W hemisphere
  35      1     pad (0x00)
  36      4     latitude  (float32 LE, NMEA DDMM.MMMM)
  40      4     longitude (float32 LE, NMEA DDDMM.MMMM)
  44      4     speed (float32 LE, knots)
  48      4     bearing (float32 LE, degrees)
  52      4     altitude (float32 LE, metres — may be 0 on some firmware)
"""

import math
import struct
from collections.abc import Generator
from dataclasses import dataclass

MAGIC = b"freeGPS "
OFFSETS_TO_TRY = (32, 28, 30, 34, 36)

# Max plausible distance between two consecutive 1-second GPS samples.
# 500m ≈ 1800 km/h — generous enough for any car, catches teleportation.
MAX_JUMP_M = 500


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance in metres between two points."""
    R = 6_371_000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@dataclass
class GPSPoint:
    lat: float
    lon: float
    speed_kmh: float
    bearing: float
    alt: float | None
    video_sec: float


def _nmea_to_decimal(val: float, hemi: str) -> float:
    deg = int(val) // 100
    mins = val - deg * 100
    dec = deg + mins / 60.0
    return -dec if hemi in ("S", "W") else dec


def _parse_block(data: bytes, offset: int) -> GPSPoint | None:
    try:
        active = chr(data[offset])
        ns = chr(data[offset + 1])
        ew = chr(data[offset + 2])

        if active not in ("A", "V") or ns not in ("N", "S") or ew not in ("E", "W"):
            return None
        if active == "V":
            return None  # no GPS fix

        lat_nmea, lon_nmea, speed_kn, bearing = struct.unpack_from("<ffff", data, offset + 4)

        if not (0 <= lat_nmea <= 9000) or not (0 <= lon_nmea <= 18000):
            return None
        if lat_nmea == 0.0 and lon_nmea == 0.0:
            return None  # uninitialised coordinates, not a real fix

        lat = _nmea_to_decimal(lat_nmea, ns)
        lon = _nmea_to_decimal(lon_nmea, ew)

        alt = None
        if offset + 20 <= len(data) - 4:
            alt_raw = struct.unpack_from("<f", data, offset + 20)[0]
            if -500 <= alt_raw <= 9000:
                alt = round(alt_raw, 1)

        return GPSPoint(
            lat=round(lat, 7),
            lon=round(lon, 7),
            speed_kmh=round(speed_kn * 1.852, 2),
            bearing=round(bearing, 1),
            alt=alt,
            video_sec=0.0,  # set by caller
        )
    except (struct.error, IndexError):
        return None


def extract_points(path: str) -> Generator[GPSPoint, None, None]:
    """Scan MP4 file for freeGPS blocks and yield GPSPoint per second.

    Includes a distance gate that drops points impossibly far from the
    previous valid one (bad GPS fixes that jump to another continent).
    """
    with open(path, "rb") as f:
        content = f.read()

    pos = 0
    block_index = 0
    last_valid: GPSPoint | None = None

    while True:
        idx = content.find(MAGIC, pos)
        if idx < 0:
            break

        block_start = idx + len(MAGIC)
        block = content[block_start : block_start + 128]

        if len(block) < 40:
            pos = idx + 8
            continue

        point = None
        for try_offset in OFFSETS_TO_TRY:
            point = _parse_block(block, try_offset)
            if point is not None:
                break

        if point is not None:
            point.video_sec = round(block_index * 1.0, 3)

            # Distance gate: drop points that teleport
            if last_valid is not None:
                dist = _haversine_m(last_valid.lat, last_valid.lon, point.lat, point.lon)
                if dist > MAX_JUMP_M:
                    # Bad fix — skip this point, don't update last_valid
                    block_index += 1
                    pos = idx + 8
                    continue

            last_valid = point
            yield point
            block_index += 1

        pos = idx + 8


def points_to_gpx(points: list[GPSPoint], source_name: str = "dashcam") -> str:
    """Convert list of GPSPoints to a GPX XML string."""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="DashTrack"',
        '  xmlns="http://www.topografix.com/GPX/1/1">',
        "  <metadata>",
        "    <n>DashTrack GPS route</n>",
        f"    <desc>Extracted from {source_name}</desc>",
        "  </metadata>",
        "  <trk>",
        f"    <n>{source_name}</n>",
        "    <trkseg>",
    ]

    for p in points:
        lines.append(f'      <trkpt lat="{p.lat:.7f}" lon="{p.lon:.7f}">')
        if p.alt is not None:
            lines.append(f"        <ele>{p.alt}</ele>")
        lines.append(f"        <speed>{round(p.speed_kmh / 3.6, 3)}</speed>")
        lines.append("        <extensions>")
        lines.append(f"          <video_sec>{p.video_sec}</video_sec>")
        lines.append(f"          <bearing>{p.bearing}</bearing>")
        lines.append("        </extensions>")
        lines.append("      </trkpt>")

    lines += ["    </trkseg>", "  </trk>", "</gpx>"]
    return "\n".join(lines)
