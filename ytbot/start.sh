#!/bin/sh
set -e

echo "[ytbot] Initializing container services..."

if [ "$RUN_SERVER" = "false" ]; then
    if [ -n "$BOT_TOKEN" ]; then
        echo "[ytbot] Running Telegram bot only..."
        exec python bot.py
    else
        echo "[ytbot] ERROR: RUN_SERVER is set to false but BOT_TOKEN is not configured!"
        exit 1
    fi
fi

if [ -n "$BOT_TOKEN" ]; then
    echo "[ytbot] Starting Telegram bot (bot.py) in background..."
    python bot.py &
else
    echo "[ytbot] Notice: BOT_TOKEN is not set. Telegram bot will not start until BOT_TOKEN is configured in .env."
fi

echo "[ytbot] Starting Web API server on 0.0.0.0:8080..."
exec gunicorn -w 2 -t 600 -b 0.0.0.0:8080 server:app
