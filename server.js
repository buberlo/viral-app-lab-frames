"use strict";
/**
 * Frame worker — runs yt-dlp + ffmpeg on a real server (Render free tier) and
 * returns base64 frames spanning a short-form video. The Vercel app calls this
 * to get whole-video vision on the hosted site (serverless can't run the tools).
 *
 * POST /frames  { url, maxFrames }   -> { frames: [base64 jpg…], durationSec, frameCount }
 * GET  /        -> health check
 *
 * Auth: if WORKER_SECRET is set, requests must send Authorization: Bearer <secret>.
 * No secrets are stored; only public video URLs from known platforms are fetched.
 */
const http = require("http");
const { spawn } = require("child_process");
const { promises: fs } = require("fs");
const os = require("os");
const path = require("path");

const PORT = process.env.PORT || 8080;
const SECRET = (process.env.WORKER_SECRET || "").trim();
const YT_DLP = process.env.YT_DLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      c.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs || 120000);
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

/** Transcribe the video's audio via Groq Whisper (free tier) if a key is set. */
async function transcribe(mp4, dir) {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) return null;
  const audio = path.join(dir, "audio.mp3");
  try {
    await run(
      FFMPEG,
      ["-i", mp4, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-y", audio],
      60000
    );
    const buf = await fs.readFile(audio);
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");
    fd.append("model", process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo");
    fd.append("response_format", "text");
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 60000);
    const r = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd, signal: controller.signal }
    );
    clearTimeout(t);
    if (!r.ok) return null;
    const text = (await r.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}

function hostAllowed(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return (
      h.endsWith("tiktok.com") ||
      h.endsWith("youtube.com") ||
      h === "youtu.be" ||
      h.endsWith("instagram.com") ||
      h === "x.com" ||
      h.endsWith("twitter.com")
    );
  } catch {
    return false;
  }
}

async function extract(url, maxFrames) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fw-"));
  try {
    const out = path.join(dir, "v.%(ext)s");
    await run(
      YT_DLP,
      [
        url,
        "-f",
        "mp4/best[height<=720]/best",
        "--no-playlist",
        "--no-warnings",
        "-q",
        "--no-progress",
        "--max-filesize",
        "100M",
        "-o",
        out,
      ],
      150000
    );
    const files = await fs.readdir(dir);
    const vid = files.find((f) => f.startsWith("v."));
    if (!vid) throw new Error("Couldn't download the video.");
    const mp4 = path.join(dir, vid);

    let dur = 0;
    try {
      const p = await run(
        FFPROBE,
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4],
        15000
      );
      dur = parseFloat(p.out.trim()) || 0;
    } catch {
      /* duration optional */
    }
    const fps = dur > 0 ? Math.min(2, maxFrames / dur) : 1;
    await run(
      FFMPEG,
      [
        "-i",
        mp4,
        "-vf",
        `fps=${fps.toFixed(4)},scale=768:-1`,
        "-frames:v",
        String(maxFrames),
        "-q:v",
        "3",
        path.join(dir, "f_%03d.jpg"),
      ],
      60000
    );
    const frameFiles = (await fs.readdir(dir))
      .filter((f) => f.startsWith("f_") && f.endsWith(".jpg"))
      .sort();
    const frames = [];
    for (const f of frameFiles) {
      frames.push((await fs.readFile(path.join(dir, f))).toString("base64"));
    }
    const transcript = await transcribe(mp4, dir);
    return { frames, durationSec: Math.round(dur), frameCount: frames.length, transcript };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("frame-worker ok");
  }
  if (req.method === "POST" && req.url === "/frames") {
    if (SECRET && req.headers["authorization"] !== `Bearer ${SECRET}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { url, maxFrames } = JSON.parse(body || "{}");
        if (!url || !hostAllowed(url)) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "missing or unsupported url" }));
        }
        const n = Math.min(Math.max(parseInt(maxFrames, 10) || 6, 1), 12);
        const result = await extract(url, n);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e && e.message) || "extraction failed" }));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log(`frame-worker listening on :${PORT}`));
