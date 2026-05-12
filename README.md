# Smartico Bridge

A Node.js middleware server that ingests Smartico winners CSV data, applies configurable rule sets, and feeds the results into a Figma plugin for automated design population.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Tech Stack](#tech-stack)
3. [Features](#features)
4. [Project Structure](#project-structure)
5. [Environment Variables](#environment-variables)
6. [Deployment Options](#deployment-options)
   - [Option A — Local (Node.js directly)](#option-a--local-nodejs-directly)
   - [Option B — Local (Docker / Docker Compose)](#option-b--local-docker--docker-compose)
   - [Option C — Bare-metal / Cloud VM (Ubuntu/Debian)](#option-c--bare-metal--cloud-vm-ubuntudebian)
   - [Option D — AWS Lightsail (Debian, cheapest AWS path)](#option-d--aws-lightsail-debian-cheapest-aws-path)
   - [Option E — Railway](#option-e--railway)
7. [API Reference](#api-reference)
8. [Figma Plugin](#figma-plugin)
9. [Data Persistence](#data-persistence)
10. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────┐        CSV upload / API calls
│   Smartico Platform │ ──────────────────────────────►┐
└─────────────────────┘                                 │
                                                        ▼
┌────────────────────────────────────────────────────────────┐
│                  Smartico Bridge  (server.js)               │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  Dashboard   │  │  Rule Engine │  │   Asset Store    │ │
│  │  (public/)   │  │  (rule-sets) │  │   (data/assets)  │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                 REST API  (/api/*)                   │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
          ▲                              │
          │ plugin messages              │ JSON datasets
          │ (postMessage)                ▼
┌─────────────────────────────────────────────────┐
│              Figma Plugin (figma-plugin/)        │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │  Panels: Data · Optimiser · Artworker    │   │
│  │          Animator · Asset Library        │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ (LTS) |
| Web framework | Express 4 |
| File uploads | Multer |
| CSV parsing | csv-parser |
| Persistence | JSON files on disk |
| Frontend dashboard | Vanilla HTML / CSS / JS |
| Figma integration | Figma Plugin API v1 |
| Container | Docker (Alpine-based, multi-stage) |
| Cloud PaaS (optional) | Railway |

---

## Features

- **CSV Import** — drag-and-drop or programmatic upload of Smartico winners exports
- **Dataset Management** — list, label, delete and version imported datasets
- **Rule Engine** — configurable rule sets applied per column (remap, filter, calculate)
- **Column Mapping** — map raw CSV headers to display/binding names
- **Pipelines** — named automation sequences that combine upload + processing steps
- **Drop Zones** — named targets that auto-process incoming files
- **Asset Library** — save and restore Figma node trees (frames, groups, components)
- **Profile Enrichment** — fetch player avatars from brand API endpoints
- **Image Proxy** — CORS-safe image relay for the Figma plugin canvas
- **Firewatch Widget** — real-time health dashboard at `/api/health`
- **Figma Plugin** — five-panel plugin (Data, Optimiser, Artworker, Animator, Asset Library) that pulls data from the Bridge and injects it into Figma frames

---

## Project Structure

```
smartico-bridge/
├── server.js               # Express server — all API routes and business logic
├── getProfileData.js       # Profile / avatar enrichment helper
├── package.json
│
├── public/                 # Dashboard web UI (served as static files)
│   ├── index.html
│   └── styles.css
│
├── figma-plugin/           # Active Figma plugin source (load this manifest)
│   ├── manifest.json
│   ├── code.js             # Plugin sandbox (runs in Figma)
│   └── ui.html             # Plugin iframe UI
│
├── data/                   # Persisted application data (git-ignored except seeds)
│   ├── settings-seed.json  # Committed default settings (bootstraps fresh installs)
│   ├── settings.json       # Live settings (git-ignored)
│   ├── datasets/           # One JSON file per imported dataset
│   ├── pipelines/          # Pipeline definitions
│   ├── dropzones/          # Drop-zone definitions
│   └── assets/             # Saved Figma node trees
│
├── uploads/                # Temporary CSV staging area (git-ignored)
│
├── Dockerfile              # Multi-stage Docker build
├── docker-compose.yml      # Local Docker Compose setup
├── .dockerignore
├── .env.example            # Environment variable template
├── railway.toml            # Railway deployment config
└── railway.json
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values before starting.

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port the server listens on |
| `DATA_DIR` | `./data` | Absolute or relative path to the data directory. On Railway point this at the mounted volume (e.g. `/data`). On Docker it is set to `/app/data` automatically. |

> **Railway note** — Railway injects `PORT` automatically. Do **not** set it in your Railway service variables or it will conflict with the platform's internal routing.

---

## Deployment Options

### Option A — Local (Node.js directly)

**Requirements:** Node.js 18+, npm

```bash
# 1. Clone the repo
git clone https://github.com/your-org/smartico-bridge.git
cd smartico-bridge

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env if you want a different port or data directory

# 4. Start the server
npm start
```

The server is now running at **http://localhost:3001**.

Open the dashboard in your browser:

```
http://localhost:3001
```

**Development mode** (auto-restart with nodemon, optional):

```bash
npm install -g nodemon
nodemon server.js
```

---

### Option B — Local (Docker / Docker Compose)

**Requirements:** Docker Desktop (or Docker Engine + Docker Compose plugin)

#### Quick start with Docker Compose

```bash
# 1. Clone the repo
git clone https://github.com/your-org/smartico-bridge.git
cd smartico-bridge

# 2. (Optional) copy and edit the env file
cp .env.example .env

# 3. Build and start
docker compose up -d

# 4. View logs
docker compose logs -f
```

The server is running at **http://localhost:3001**.

All data is persisted to `./data` and `./uploads` on your host machine, so it survives container restarts and rebuilds.

#### Common Docker Compose commands

```bash
# Stop the container (data is preserved)
docker compose down

# Rebuild after code changes
docker compose up -d --build

# Tail logs
docker compose logs -f smartico-bridge

# Open a shell inside the running container
docker compose exec smartico-bridge sh

# Run on a different port (e.g. 8080)
PORT=8080 docker compose up -d
```

#### Single-container run (without Compose)

```bash
# Build the image
docker build -t smartico-bridge .

# Run with host-mounted data volume
docker run -d \
  --name smartico-bridge \
  -p 3001:3001 \
  -e PORT=3001 \
  -e DATA_DIR=/app/data \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/uploads:/app/uploads" \
  --restart unless-stopped \
  smartico-bridge
```

---

### Option C — Bare-metal / Cloud VM (Ubuntu/Debian)

This covers any **VPS, EC2 instance, DigitalOcean Droplet, Linode, Hetzner**, or other Linux server where you have root/sudo access.

#### 1. Provision the server

Minimum recommended specs:

| | Minimum | Comfortable |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512 MB | 1 GB |
| Disk | 10 GB | 20 GB |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

Open **port 3001** (or 80/443 if using a reverse proxy) in your cloud provider's firewall / security group before continuing.

#### 2. Install Docker on the VM

```bash
# Update package index
sudo apt update && sudo apt upgrade -y

# Install Docker's official GPG key and repo
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
                    docker-buildx-plugin docker-compose-plugin

# Allow your user to run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker

# Verify install
docker --version
docker compose version
```

#### 3. Deploy the application

```bash
# Clone the repo (SSH or HTTPS)
git clone https://github.com/your-org/smartico-bridge.git
cd smartico-bridge

# Configure environment
cp .env.example .env
# nano .env   ← set PORT=3001 (or 80 if not using a reverse proxy)

# Build and start in detached mode
docker compose up -d --build

# Verify it's running
docker compose ps
curl http://localhost:3001/api/health
```

#### 4. (Recommended) Put Nginx in front as a reverse proxy

This gives you HTTPS via Let's Encrypt and hides the raw port from the outside world.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Create an Nginx site config
sudo tee /etc/nginx/sites-available/smartico-bridge <<'EOF'
server {
    listen 80;
    server_name your-domain.com;          # ← replace with your domain

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # Required for large CSV uploads
        client_max_body_size 25M;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/smartico-bridge \
           /etc/nginx/sites-enabled/

sudo nginx -t && sudo systemctl reload nginx

# Issue an SSL certificate
sudo certbot --nginx -d your-domain.com --non-interactive \
  --agree-tos -m your@email.com
```

Certbot auto-renews certificates. Verify with:

```bash
sudo certbot renew --dry-run
```

Your Bridge is now accessible at `https://your-domain.com`.

#### 5. Update the Figma plugin with your server URL

Open `figma-plugin/manifest.json` and add your domain to `networkAccess.allowedDomains`:

```json
"networkAccess": {
  "allowedDomains": [
    "https://your-domain.com"
  ]
}
```

Then open `figma-plugin/ui.html` and update `serverUrl` near the top of the `<script>` block:

```js
var serverUrl = 'https://your-domain.com';
```

Reload the plugin in Figma (Plugins → Development → your plugin → right-click → Reload).

#### 6. Keeping the server up to date

```bash
# Pull latest code and rebuild
cd ~/smartico-bridge
git pull
docker compose up -d --build

# Tail logs to confirm clean start
docker compose logs -f --tail=50
```

#### 7. Auto-start on VM reboot

Docker's `restart: unless-stopped` policy in `docker-compose.yml` handles this automatically, provided the Docker daemon itself starts on boot:

```bash
sudo systemctl enable docker
```

Verify after a test reboot:

```bash
sudo reboot
# — reconnect, then —
docker compose -f ~/smartico-bridge/docker-compose.yml ps
```

---

### Option D — AWS Lightsail (Debian, cheapest AWS path)

This is the recommended lightweight AWS deployment for this app. It keeps the app on one small VM with a persistent disk, which fits the current JSON-file storage model under `data/`.

#### 1. Create the Lightsail instance

Use a **Debian** Lightsail image. The startup script is intentionally Debian-only.

Recommended starting size:

| Plan | Use |
|---|---|
| 1 GB RAM | Recommended baseline for Docker + Node + Nginx |
| 512 MB RAM | May work for light testing, but has little headroom |

In the Lightsail **Networking** tab, add inbound IPv4 firewall rules:

| Port | Source | Purpose |
|---|---|---|
| `22` | Your IP/CIDR | SSH |
| `80` | `0.0.0.0/0` or your IP/CIDR | Browser access through Nginx |
| `3001` | Your IP/CIDR only, temporary | Optional direct app debugging |

Once Nginx on port `80` works, remove public access to `3001`. The app should normally be reached through Nginx.

#### 2. Install Git and clone the repo

```bash
sudo apt-get update
sudo apt-get install -y git

git clone https://github.com/your-org/smartico-bridge.git
cd smartico-bridge
```

#### 3. Start the app and deploy Nginx

The production startup script handles the Debian server setup:

- installs Docker if missing
- installs the Docker Compose plugin if missing
- installs Nginx if missing
- writes `/etc/nginx/sites-available/smartico-bridge`
- enables it under `/etc/nginx/sites-enabled/`
- writes the optional Nginx CIDR allowlist include
- starts/rebuilds the Docker Compose app
- checks `/api/health`

Public port `80` with any hostname/IP:

```bash
./scripts/start-production.sh
```

With a domain:

```bash
NGINX_SERVER_NAME=bridge.your-domain.com ./scripts/start-production.sh
```

Then open:

```text
http://YOUR_SERVER_PUBLIC_IP
```

or:

```text
http://bridge.your-domain.com
```

#### 4. Where to put CIDRs for access control

There are two places you can restrict access. Use both for defense in depth.

**Lightsail firewall CIDRs**

Set these in the AWS Lightsail console:

1. Open the Lightsail instance.
2. Go to **Networking**.
3. Under **IPv4 Firewall**, edit the source for each port.

Examples:

| Port | Source |
|---|---|
| `22` | `YOUR_OFFICE_IP/32` |
| `80` | `YOUR_OFFICE_IP/32`, or `0.0.0.0/0` if public |
| `3001` | `YOUR_OFFICE_IP/32` only, or delete this rule |

**Nginx allowlist CIDRs**

Pass CIDRs to the startup script with `NGINX_ALLOW_CIDRS`. This writes Nginx rules into:

```text
/etc/nginx/snippets/smartico-bridge-allowlist.conf
```

Example allowing one office IP and one VPN range:

```bash
NGINX_SERVER_NAME=bridge.your-domain.com \
NGINX_ALLOW_CIDRS="203.0.113.10/32,198.51.100.0/24" \
./scripts/start-production.sh
```

If `NGINX_ALLOW_CIDRS` is empty, the Nginx site is public on port `80`.

To allow only your current single public IP, use `/32`:

```bash
NGINX_ALLOW_CIDRS="YOUR_PUBLIC_IP/32" ./scripts/start-production.sh
```

To remove the Nginx allowlist and make port `80` public again:

```bash
NGINX_ALLOW_CIDRS="" ./scripts/start-production.sh
```

#### 5. Verify deployment

On the server:

```bash
docker compose ps
curl http://127.0.0.1:3001/api/health
sudo nginx -t
sudo ss -ltnp | grep -E ':80|:3001'
```

From your browser:

```text
http://YOUR_SERVER_PUBLIC_IP
```

If direct port access is needed for debugging:

```text
http://YOUR_SERVER_PUBLIC_IP:3001
```

Only use direct port `3001` when the Lightsail firewall restricts it to your IP.

#### 6. Update the Figma plugin

After choosing the final URL, update:

- `figma-plugin/ui.html` → `serverUrl`
- `figma-plugin/manifest.json` → `networkAccess.allowedDomains`

Example:

```js
var serverUrl = 'http://bridge.your-domain.com';
```

```json
"networkAccess": {
  "allowedDomains": [
    "http://bridge.your-domain.com"
  ]
}
```

For production, add HTTPS with Certbot and switch both plugin values to `https://...`.

---

### Option E — Railway

Railway is the zero-ops cloud PaaS this project was originally designed for.

1. Fork or push this repo to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Select your repo. Railway detects `railway.toml` automatically and sets the build/start commands.
4. Add a **Volume** to the service (Railway dashboard → your service → **Volumes** → **Add Volume**). Set the mount path to `/data`.
5. Set the environment variable `DATA_DIR` to `/data`.
6. Click **Deploy**.

Railway injects `PORT` automatically — do **not** set it manually in your service variables.

Your service URL (e.g. `https://smartico-bridge-production.up.railway.app`) is shown in the Railway dashboard. Update the Figma plugin with this URL as described in step 5 of the bare-metal section.

---

## API Reference

All endpoints return JSON. Replace `BASE_URL` with your deployment URL (e.g. `http://localhost:3001`).

### Datasets

| Method | Path | Description |
|---|---|---|
| `POST` | `/upload` | Upload a CSV file (`multipart/form-data`, field name `file`) |
| `GET` | `/api/datasets` | List all datasets (metadata only) |
| `GET` | `/api/datasets/:id` | Fetch a single dataset including all rows |
| `PATCH` | `/api/datasets/:id` | Update dataset label |
| `DELETE` | `/api/datasets/:id` | Delete a dataset |
| `POST` | `/api/datasets/:id/process` | Apply column mappings to a dataset |
| `POST` | `/api/datasets/:id/remap` | Re-apply a mapping set |
| `POST` | `/api/datasets/:id/enrich` | Enrich rows with player profile/avatar data |
| `POST` | `/api/datasets/:id/apply-rules` | Apply a named rule set to a dataset |

### Figma Plugin Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/figma/datasets` | Processed datasets, optimised for plugin consumption |
| `GET` | `/api/figma/datasets/:id` | Single processed dataset for the plugin |

### Settings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Read all settings (mappings, rule sets, profile API config) |
| `POST` | `/api/settings` | Save all settings |
| `GET` | `/api/settings/export` | Export settings as a downloadable JSON file |
| `POST` | `/api/settings/import` | Import settings from JSON |
| `PATCH` | `/api/settings/default-column-preset` | Set the active column preset |

### Rule Sets

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/rule-sets` | Create a rule set |
| `PATCH` | `/api/rule-sets/:id` | Update a rule set |
| `DELETE` | `/api/rule-sets/:id` | Delete a rule set |
| `POST` | `/api/apply-rules` | Evaluate rules against a provided payload |

### Mapping Sets & Column Presets

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mapping-sets` | List mapping sets |
| `POST` | `/api/mapping-sets` | Create a mapping set |
| `PATCH` | `/api/mapping-sets/:id` | Update a mapping set |
| `DELETE` | `/api/mapping-sets/:id` | Delete a mapping set |
| `POST` | `/api/mapping-sets/:id/activate` | Activate a mapping set |
| `GET` | `/api/column-presets` | List column presets |
| `POST` | `/api/column-presets` | Create a column preset |
| `PATCH` | `/api/column-presets/:id` | Update a column preset |
| `DELETE` | `/api/column-presets/:id` | Delete a column preset |

### Pipelines

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pipelines` | List all pipelines |
| `GET` | `/api/pipelines/:id` | Fetch a pipeline |
| `POST` | `/api/pipelines` | Create a pipeline |
| `PATCH` | `/api/pipelines/:id` | Update a pipeline |
| `DELETE` | `/api/pipelines/:id` | Delete a pipeline |
| `POST` | `/api/pipelines/:id/run` | Execute a pipeline (with optional CSV upload) |

### Drop Zones

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/dropzones` | List drop zones |
| `POST` | `/api/dropzones` | Create a drop zone |
| `PATCH` | `/api/dropzones/:id` | Update a drop zone |
| `DELETE` | `/api/dropzones/:id` | Delete a drop zone |

### Asset Library

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/assets` | List saved assets (metadata only) |
| `POST` | `/api/assets` | Save a new asset (full Figma node tree in request body) |
| `GET` | `/api/assets/:id` | Fetch a single asset with full node data |
| `DELETE` | `/api/assets/:id` | Delete an asset |

### Utilities

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/proxy-image?url=...` | CORS-safe image proxy for the Figma plugin |
| `GET` | `/api/plugin/download` | Download the Figma plugin as a ZIP |
| `GET` | `/api/health` | Health snapshot (uptime, dataset count, memory) |

---

## Figma Plugin

The plugin lives in `figma-plugin/`. To install it in Figma Desktop:

1. Open **Figma Desktop** (browser Figma does not support local plugin development).
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Select `figma-plugin/manifest.json`.
4. The plugin appears in your Plugins menu immediately.

The plugin talks to the Bridge server. By default `serverUrl` in `figma-plugin/ui.html` points at the Railway production URL. To switch to a local or different server, update that variable.

### Plugin Panels

| Panel | What it does |
|---|---|
| **Data** | Browse datasets, preview rows, inject data into selected Figma frames using `#column.row` layer naming |
| **Optimiser** | Compress and convert images on Figma layers; export as PNG |
| **Artworker** | Export layers as PNG/PDF with custom scale and quality settings |
| **Animator** | Preview and manage GIF animations embedded in Figma layers |
| **Asset Library** | Save full Figma frame trees to the Bridge and restore them into any document |

### Layer naming convention

Rename Figma layers using the `#column.row` pattern to bind them to dataset values:

```
#prize.1       → text / image fill from the "prize" column, row 1
#avatar.2      → image fill fetched from the URL in "avatar" column, row 2
#player_name.3 → text content from "player_name" column, row 3
##variant.1    → component swap: the instance is swapped to the component
                 whose name matches the value in "variant" column, row 1
```

---

## Data Persistence

All application data is stored as JSON files under `DATA_DIR` (default `./data`):

```
data/
├── settings.json         # Column mappings, rule sets, profile API config (git-ignored)
├── settings-seed.json    # Committed defaults — auto-restored if settings.json is missing
├── datasets/             # One file per dataset: { id, label, headers, rows, ... }
├── pipelines/            # Pipeline definitions
├── dropzones/            # Drop-zone definitions
└── assets/               # Saved Figma node trees
```

**Backup:** copy the entire `data/` directory. Restore by copying it back.

**On Railway:** attach a persistent volume at `/data` and set `DATA_DIR=/data`. Files inside the volume survive deploys and restarts.

**On Docker:** the `data/` directory is bind-mounted from the host (see `docker-compose.yml`), so data persists across container rebuilds automatically.

---

## Troubleshooting

### Server won't start — port already in use

```bash
# Find what's on port 3001
lsof -i :3001

# Kill it
kill -9 <PID>

# Or use a different port
PORT=3002 npm start
```

### Docker container exits immediately

```bash
docker compose logs smartico-bridge
```

Common causes:
- `data/` directory has wrong permissions — fix with `sudo chown -R $USER:$USER data/`
- Stale image — rebuild with `docker compose up -d --build`

### Figma plugin shows "Cannot connect to server"

1. Confirm the server is publicly reachable (not just on localhost) if Figma is running as the desktop app pointing at a remote host.
2. Check that `serverUrl` in `figma-plugin/ui.html` matches your deployment URL exactly (including `https://` or `http://`).
3. Verify the domain is listed in `figma-plugin/manifest.json` under `networkAccess.allowedDomains`.
4. The server sends `Access-Control-Allow-Origin: *` by default, which should allow all Figma origins.

### CSV upload fails with 413 error

Your reverse proxy is rejecting the upload before it reaches Node. Add to your Nginx config:

```nginx
client_max_body_size 25M;
```

Then reload Nginx: `sudo systemctl reload nginx`.

### Settings are reset after a deploy or container restart

`DATA_DIR` is not being persisted. On Railway, ensure a volume is mounted at `/data`. On Docker, ensure the `./data:/app/data` bind mount is present in `docker-compose.yml`.

If `settings.json` is missing on boot, the server auto-restores from `data/settings-seed.json`. Update that seed file and commit it to embed your default configuration in the repo.

---

## License

Internal tool — not licensed for redistribution.
