#!/bin/bash
# Runs on the relay host (172.17.13.62) as root.
#
# The local WSL machine keeps a reverse SSH tunnel open to this host, binding
# 127.0.0.1:3000 here. This script puts systemd-socket-proxyd in front of it on
# :80, so colleagues keep using http://172.17.13.62/ and nothing has to know the
# local machine's address.
#
# Install:  sudo bash install-web-relay.sh
# Remove:   sudo systemctl disable --now regwatch-web.socket
#           sudo rm /etc/systemd/system/regwatch-web.{socket,service}
#           sudo systemctl daemon-reload
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

if ss -lntH 'sport = :80' | grep -q .; then
  echo "port 80 is already in use:" >&2
  ss -lntp 'sport = :80' >&2
  exit 1
fi

cat >/etc/systemd/system/regwatch-web.socket <<'EOF'
[Unit]
Description=RegWatch public web socket (relay to the local WSL stack)

[Socket]
ListenStream=0.0.0.0:80
ReusePort=no

[Install]
WantedBy=sockets.target
EOF

cat >/etc/systemd/system/regwatch-web.service <<'EOF'
[Unit]
Description=RegWatch public web relay (127.0.0.1:3000)
Requires=regwatch-web.socket
After=regwatch-web.socket

[Service]
ExecStart=/lib/systemd/systemd-socket-proxyd 127.0.0.1:3000
PrivateTmp=yes
EOF

systemctl daemon-reload
systemctl enable --now regwatch-web.socket

echo "installed; checking http://127.0.0.1/api/health"
for _ in $(seq 1 10); do
  if curl -fsS -m 3 http://127.0.0.1/api/health; then
    echo
    exit 0
  fi
  sleep 1
done

echo "the socket is up but the local stack did not answer; check the reverse tunnel on the WSL machine:" >&2
echo "  systemctl --user status regwatch-relay" >&2
exit 1
