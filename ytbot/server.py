"""
Small yt-dlp API for the Google Sheets bot.

Install:   pip install flask yt-dlp gunicorn
           (and install ffmpeg on the machine)
Run:       YTBOT_API_KEY=change-me gunicorn -w 2 -t 600 -b 0.0.0.0:8080 server:app
Then put it behind HTTPS (Tailscale Funnel, Cloudflare Tunnel, Caddy, nginx...) because
Apps Script can only call public URLs.
"""
import hmac
import os
import re
import uuid

import yt_dlp
import yt_dlp.utils._jsruntime

# Ensure Debian system node (20.x) and Deno (2.x) are accepted by yt-dlp without warnings or 403 errors
yt_dlp.utils._jsruntime.DenoJsRuntime.MIN_SUPPORTED_VERSION = (2, 0, 0)
yt_dlp.utils._jsruntime.NodeJsRuntime.MIN_SUPPORTED_VERSION = (20, 0, 0)

from flask import Flask, abort, jsonify, request, send_from_directory

API_KEY = os.environ.get("YTBOT_API_KEY") or os.environ.get("API_KEY", "")
OUT_DIR = os.path.abspath("downloads")
os.makedirs(OUT_DIR, exist_ok=True)

app = Flask(__name__)


def check_key():
    sent = request.headers.get("X-API-Key", "")
    if not API_KEY or not hmac.compare_digest(sent, API_KEY):
        abort(401)


@app.get("/")
def health_check():
    return jsonify(status="ok", service="ytbot")


@app.post("/download")
def download():
    check_key()
    data = request.get_json(force=True, silent=True) or {}
    url = str(data.get("url", "")).strip()
    kind = data.get("type", "video")
    quality = str(data.get("quality") or "")

    if not re.match(r"^https?://([a-zA-Z0-9_-]+\.)?(youtube\.com|youtu\.be)/", url):
        return jsonify(error="Only YouTube links are allowed"), 400
    if quality and not quality.isdigit():
        return jsonify(error="Quality must be a number"), 400

    job = uuid.uuid4().hex
    folder = os.path.join(OUT_DIR, job)
    opts = {
        "outtmpl": os.path.join(folder, "%(title).80s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
    }

    if kind == "audio":
        opts.update({
            "format": "bestaudio/best",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": quality or "192",
            }],
        })
    else:
        h = quality or "720"
        opts.update({
            "format": f"bv*[height<={h}]+ba/b[height<={h}]",
            "merge_output_format": "mp4",
        })

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:
        return jsonify(error=str(e)[:300]), 500

    if not os.path.exists(folder):
        return jsonify(error="Download directory not found"), 500

    files_list = [f for f in os.listdir(folder) if not f.endswith((".part", ".temp", ".ytdl"))]
    if not files_list:
        return jsonify(error="Download completed but output file not found"), 500

    filename = files_list[0]
    size = os.path.getsize(os.path.join(folder, filename))
    return jsonify(
        title=info.get("title", filename),
        filename=filename,
        size=size,
        file_path=f"/files/{job}/{filename}",
    )


@app.get("/files/<job>/<path:name>")
def files(job, name):
    # The job id is a random 32-char token, so the link is unguessable.
    if not re.fullmatch(r"[0-9a-f]{32}", job):
        abort(404)
    return send_from_directory(os.path.join(OUT_DIR, job), name, as_attachment=True)
