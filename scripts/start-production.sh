#!/usr/bin/env bash
set -euo pipefail

# Starts Smartico Bridge for a lightweight single-server deployment.
# Debian-only server bootstrap is included: if Docker or the Compose plugin is
# missing, the script installs them from Docker's official apt repository.
#
# Intended use on the server:
#   cd /opt/smartico-bridge
#   ./scripts/start-production.sh
#
# Optional environment overrides:
#   PORT=3001 ./scripts/start-production.sh
#   COMPOSE_PROJECT_NAME=smartico-bridge ./scripts/start-production.sh

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3001}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-smartico-bridge}"

cd "$APP_DIR"

install_docker_debian() {
  if [ ! -r /etc/os-release ]; then
    echo "Cannot detect OS. This script only auto-installs Docker on Debian." >&2
    exit 1
  fi

  . /etc/os-release
  if [ "${ID:-}" != "debian" ]; then
    echo "Detected '${ID:-unknown}'. This script only auto-installs Docker on Debian." >&2
    exit 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Docker installation requires root or sudo." >&2
    exit 1
  fi

  echo "Installing Docker Engine and Docker Compose plugin for Debian..."

  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings

  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL "https://download.docker.com/linux/debian/gpg" \
      | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

  $SUDO apt-get update
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker

  if [ -n "$SUDO" ]; then
    $SUDO usermod -aG docker "$USER" || true
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  install_docker_debian
fi

if ! docker compose version >/dev/null 2>&1; then
  install_docker_debian
fi

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    echo "Docker is installed, but this user cannot access the Docker daemon." >&2
    echo "Log out and back in, or run this script with sudo." >&2
    exit 1
  fi
fi

if [ ! -f .env ]; then
  cat > .env <<ENV
PORT=${PORT}
DATA_DIR=./data
ENV
  chmod 600 .env
  echo "Created .env with PORT=${PORT} and DATA_DIR=./data"
fi

mkdir -p \
  data/datasets \
  data/pipelines \
  data/dropzones \
  data/assets \
  uploads

export COMPOSE_PROJECT_NAME

"${DOCKER[@]}" compose up -d --build

echo "Waiting for Smartico Bridge health check..."
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Smartico Bridge is running on http://127.0.0.1:${PORT}"
    exit 0
  fi
  sleep 2
done

echo "Smartico Bridge did not pass health check. Recent logs:" >&2
"${DOCKER[@]}" compose logs --tail=80 smartico-bridge >&2
exit 1
