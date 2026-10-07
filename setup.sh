#!/usr/bin/env bash
# ==============================================================================
# 🚀 Docker Gateway Stack Setup Script for macOS / Linux
# ==============================================================================
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\n${BOLD}${BLUE}======================================================${NC}"
echo -e "${BOLD}${BLUE}   🚀 Setting up Docker Gateway Stack (macOS / Linux) ${NC}"
echo -e "${BOLD}${BLUE}======================================================${NC}\n"

# 1. Check Prerequisites
echo -e "${BLUE}[1/5] Checking prerequisites...${NC}"

if command -v docker >/dev/null 2>&1; then
    echo -e "  ${GREEN}✔ Docker is installed:${NC} $(docker --version)"
else
    echo -e "  ${RED}✖ Docker is NOT installed.${NC} Please install Docker Desktop from https://www.docker.com/products/docker-desktop/"
    exit 1
fi

if docker info >/dev/null 2>&1; then
    echo -e "  ${GREEN}✔ Docker daemon is running.${NC}"
else
    echo -e "  ${YELLOW}⚠ Docker daemon is not running.${NC} Please start Docker Desktop and run this script again."
    exit 1
fi

if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node --version)
    NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
    if [ "$NODE_MAJOR" -ge 18 ]; then
        echo -e "  ${GREEN}✔ Node.js is installed:${NC} $NODE_VER (>= 18 LTS)"
    else
        echo -e "  ${RED}✖ Node.js $NODE_VER is too old.${NC} Please upgrade to Node.js 18 LTS, 20 LTS, or 22+ (run: nvm install 20 && nvm use 20)"
        exit 1
    fi
else
    echo -e "  ${RED}✖ Node.js is NOT installed.${NC} Please install Node.js (18 LTS, 20 LTS, or 22+) from https://nodejs.org/"
    exit 1
fi

if command -v yarn >/dev/null 2>&1; then
    echo -e "  ${GREEN}✔ Yarn is installed:${NC} $(yarn --version)"
elif command -v npm >/dev/null 2>&1; then
    echo -e "  ${GREEN}✔ npm is installed:${NC} $(npm --version)"
fi

# 2. Setup .env file
echo -e "\n${BLUE}[2/5] Setting up environment configuration (.env)...${NC}"
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    if [ -f "$SCRIPT_DIR/.env.example" ]; then
        cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
        echo -e "  ${GREEN}✔ Created .env from .env.example${NC}"
        echo -e "  ${YELLOW}👉 IMPORTANT: Please open .env and set your TS_AUTHKEY.${NC}"
    else
        echo -e "  ${RED}✖ .env.example not found.${NC}"
    fi
else
    echo -e "  ${GREEN}✔ .env already exists.${NC}"
    if grep -Eq "TS_AUTHKEY=(tskey-auth-your-key-here|\"\"|''|$)" "$SCRIPT_DIR/.env"; then
        echo -e "  ${YELLOW}⚠ TS_AUTHKEY appears unset or default in .env. Please set your key for Tailscale HTTPS.${NC}"
    fi
fi

# 3. Create required folders
echo -e "\n${BLUE}[3/5] Initializing workspace directories...${NC}"
mkdir -p "$SCRIPT_DIR/html" "$SCRIPT_DIR/webapps" "$SCRIPT_DIR/projects"
touch "$SCRIPT_DIR/html/.gitkeep" "$SCRIPT_DIR/webapps/.gitkeep" "$SCRIPT_DIR/projects/.gitkeep"
echo -e "  ${GREEN}✔ html/, webapps/, and projects/ ready.${NC}"

# 4. Install Global Terminal Shortcuts into Shell Profile
echo -e "\n${BLUE}[4/5] Installing global shell shortcuts...${NC}"

SHELL_PROFILES=()
[ -f "$HOME/.zshrc" ] && SHELL_PROFILES+=("$HOME/.zshrc")
[ -f "$HOME/.bashrc" ] && SHELL_PROFILES+=("$HOME/.bashrc")
[ -f "$HOME/.bash_profile" ] && SHELL_PROFILES+=("$HOME/.bash_profile")

# If no profile exists, default to .zshrc on macOS or .bashrc on Linux
if [ ${#SHELL_PROFILES[@]} -eq 0 ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        SHELL_PROFILES+=("$HOME/.zshrc")
        touch "$HOME/.zshrc"
    else
        SHELL_PROFILES+=("$HOME/.bashrc")
        touch "$HOME/.bashrc"
    fi
fi

MARKER_START="# >>> GLOBAL_DOCKER_STACK_START >>>"
MARKER_END="# <<< GLOBAL_DOCKER_STACK_END <<<"

SHORTCUT_BLOCK="${MARKER_START}
# --- Global Docker Stack Shortcuts ---
export DOCKER_GLOBAL_DIR=\"${SCRIPT_DIR}\"

alias dwar=\"node \\\$DOCKER_GLOBAL_DIR/scripts/deploy-war.cjs\"
alias dweb=\"node \\\$DOCKER_GLOBAL_DIR/scripts/deploy-web.cjs\"
alias dzip=\"node \\\$DOCKER_GLOBAL_DIR/scripts/deploy-zip.cjs\"
alias dall=\"dwar && dzip\"
alias drm=\"node \\\$DOCKER_GLOBAL_DIR/scripts/remove-project.cjs\"
alias d-rm=\"drm\"
alias dstop=\"node \\\$DOCKER_GLOBAL_DIR/scripts/manage-project.cjs stop\"
alias d-stop=\"dstop\"
alias dstart=\"node \\\$DOCKER_GLOBAL_DIR/scripts/manage-project.cjs start\"
alias d-start=\"dstart\"

alias d-up=\"cd \\\$DOCKER_GLOBAL_DIR && docker compose up -d && cd -\"
alias d-down=\"cd \\\$DOCKER_GLOBAL_DIR && docker compose down && cd -\"
alias d-restart=\"cd \\\$DOCKER_GLOBAL_DIR && docker compose restart && cd -\"
alias d-ps=\"docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'\"
alias d-logs=\"cd \\\$DOCKER_GLOBAL_DIR && docker compose logs -f\"
${MARKER_END}"

for PROFILE in "${SHELL_PROFILES[@]}"; do
    if [ -f "$PROFILE" ]; then
        # Remove any existing block cleanly
        if grep -q "$MARKER_START" "$PROFILE"; then
            TEMP_FILE=$(mktemp)
            sed -e "/$MARKER_START/,/$MARKER_END/d" "$PROFILE" > "$TEMP_FILE"
            mv "$TEMP_FILE" "$PROFILE"
        fi
        
        # Append updated block
        echo -e "\n$SHORTCUT_BLOCK" >> "$PROFILE"
        echo -e "  ${GREEN}✔ Injected shortcuts into:${NC} $PROFILE"
    fi
done

# 5. Start Docker Containers
echo -e "\n${BLUE}[5/5] Starting Docker containers...${NC}"
cd "$SCRIPT_DIR"
docker compose up -d

echo -e "\n${BOLD}${GREEN}======================================================${NC}"
echo -e "${BOLD}${GREEN}   🎉 Setup Completed Successfully!                   ${NC}"
echo -e "${BOLD}${GREEN}======================================================${NC}\n"

echo -e "${BOLD}To start using the shortcuts in your current terminal, run:${NC}"
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -e "  ${CYAN}source ~/.zshrc${NC}\n"
else
    echo -e "  ${CYAN}source ~/.bashrc${NC}\n"
fi

echo -e "${BOLD}Available Shortcuts:${NC}"
echo -e "  ${GREEN}dweb${NC}      Deploy Web Frontend from current directory -> https://<your-app-domain>.ts.net/<project>/"
echo -e "  ${GREEN}dwar${NC}      Deploy Java WAR from current directory     -> https://<your-qa-domain>.ts.net/<app>/"
echo -e "  ${GREEN}dzip${NC}      Deploy ZIP release from current directory"
echo -e "  ${GREEN}dall${NC}      Deploy both WAR and Web frontend"
echo -e "  ${GREEN}d-up${NC}      Start all global Docker containers"
echo -e "  ${GREEN}d-down${NC}    Stop all global Docker containers"
echo -e "  ${GREEN}d-ps${NC}      View all running containers"
echo -e "  ${GREEN}d-logs${NC}    Live stream container logs\n"
