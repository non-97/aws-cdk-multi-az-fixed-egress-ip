#!/bin/bash
set -uo pipefail

# 検証用ヘルパ (CloudFormation Fn::Sub でプレースホルダを置換)。
# 接続先サーバーへ HTTP リクエストし、サーバーが見た送信元 IP を表示する。
# SNAT が適用されていれば送信元は VIP になり allowlist を通過して 200 が返る。
cat >/usr/local/bin/test-egress.sh <<EOF
#!/bin/bash
echo "== request to ${DEST_SERVER_IP} =="
curl -s -m 5 "http://${DEST_SERVER_IP}/" || echo "request failed"
EOF
chmod +x /usr/local/bin/test-egress.sh
