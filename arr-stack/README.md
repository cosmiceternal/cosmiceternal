# arr + download-client stack

A self-contained Docker Compose setup for **Prowlarr** (indexers), **Sonarr**
(TV), **Radarr** (movies), **qBittorrent** (download client), plus optional
**Bazarr** (subtitles) and **FlareSolverr** (Cloudflare solver).

Everything runs on one shared Docker network so the apps talk to each other by
name, and everything shares one `/data` mount so imports are instant hardlinks
instead of slow copies. The [debugging section](#debug-prowlarr-isnt-talking-to-sonarr)
covers the classic "Prowlarr can't reach Sonarr" problem.

> This stack is content-neutral plumbing — it's equally at home managing Usenet
> from a paid provider, public-domain films, Linux ISOs, or media you already
> own. Point it at indexers you're allowed to use, and respect copyright in your
> jurisdiction.

---

## Services at a glance

| Service       | Image                                   | Web UI (host)          | Talk to it *inside* Docker as |
|---------------|-----------------------------------------|------------------------|-------------------------------|
| Prowlarr      | `lscr.io/linuxserver/prowlarr`          | http://localhost:9696  | `http://prowlarr:9696`        |
| Sonarr        | `lscr.io/linuxserver/sonarr`            | http://localhost:8989  | `http://sonarr:8989`          |
| Radarr        | `lscr.io/linuxserver/radarr`            | http://localhost:7878  | `http://radarr:7878`          |
| qBittorrent   | `lscr.io/linuxserver/qbittorrent`       | http://localhost:8080  | `http://qbittorrent:8080`     |
| Bazarr        | `lscr.io/linuxserver/bazarr`            | http://localhost:6767  | `http://bazarr:6767`          |
| FlareSolverr  | `ghcr.io/flaresolverr/flaresolverr`     | —                      | `http://flaresolverr:8191`    |

The right-hand column is the golden rule: **from one container to another, use
the service name and the container's internal port — never `localhost`.**

---

## Quick start

```bash
cd arr-stack
cp .env.example .env          # then edit PUID/PGID/TZ (see comments in the file)

# Create the shared data tree ONCE. Everything hardlinks within here.
mkdir -p data/torrents data/media/tv data/media/movies

docker compose up -d
docker compose ps             # all should be "running"
```

Get the qBittorrent temporary admin password (recent images randomise it on
first boot):

```bash
docker logs qbittorrent 2>&1 | grep -i "temporary password"
```

Log in at http://localhost:8080 with user `admin` and that password, then set a
permanent one under **Options → Web UI**.

---

## Why one `/data` mount (don't skip this)

```
data/                     ->  mounted as /data in sonarr, radarr, qbittorrent
├── torrents/             ->  qBittorrent's default save path  (/data/torrents)
└── media/
    ├── tv/               ->  Sonarr root folder               (/data/media/tv)
    └── movies/           ->  Radarr root folder               (/data/media/movies)
```

Because all three containers see this as **one** filesystem, when Sonarr imports
a finished download it creates a **hardlink** from `torrents/` into `media/tv/`:
instant, zero extra disk, and the torrent keeps seeding. If you instead mount
`/downloads` and `/tv` as separate volumes (a very common mistake), they land on
different mounts, hardlinks become impossible, and every import turns into a slow
full copy that doubles your disk usage. Keep the single `/data` mount.

---

## First-run configuration

Do these in order. You'll copy a few **API keys** around — each app's key lives
under **Settings → General → Security → API Key**.

### 1. qBittorrent
- **Options → Downloads → Default Save Path:** `/data/torrents`
- **Options → Web UI:** set a real username/password.
- **Options → Web UI → uncheck "Enable Host header validation"** (or add
  `qbittorrent` to the whitelist). Otherwise Sonarr/Radarr connecting via the
  hostname `qbittorrent` get a **401/403** even though the credentials are right.
  This is a frequent "download client won't connect" gotcha.

### 2. Sonarr (and Radarr — identical steps with movies/)
- **Settings → Media Management → Root Folders → Add:** `/data/media/tv`
  (Radarr: `/data/media/movies`).
- **Settings → Download Clients → Add → qBittorrent:**
  - **Host:** `qbittorrent`  ← the service name, **not** `localhost`
  - **Port:** `8080`
  - **Username / Password:** what you set in step 1
  - **Category:** `tv-sonarr` (Radarr: `radarr`) — keeps downloads tidy.
  - Hit **Test** → should go green.

### 3. Prowlarr — add your indexers
- **Settings → Indexers → Add Indexer** and pick the ones you use.
- If an indexer is behind Cloudflare: **Settings → Indexers → Add a FlareSolverr
  proxy** with Host `http://flaresolverr:8191`, give it a tag, and add that tag
  to the affected indexers.

### 4. Prowlarr — connect it to Sonarr & Radarr (the part people trip on)
**Settings → Apps → Add → Sonarr:**

| Field               | Value                                   | What it means                          |
|---------------------|-----------------------------------------|----------------------------------------|
| **Sync Level**      | Full Sync                               | Push indexers automatically            |
| **Prowlarr Server** | `http://prowlarr:9696`                  | How **Sonarr** will reach Prowlarr     |
| **Sonarr Server**   | `http://sonarr:8989`                    | How **Prowlarr** will reach Sonarr     |
| **API Key**         | *Sonarr's* API key                      | Sonarr → Settings → General → API Key  |

Repeat for Radarr (`http://radarr:7878`, Radarr's API key). Hit **Test** → green.

Once the app is connected, Prowlarr pushes every indexer into Sonarr/Radarr
automatically. To force it: **Settings → Apps → Sync App Indexers** (the circular
arrows). Indexers appear under each arr's **Settings → Indexers** as
`(Prowlarr)` — you don't add indexers in Sonarr/Radarr directly anymore.

---

## Debug: "Prowlarr isn't talking to Sonarr"

Nine times out of ten it's one of the first two rows. Read the **exact** error on
the failing **Test** button first — it usually names the cause.

| Symptom / error                                            | Cause                                                              | Fix                                                                                 |
|------------------------------------------------------------|-------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| Test hangs then "Unable to connect" / connection refused   | Used `localhost` or `127.0.0.1` in the Sonarr Server field        | Use `http://sonarr:8989`. A container's `localhost` is *itself*, not Sonarr.        |
| "Name or service not known" / DNS failure                  | Containers aren't on the same user-defined network                | Ensure both are on the `arr` network (they are in this compose). Not the default bridge. |
| "Unauthorized" / 401                                        | Wrong API key (often Prowlarr's own key pasted in)                | Paste **Sonarr's** API key (Sonarr → Settings → General).                            |
| Connects but "404" / wrong path                            | Sonarr has a **URL Base** set                                     | Match it: `http://sonarr:8989/sonarr`, or clear the URL Base in Sonarr.             |
| Test is green but no indexers show up in Sonarr            | Never synced, or category mismatch                                | Hit **Sync App Indexers**; ensure indexers carry TV cats (5000) for Sonarr, movie cats (2000) for Radarr. |
| Worked before, broke after adding a VPN                    | qBittorrent (or an arr) moved behind Gluetun                      | See [VPN](#optional-route-qbittorrent-through-a-vpn-gluetun) — reach it via the `gluetun` hostname now. |

### Prove where it's broken with two commands

Run a throwaway container **on the same network** so the test doesn't depend on
what tools are baked into the images:

```bash
# 1. Does the name resolve + is Sonarr reachable + is the API key valid?
#    A JSON blob back = networking AND key are fine → your problem is a UI field.
docker run --rm --network arr curlimages/curl -sS \
  "http://sonarr:8989/api/v3/system/status?apikey=YOUR_SONARR_API_KEY"
```

- **You get JSON** → connectivity and key are good. The failing Test is a typo in
  the Prowlarr **Sonarr Server** URL or API-key field. Re-check row 1/3 above.
- **Connection refused / times out** → networking. Confirm both containers are
  up and on `arr`: `docker inspect -f '{{json .NetworkSettings.Networks}}' sonarr prowlarr`
- **`Could not resolve host: sonarr`** → DNS/network mismatch (row 2).
- **`401 Unauthorized`** → wrong API key (row 3).

```bash
# 2. Quick DNS-only check from inside Prowlarr itself:
docker exec prowlarr nslookup sonarr
```

A resolved address confirms Prowlarr can *find* Sonarr; if this fails, it's a
network problem, full stop — no amount of UI fiddling will fix it.

### Still stuck? Read the logs
```bash
docker compose logs -f prowlarr        # what Prowlarr says when it tries
docker compose logs -f sonarr          # what Sonarr sees on the other end
```

---

## Optional: route qBittorrent through a VPN (Gluetun)

Best practice for a torrent client. Add a `gluetun` service and make qBittorrent
share its network namespace. Merge this into `docker-compose.yml`:

```yaml
  gluetun:
    image: qmcgaw/gluetun
    container_name: gluetun
    cap_add: [NET_ADMIN]
    devices: [/dev/net/tun:/dev/net/tun]
    networks: [arr]
    environment:
      VPN_SERVICE_PROVIDER: your_provider     # e.g. mullvad, protonvpn, nordvpn
      VPN_TYPE: wireguard
      WIREGUARD_PRIVATE_KEY: ${WG_PRIVATE_KEY}
      WIREGUARD_ADDRESSES: ${WG_ADDRESSES}
      SERVER_COUNTRIES: ${VPN_COUNTRIES:-Netherlands}
    ports:
      - ${QBIT_WEBUI_PORT:-8080}:${QBIT_WEBUI_PORT:-8080}   # qBit UI now published HERE
    restart: unless-stopped
```

Then change the `qbittorrent` service:

```yaml
  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: qbittorrent
    restart: unless-stopped
    network_mode: "service:gluetun"   # shares Gluetun's network
    # REMOVE the qbittorrent 'networks:' and 'ports:' blocks — Gluetun owns them now
    environment:
      <<: *common-env
      WEBUI_PORT: ${QBIT_WEBUI_PORT:-8080}
    volumes:
      - ${CONFIG_ROOT:-./config}/qbittorrent:/config
      - ${DATA_ROOT:-./data}:/data
```

**Crucial:** once qBittorrent lives inside Gluetun's namespace, other containers
can no longer reach it at `http://qbittorrent:8080`. In Sonarr/Radarr change the
download-client **Host** to `gluetun`. Forgetting this is the usual "everything
broke after I added the VPN" report.

---

## Optional: add a media server

Point Jellyfin (or Plex/Emby) at `/data/media` read-only and you have the full
picture. Sketch:

```yaml
  jellyfin:
    image: lscr.io/linuxserver/jellyfin:latest
    container_name: jellyfin
    networks: [arr]
    environment:
      <<: *common-env
    volumes:
      - ${CONFIG_ROOT:-./config}/jellyfin:/config
      - ${DATA_ROOT:-./data}/media:/data/media:ro
    ports:
      - 8096:8096
    restart: unless-stopped
```

---

## Everyday commands

```bash
docker compose up -d                 # start / apply changes
docker compose pull && docker compose up -d   # update all images
docker compose logs -f sonarr        # tail one service
docker compose down                  # stop (config/ and data/ persist)
docker compose restart prowlarr      # bounce one service
```

Config and library live in `config/` and `data/` on the host, so `down` and
image updates never lose your setup.
