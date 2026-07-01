# Frame worker — yt-dlp + ffmpeg on a real server (Render free tier).
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp (the generic zipapp; runs on the system python3 installed above)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY server.js .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
