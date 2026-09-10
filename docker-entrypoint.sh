#!/bin/sh
# Fix upload-volume ownership, then drop to the unprivileged node user.
# Bind mounts and Portainer named volumes are usually root-owned, so a
# USER node image cannot write them without this step.

set -e

UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"

dir_writable_by_node() {
  su-exec node test -w "$1"
}

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$UPLOAD_DIR"

  if ! dir_writable_by_node "$UPLOAD_DIR"; then
    echo "Upload directory $UPLOAD_DIR is not writable by user node; fixing ownership"
    chown node:node "$UPLOAD_DIR" || true
  fi

  if ! dir_writable_by_node "$UPLOAD_DIR"; then
    chown -R node:node "$UPLOAD_DIR" || true
  fi

  if ! dir_writable_by_node "$UPLOAD_DIR"; then
    echo "ERROR: $UPLOAD_DIR is not writable after chown."
    echo "The volume is likely a network share that ignores Unix ownership."
    echo "Make the host directory writable by UID $(su-exec node id -u) and restart."
    exit 1
  fi

  exec su-exec node "$@"
fi

mkdir -p "$UPLOAD_DIR" || true
if [ ! -w "$UPLOAD_DIR" ]; then
  echo "ERROR: $UPLOAD_DIR is not writable by UID $(id -u)."
  echo "Remove any compose 'user:' override so the entrypoint can run as root,"
  echo "or chown the host volume to this user."
  exit 1
fi

exec "$@"
