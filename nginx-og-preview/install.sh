#!/usr/bin/env bash
# ==============================================================================
# 🚀 Automated Installer for Nginx OpenGraph Preview (NJS) on Real Server
# ==============================================================================
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo -e "\n${BOLD}${BLUE}======================================================${NC}"
echo -e "${BOLD}${BLUE}   🚀 Installing Nginx NJS OpenGraph Preview Module   ${NC}"
echo -e "${BOLD}${BLUE}======================================================${NC}\n"

# 1. Require Root / Sudo
if [ "$EUID" -ne 0 ]; then
    echo -e "  ${RED}✖ This script must be run as root or with sudo.${NC}"
    echo -e "  Please run: ${CYAN}sudo bash install.sh${NC}\n"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 2. Detect OS & Install NJS Module
echo -e "${BLUE}[1/4] Detecting OS and installing Nginx NJS module...${NC}"

if [ -f /etc/debian_version ]; then
    echo -e "  ${GREEN}✔ Detected Debian / Ubuntu${NC}"
    apt-get update -y
    apt-get install -y nginx libnginx-mod-http-js || apt-get install -y nginx-module-njs
elif [ -f /etc/redhat-release ]; then
    echo -e "  ${GREEN}✔ Detected RHEL / CentOS / AlmaLinux / Rocky${NC}"
    dnf install -y nginx-module-njs || yum install -y nginx-module-njs
else
    echo -e "  ${YELLOW}⚠ Unknown Linux distribution. Please ensure 'nginx-module-njs' is installed manually.${NC}"
fi

# 3. Copy og_preview.js to /etc/nginx/
echo -e "\n${BLUE}[2/4] Deploying og_preview.js to /etc/nginx/...${NC}"
mkdir -p /etc/nginx
cp "$SCRIPT_DIR/og_preview.js" /etc/nginx/og_preview.js
chmod 644 /etc/nginx/og_preview.js
echo -e "  ${GREEN}✔ Installed: /etc/nginx/og_preview.js (chmod 644)${NC}"

# 4. Check if load_module is required in /etc/nginx/nginx.conf
echo -e "\n${BLUE}[3/4] Verifying NJS module loading in /etc/nginx/nginx.conf...${NC}"

if ! nginx -V 2>&1 | grep -q "with-http_js_module"; then
    if ! grep -q "ngx_http_js_module.so" /etc/nginx/nginx.conf; then
        echo -e "  ${YELLOW}Adding 'load_module modules/ngx_http_js_module.so;' to /etc/nginx/nginx.conf...${NC}"
        sed -i '1s/^/load_module modules\/ngx_http_js_module.so;\n/' /etc/nginx/nginx.conf
    else
        echo -e "  ${GREEN}✔ Module loading directive already present.${NC}"
    fi
else
    echo -e "  ${GREEN}✔ NJS module is built-in or already enabled.${NC}"
fi

# 5. Test Nginx Configuration
echo -e "\n${BLUE}[4/4] Testing Nginx configuration...${NC}"

if nginx -t; then
    echo -e "  ${GREEN}✔ Nginx syntax test passed!${NC}"
    echo -e "\n${YELLOW}Would you like to reload Nginx now? (y/N):${NC} "
    read -r response
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        systemctl reload nginx
        echo -e "  ${GREEN}✔ Nginx reloaded successfully!${NC}"
    else
        echo -e "  Skipped reload. Run ${CYAN}sudo systemctl reload nginx${NC} when ready."
    fi
else
    echo -e "  ${RED}✖ Nginx configuration test failed. Please check your config.${NC}"
    exit 1
fi

echo -e "\n${BOLD}${GREEN}======================================================${NC}"
echo -e "${BOLD}${GREEN}   🎉 Installation Complete!                          ${NC}"
echo -e "${BOLD}${GREEN}======================================================${NC}\n"

echo -e "Next Steps for your Website Config:"
echo -e "1. In your site's server block (e.g. /etc/nginx/sites-available/your-site):"
echo -e "   Include the snippets shown in ${CYAN}nginx-og-preview/og-preview.conf${NC}."
echo -e "2. Run: ${CYAN}sudo nginx -t && sudo systemctl reload nginx${NC}"
echo -e "3. Test with: ${CYAN}bash test-bot.sh https://yourdomain.com/temple/detail/1${NC}\n"
