#!/bin/bash
set -uo pipefail

# =============================================================================
# 接続先サーバー UserData (CloudFormation Fn::Sub でプレースホルダを置換)
#   - HTTP サーバー (リクエスト元 IP を返す) を起動。curl で送信元 IP が確認できる。
#   - アクセスログ (送信元 IP) を systemd journal に出力 → `journalctl -u echo-server` で確認可。
#   - iptables で送信元 ALLOWED_SOURCE_IP (VIP) のみ port 80 を許可、他は drop
# =============================================================================

# AL2023 には iptables が無いため導入 (public サブネット + IGW でインターネット可)。
dnf install -y iptables-nft

cat >/usr/local/bin/echo-server.py <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        src = self.client_address[0]
        # アクセスログ: どの送信元 IP から来たかを journal へ (SNAT 後は 10.10.0.85)
        print(f"access source={src} \"{self.requestline}\"", flush=True)
        body = f"ok: source={src}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

HTTPServer(("0.0.0.0", 80), Handler).serve_forever()
PY

cat >/etc/systemd/system/echo-server.service <<EOF
[Unit]
Description=Echo source IP HTTP server
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 /usr/local/bin/echo-server.py
Restart=always
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now echo-server.service

# allowlist: VIP のみ port 80 許可
iptables -A INPUT -p tcp --dport 80 -s "${ALLOWED_SOURCE_IP}" -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j DROP
