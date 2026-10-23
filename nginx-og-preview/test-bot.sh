#!/usr/bin/env bash
# ==============================================================================
# 🤖 Test Social Media Bot Preview Script
# Simulates Facebook, Telegram, WhatsApp, or Twitter crawler requests
# ==============================================================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

TARGET_URL="${1:-https://visitangkor.utebi.com/temple/detail/111}"
BOT_TYPE="${2:-facebook}"

case "$BOT_TYPE" in
    telegram)
        UA="TelegramBot (like TwitterBot)"
        ;;
    whatsapp)
        UA="WhatsApp/2.21.12.21 A"
        ;;
    twitter)
        UA="Twitterbot/1.0"
        ;;
    *)
        UA="facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
        ;;
esac

echo -e "\n${BOLD}${BLUE}======================================================${NC}"
echo -e "${BOLD}${BLUE}   🤖 Simulating Social Bot Request (${BOT_TYPE})      ${NC}"
echo -e "${BOLD}${BLUE}======================================================${NC}"
echo -e "Target URL:  ${CYAN}${TARGET_URL}${NC}"
echo -e "User-Agent:  ${YELLOW}${UA}${NC}\n"

RESPONSE=$(curl -s -L -A "$UA" "$TARGET_URL")

echo -e "${BOLD}Rendered Meta Tags:${NC}"
echo "$RESPONSE" | grep -E "og:title|og:description|og:image|twitter:title|twitter:image|<title>" || echo "$RESPONSE" | head -n 30

echo -e "\n${GREEN}✔ Request completed!${NC}\n"
