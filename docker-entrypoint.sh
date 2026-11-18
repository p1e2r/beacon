#!/bin/sh
# Make the data folder writable (bind mounts are often created as root), then drop
# root and run the proxy as the unprivileged "beacon" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$BEACON_DATA"
  chown -R beacon:beacon "$BEACON_DATA" 2>/dev/null || echo "warning: could not chown $BEACON_DATA" >&2
  exec setpriv --reuid=beacon --regid=beacon --init-groups beacon-proxy "$@"
fi
exec beacon-proxy "$@"
