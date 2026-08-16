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
| Jellyfin ¹    | `lscr.io/linuxserver/jellyfin`          | http://localhost:8096  | `http://jellyfin:8096`        |

¹ Optional — only when you run Jellyfin **on this host** via the bundled
`docker-compose.jellyfin.yml` override. If your Jellyfin is a separate box, you
connect to it instead — see [Wire it into Jellyfin](#wire-it-into-jellyfin).

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

# Running Jellyfin on THIS host too? Bring it up alongside the stack:
#   docker compose -f docker-compose.yml -f docker-compose.jellyfin.yml up -d
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

## Wire it into Jellyfin

Sonarr and Radarr do the downloading and organising; Jellyfin just needs to
**see the finished files** and get **poked to rescan** when new ones land. Three
things to set up.

### 1. Let Jellyfin see the library (shared path)

Sonarr/Radarr write final files to `${DATA_ROOT}/media` on the host
(`/data/media` inside their containers). Jellyfin has to read that exact folder.

- **Jellyfin on the same host** — easiest. Bring it up with the bundled override,
  which mounts the media read-only:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.jellyfin.yml up -d
  ```
  Inside Jellyfin the library then lives at `/media/movies` and `/media/tv`.

- **Jellyfin on another machine** — share `${DATA_ROOT}/media` over NFS or SMB,
  mount it on the Jellyfin box, and point Jellyfin at that mount. Make sure
  Jellyfin's user can read it: match the same `PUID`/`PGID`, or make the files
  group-readable.

### 2. Give Sonarr/Radarr Jellyfin-friendly names (set once)

Jellyfin identifies things by folder/file name, so a clean scheme means
near-100% correct posters and metadata. In each app under
**Settings → Media Management** (tick *Rename Episodes/Movies*, then *Show
Advanced*):

**Radarr**
- Movie Folder Format: `{Movie CleanTitle} ({Release Year}) [imdbid-{ImdbId}]`
- Standard Movie Format: `{Movie CleanTitle} ({Release Year}) [{Quality Full}]`

**Sonarr**
- Series Folder Format: `{Series TitleYear} [tvdbid-{TvdbId}]`
- Season Folder Format: `Season {season:00}`
- Standard Episode Format:
  `{Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle} [{Quality Full}]`

The `[imdbid-…]` / `[tvdbid-…]` tag in the folder is a Jellyfin feature — it
pins each item to the exact right entry so it never mis-matches a remake or a
common title. (For the fully tuned versions, the TRaSH Guides naming pages are
the reference.)

### 3. Poke Jellyfin to rescan on every import

So new episodes appear in seconds instead of waiting for a scheduled scan:

1. In **Jellyfin → Dashboard → API Keys → +**, create a key.
2. In **Sonarr → Settings → Connect → + → Emby / Jellyfin**:
   - **Host:** `jellyfin` (same-host override) or your Jellyfin IP/hostname
   - **Port:** `8096`
   - **API Key:** the key from step 1
   - **Update Library:** on; enable triggers **On Import** and **On Upgrade**
   - **Test → Save**
3. Repeat in **Radarr**.

Finally, in Jellyfin add two libraries — **Movies** → the movies path, **Shows**
→ the tv path — and switch on **Enable real-time monitoring** as a fallback.

That's the whole pipeline:

```
Prowlarr ─(indexers)→ Sonarr / Radarr ─(grab)→ qBittorrent ─(hardlink import,
Jellyfin-clean names)→ /data/media ─(Connect ping)→ Jellyfin refreshes the shelf
```

---

## Start filling the library

- **Radarr → Movies → Add New:** search a title, set Root Folder
  `/data/media/movies` and a Quality Profile, tick *Search on add*, Add.
- **Sonarr → Series → Add New:** same idea with `/data/media/tv`; choose which
  seasons to monitor.
- Track progress under **Activity → Queue**. On completion each item imports,
  hardlinks into `media/`, and pings Jellyfin.
- Tune **Quality Profiles** (Settings → Profiles) up front so you're not pulling
  40 GB remuxes onto a small disk. As a reminder from the top of this file: point
  your indexers at content you're entitled to.

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

## Media server (Jellyfin)

Setup lives in [Wire it into Jellyfin](#wire-it-into-jellyfin) above. To run
Jellyfin on this same host, use the bundled override:

```bash
docker compose -f docker-compose.yml -f docker-compose.jellyfin.yml up -d
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
