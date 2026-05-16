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
#   NGINX_SERVER_NAME=bridge.example.com ./scripts/start-production.sh
#   NGINX_ALLOW_CIDRS="203.0.113.10/32,198.51.100.0/24" ./scripts/start-production.sh

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3001}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-smartico-bridge}"
APP_UID="${APP_UID:-10001}"
APP_GID="${APP_GID:-10001}"
INSTALL_NGINX="${INSTALL_NGINX:-1}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-_}"
NGINX_ALLOW_CIDRS="${NGINX_ALLOW_CIDRS:-}"
# Set SETUP_HTTPS=1 and provide a real NGINX_SERVER_NAME to enable Let's Encrypt.
# Optionally set HTTPS_EMAIL for certbot (registration email).
SETUP_HTTPS="${SETUP_HTTPS:-0}"
HTTPS_EMAIL="${HTTPS_EMAIL:-}"

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

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Root privileges are required for: $*" >&2
    exit 1
  fi
}

build_nginx_allowlist() {
  # Writes allow/deny rules to stdout based on NGINX_ALLOW_CIDRS.
  if [ -n "${NGINX_ALLOW_CIDRS}" ]; then
    old_ifs="$IFS"
    IFS=","
    for cidr in ${NGINX_ALLOW_CIDRS}; do
      cidr="$(printf '%s' "$cidr" | xargs)"
      if [ -n "$cidr" ]; then
        printf 'allow %s;\n' "$cidr"
      fi
    done
    IFS="$old_ifs"
    printf 'deny all;\n'
  fi
}

install_nginx_debian() {
  if [ "${INSTALL_NGINX}" != "1" ]; then
    return
  fi

  if [ ! -r /etc/os-release ]; then
    echo "Cannot detect OS. This script only auto-installs Nginx on Debian." >&2
    exit 1
  fi

  . /etc/os-release
  if [ "${ID:-}" != "debian" ]; then
    echo "Detected '${ID:-unknown}'. This script only auto-installs Nginx on Debian." >&2
    exit 1
  fi

  if ! command -v nginx >/dev/null 2>&1; then
    echo "Installing Nginx for Debian..."
    run_as_root apt-get update
    run_as_root apt-get install -y nginx
  fi

  run_as_root install -d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled

  # Write the IP allowlist snippet (used by both HTTP and HTTPS configs).
  tmp_allowlist="$(mktemp)"
  build_nginx_allowlist > "$tmp_allowlist"
  run_as_root cp "$tmp_allowlist" /etc/nginx/snippets/smartico-bridge-allowlist.conf
  rm -f "$tmp_allowlist"

  # Deploy HTTP config first — needed for ACME http-01 challenge even when HTTPS is enabled.
  tmp_site="$(mktemp)"
  sed \
    -e "s#__SERVER_NAME__#${NGINX_SERVER_NAME}#g" \
    -e "s#__APP_PORT__#${PORT}#g" \
    deploy/nginx/smartico-bridge.http.conf > "$tmp_site"

  run_as_root cp "$tmp_site" /etc/nginx/sites-available/smartico-bridge
  rm -f "$tmp_site"

  run_as_root rm -f /etc/nginx/sites-enabled/default
  run_as_root ln -sf /etc/nginx/sites-available/smartico-bridge /etc/nginx/sites-enabled/smartico-bridge
  run_as_root nginx -t
  run_as_root systemctl enable --now nginx
  run_as_root systemctl reload nginx

  # Upgrade to HTTPS if requested and a real domain is configured.
  if [ "${SETUP_HTTPS}" = "1" ] && [ "${NGINX_SERVER_NAME}" != "_" ]; then
    setup_https_debian
  fi
}

setup_https_debian() {
  local domain="${NGINX_SERVER_NAME}"
  local cert_dir="/etc/letsencrypt/live/${domain}"

  echo "Setting up HTTPS for ${domain}..."

  # Install certbot if missing.
  if ! command -v certbot >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y certbot
  fi

  # Obtain certificate if it doesn't exist yet (skips on subsequent deploys).
  if [ ! -f "${cert_dir}/fullchain.pem" ]; then
    local email_args
    if [ -n "${HTTPS_EMAIL}" ]; then
      email_args="--email ${HTTPS_EMAIL} --no-eff-email"
    else
      email_args="--register-unsafely-without-email"
    fi
    # Use webroot; nginx is already serving /.well-known/acme-challenge/ from /var/www/html.
    run_as_root mkdir -p /var/www/html
    run_as_root certbot certonly --webroot \
      --webroot-path /var/www/html \
      --non-interactive --agree-tos \
      $email_args \
      -d "${domain}"
  else
    echo "Certificate already exists for ${domain}, skipping certbot."
    # Attempt renewal in case it's close to expiry.
    run_as_root certbot renew --quiet --no-random-sleep-on-renew 2>/dev/null || true
  fi

  # Deploy the HTTPS nginx config, substituting domain and port.
  # __ALLOW_RULES__ is replaced with the IP allowlist (or nothing for public access).
  local allow_rules
  allow_rules="$(build_nginx_allowlist)"

  tmp_site="$(mktemp)"
  sed \
    -e "s#bridge.example.com#${domain}#g" \
    -e "s#server 127.0.0.1:3001#server 127.0.0.1:${PORT}#g" \
    deploy/nginx/smartico-bridge.conf > "$tmp_site"

  run_as_root cp "$tmp_site" /etc/nginx/sites-available/smartico-bridge
  rm -f "$tmp_site"

  run_as_root nginx -t
  run_as_root systemctl reload nginx

  # Enable automatic certificate renewal (systemd timer, preferred over cron).
  run_as_root systemctl enable --now certbot.timer 2>/dev/null \
    || run_as_root systemctl enable --now snap.certbot.renew.timer 2>/dev/null \
    || true

  echo "HTTPS is active at https://${domain}"
}

if ! command -v docker >/dev/null 2>&1; then
  install_docker_debian
fi

if ! docker compose version >/dev/null 2>&1; then
  install_docker_debian
fi

install_nginx_debian

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

# These paths are bind-mounted into the container. The app runs as APP_UID/GID,
# so the host directories must be writable by that numeric user.
run_as_root chown -R "${APP_UID}:${APP_GID}" data uploads

export COMPOSE_PROJECT_NAME

# `container_name` is fixed in docker-compose.yml. If this app was previously
# started from another directory/project name, Compose cannot reuse it.
existing_container="$("${DOCKER[@]}" ps -aq --filter "name=^/smartico-bridge$")"
if [ -n "$existing_container" ]; then
  echo "Removing existing smartico-bridge container before recreate..."
  "${DOCKER[@]}" rm -f smartico-bridge
fi

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
