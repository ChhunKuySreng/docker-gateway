#!/usr/bin/env bash
# ==============================================================================
# 🧹 Clean .DS_Store Script for macOS
# Recursively searches and deletes all .DS_Store files in the workspace
# ==============================================================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

TARGET_DIR="${1:-.}"

echo -e "\n${BOLD}${BLUE}🔍 Scanning for .DS_Store files in:${NC} $(cd "$TARGET_DIR" && pwd)\n"

# Find all .DS_Store files
COUNT=$(find "$TARGET_DIR" -name ".DS_Store" -type f | wc -l | tr -d ' ')

if [ "$COUNT" -eq 0 ]; then
    echo -e "  ${GREEN}✔ Clean! No .DS_Store files found.${NC}\n"
    exit 0
fi

echo -e "  Found ${YELLOW}${COUNT}${NC} .DS_Store file(s):"

find "$TARGET_DIR" -name ".DS_Store" -type f | while read -r file; do
    echo -e "    ${YELLOW}✖ Deleting:${NC} $file"
    rm -f "$file"
done

echo -e "\n  ${GREEN}🎉 Successfully removed all ${COUNT} .DS_Store file(s)!${NC}\n"
