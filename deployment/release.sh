#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}       NoorNote Release Script         ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Get current version from package.json
CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
echo -e "Current version: ${YELLOW}${CURRENT_VERSION}${NC}"
echo ""

# Ask for new version
read -p "Enter new version (e.g. 0.8.0): " NEW_VERSION

if [[ -z "$NEW_VERSION" ]]; then
    echo -e "${RED}Error: Version cannot be empty${NC}"
    exit 1
fi

if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}Error: Version must be in format X.Y.Z (e.g. 0.8.0)${NC}"
    exit 1
fi

# Check that release notes file exists
NOTES_FILE="docs/release-notes-${NEW_VERSION}.md"
if [[ ! -f "$NOTES_FILE" ]]; then
    echo -e "${RED}Error: Release notes not found at ${NOTES_FILE}${NC}"
    echo -e "${RED}Generate them first with /release skill (step 1)${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}Release notes (${NOTES_FILE}):${NC}"
echo "----------------------------------------"
cat "$NOTES_FILE"
echo "----------------------------------------"
echo ""

echo -e "${YELLOW}This will:${NC}"
echo "  1. Update version in package.json, tauri.conf.json, Cargo.toml"
echo "  2. Commit version bump"
echo "  3. Merge development → main"
echo "  4. Create tag v${NEW_VERSION}"
echo "  5. Push everything to GitHub"
echo "  6. Create GitHub Release with release notes"
echo "  7. GitHub Actions builds and uploads artifacts"
echo ""
read -p "Continue? (y/n): " CONFIRM

if [[ "$CONFIRM" != "y" ]]; then
    echo "Aborted."
    exit 0
fi

echo ""
echo -e "${GREEN}[1/7] Updating version to ${NEW_VERSION}...${NC}"

# Update package.json
sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" package.json

# Update tauri.conf.json
sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" src-tauri/tauri.conf.json

# Update Cargo.toml
sed -i '' "s/^version = \"${CURRENT_VERSION}\"/version = \"${NEW_VERSION}\"/" src-tauri/Cargo.toml

echo -e "${GREEN}[2/7] Committing version bump...${NC}"
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "Bump version to ${NEW_VERSION}"

echo -e "${GREEN}[3/7] Merging development → main...${NC}"
git checkout main
git merge development

echo -e "${GREEN}[4/7] Creating tag v${NEW_VERSION}...${NC}"
git tag "v${NEW_VERSION}"

echo -e "${GREEN}[5/7] Pushing to GitHub...${NC}"
git push origin main
git push origin "v${NEW_VERSION}"

echo -e "${GREEN}[6/7] Creating GitHub Release...${NC}"
gh release create "v${NEW_VERSION}" --title "v${NEW_VERSION}" --notes-file "$NOTES_FILE"

echo -e "${GREEN}[7/7] Switching back to development...${NC}"
git checkout development

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Done!${NC}"
echo ""
echo -e "GitHub Actions is now building the release."
echo -e "Watch progress: ${YELLOW}https://github.com/77elements/noornote/actions${NC}"
echo ""
echo -e "Release will appear at:"
echo -e "${YELLOW}https://github.com/77elements/noornote/releases/tag/v${NEW_VERSION}${NC}"
echo -e "${GREEN}========================================${NC}"
