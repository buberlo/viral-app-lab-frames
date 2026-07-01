# viral-app-lab-frames

A tiny no-dependency Node service that runs **yt-dlp + ffmpeg** to turn a
short-form video URL into base64 frames. Used by [Viral App Lab] for
whole-video vision on its hosted (serverless) deployment.

## API
- `GET /` → health check
- `POST /frames` `{ "url": "...", "maxFrames": 6 }` →
  `{ "frames": ["<base64 jpg>", …], "durationSec": 8, "frameCount": 6 }`
  (send `Authorization: Bearer <WORKER_SECRET>` when that env var is set;
  only TikTok / YouTube / Instagram / X URLs are accepted).

## Deploy (Render, free)
**New → Blueprint → pick this repo → Apply** (builds `Dockerfile` on the free
plan, generates a `WORKER_SECRET`). Then copy the service URL + `WORKER_SECRET`
into the app's `FRAME_WORKER_URL` / `FRAME_WORKER_SECRET`.

Free-tier: spins down after ~15 min idle (~30–60s cold start); to avoid it, point
a free uptime pinger (cron-job.org / UptimeRobot) at `GET /` every ~10 min. Some
platforms (esp. TikTok) may rate-limit a datacenter IP — the app falls back to the
cover frame when a download fails.
