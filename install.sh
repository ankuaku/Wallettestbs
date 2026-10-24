#!/usr/bin/env bash
# =============================================================================
#  Wallet Billing installer for Ubuntu 22.04 / 24.04
#
#  Fresh install (run from the unzipped folder, as root):
#      sudo bash install.sh
#
#  Update an existing install with a new version (run from the NEW folder):
#      sudo bash install.sh --update
#
#  Options (all optional; you are asked for anything missing):
#      --domain billing.example.com   Domain for HTTPS (its DNS A record must point to this server)
#      --name "My Service"            Your business name
#      --chains bsc                   bsc (default) or bsc-testnet for testing
#      --treasury 0x...               EVM treasury address
#      --unit credits                 What you bill for
#      --price 0.002                  Price of one unit in USDT/USDC
#      --no-ssl                       No domain / HTTPS: open port 3001 instead (testing only)
#      --no-firewall                  Don't touch the firewall (ufw)
#      --skip-system                  Skip system packages, Node.js, swap, firewall and Caddy
#                                     (you already have Node.js 22.13+, PM2 and your own proxy)
#      --yes                          Don't ask questions; use options and defaults
#      --update                       Update an existing install, keep settings and data
# =============================================================================
set -Eeuo pipefail

APP_USER="app"
APP_HOME="/home/${APP_USER}"
APP_DIR="${APP_HOME}/wallet-billing"
DATA_DIR="${APP_HOME}/data"
BACKUP_DIR="${APP_HOME}/backups"
PM2_NAME="billing"
PORT="3001"
NODE_MAJOR="22"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DOMAIN="" ; SERVICE_NAME="" ; CHAINS="" ; TREASURY=""
UNIT_NAME="" ; PRICE="" ; NO_SSL=0 ; NO_FIREWALL=0 ; SKIP_SYSTEM=0 ; ASSUME_YES=0 ; UPDATE=0

# ----------------------------------------------------------------------------- output helpers
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; C=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$C$B" "$*" "$N"; }
ok()   { printf '%s  ✓ %s%s\n' "$G" "$*" "$N"; }
warn() { printf '%s  ! %s%s\n' "$Y" "$*" "$N"; }
die()  { printf '\n%sError: %s%s\n' "$R$B" "$*" "$N" >&2; exit 1; }
trap 'if [ "$BASH_SUBSHELL" -eq 0 ]; then die "the installer stopped at line $LINENO. Fix the problem above and run it again (it is safe to re-run)."; else exit 1; fi' ERR

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# ----------------------------------------------------------------------------- arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --chains) CHAINS="${2:-}"; shift 2 ;;
    --treasury) TREASURY="${2:-}"; shift 2 ;;
    --unit) UNIT_NAME="${2:-}"; shift 2 ;;
    --price) PRICE="${2:-}"; shift 2 ;;
    --no-ssl) NO_SSL=1; shift ;;
    --no-firewall) NO_FIREWALL=1; shift ;;
    --skip-system) SKIP_SYSTEM=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --update) UPDATE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (see: bash install.sh --help)" ;;
  esac
done

# ----------------------------------------------------------------------------- checks
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash install.sh"
[ -f "$SRC_DIR/backend/package.json" ] && [ -f "$SRC_DIR/site/package.json" ] || die "run this script from the unzipped wallet-billing folder."
if [ "$SKIP_SYSTEM" -eq 0 ]; then
  . /etc/os-release 2>/dev/null || true
  [ "${ID:-}" = "ubuntu" ] || warn "This installer is made for Ubuntu 22.04 / 24.04 (found: ${PRETTY_NAME:-unknown}). Continuing anyway."
fi
INTERACTIVE=0; if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then INTERACTIVE=1; fi

ask() { # ask VAR "Question" "default"
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ -n "${!__var}" ] || [ "$INTERACTIVE" -eq 0 ]; then [ -n "${!__var}" ] || printf -v "$__var" '%s' "$__def"; return; fi
  if [ -n "$__def" ]; then read -r -p "  $__q [$__def]: " __ans; else read -r -p "  $__q: " __ans; fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_valid VAR "Question" "default" checker "error message": asks again until the checker accepts (empty = skip)
ask_valid() {
  local __var="$1" __q="$2" __def="$3" __chk="$4" __msg="$5"
  while :; do
    ask "$__var" "$__q" "$__def"
    if [ -z "${!__var}" ] || "$__chk" "${!__var}"; then return 0; fi
    [ "$INTERACTIVE" -eq 1 ] || die "$__msg"
    warn "$__msg"; printf -v "$__var" '%s' ""
  done
}
clean_domain() { local d="${1#http://}"; d="${d#https://}"; d="${d%%/*}"; printf '%s' "$d"; }
is_domain() { [[ "$(clean_domain "$1")" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
is_price()  { [[ "$1" =~ ^[0-9]*\.?[0-9]+$ ]] && [[ ! "$1" =~ ^0*\.?0*$ ]]; }
is_chains() { [[ "$(echo "$1" | tr 'A-Z' 'a-z' | tr -d ' ')" =~ ^(bsc|bsc-testnet|local)$ ]]; }
is_evm()    { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }

run_as_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" PATH="$PATH" bash -c "$1"; }

# set KEY=VALUE in an .env file (replaces an existing or commented-out line, else appends)
set_env() {
  node -e '
    const fs = require("fs"); const [f, k, v] = process.argv.slice(1);
    let s = fs.readFileSync(f, "utf8");
    const re = new RegExp("^#?[ \\t]*" + k + "=.*$", "m");
    const line = k + "=" + v;
    s = re.test(s) ? s.replace(re, () => line) : s.replace(/\n*$/, "\n" + line + "\n");
    fs.writeFileSync(f, s);' "$1" "$2" "$3"
}
get_env() { # get_env FILE KEY
  [ -f "$1" ] || return 0
  grep -E "^$2=" "$1" | tail -n1 | cut -d= -f2- || true
}

# ----------------------------------------------------------------------------- questions
printf '\n%sWallet Billing installer%s\n' "$B" "$N"
EXISTING_ENV="$APP_DIR/backend/.env"
if [ -f "$EXISTING_ENV" ] && [ "$UPDATE" -eq 0 ]; then
  warn "An installation already exists in $APP_DIR. Its settings (.env) and data are kept."
  UPDATE=1
fi
[ -f "$EXISTING_ENV" ] && PORT="$(get_env "$EXISTING_ENV" PORT)" && PORT="${PORT:-3001}"

if [ "$UPDATE" -eq 0 ]; then
  echo "Answer a few questions (press Enter to accept the value in brackets)."
  if [ "$NO_SSL" -eq 0 ]; then
    ask_valid DOMAIN "Domain for the billing site (e.g. billing.yourdomain.com; leave empty to skip HTTPS)" "" is_domain "That is not a valid domain (example: billing.yourdomain.com)."
    DOMAIN="$(clean_domain "$DOMAIN")"
    [ -n "$DOMAIN" ] || NO_SSL=1
  fi
  ask SERVICE_NAME "Your business / service name" "My Service"
  # BNB Smart Chain edition: one network
  [ -n "$CHAINS" ] || CHAINS="bsc"
  CHAINS="$(echo "${CHAINS:-bsc}" | tr 'A-Z' 'a-z' | tr -d ' ')"
  ask UNIT_NAME "What do you bill for (tokens, credits, messages...)" "credits"
  ask_valid PRICE "Price of one unit (1 ${UNIT_NAME%s}) in USDT/USDC" "0.002" is_price "The price must be a number above 0, e.g. 0.002."
  PRICE="${PRICE:-0.002}"
  if [[ ",$CHAINS," =~ ,(bsc|polygon|arbitrum|base|ethereum|bsc-testnet|local), ]]; then
    ask_valid TREASURY "BNB Smart Chain treasury address that receives payments (0x..., optional now)" "" is_evm "An EVM address is 0x followed by 40 hex characters (never paste a private key)."
  fi
fi

# ----------------------------------------------------------------------------- system
if [ "$SKIP_SYSTEM" -eq 0 ]; then
  step "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null
  apt-get install -y curl ca-certificates gnupg unzip sqlite3 ufw cron openssl iproute2 >/dev/null
  ok "curl, sqlite3, ufw, cron"

  # swap on small servers (npm builds need memory)
  MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  if [ "$MEM_MB" -lt 2000 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
    step "Adding 2 GB swap (server has ${MEM_MB} MB RAM)"
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap on"
  fi

  step "Installing Node.js ${NODE_MAJOR} and PM2"
  NEED_NODE=1
  if command -v node >/dev/null 2>&1; then
    NV="$(node -p 'process.versions.node')"
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' && NEED_NODE=0 || warn "Node.js $NV is too old, upgrading"
  fi
  if [ "$NEED_NODE" -eq 1 ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  fi
  ok "Node.js $(node -v)"
  command -v pm2 >/dev/null 2>&1 || npm install -g pm2 --no-audit --no-fund >/dev/null
  ok "PM2 $(pm2 -v 2>/dev/null | tail -n1)"
else
  step "Checking Node.js and PM2 (--skip-system)"
  command -v node >/dev/null 2>&1 || die "Node.js 22.13+ is required."
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' || die "Node.js 22.13 or newer is required (found $(node -v))."
  command -v pm2 >/dev/null 2>&1 || npm install -g pm2 --no-audit --no-fund >/dev/null
  ok "Node.js $(node -v), PM2 $(pm2 -v 2>/dev/null | tail -n1)"
fi

# ----------------------------------------------------------------------------- app user and files
step "Setting up the app user and files"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$APP_USER"
  ok "created user '$APP_USER'"
fi
mkdir -p "$DATA_DIR" "$BACKUP_DIR"

if [ "$UPDATE" -eq 1 ] && [ -f "$DATA_DIR/billing.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  BK="$BACKUP_DIR/billing-before-update-$(date +%F-%H%M).db"
  sqlite3 "$DATA_DIR/billing.db" ".backup '$BK'" && ok "database backed up to $BK"
fi

if [ "$SRC_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  # copy the new files; never overwrite settings or data
  tar -C "$SRC_DIR" --exclude='./backend/.env' --exclude='*/node_modules' --exclude='*/dist' \
      --exclude='*.db' --exclude='*.db-*' -cf - . | tar -C "$APP_DIR" -xf -
  ok "files copied to $APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_HOME"

# ----------------------------------------------------------------------------- settings (.env)
ENV_FILE="$APP_DIR/backend/.env"
NEW_KEYS=0
if [ ! -f "$ENV_FILE" ]; then
  step "Creating settings (backend/.env)"
  cp "$APP_DIR/backend/.env.example" "$ENV_FILE"
  ADMIN_KEY="$(openssl rand -hex 24)"
  SERVICE_KEY="$(openssl rand -hex 24)"
  WITHDRAW_KEY="$(openssl rand -hex 12)"
  set_env "$ENV_FILE" WITHDRAW_KEY "$WITHDRAW_KEY"
  set_env "$ENV_FILE" SERVICE_NAME "$SERVICE_NAME"
  set_env "$ENV_FILE" CHAINS "$CHAINS"
  set_env "$ENV_FILE" ADMIN_KEY "$ADMIN_KEY"
  set_env "$ENV_FILE" SERVICE_API_KEY "$SERVICE_KEY"
  set_env "$ENV_FILE" UNIT_NAME "$UNIT_NAME"
  set_env "$ENV_FILE" PRICE_PER_UNIT "$PRICE"
  set_env "$ENV_FILE" DB_PATH "$DATA_DIR/billing.db"
  set_env "$ENV_FILE" PORT "$PORT"
  set_env "$ENV_FILE" TREASURY_WALLET "$TREASURY"
  NEW_KEYS=1
  ok "settings created with new random ADMIN_KEY and SERVICE_API_KEY"
else
  ok "keeping existing settings ($ENV_FILE)"
  [ -n "$(get_env "$ENV_FILE" DB_PATH)" ] || set_env "$ENV_FILE" DB_PATH "$DATA_DIR/billing.db"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

# ----------------------------------------------------------------------------- install and build
step "Installing dependencies and building (takes a few minutes)"
run_as_app "cd '$APP_DIR/backend' && npm ci --omit=dev --no-audit --no-fund --progress=false --loglevel=error"
ok "server"
run_as_app "cd '$APP_DIR/site' && npm ci --no-audit --no-fund --progress=false --loglevel=error && npm run build --silent >/dev/null"
ok "billing page"
run_as_app "cd '$APP_DIR/admin' && npm ci --no-audit --no-fund --progress=false --loglevel=error && npm run build --silent >/dev/null"
ok "admin panel"

# ----------------------------------------------------------------------------- start with PM2
step "Starting the app"
if run_as_app "pm2 describe '$PM2_NAME' >/dev/null 2>&1"; then
  run_as_app "cd '$APP_DIR/backend' && pm2 restart '$PM2_NAME' --update-env >/dev/null"
else
  run_as_app "cd '$APP_DIR/backend' && pm2 start npm --name '$PM2_NAME' -- start >/dev/null"
fi
run_as_app "pm2 save >/dev/null"
if [ -d /run/systemd/system ]; then
  env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null && ok "starts automatically after a reboot"
else
  warn "systemd not found: the app won't start by itself after a reboot (start it with: su - $APP_USER -c 'pm2 resurrect')"
fi

HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
if [ "$HEALTHY" -eq 1 ]; then ok "running on port $PORT"; else
  warn "the app didn't answer yet. Check the log: su - $APP_USER -c 'pm2 logs $PM2_NAME --lines 50'"
fi

# ----------------------------------------------------------------------------- firewall
if [ "$SKIP_SYSTEM" -eq 0 ] && [ "$NO_FIREWALL" -eq 0 ] && [ "$UPDATE" -eq 0 ]; then
  step "Firewall"
  SSH_PORTS="$(ss -tlnpH 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u)"
  [ -n "$SSH_PORTS" ] || SSH_PORTS="22"
  for p in $SSH_PORTS; do ufw allow "$p/tcp" >/dev/null; done
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  [ "$NO_SSL" -eq 0 ] || ufw allow "${PORT}/tcp" >/dev/null
  ufw --force enable >/dev/null
  ok "open: SSH ($(echo $SSH_PORTS | tr ' ' ',')), 80, 443$([ "$NO_SSL" -eq 1 ] && echo ", $PORT")"
fi

# ----------------------------------------------------------------------------- HTTPS with Caddy
if [ "$SKIP_SYSTEM" -eq 0 ] && [ "$NO_SSL" -eq 0 ] && [ -n "$DOMAIN" ]; then
  step "HTTPS for $DOMAIN (Caddy)"
  PORT80="$(ss -tlnpH '( sport = :80 )' 2>/dev/null || true)"
  if [ -n "$PORT80" ] && ! echo "$PORT80" | grep -q caddy; then
    warn "port 80 is already used by another web server:"
    echo "$PORT80" | sed 's/^/      /'
    warn "skipping Caddy. Point your web server to http://127.0.0.1:${PORT} (see README, 'Prefer Nginx?')."
  else
    if ! command -v caddy >/dev/null 2>&1; then
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -y >/dev/null && apt-get install -y caddy >/dev/null
    fi
    CF=/etc/caddy/Caddyfile
    BLOCK="$(printf '%s {\n    encode gzip\n    reverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT")"
    if [ -f "$CF" ] && grep -qE "^[[:space:]]*${DOMAIN//./\\.}[[:space:]]*\{" "$CF"; then
      ok "$DOMAIN is already in $CF"
    elif [ ! -f "$CF" ] || grep -qE '^:80[[:space:]]*\{' "$CF"; then
      [ ! -f "$CF" ] || cp "$CF" "$CF.bak-$(date +%s)"
      printf '%s\n' "$BLOCK" > "$CF"; ok "Caddyfile written"
    else
      cp "$CF" "$CF.bak-$(date +%s)"; printf '\n%s\n' "$BLOCK" >> "$CF"; ok "site added to existing Caddyfile"
    fi
    if [ -d /run/systemd/system ]; then
      systemctl enable --now caddy >/dev/null 2>&1 || true
      systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy
    else
      caddy stop >/dev/null 2>&1 || true
      caddy start --config "$CF" --adapter caddyfile >/dev/null 2>&1
    fi
    ok "Caddy running (the certificate is issued automatically on the first visit)"

    SERVER_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}' || true)"
    DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    if [ -z "$DOMAIN_IP" ]; then
      warn "$DOMAIN doesn't resolve yet. Add a DNS A record: $DOMAIN -> $SERVER_IP (HTTPS starts working a few minutes after)."
    elif [ -n "$SERVER_IP" ] && [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
      warn "$DOMAIN points to $DOMAIN_IP but this server is $SERVER_IP. Fix the DNS A record (or ignore if you use a proxy such as Cloudflare)."
    else
      ok "$DOMAIN points to this server"
    fi
  fi
fi

# ----------------------------------------------------------------------------- daily backup
if command -v crontab >/dev/null 2>&1 && command -v sqlite3 >/dev/null 2>&1; then
  CRON_LINE="15 3 * * * sqlite3 $DATA_DIR/billing.db \".backup '$BACKUP_DIR/billing-\$(date +\\%F).db'\" && find $BACKUP_DIR -name 'billing-*.db' -mtime +14 -delete"
  if ! run_as_app "crontab -l 2>/dev/null" | grep -q "$BACKUP_DIR/billing-"; then
    (run_as_app "crontab -l 2>/dev/null" || true; echo "$CRON_LINE") | crontab -u "$APP_USER" -
    ok "daily database backup at 03:15 to $BACKUP_DIR (kept 14 days)"
  fi
fi

# ----------------------------------------------------------------------------- summary
if [ -z "$DOMAIN" ] && [ "$UPDATE" -eq 1 ] && [ -f /etc/caddy/Caddyfile ]; then
  DOMAIN="$(awk -v p="127.0.0.1:${PORT}" '/^[^ \t#].*\{/ {d=$1} index($0,p) {print d; exit}' /etc/caddy/Caddyfile)"
fi
if [ -n "$DOMAIN" ] && [ "$NO_SSL" -eq 0 ]; then BASE="https://$DOMAIN"
else BASE="http://$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}' || true):$PORT"; fi

INFO="$APP_HOME/wallet-billing-access.txt"
if [ "$NEW_KEYS" -eq 1 ]; then
  {
    echo "Wallet Billing - access details (keep this file private)"
    echo "Billing page : $BASE/"
    echo "Admin panel  : $BASE/admin/"
    echo "Deploy page  : $BASE/admin/deploy.html"
    echo "ADMIN_KEY    : $ADMIN_KEY"
    echo "SERVICE_API_KEY: $SERVICE_KEY"
    echo "Withdraw page: $BASE/admin/withdraw.html  (staff password WITHDRAW_KEY: $WITHDRAW_KEY)"
    echo "Settings     : $ENV_FILE"
  } > "$INFO"
  chown "$APP_USER:$APP_USER" "$INFO"; chmod 600 "$INFO"
fi

printf '\n%s%s Wallet Billing is %s %s\n\n' "$G$B" "✓" "$([ "$UPDATE" -eq 1 ] && echo updated || echo installed)" "$N"
echo "  Billing page : $BASE/"
echo "  Admin panel  : $BASE/admin/"
echo "  Deploy page  : $BASE/admin/deploy.html"
if [ "$NEW_KEYS" -eq 1 ]; then
  echo
  echo "  ${B}Admin password (ADMIN_KEY):${N} $ADMIN_KEY"
  echo "  ${B}Service API key:${N}            $SERVICE_KEY"
  echo "  ${B}Withdraw page password:${N}     $WITHDRAW_KEY   ($BASE/admin/withdraw.html, for staff who only collect)"
  echo "  (also saved in $INFO, readable only by root and '$APP_USER')"
fi
cat <<EOF

  Next steps
  1. Open the Deploy page on a desktop browser with MetaMask and set up
     BNB Smart Chain (README, section 7). Paste the lines it gives you into:
       $ENV_FILE
     then restart:  su - $APP_USER -c 'pm2 restart $PM2_NAME'
  2. Admin panel -> Telegram alerts: connect your bot.
  3. Test with a small amount (README, section 8).
  Useful:  su - $APP_USER -c 'pm2 logs $PM2_NAME'   (live log)
           su - $APP_USER -c 'pm2 status'
           sudo bash install.sh --update            (from a newer version's folder)
EOF
