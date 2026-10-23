"""
Telegram YouTube Bot (runs in Docker on your own machine).
Send a link -> Bot shows a clean, interactive selection menu -> Downloads at highest quality.
Supports both direct Telegram file uploads (<= 50MB) and instant direct links (> 50MB).
"""
import asyncio
import collections
import html
import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import yt_dlp
import yt_dlp.utils._jsruntime

# Ensure Debian system node (20.x) and Deno (2.x) are accepted by yt-dlp without warnings or 403 errors
yt_dlp.utils._jsruntime.DenoJsRuntime.MIN_SUPPORTED_VERSION = (2, 0, 0)
yt_dlp.utils._jsruntime.NodeJsRuntime.MIN_SUPPORTED_VERSION = (20, 0, 0)

from telegram import (
    BotCommand,
    ForceReply,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Update,
)
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ---------------------------------------------------------------- config
TOKEN = os.environ.get("BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
RAW_ALLOWED = os.environ.get("ALLOWED_IDS", "").strip()
ALLOW_ALL = RAW_ALLOWED == "*"
ALLOWED = {int(x) for x in RAW_ALLOWED.replace(" ", "").split(",") if x.isdigit()}
MAX_PARALLEL = int(os.environ.get("MAX_PARALLEL", "2"))
COOKIES = os.environ.get("COOKIES_FILE", "/app/cookies.txt")
MAX_BYTES = 49 * 1024 * 1024  # Telegram bot direct upload limit is 50 MB

PUBLIC_URL = (
    os.environ.get("PUBLIC_URL")
    or os.environ.get("SERVER_URL")
    or f"https://{os.environ.get('TS_HOSTNAME_YTBOT', 'local-ytbot')}.tail7fda6b.ts.net"
).rstrip("/")

OUT_DIR = Path("/app/downloads")
OUT_DIR.mkdir(parents=True, exist_ok=True)

YT_RE = re.compile(r"https?://(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)/\S+", re.I)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

log = logging.getLogger("ytbot")
SEM = asyncio.Semaphore(MAX_PARALLEL)
state = {"active": 0, "waiting": 0}

# Global Job & Queue Registries
ACTIVE_JOBS = {}  # {job_id: dict}
QUEUED_JOBS = []  # [dict, ...]
RECENT_JOBS = collections.deque(maxlen=8)
CHANNEL_CACHE = {}  # {token: {"channel": ..., "entries": [...]}}
VIDEO_CACHE = {}  # {token: {...}}
SEEN_UPDATE_IDS = collections.deque(maxlen=2000)
SEEN_MESSAGE_IDS = collections.deque(maxlen=2000)
LAST_START_TIME = {}  # {(chat_id, user_id): timestamp}


# ---------------------------------------------------------------- helpers
def clean(err) -> str:
    return ANSI_RE.sub("", str(err)).strip()[:300]


def escape_html(text: str) -> str:
    return html.escape(str(text or ""))


def extract_video_id(url: str) -> str:
    m = re.search(r"(?:v=|\/|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})", url)
    return m.group(1) if m else uuid.uuid4().hex[:10]


def format_duration(seconds) -> str:
    if not seconds:
        return "Live / Unknown"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def format_size(bytes_val: int) -> str:
    mb = bytes_val / (1024 * 1024)
    if mb < 1024:
        return f"{mb:.1f} MB"
    return f"{mb / 1024:.2f} GB"


def is_channel_or_playlist(url: str) -> bool:
    patterns = [
        r"youtube\.com/@[\w.-]+",
        r"youtube\.com/channel/[\w.-]+",
        r"youtube\.com/c/[\w.-]+",
        r"youtube\.com/user/[\w.-]+",
        r"youtube\.com/playlist\?list=[\w.-]+",
    ]
    return any(re.search(p, url, re.I) for p in patterns)


def parse_url_and_quality(text: str):
    m = YT_RE.search(text or "")
    if not m:
        return None
    raw_url = m.group(0)
    q = re.search(r"\b(\d{2,4})\b", text.replace(raw_url, " "))

    # Preserve full channel, playlist, or artist URL
    if is_channel_or_playlist(raw_url):
        return raw_url, (int(q.group(1)) if q else None)

    # Clean URL for individual video to avoid radio playlist mix 403 errors
    vid_match = re.search(r"(?:v=|\/|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})", raw_url)
    clean_url = f"https://www.youtube.com/watch?v={vid_match.group(1)}" if vid_match else raw_url
    return clean_url, (int(q.group(1)) if q else None)


async def authorized(update: Update) -> bool:
    if ALLOW_ALL:
        return True
    user = update.effective_user
    uid = user.id if user else None
    if uid in ALLOWED:
        return True
    text = (update.message.text or "") if update.message else ""
    if text.startswith(("/start", "/id")):
        await update.message.reply_text(
            f"⚠️ <b>Not authorized.</b>\nYour Telegram ID: <code>{uid}</code>\nAdd it to <code>ALLOWED_IDS</code> in .env.",
            parse_mode="HTML",
        )
    return False


async def safe_edit(msg, text: str, reply_markup: InlineKeyboardMarkup = None):
    try:
        if msg.photo:
            await msg.edit_caption(caption=text, parse_mode="HTML", reply_markup=reply_markup)
        else:
            await msg.edit_text(text=text, parse_mode="HTML", reply_markup=reply_markup)
    except Exception:
        pass


# ---------------------------------------------------------------- metadata & UI
def extract_metadata(url: str) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    if os.path.isfile(COOKIES):
        opts["cookiefile"] = COOKIES
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


def get_quality_label(height: int) -> str:
    if height >= 2160:
        return f"🎬 4K ({height}p)"
    elif height >= 1440:
        return f"🎬 2K ({height}p)"
    elif height >= 1080:
        return f"🎬 1080p FHD"
    elif height >= 720:
        return f"🎬 720p HD"
    elif height >= 480:
        return f"🎬 480p SD"
    elif height >= 360:
        return f"🎬 360p"
    elif height >= 240:
        return f"🎬 240p"
    return f"🎬 {height}p"


def build_selection_keyboard(token: str, available_heights: list = None) -> InlineKeyboardMarkup:
    # Filter valid unique heights and pick top options (max 6 to keep it clean)
    valid_heights = [h for h in (available_heights or []) if h >= 240]
    if not valid_heights and available_heights:
        valid_heights = available_heights[:4]
    
    # Fallback to standard if no heights extracted
    if not valid_heights:
        valid_heights = [1080, 720, 480]

    valid_heights = valid_heights[:6]
    keyboard = []

    # Display video buttons 2 per row
    for i in range(0, len(valid_heights), 2):
        row = []
        h1 = valid_heights[i]
        row.append(InlineKeyboardButton(get_quality_label(h1), callback_data=f"dl:v:{h1}:{token}"))
        if i + 1 < len(valid_heights):
            h2 = valid_heights[i + 1]
            row.append(InlineKeyboardButton(get_quality_label(h2), callback_data=f"dl:v:{h2}:{token}"))
        keyboard.append(row)

    # Audio buttons
    keyboard.append([
        InlineKeyboardButton("🎵 MP3 320k (Highest)", callback_data=f"dl:a:320:{token}"),
        InlineKeyboardButton("🎵 MP3 192k", callback_data=f"dl:a:192:{token}"),
    ])

    # Cancel button
    keyboard.append([
        InlineKeyboardButton("❌ Cancel", callback_data=f"cancel:{token}"),
    ])

    return InlineKeyboardMarkup(keyboard)


def build_error_keyboard(token: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("🔄 Try Again", callback_data=f"retry:{token}"),
            InlineKeyboardButton("🎞️ Select Other Quality", callback_data=f"menu:{token}"),
        ],
        [
            InlineKeyboardButton("🎵 Try MP3 Audio", callback_data=f"dl:a:320:{token}"),
            InlineKeyboardButton("❌ Dismiss", callback_data=f"dismiss:{token}"),
        ]
    ])


def extract_channel_videos(url: str, limit: int = 15) -> dict:
    target_url = url
    if re.search(r"youtube\.com/@[\w.-]+/?$", url, re.I) or re.search(r"youtube\.com/channel/[\w.-]+/?$", url, re.I):
        target_url = url.rstrip("/") + "/videos"

    opts = {
        "extract_flat": "in_playlist",
        "playlist_items": f"1:{limit}",
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
    }
    if os.path.isfile(COOKIES):
        opts["cookiefile"] = COOKIES
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(target_url, download=False)


def build_channel_keyboard(token: str, count: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton(f"📥 Download All Videos ({count})", callback_data=f"ch_dl:v:{token}"),
            InlineKeyboardButton(f"🎵 Download All MP3 ({count})", callback_data=f"ch_dl:a:{token}"),
        ],
        [
            InlineKeyboardButton("📋 View Queue", callback_data="refresh_queue"),
            InlineKeyboardButton("❌ Cancel", callback_data=f"cancel:{token}"),
        ]
    ])


class UploadProgressReader(io.BufferedReader):
    def __init__(self, raw, total_bytes, callback):
        super().__init__(raw)
        self.total = total_bytes
        self.callback = callback
        self.uploaded = 0

    def read(self, size=-1):
        chunk = super().read(size)
        if chunk:
            self.uploaded += len(chunk)
            self.callback(self.uploaded, self.total)
        return chunk


def format_queue_dashboard(for_chat_id=None) -> str:
    active_count = len(ACTIVE_JOBS)
    queued_count = len(QUEUED_JOBS)

    text = [
        "📋 <b>Download Queue Manager</b>",
        f"⚡ <b>Slots:</b> <code>{active_count}/{MAX_PARALLEL} active</code> • ⏳ <b>Waiting in queue:</b> <code>{queued_count}</code>\n"
    ]

    if ACTIVE_JOBS:
        text.append("▶️ <b>Currently Downloading / Processing:</b>")
        for i, (jid, job) in enumerate(ACTIVE_JOBS.items(), 1):
            title = escape_html(job.get("title") or "YouTube Video")
            kind = job.get("kind", "video").upper()
            q_desc = job.get("quality_desc", "")
            pct = job.get("progress_pct", 0.0)
            speed = job.get("speed_str") or "..."
            eta = job.get("eta_str") or "..."
            chat_name = escape_html(job.get("chat_title") or "Private")
            filled = min(max(int(pct / 10), 0), 10)
            bar = "█" * filled + "░" * (10 - filled)
            status_desc = job.get("status", "working").capitalize()

            text.append(
                f"{i}. 🎬 <b>{title[:45]}</b>\n"
                f"   📊 <code>{kind} • {q_desc}</code> • 📍 <i>{chat_name}</i>\n"
                f"   <code>[{bar}] {pct:.1f}%</code> • ⚡ <code>{speed}</code> (ETA: <code>{eta}</code>) • [{status_desc}]"
            )
        text.append("")

    if QUEUED_JOBS:
        text.append("⏳ <b>Waiting in Queue:</b>")
        for i, job in enumerate(QUEUED_JOBS, 1):
            title = escape_html(job.get("title") or "YouTube Video")
            kind = job.get("kind", "video").upper()
            q_desc = job.get("quality_desc", "")
            chat_name = escape_html(job.get("chat_title") or "Private")
            user = escape_html(job.get("user_name") or "User")
            text.append(
                f"#{i} • 📦 <b>{title[:45]}</b>\n"
                f"    <code>{kind} • {q_desc}</code> • 👤 <i>{user}</i> (📍 <i>{chat_name}</i>)"
            )
        text.append("")

    if not ACTIVE_JOBS and not QUEUED_JOBS:
        text.append("✨ <i>No active or queued downloads at the moment. Send any YouTube link to start!</i>\n")

    if RECENT_JOBS:
        text.append("✅ <b>Recently Completed:</b>")
        for job in list(RECENT_JOBS)[-3:]:
            title = escape_html(job.get("title") or "YouTube Video")
            q_desc = job.get("quality_desc", "")
            text.append(f"• <code>{job.get('kind', '').upper()} {q_desc}</code> — {title[:40]}")

    return "\n".join(text)


def build_queue_keyboard(for_chat_id=None) -> InlineKeyboardMarkup:
    rows = []
    # Buttons to remove EACH individual queued download
    cancel_btns = []
    for i, job in enumerate(QUEUED_JOBS, 1):
        if for_chat_id is None or job.get("chat_id") == for_chat_id:
            cancel_btns.append(InlineKeyboardButton(f"❌ Remove #{i}", callback_data=f"cancel_q:{job['id']}"))
            if len(cancel_btns) == 2:
                rows.append(cancel_btns)
                cancel_btns = []
    if cancel_btns:
        rows.append(cancel_btns)

    # Action row: Clear All (if any queued), Refresh, Close
    action_row = []
    has_queued = any(job.get("chat_id") == for_chat_id or for_chat_id is None for job in QUEUED_JOBS)
    if has_queued:
        action_row.append(InlineKeyboardButton("🧹 Clear All Queue", callback_data="clear_all_q"))
    action_row.append(InlineKeyboardButton("🔄 Refresh", callback_data="refresh_queue"))
    action_row.append(InlineKeyboardButton("🗑️ Close", callback_data="close_queue"))
    rows.append(action_row)
    return InlineKeyboardMarkup(rows)


# ---------------------------------------------------------------- downloader
def pick_file(workdir: str) -> Path:
    files = [
        p for p in Path(workdir).iterdir()
        if p.is_file() and p.suffix not in (".part", ".ytdl", ".temp")
    ]
    if not files:
        raise RuntimeError("Download finished but no output media file was found.")
    return max(files, key=lambda p: p.stat().st_size)


def clear_dir(workdir: str):
    for p in Path(workdir).iterdir():
        if p.is_file():
            p.unlink(missing_ok=True)


def ydl_download(url: str, kind: str, quality, workdir: str, progress_hook=None) -> dict:
    opts = {
        "outtmpl": str(Path(workdir) / "%(title).80s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
    }
    if os.path.isfile(COOKIES):
        opts["cookiefile"] = COOKIES
    if progress_hook:
        opts["progress_hooks"] = [progress_hook]

    if kind == "audio":
        bitrate = str(quality) if (quality and str(quality).isdigit()) else "320"
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": bitrate,
        }]
    else:
        # Highest available video & audio if no specific height requested
        if quality and str(quality).isdigit():
            h = int(quality)
            opts["format"] = f"bv*[height<={h}]+ba/b[height<={h}]"
        else:
            opts["format"] = "bv*+ba/b"
        opts["merge_output_format"] = "mp4"

    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=True)


def run_download(url: str, kind: str, quality, workdir: str, progress_hook=None):
    clear_dir(workdir)
    info = ydl_download(url, kind, quality, workdir, progress_hook=progress_hook)
    f = pick_file(workdir)
    if kind == "audio":
        q_label = f"{quality or 320} kbps"
    else:
        height = info.get("height")
        q_label = f"{height}p" if height else (f"{quality}p" if quality else "Best / Highest")
    return f, info, q_label


def compress_to_fit(input_path: Path, output_path: Path, duration: int, target_mb: float = 47.0) -> bool:
    try:
        dur = duration if (duration and duration > 0) else 180
        total_bitrate = int((target_mb * 8 * 1024 * 1024) / dur)
        audio_bitrate = 128 * 1024
        video_bitrate = max(total_bitrate - audio_bitrate, 300 * 1024)

        cmd = [
            "ffmpeg", "-y", "-i", str(input_path),
            "-c:v", "libx264", "-b:v", str(video_bitrate),
            "-maxrate", str(int(video_bitrate * 1.2)),
            "-bufsize", str(int(video_bitrate * 2)),
            "-preset", "faster",
            "-c:a", "aac", "-b:a", "128k",
            str(output_path),
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0 and output_path.exists() and output_path.stat().st_size <= MAX_BYTES:
            return True
    except Exception as e:
        log.warning("Compression error: %s", e)
    return False


# ---------------------------------------------------------------- delivery
async def deliver_result(context, chat_id, kind: str, f: Path, info: dict, quality_label: str, status_msg):
    size = f.stat().st_size
    size_str = format_size(size)
    title = info.get("title") or f.stem
    uploader = info.get("uploader") or "YouTube"
    duration = int(info.get("duration") or 0)

    upload_file = f
    compressed_file = None

    # If video exceeds 50MB but is under 130MB (like a 58MB or 80MB clip),
    # automatically optimize with ffmpeg to 47MB so it delivers directly to Telegram!
    if size > MAX_BYTES and kind == "video" and size <= 130 * 1024 * 1024:
        await safe_edit(status_msg, f"⚙️ <b>Optimizing video ({size_str}) to fit Telegram 50 MB limit…</b>")
        comp_path = f.parent / f"compressed_{f.name}"
        success = await asyncio.to_thread(compress_to_fit, f, comp_path, duration)
        if success:
            upload_file = comp_path
            compressed_file = comp_path
            size = comp_path.stat().st_size
            size_str = format_size(size)

    if size <= MAX_BYTES:
        loop = asyncio.get_running_loop()
        last_upload_update = [0.0]
        start_time = [time.time()]

        def on_upload_progress(uploaded, total):
            now = time.time()
            if now - last_upload_update[0] < 1.8 and uploaded < total:
                return
            last_upload_update[0] = now
            elapsed = max(now - start_time[0], 0.1)
            speed = uploaded / elapsed
            speed_str = f"{speed / (1024*1024):.1f} MB/s" if speed else "N/A"
            rem = max(total - uploaded, 0)
            eta = int(rem / speed) if speed > 0 else 0
            eta_str = f"{eta}s" if eta else "..."

            pct = (uploaded / total * 100) if total > 0 else 0
            filled = min(max(int(pct / 10), 0), 10)
            bar = "█" * filled + "░" * (10 - filled)
            up_mb = uploaded / (1024 * 1024)
            tot_mb = total / (1024 * 1024)

            text = (
                f"📤 <b>Uploading to Telegram ({kind.upper()})…</b>\n\n"
                f"<code>[{bar}] {pct:.1f}%</code>\n"
                f"📦 <code>{up_mb:.1f} MB / {tot_mb:.1f} MB</code>\n"
                f"⚡ <code>{speed_str}</code> • ⏳ <code>ETA: {eta_str}</code>"
            )
            asyncio.run_coroutine_threadsafe(safe_edit(status_msg, text, reply_markup=None), loop)

        caption = (
            f"🎬 <b>{escape_html(title)}</b>\n"
            f"📊 <code>{escape_html(quality_label)}</code> • 📦 <code>{size_str}</code>\n"
            f"👤 <i>{escape_html(uploader)}</i>"
        )
        timeouts = dict(read_timeout=600, write_timeout=600, connect_timeout=60, pool_timeout=60)
        with open(upload_file, "rb") as raw_fh:
            progress_fh = UploadProgressReader(raw_fh, size, on_upload_progress)
            if kind == "audio":
                await context.bot.send_audio(
                    chat_id,
                    audio=progress_fh,
                    caption=caption,
                    parse_mode="HTML",
                    title=str(title)[:100],
                    performer=str(uploader)[:100],
                    duration=duration or None,
                    **timeouts,
                )
            else:
                await context.bot.send_video(
                    chat_id,
                    video=progress_fh,
                    caption=caption,
                    parse_mode="HTML",
                    supports_streaming=True,
                    duration=duration or None,
                    **timeouts,
                )
        await status_msg.delete()
        if compressed_file and compressed_file.exists():
            compressed_file.unlink(missing_ok=True)
    else:
        # File > 50 MB (and over 130MB, e.g. very long movie/livestream):
        # Save to public folder and serve direct high-speed download link
        job = uuid.uuid4().hex
        job_dir = OUT_DIR / job
        job_dir.mkdir(parents=True, exist_ok=True)
        dest_file = job_dir / f.name
        shutil.copy2(f, dest_file)

        download_url = f"{PUBLIC_URL}/files/{job}/{f.name}"
        msg_text = (
            f"🎬 <b>{escape_html(title)}</b>\n\n"
            f"👤 <b>Channel:</b> {escape_html(uploader)}\n"
            f"📊 <b>Quality:</b> {escape_html(quality_label)}\n"
            f"📦 <b>File Size:</b> {size_str}\n\n"
            f"ℹ️ <i>File exceeds Telegram's 50 MB bot upload limit.</i>\n"
            f"🚀 <b>Highest quality file is ready for direct download:</b>"
        )
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton(f"⬇️ Download {kind.upper()} ({size_str})", url=download_url)],
        ])
        await safe_edit(status_msg, msg_text, reply_markup=keyboard)


async def execute_download(context, chat_id, url: str, kind: str, quality, status_msg, meta: dict = None, chat_title: str = None, user_name: str = None):
    job_id = uuid.uuid4().hex[:8]
    quality_desc = f"{quality}p" if (quality and kind == "video") else (f"{quality}k" if quality else "Highest")
    title = (meta or {}).get("title") or "YouTube Video"
    uploader = (meta or {}).get("uploader") or ""

    job = {
        "id": job_id,
        "chat_id": chat_id,
        "chat_title": chat_title or "Direct",
        "user_name": user_name or "User",
        "url": url,
        "kind": kind,
        "quality": quality,
        "quality_desc": quality_desc,
        "title": title,
        "uploader": uploader,
        "status": "queued",
        "progress_pct": 0.0,
        "speed_str": "",
        "eta_str": "",
        "down_mb": 0.0,
        "total_mb": 0.0,
        "status_msg": status_msg,
        "cancelled": False,
    }

    QUEUED_JOBS.append(job)
    state["waiting"] = len(QUEUED_JOBS)
    pos = len(QUEUED_JOBS)

    cancel_btn = InlineKeyboardMarkup([
        [InlineKeyboardButton("❌ Remove From Queue", callback_data=f"cancel_q:{job_id}")]
    ])

    await safe_edit(
        status_msg,
        f"⏳ <b>Queued for download (Position #{pos})</b>\n\n"
        f"🎬 <b>{escape_html(title[:45])}</b>\n"
        f"📊 <code>{kind.upper()} • {quality_desc}</code>\n"
        f"<i>Waiting for a free download slot…</i>",
        reply_markup=cancel_btn,
    )

    workdir = None
    loop = asyncio.get_running_loop()
    last_update = [0.0]

    def on_progress(d):
        if d.get("status") == "downloading":
            now = time.time()
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            speed = d.get("speed") or 0
            eta = d.get("eta") or 0

            pct = (downloaded / total * 100) if total > 0 else 0
            speed_str = f"{speed / (1024*1024):.1f} MB/s" if speed else "N/A"
            eta_str = f"{int(eta)}s" if eta else "..."
            down_mb = downloaded / (1024 * 1024)
            total_mb = total / (1024 * 1024)

            # Update job state in active registry
            job["progress_pct"] = pct
            job["speed_str"] = speed_str
            job["eta_str"] = eta_str
            job["down_mb"] = down_mb
            job["total_mb"] = total_mb

            if now - last_update[0] < 1.8:
                return
            last_update[0] = now

            filled = min(max(int(pct / 10), 0), 10)
            bar = "█" * filled + "░" * (10 - filled)

            text = (
                f"⬇️ <b>Downloading {kind.upper()} ({quality_desc})…</b>\n\n"
                f"<code>[{bar}] {pct:.1f}%</code>\n"
                f"📦 <code>{down_mb:.1f} MB / {total_mb:.1f} MB</code>\n"
                f"⚡ <code>{speed_str}</code> • ⏳ <code>ETA: {eta_str}</code>"
            )
            asyncio.run_coroutine_threadsafe(safe_edit(status_msg, text, reply_markup=None), loop)

    async with SEM:
        if job in QUEUED_JOBS:
            QUEUED_JOBS.remove(job)
        state["waiting"] = len(QUEUED_JOBS)

        if job.get("cancelled"):
            await safe_edit(status_msg, "❌ <i>Download was cancelled from queue.</i>", reply_markup=None)
            return

        ACTIVE_JOBS[job_id] = job
        state["active"] = len(ACTIVE_JOBS)
        job["status"] = "downloading"
        try:
            workdir = tempfile.mkdtemp(prefix="yt_")
            await safe_edit(status_msg, f"⬇️ <b>Connecting to YouTube ({quality_desc})…</b>\n<code>[░░░░░░░░░░] 0.0%</code>", reply_markup=None)
            f, info, quality_label = await asyncio.to_thread(run_download, url, kind, quality, workdir, on_progress)
            if info.get("title"):
                job["title"] = info["title"]
            job["status"] = "uploading"
            await deliver_result(context, chat_id, kind, f, info, quality_label, status_msg)
            job["status"] = "done"
            RECENT_JOBS.append(job)
        except Exception as e:
            job["status"] = "failed"
            log.exception("Download failed")
            err_token = uuid.uuid4().hex[:12]
            VIDEO_CACHE[err_token] = {
                "url": url,
                "kind": kind,
                "quality": quality,
                "title": job.get("title") or (meta or {}).get("title") or "YouTube Video",
                "uploader": (meta or {}).get("uploader") or "",
                "heights": (meta or {}).get("heights") or [],
                "duration": (meta or {}).get("duration") or "",
            }
            err_msg = escape_html(clean(e))
            err_text = (
                f"❌ <b>Download Error:</b>\n"
                f"<code>{err_msg}</code>\n\n"
                f"💡 <i>Choose an option below to retry or select another format/quality:</i>"
            )
            await safe_edit(status_msg, err_text, reply_markup=build_error_keyboard(err_token))
        finally:
            ACTIVE_JOBS.pop(job_id, None)
            state["active"] = len(ACTIVE_JOBS)
            if workdir:
                shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------- handlers
async def on_message_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await authorized(update):
        return

    msg = update.message
    parsed = parse_url_and_quality(msg.text or "")
    if not parsed:
        return

    url, explicit_quality = parsed
    chat_title = msg.chat.title if (msg.chat and msg.chat.title) else "Direct"
    user_name = msg.from_user.first_name if msg.from_user else "User"

    # Check if user replied to a ForceReply prompt for /video or /audio
    reply_to = msg.reply_to_message
    if reply_to and reply_to.text:
        if "Audio (MP3) Download:" in reply_to.text:
            bitrate = explicit_quality or 320
            status = await msg.reply_text(f"⏳ <i>Initializing audio download ({bitrate}k)…</i>", parse_mode="HTML")
            await execute_download(context, msg.chat_id, url, "audio", bitrate, status, chat_title=chat_title, user_name=user_name)
            return
        elif "Video Download:" in reply_to.text:
            quality_desc = f"{explicit_quality}p" if explicit_quality else "Highest"
            status = await msg.reply_text(f"⏳ <i>Initializing video download ({quality_desc})…</i>", parse_mode="HTML")
            await execute_download(context, msg.chat_id, url, "video", explicit_quality, status, chat_title=chat_title, user_name=user_name)
            return

    # Check if URL is a YouTube Channel, Playlist, or Artist page
    if is_channel_or_playlist(url):
        loading = await msg.reply_text("🔍 <i>Fetching channel / artist video list…</i>", parse_mode="HTML")
        try:
            info = await asyncio.to_thread(extract_channel_videos, url, 12)
            channel_name = info.get("channel") or info.get("uploader") or info.get("title") or "YouTube Channel / Artist"
            entries = [e for e in info.get("entries", []) if e and (e.get("url") or e.get("id"))]

            if not entries:
                await safe_edit(loading, "⚠️ <i>No videos found in this channel or playlist.</i>")
                return

            token = uuid.uuid4().hex[:12]
            CHANNEL_CACHE[token] = {
                "channel": channel_name,
                "url": url,
                "entries": entries,
            }

            text = [
                f"📺 <b>Channel / Artist: {escape_html(channel_name)}</b>",
                f"📁 <b>Found {len(entries)} recent videos</b>\n",
                "<b>Latest Videos:</b>"
            ]
            for idx, entry in enumerate(entries[:8], 1):
                t = entry.get("title") or "Untitled"
                dur = format_duration(entry.get("duration"))
                text.append(f"{idx}. 🎬 <b>{escape_html(t[:40])}</b> (<code>{dur}</code>)")

            if len(entries) > 8:
                text.append(f"<i>…and {len(entries) - 8} more.</i>")

            text.append("\n<i>Choose an option below to batch-download to Telegram:</i>")
            kb = build_channel_keyboard(token, len(entries))
            await safe_edit(loading, "\n".join(text), reply_markup=kb)
        except Exception as e:
            log.exception("Channel extraction failed")
            await safe_edit(loading, f"❌ <b>Channel Error:</b> <code>{escape_html(clean(e))}</code>")
        return

    # Individual YouTube Video Handling
    loading = await msg.reply_text("🔍 <i>Fetching video details & available formats…</i>", parse_mode="HTML")

    try:
        info = await asyncio.to_thread(extract_metadata, url)
        title = info.get("title") or "YouTube Video"
        uploader = info.get("uploader") or "Unknown Creator"
        duration = format_duration(info.get("duration"))
        thumb = info.get("thumbnail")

        # Extract REAL video heights available on YouTube for this specific video
        available_heights = sorted({
            f['height'] for f in info.get('formats', [])
            if f.get('vcodec') != 'none' and f.get('height')
        }, reverse=True)

        max_res_label = f"{available_heights[0]}p" if available_heights else "Standard"

        token = uuid.uuid4().hex[:12]
        VIDEO_CACHE[token] = {
            "url": url,
            "title": title,
            "uploader": uploader,
            "heights": available_heights,
            "duration": duration,
        }

        caption = (
            f"🎬 <b>{escape_html(title)}</b>\n\n"
            f"👤 <b>Channel:</b> {escape_html(uploader)}\n"
            f"⏱ <b>Duration:</b> <code>{duration}</code> • 📺 <b>Max:</b> <code>{max_res_label}</code>\n\n"
            f"<i>Select your preferred quality below:</i>"
        )
        keyboard = build_selection_keyboard(token, available_heights)

        await loading.delete()
        if thumb:
            try:
                await msg.reply_photo(
                    photo=thumb,
                    caption=caption,
                    parse_mode="HTML",
                    reply_markup=keyboard,
                )
                return
            except Exception:
                pass
        await msg.reply_text(caption, parse_mode="HTML", reply_markup=keyboard)

    except Exception as e:
        log.exception("Metadata extraction failed")
        await safe_edit(loading, f"❌ <b>Error:</b> <code>{escape_html(clean(e))}</code>")


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    data = query.data or ""

    # Channel Batch Download Callback
    if data.startswith("ch_dl:"):
        _, kind_code, token = data.split(":")
        cached = CHANNEL_CACHE.pop(token, None)
        if not cached:
            await query.answer("Session expired. Please paste channel link again.", show_alert=True)
            return

        kind = "video" if kind_code == "v" else "audio"
        quality = None if kind == "video" else 320
        entries = cached.get("entries", [])
        channel_name = cached.get("channel", "Channel")

        chat_title = query.message.chat.title if (query.message and query.message.chat and query.message.chat.title) else "Direct"
        user_name = query.from_user.first_name if query.from_user else "User"

        await safe_edit(
            query.message,
            f"⏳ <b>Enqueuing {len(entries)} items from {escape_html(channel_name)} ({kind.upper()})…</b>\n"
            f"Files will download and upload to Telegram one-by-one.\n\n"
            f"<i>Use /queue to monitor active jobs or clear the queue.</i>",
            reply_markup=None
        )

        for e in entries:
            v_id = e.get("id") or extract_video_id(e.get("url") or "")
            v_url = f"https://www.youtube.com/watch?v={v_id}"
            v_title = e.get("title") or "YouTube Video"

            job_status = await query.message.reply_text(
                f"⏳ <b>Added to queue:</b> {escape_html(v_title[:45])}…",
                parse_mode="HTML"
            )
            asyncio.create_task(
                execute_download(
                    context,
                    query.message.chat_id,
                    v_url,
                    kind,
                    quality,
                    job_status,
                    meta={"title": v_title, "uploader": channel_name},
                    chat_title=chat_title,
                    user_name=user_name,
                )
            )
        return

    # Queue management callbacks
    if data.startswith("cancel_q:"):
        jid = data.split(":", 1)[1]
        cancelled_job = None
        for j in list(QUEUED_JOBS):
            if j["id"] == jid:
                j["cancelled"] = True
                QUEUED_JOBS.remove(j)
                cancelled_job = j
                break
        state["waiting"] = len(QUEUED_JOBS)

        if cancelled_job:
            try:
                await safe_edit(cancelled_job["status_msg"], "❌ <i>Download was cancelled from queue.</i>", reply_markup=None)
            except Exception:
                pass
            await query.answer("Job removed from queue!", show_alert=True)
            if query.message and "Download Queue Manager" in (query.message.text or ""):
                dash = format_queue_dashboard(for_chat_id=query.message.chat_id)
                kb = build_queue_keyboard(for_chat_id=query.message.chat_id)
                await safe_edit(query.message, dash, reply_markup=kb)
        else:
            await query.answer("Job is already downloading or finished.", show_alert=True)
        return

    if data == "clear_all_q":
        chat_id = query.message.chat_id if query.message else None
        cleared_count = 0
        for j in list(QUEUED_JOBS):
            if chat_id is None or j.get("chat_id") == chat_id:
                j["cancelled"] = True
                QUEUED_JOBS.remove(j)
                cleared_count += 1
                try:
                    asyncio.create_task(safe_edit(j["status_msg"], "❌ <i>Download cancelled (queue cleared).</i>", reply_markup=None))
                except Exception:
                    pass
        state["waiting"] = len(QUEUED_JOBS)
        await query.answer(f"Cleared {cleared_count} download(s) from queue!", show_alert=True)
        if query.message and "Download Queue Manager" in (query.message.text or ""):
            dash = format_queue_dashboard(for_chat_id=chat_id)
            kb = build_queue_keyboard(for_chat_id=chat_id)
            await safe_edit(query.message, dash, reply_markup=kb)
        return

    if data == "refresh_queue":
        chat_id = query.message.chat_id if query.message else None
        dash = format_queue_dashboard(for_chat_id=chat_id)
        kb = build_queue_keyboard(for_chat_id=chat_id)
        await safe_edit(query.message, dash, reply_markup=kb)
        await query.answer("Queue updated!")
        return

    if data == "close_queue":
        try:
            await query.message.delete()
        except Exception:
            await safe_edit(query.message, "🗑️ <i>Queue closed.</i>", reply_markup=None)
        return

    if data.startswith("cancel:"):
        token = data.split(":", 1)[1]
        VIDEO_CACHE.pop(token, None)
        CHANNEL_CACHE.pop(token, None)
        await safe_edit(query.message, "❌ <i>Cancelled.</i>", reply_markup=None)
        return

    if data.startswith("dismiss:"):
        token = data.split(":", 1)[1]
        VIDEO_CACHE.pop(token, None)
        try:
            await query.message.delete()
        except Exception:
            await safe_edit(query.message, "🗑️ <i>Error dismissed.</i>", reply_markup=None)
        return

    if data.startswith("retry:"):
        token = data.split(":", 1)[1]
        cached = VIDEO_CACHE.pop(token, None)
        if not cached:
            await query.answer("Session expired. Please paste the YouTube link again.", show_alert=True)
            return
        url = cached["url"]
        kind = cached.get("kind", "video")
        quality = cached.get("quality")
        quality_desc = f"{quality}p" if (quality and kind == "video") else (f"{quality}k" if quality else "Highest")
        chat_title = query.message.chat.title if (query.message and query.message.chat and query.message.chat.title) else "Direct"
        user_name = query.from_user.first_name if query.from_user else "User"

        await safe_edit(query.message, f"🔄 <b>Retrying {kind.title()} ({quality_desc})…</b>", reply_markup=None)
        await execute_download(context, query.message.chat_id, url, kind, quality, query.message, meta=cached, chat_title=chat_title, user_name=user_name)
        return

    if data.startswith("menu:"):
        token = data.split(":", 1)[1]
        cached = VIDEO_CACHE.get(token)
        if not cached:
            await query.answer("Session expired. Please paste the YouTube link again.", show_alert=True)
            return

        url = cached["url"]
        heights = cached.get("heights")
        if heights:
            new_token = uuid.uuid4().hex[:12]
            VIDEO_CACHE[new_token] = cached
            VIDEO_CACHE.pop(token, None)
            title = cached.get("title") or "YouTube Video"
            uploader = cached.get("uploader") or "Unknown Creator"
            duration = cached.get("duration") or ""
            max_res_label = f"{heights[0]}p" if heights else "Standard"
            caption = (
                f"🎬 <b>{escape_html(title)}</b>\n\n"
                f"👤 <b>Channel:</b> {escape_html(uploader)}\n"
                f"⏱ <b>Duration:</b> <code>{duration}</code> • 📺 <b>Max:</b> <code>{max_res_label}</code>\n\n"
                f"<i>Select your preferred quality below:</i>"
            )
            keyboard = build_selection_keyboard(new_token, heights)
            await safe_edit(query.message, caption, reply_markup=keyboard)
        else:
            await safe_edit(query.message, "🔍 <i>Fetching available formats…</i>", reply_markup=None)
            try:
                info = await asyncio.to_thread(extract_metadata, url)
                title = info.get("title") or "YouTube Video"
                uploader = info.get("uploader") or "Unknown Creator"
                duration = format_duration(info.get("duration"))
                available_heights = sorted({
                    f['height'] for f in info.get('formats', [])
                    if f.get('vcodec') != 'none' and f.get('height')
                }, reverse=True)
                new_token = uuid.uuid4().hex[:12]
                VIDEO_CACHE[new_token] = {
                    "url": url,
                    "title": title,
                    "uploader": uploader,
                    "heights": available_heights,
                    "duration": duration,
                }
                max_res_label = f"{available_heights[0]}p" if available_heights else "Standard"
                caption = (
                    f"🎬 <b>{escape_html(title)}</b>\n\n"
                    f"👤 <b>Channel:</b> {escape_html(uploader)}\n"
                    f"⏱ <b>Duration:</b> <code>{duration}</code> • 📺 <b>Max:</b> <code>{max_res_label}</code>\n\n"
                    f"<i>Select your preferred quality below:</i>"
                )
                keyboard = build_selection_keyboard(new_token, available_heights)
                await safe_edit(query.message, caption, reply_markup=keyboard)
            except Exception as e:
                await safe_edit(query.message, f"❌ <b>Error:</b> <code>{escape_html(clean(e))}</code>", reply_markup=None)
        return

    if not data.startswith("dl:"):
        return

    parts = data.split(":")
    if len(parts) != 4:
        return

    _, kind_code, quality_code, token = parts

    # POP token immediately so button CANNOT be clicked multiple times
    cached = VIDEO_CACHE.pop(token, None)
    if not cached:
        await query.answer("Already downloading or expired!", show_alert=True)
        return

    url = cached["url"]
    kind = "video" if kind_code == "v" else "audio"
    quality = None if quality_code == "max" else int(quality_code)
    quality_desc = f"{quality}p" if (quality and kind == "video") else (f"{quality}k" if quality else "Highest")

    chat_title = query.message.chat.title if (query.message and query.message.chat and query.message.chat.title) else "Direct"
    user_name = query.from_user.first_name if query.from_user else "User"

    # Remove keyboard immediately so user only has a single selection
    await safe_edit(query.message, f"⏳ <b>Selected: {kind.title()} ({quality_desc})</b>\nStarting download…", reply_markup=None)
    await execute_download(context, query.message.chat_id, url, kind, quality, query.message, meta=cached, chat_title=chat_title, user_name=user_name)


async def cmd_video(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await authorized(update):
        return
    parsed = parse_url_and_quality(update.message.text or "")
    if not parsed:
        prompt_text = (
            "🎬 <b>Video Download:</b>\n"
            "Please paste your YouTube link below.\n\n"
            "📋 <b>Tap to copy command:</b>\n"
            "<code>/video </code>\n\n"
            "<i>Format: <code>/video &lt;link&gt; [height]</code> (e.g. 1080, 720)</i>"
        )
        await update.message.reply_text(
            prompt_text,
            parse_mode="HTML",
            reply_markup=ForceReply(
                selective=True,
                input_field_placeholder="/video <paste link here> 1080"
            ),
        )
        return
    url, quality = parsed
    chat_title = update.effective_chat.title if (update.effective_chat and update.effective_chat.title) else "Direct"
    user_name = update.effective_user.first_name if update.effective_user else "User"
    status = await update.message.reply_text("⏳ <i>Initializing video download…</i>", parse_mode="HTML")
    await execute_download(context, update.message.chat_id, url, "video", quality, status, chat_title=chat_title, user_name=user_name)


async def cmd_audio(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await authorized(update):
        return
    parsed = parse_url_and_quality(update.message.text or "")
    if not parsed:
        prompt_text = (
            "🎵 <b>Audio (MP3) Download:</b>\n"
            "Please paste your YouTube link below.\n\n"
            "📋 <b>Tap to copy command:</b>\n"
            "<code>/audio </code>\n\n"
            "<i>Format: <code>/audio &lt;link&gt; [bitrate]</code> (e.g. 320, 192)</i>"
        )
        await update.message.reply_text(
            prompt_text,
            parse_mode="HTML",
            reply_markup=ForceReply(
                selective=True,
                input_field_placeholder="/audio <paste link here> 320"
            ),
        )
        return
    url, quality = parsed
    chat_title = update.effective_chat.title if (update.effective_chat and update.effective_chat.title) else "Direct"
    user_name = update.effective_user.first_name if update.effective_user else "User"
    status = await update.message.reply_text("⏳ <i>Initializing audio download…</i>", parse_mode="HTML")
    await execute_download(context, update.message.chat_id, url, "audio", quality, status, chat_title=chat_title, user_name=user_name)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # 1. Update ID deduplication
    if update.update_id in SEEN_UPDATE_IDS:
        log.info("[cmd_start] Dropped duplicate update_id: %s", update.update_id)
        return
    SEEN_UPDATE_IDS.append(update.update_id)

    # 2. Message ID deduplication and atomic per-user/chat debounce BEFORE ANY await
    if update.message:
        chat_id = update.effective_chat.id if update.effective_chat else 0
        user_id = update.effective_user.id if update.effective_user else 0
        msg_key = (chat_id, update.message.message_id)
        if msg_key in SEEN_MESSAGE_IDS:
            log.info("[cmd_start] Dropped duplicate message_id: %s", msg_key)
            return
        SEEN_MESSAGE_IDS.append(msg_key)

        debounce_key = (chat_id, user_id)
        now = time.time()
        last_t = LAST_START_TIME.get(debounce_key, 0)
        if now - last_t < 4.0:
            log.info("[cmd_start] Debounced rapid duplicate /start for %s (diff: %.2fs)", debounce_key, now - last_t)
            return
        LAST_START_TIME[debounce_key] = now

    if not await authorized(update):
        return

    welcome_text = (
        "🎬 <b>Welcome to YouTube Downloader Bot!</b>\n\n"
        "Simply <b>paste any YouTube link</b> (video, channel, artist, or playlist) to start!\n\n"
        "<b>⚡ Commands:</b>\n"
        "• <code>/video &lt;link&gt; [quality]</code> — Download MP4 (e.g. 1080)\n"
        "• <code>/audio &lt;link&gt; [bitrate]</code> — Download MP3 (e.g. 320)\n"
        "• <code>/queue</code> or <code>/status</code> — View & manage download queue\n"
        "• <code>/clearqueue</code> — Clear all waiting items in queue\n"
        "• <code>/id</code> — Show your Telegram ID\n\n"
        "✨ <b>No quality limits:</b> Maximum available resolution with real-time download and upload progress."
    )
    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton("📊 Queue Manager", callback_data="status_check"),
            InlineKeyboardButton("🆔 My ID", callback_data="id_check"),
        ]
    ])
    await update.message.reply_text(welcome_text, parse_mode="HTML", reply_markup=keyboard)


async def on_misc_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if query.data == "status_check":
        chat_id = query.message.chat_id if query.message else None
        dashboard = format_queue_dashboard(for_chat_id=chat_id)
        keyboard = build_queue_keyboard(for_chat_id=chat_id)
        await query.message.reply_text(dashboard, parse_mode="HTML", reply_markup=keyboard)
    elif query.data == "id_check":
        await query.message.reply_text(
            f"🆔 <b>Your Telegram ID:</b> <code>{update.effective_user.id}</code>",
            parse_mode="HTML",
        )


async def cmd_id(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(f"Your Telegram ID: <code>{update.effective_user.id}</code>", parse_mode="HTML")


async def cmd_queue(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await authorized(update):
        return
    chat_id = update.effective_chat.id if update.effective_chat else None
    dashboard = format_queue_dashboard(for_chat_id=chat_id)
    keyboard = build_queue_keyboard(for_chat_id=chat_id)
    await update.message.reply_text(dashboard, parse_mode="HTML", reply_markup=keyboard)


async def cmd_clear_queue(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await authorized(update):
        return
    chat_id = update.effective_chat.id if update.effective_chat else None
    cleared_count = 0
    for j in list(QUEUED_JOBS):
        if chat_id is None or j.get("chat_id") == chat_id:
            j["cancelled"] = True
            QUEUED_JOBS.remove(j)
            cleared_count += 1
            try:
                asyncio.create_task(safe_edit(j["status_msg"], "❌ <i>Download cancelled (queue cleared).</i>", reply_markup=None))
            except Exception:
                pass
    state["waiting"] = len(QUEUED_JOBS)
    await update.message.reply_text(f"🧹 <b>Queue cleared:</b> Removed <code>{cleared_count}</code> waiting item(s).", parse_mode="HTML")


async def on_error(update, context):
    log.error("Unhandled error: %s", context.error)


async def post_init(app: Application):
    await app.bot.set_my_commands([
        BotCommand("start", "Start the bot & show help"),
        BotCommand("video", "Direct video download (/video <link> [1080])"),
        BotCommand("audio", "Direct audio download (/audio <link> [320])"),
        BotCommand("queue", "View & manage download queue"),
        BotCommand("status", "Show active download jobs"),
        BotCommand("clearqueue", "Clear all waiting items in queue"),
        BotCommand("id", "Show your Telegram ID"),
    ])


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not TOKEN:
        log.error("BOT_TOKEN is not set! Please provide BOT_TOKEN in .env.")
        return
    if not ALLOWED and not ALLOW_ALL:
        log.warning("ALLOWED_IDS is empty: send /id to the bot, then add your ID to .env")

    app = Application.builder().token(TOKEN).concurrent_updates(True).post_init(post_init).build()

    app.add_handler(CommandHandler(["start", "help"], cmd_start))
    app.add_handler(CommandHandler("id", cmd_id))
    app.add_handler(CommandHandler(["status", "queue"], cmd_queue))
    app.add_handler(CommandHandler(["clearqueue", "clear_queue"], cmd_clear_queue))
    app.add_handler(CommandHandler("video", cmd_video))
    app.add_handler(CommandHandler("audio", cmd_audio))

    app.add_handler(CallbackQueryHandler(on_callback, pattern=r"^(dl:|cancel:|retry:|menu:|dismiss:|ch_dl:|cancel_q:|clear_all_q|refresh_queue|close_queue)"))
    app.add_handler(CallbackQueryHandler(on_misc_callback, pattern=r"^(status_check|id_check)$"))

    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message_link))
    app.add_error_handler(on_error)

    log.info("Starting Telegram Bot long-polling...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
