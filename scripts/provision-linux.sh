#!/usr/bin/env bash
#
# Provision a Linux server for Airlock deploys (dedicated account + sshd gate).
#
# Creates a low-privilege account (default: ag-ssh), installs the supplied
# public key, writes the deploy launcher, and pins that account to the deployer
# through sshd ForceCommand.
#
# The account is deliberately NOT a sudoer by default. Deploying to systemd
# units needs `systemctl`, so pass --allow-systemctl <unit> to whitelist exactly
# those units and nothing else.
#
# Idempotent: safe to re-run. sshd_config is backed up, validated with `sshd -t`,
# and a rollback guard is armed before the service is reloaded so a broken gate
# restores itself.
#
# Verified on OpenCloudOS 9.6 / OpenSSH 9.3 / systemd 255.
set -euo pipefail

ACCOUNT='ag-ssh'
DEPLOY_ROOT='/opt/airlock'
NODE_ROOT='/opt/nodejs'
NODE_PATH=''
INSTALL_NODE=0
CONFIG='/etc/airlock/deployer.json'
SKIP_SSHD=0
DRY_RUN=0
ROLLBACK_MINUTES=10
ALLOW_UNITS=()

usage() {
    cat <<'EOF'
Usage: provision-linux.sh --public-key "ssh-ed25519 AAAA... comment" [options]

Options:
  --public-key KEY         Public key line to authorize (required)
  --account NAME           Deploy account name (default: ag-ssh)
  --deploy-root DIR        Airlock install directory (default: /opt/airlock)
  --node-path PATH         node binary (default: PATH, else <node-root>/bin/node)
  --node-root DIR          Node install target for --install-node (default: /opt/nodejs)
  --install-node           Install Node >= 24 into --node-root (npmmirror build)
  --config FILE            deployer config path (default: /etc/airlock/deployer.json)
  --allow-systemctl UNIT   Allow NOPASSWD systemctl on UNIT (repeatable)
  --rollback-minutes N     sshd rollback window, 0 disables (default: 10)
  --skip-sshd              Leave sshd_config alone (account/key/launcher only)
  --dry-run                Print what would happen, change nothing
  -h, --help               Show this help

Example:
  ./provision-linux.sh --public-key 'ssh-ed25519 AAAA... ag-ssh-deploy' \
      --install-node --allow-systemctl airlock-demo
EOF
}

step() { printf '[provision] %s\n' "$*"; }
warn() { printf '[provision] WARNING: %s\n' "$*" >&2; }
die() { printf '[provision] ERROR: %s\n' "$*" >&2; exit 1; }

# run() executes unless --dry-run, printing what it would do instead.
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        step "would run: $*"
        return 0
    fi
    "$@"
}

# --- argument parsing --------------------------------------------------------
PUBKEY=''
while [ $# -gt 0 ]; do
    case "$1" in
        --public-key)       PUBKEY="${2:-}"; shift 2 ;;
        --account)          ACCOUNT="${2:-}"; shift 2 ;;
        --deploy-root)      DEPLOY_ROOT="${2:-}"; shift 2 ;;
        --node-path)        NODE_PATH="${2:-}"; shift 2 ;;
        --node-root)        NODE_ROOT="${2:-}"; shift 2 ;;
        --config)           CONFIG="${2:-}"; shift 2 ;;
        --install-node)     INSTALL_NODE=1; shift ;;
        --allow-systemctl)  ALLOW_UNITS+=("${2:-}"); shift 2 ;;
        --rollback-minutes) ROLLBACK_MINUTES="${2:-}"; shift 2 ;;
        --skip-sshd)        SKIP_SSHD=1; shift ;;
        --dry-run)          DRY_RUN=1; shift ;;
        -h|--help)          usage; exit 0 ;;
        *)                  usage >&2; die "unknown argument: $1" ;;
    esac
done

[ -n "$PUBKEY" ] || { usage >&2; die '--public-key is required'; }

# --- 0. preflight ------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
    die 'must run as root (use sudo)'
fi

PUBKEY="$(printf '%s' "$PUBKEY" | sed -e 's/[[:space:]]*$//')"
case "$PUBKEY" in
    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *|sk-ssh-ed25519@openssh.com\ *) ;;
    *) die 'PublicKey does not look like an OpenSSH public key line' ;;
esac
KEY_BODY="$(printf '%s' "$PUBKEY" | awk '{print $2}')"
[ -n "$KEY_BODY" ] || die 'could not parse the key body out of --public-key'

command -v systemctl >/dev/null 2>&1 || die 'systemctl not found; this script targets systemd hosts'
[ -d /run/systemd/system ] || die 'systemd is not the running init (container or sysvinit?)'

[ "$ROLLBACK_MINUTES" -ge 0 ] 2>/dev/null || die '--rollback-minutes must be a non-negative integer'

if [ "$INSTALL_NODE" -eq 1 ]; then
    if [ -x "$NODE_ROOT/bin/node" ] && "$NODE_ROOT/bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
        step "node already installed at $NODE_ROOT/bin/node ($("$NODE_ROOT/bin/node" --version))"
        NODE_PATH="$NODE_ROOT/bin/node"
    elif [ "$DRY_RUN" -eq 1 ]; then
        # Keep --dry-run offline: do not resolve or download anything.
        step "would install the newest Node 24 build into $NODE_ROOT"
        NODE_PATH="$NODE_ROOT/bin/node"
    else
        command -v curl >/dev/null 2>&1 || die 'curl is required by --install-node'
        command -v xz >/dev/null 2>&1 || die 'xz is required by --install-node'
        case "$(uname -m)" in
            x86_64|aarch64) ;;
            *) die "unsupported architecture for --install-node: $(uname -m)" ;;
        esac
        step 'resolving the newest Node 24 build from npmmirror'
        INDEX_JSON="$(curl -fsSL --max-time 60 https://npmmirror.com/mirrors/node/index.json)" \
            || die 'could not download the Node version index'
        NODE_VERSION="$(printf '%s' "$INDEX_JSON" \
            | grep -o '"version"[[:space:]]*:[[:space:]]*"v24\.[0-9.]*"' \
            | head -1 \
            | sed 's/.*"\(v24\.[0-9.]*\)"/\1/')"
        [ -n "$NODE_VERSION" ] || die 'no v24 build found in the Node version index'
        ARCH="$(uname -m)"
        TARBALL="node-$NODE_VERSION-linux-$ARCH.tar.xz"
        TMP_TAR="$(mktemp -d)"
        step "downloading $TARBALL"
        run curl -fsSL --max-time 900 -o "$TMP_TAR/$TARBALL" \
            "https://npmmirror.com/mirrors/node/$NODE_VERSION/$TARBALL"
        if [ "$DRY_RUN" -eq 0 ]; then
            rm -rf "$NODE_ROOT"
            mkdir -p "$(dirname "$NODE_ROOT")"
            tar -xJf "$TMP_TAR/$TARBALL" -C "$TMP_TAR"
            mv "$TMP_TAR/node-$NODE_VERSION-linux-$ARCH" "$NODE_ROOT"
            rm -rf "$TMP_TAR"
        fi
        NODE_PATH="$NODE_ROOT/bin/node"
    fi
fi

if [ -z "$NODE_PATH" ]; then
    if command -v node >/dev/null 2>&1; then
        NODE_PATH="$(command -v node)"
    elif [ -x "$NODE_ROOT/bin/node" ]; then
        NODE_PATH="$NODE_ROOT/bin/node"
    else
        die 'node not found in PATH and no --node-path given (try --install-node)'
    fi
fi
if [ "$DRY_RUN" -eq 0 ] && [ ! -x "$NODE_PATH" ]; then
    die "node binary is not executable: $NODE_PATH"
fi
if [ -x "$NODE_PATH" ]; then
    NODE_VERSION_ACTUAL="$("$NODE_PATH" --version 2>/dev/null || echo unknown)"
    case "$NODE_VERSION_ACTUAL" in
        v2[4-9].*|v[3-9][0-9].*) ;;
        *) warn "node is $NODE_VERSION_ACTUAL, Airlock needs >= 24" ;;
    esac
    step "node: $NODE_PATH ($NODE_VERSION_ACTUAL)"
fi

if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = 'Enforcing' ]; then
    warn 'SELinux is Enforcing; if sshd cannot read authorized_keys run: restorecon -R -v <home>/.ssh'
fi

# --- 1. account --------------------------------------------------------------
if id -u "$ACCOUNT" >/dev/null 2>&1; then
    step "account $ACCOUNT already exists, reusing it"
else
    step "creating user $ACCOUNT (home directory, no password)"
    run useradd --create-home --shell /bin/bash "$ACCOUNT"
fi
# Key-only: lock the password so PAM cannot fall back to it.
run usermod -L "$ACCOUNT"

HOME_DIR="$(getent passwd "$ACCOUNT" | cut -d: -f6)"
if [ -z "$HOME_DIR" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        HOME_DIR="/home/$ACCOUNT"
    else
        die "no home directory for $ACCOUNT"
    fi
fi

# --- 2. authorized key -------------------------------------------------------
AUTH_FILE="$HOME_DIR/.ssh/authorized_keys"
step "authorize key in $AUTH_FILE"
run install -d -m 700 -o "$ACCOUNT" -g "$ACCOUNT" "$HOME_DIR/.ssh"
if [ "$DRY_RUN" -eq 1 ]; then
    step "would append the key if absent, then chown $ACCOUNT and chmod 600"
else
    [ -f "$AUTH_FILE" ] || : > "$AUTH_FILE"
    if grep -qF -- "$KEY_BODY" "$AUTH_FILE"; then
        step 'key already authorized'
    else
        printf '%s\n' "$PUBKEY" >> "$AUTH_FILE"
    fi
    chown "$ACCOUNT:$ACCOUNT" "$AUTH_FILE"
    chmod 600 "$AUTH_FILE"
    chmod 700 "$HOME_DIR/.ssh"
fi

# --- 3. directories ----------------------------------------------------------
step "ensure $DEPLOY_ROOT/bin and $(dirname "$CONFIG")"
run mkdir -p "$DEPLOY_ROOT/bin" "$(dirname "$CONFIG")"

# --- 4. deploy launcher ------------------------------------------------------
LAUNCHER="$DEPLOY_ROOT/bin/deploy.sh"
DEPLOYER="$DEPLOY_ROOT/bin/airlock-deployer.mjs"
step "write launcher $LAUNCHER"
if [ "$DRY_RUN" -eq 0 ]; then
    cat > "$LAUNCHER" <<LAUNCH
#!/bin/sh
exec "$NODE_PATH" "$DEPLOYER" --config "$CONFIG"
LAUNCH
    chmod 755 "$LAUNCHER"
fi
if [ ! -f "$DEPLOYER" ]; then
    step "NOTE: $DEPLOYER does not exist yet; copy the Airlock tree to $DEPLOY_ROOT before using it"
fi
if [ ! -f "$CONFIG" ]; then
    step "NOTE: $CONFIG does not exist yet; see examples/deployer.example.json"
fi

# --- 5. systemctl whitelist --------------------------------------------------
if [ "${#ALLOW_UNITS[@]}" -gt 0 ]; then
    SUDO_FILE="/etc/sudoers.d/airlock-$ACCOUNT"
    COMMANDS=()
    for unit in "${ALLOW_UNITS[@]}"; do
        for verb in restart stop start is-active status; do
            COMMANDS+=("/usr/bin/systemctl $verb $unit")
        done
    done
    joined="$(IFS=,; printf '%s' "${COMMANDS[*]}" | sed 's/,/, /g')"
    step "whitelist systemctl for: ${ALLOW_UNITS[*]}"
    if [ "$DRY_RUN" -eq 0 ]; then
        printf '%s ALL=(root) NOPASSWD: %s\n' "$ACCOUNT" "$joined" > "$SUDO_FILE"
        chmod 440 "$SUDO_FILE"
        if ! visudo -cf "$SUDO_FILE" >/dev/null; then
            rm -f "$SUDO_FILE"
            die "generated sudoers file failed validation, removed: $SUDO_FILE"
        fi
        step "sudoers: $SUDO_FILE (validated with visudo -c)"
    fi
fi

# --- 6. sshd gate ------------------------------------------------------------
MARKER="# --- airlock deploy account: $ACCOUNT ---"
SSHD_SERVICE=''
if [ "$SKIP_SSHD" -eq 0 ]; then
    SSHD_CONFIG='/etc/ssh/sshd_config'
    [ -f "$SSHD_CONFIG" ] || die "sshd_config not found: $SSHD_CONFIG"

    if systemctl cat sshd.service >/dev/null 2>&1; then
        SSHD_SERVICE='sshd'
    elif systemctl cat ssh.service >/dev/null 2>&1; then
        SSHD_SERVICE='ssh'
    else
        die 'neither sshd.service nor ssh.service exists'
    fi

    BACKUP="$SSHD_CONFIG.bak-airlock-$(date +%Y%m%d-%H%M%S)"
    step "backup sshd_config -> $BACKUP"
    if [ "$DRY_RUN" -eq 0 ]; then
        cp -p "$SSHD_CONFIG" "$BACKUP"
    fi

    BLOCK="$MARKER
Match User $ACCOUNT
    ForceCommand $LAUNCHER
    PermitTTY no
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PasswordAuthentication no
    AuthenticationMethods publickey"

    if [ "$DRY_RUN" -eq 0 ]; then
        # Drop a previous block for this account, then append the fresh one.
        # The marker is matched by prefix so an older block written by hand (or
        # by an earlier revision of this script) is replaced too, and the account
        # bound is exact: "ag-ssh" must not swallow "ag-ssh2".
        # Everything from the marker up to the next top-level directive goes:
        # the marker line, the indented `Match` line, and the indented settings
        # that follow it (Match blocks only contain indented directives).
        FILTERED="$(awk -v acc="$ACCOUNT" '
            BEGIN { pat = "^# --- airlock deploy account: " acc "([^A-Za-z0-9_-]|$)" }
            $0 ~ pat { skip = 1; next }
            skip {
                if ($0 ~ /^Match[ \t]/) next
                if ($0 ~ /^[ \t]/) next
                if ($0 == "") { skip = 0; next }
                skip = 0
            }
            { print }
        ' "$SSHD_CONFIG")"
        printf '%s\n\n%s\n' "$FILTERED" "$BLOCK" > "$SSHD_CONFIG.airlock-new"
        cat "$SSHD_CONFIG.airlock-new" > "$SSHD_CONFIG"
        rm -f "$SSHD_CONFIG.airlock-new"

        step 'validating with sshd -t'
        if ! sshd -t; then
            cp -p "$BACKUP" "$SSHD_CONFIG"
            die "sshd_config validation failed; restored $BACKUP. Nothing was reloaded."
        fi
        step 'sshd_config valid'

        if [ "$ROLLBACK_MINUTES" -gt 0 ]; then
            # Arm the guard BEFORE reloading: if the new gate locks everyone out,
            # the previous file comes back by itself.
            systemctl stop sshd-rollback.timer >/dev/null 2>&1 || true
            systemctl reset-failed sshd-rollback.service >/dev/null 2>&1 || true
            if systemd-run --on-active="$((ROLLBACK_MINUTES * 60))" --unit=sshd-rollback \
                /bin/sh -c "cp '$BACKUP' '$SSHD_CONFIG' && systemctl reload $SSHD_SERVICE" >/dev/null 2>&1; then
                step "rollback guard armed for $ROLLBACK_MINUTES minutes (unit: sshd-rollback)"
            else
                warn 'could not arm the rollback guard; roll back by hand if the gate breaks'
            fi
        fi

        step "reloading $SSHD_SERVICE (existing sessions survive a reload)"
        systemctl reload "$SSHD_SERVICE"
    fi
fi

# --- 7. summary --------------------------------------------------------------
printf '\n'
step 'done. summary:'
printf '  account          : %s\n' "$ACCOUNT"
printf '  home             : %s\n' "$HOME_DIR"
printf '  authorized_keys  : %s\n' "${AUTH_FILE:-/home/$ACCOUNT/.ssh/authorized_keys}"
printf '  deploy root      : %s\n' "$DEPLOY_ROOT"
printf '  node             : %s\n' "$NODE_PATH"
printf '  launcher         : %s\n' "$LAUNCHER"
printf '  deployer config  : %s\n' "$CONFIG"
if [ "${#ALLOW_UNITS[@]}" -gt 0 ]; then
    printf '  systemctl allowed: %s\n' "${ALLOW_UNITS[*]}"
fi
if [ "$SKIP_SSHD" -eq 0 ]; then
    printf '  sshd gate        : ForceCommand -> %s (PermitTTY no)\n' "$LAUNCHER"
    printf '  sshd backup      : %s\n' "${BACKUP:-<none>}"
fi

printf '\n'
step 'Next:'
printf '  1. copy the Airlock tree to %s (bin/, src/, node_modules/, package.json)\n' "$DEPLOY_ROOT"
printf '  2. write %s (see examples/deployer.example.json)\n' "$CONFIG"
printf '  3. from your workstation: airlock-deploy status --app <app> --probe\n'
if [ "$SKIP_SSHD" -eq 0 ] && [ "$ROLLBACK_MINUTES" -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    printf '  4. once the gate is confirmed working: systemctl stop sshd-rollback.timer\n'
    printf '     (otherwise it reverts sshd_config on its own, %s minutes after the reload)\n' "$ROLLBACK_MINUTES"
fi
