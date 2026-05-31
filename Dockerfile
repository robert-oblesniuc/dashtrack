# ── Stage 1: Build React frontend ─────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

COPY package.json package-lock.json* ./
RUN npm install

COPY vite.config.ts tsconfig.json index.html ./
COPY src ./src

RUN npm run build
# Output: /app/frontend/dist

# ── Stage 2: Python backend + serve built frontend ─────────────
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend source
COPY main.py extractor.py db.py scanner.py ./
COPY routers/ ./routers/

# Built frontend (FastAPI will serve this as static files)
COPY --from=frontend-builder /app/frontend/dist ./static

# Upload temp dir + dashtrack data dirs
RUN mkdir -p /tmp/dashtrack /dashtrack/footage /dashtrack/data /dashtrack/gpx

VOLUME ["/dashtrack/footage", "/dashtrack/data", "/dashtrack/gpx"]

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
