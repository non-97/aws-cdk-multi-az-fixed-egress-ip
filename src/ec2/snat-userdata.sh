#!/bin/bash
set -uo pipefail

# =============================================================================
# SNAT UserData (1 枚 ENI 方式, CloudFormation Fn::Sub)
#   - ENI はインスタンスのプライマリ ENI (ens5) 1 枚のみ。
#   - source/dest check の無効化もこのスクリプトが自身に対して行う (ASG 生成の ENI には
#     起動テンプレートで設定できないため)。
#   - ip_forward / 接続先宛 SNAT (送信元を VIP に固定) / 詳細なヘルスチェックを構成する。
#   プレースホルダ (波括弧) = デプロイ時に Fn::Sub が置換する値 (synth 時に確定)。
#   シェル変数は Fn::Sub のエスケープ記法 (波括弧内の先頭に !) で記述する。
# =============================================================================

# --- 自身の source/dest check を無効化 (この単一 ENI が NAT 転送するため必須) ---------
# ASG 自動生成のプライマリ ENI には起動テンプレートで設定できないため、自分で無効化する。
# 1 枚 ENI なのでインスタンス単位の modify-instance-attribute で足りる (ENI 探索不要)。
ATOKEN="$(curl -sS -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
IID="$(curl -sS -H "X-aws-ec2-metadata-token: ${!ATOKEN}" http://169.254.169.254/latest/meta-data/instance-id)"
aws ec2 modify-instance-attribute --region ${REGION} --instance-id "${!IID}" --no-source-dest-check || true

# --- iptables 導入 (AL2023 には無い。public サブネット + IGW でインターネットへ出られる) -----
dnf install -y iptables-nft

# --- フォワーディング有効化 ----------------------------------------------------
# 戻り (宛先 VIP) は conntrack の逆 NAT で元クライアントへ。単一 ENI なので経路は対称。
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv4.conf.all.rp_filter=2
cat >/etc/sysctl.d/99-snat.conf <<EOF
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=2
EOF

# --- SNAT (クライアント発かつ接続先宛のみ送信元を VIP に固定) ----------------------
# 接続先へは既定経路 (SNAT サブネット RT の VGW 伝播ルート) で到達するため、明示ルートは不要。
# 自身発の probe (src=ENI 自身の IP) は対象外 → 戻りが自分の ENI に返る。
for src in ${CLIENT_CIDRS}; do
  iptables -t nat -C POSTROUTING -s "${!src}" -d "${DEST_VPC_CIDR}" -j SNAT --to-source "${FIXED_EGRESS_IP}" 2>/dev/null \
    || iptables -t nat -A POSTROUTING -s "${!src}" -d "${DEST_VPC_CIDR}" -j SNAT --to-source "${FIXED_EGRESS_IP}"
done

# --- 詳細なヘルスチェックのスクリプト (クォート版ヒアドキュメント) ----------------------
# プレースホルダは Fn::Sub が先に置換、エスケープ記法はヘルス実行時のシェル変数になる。
cat >/usr/local/bin/snat-healthcheck.sh <<'HEOF'
#!/bin/bash
set -uo pipefail
# SNAT インスタンスが「送信元を固定した転送経路」として正しく機能しているかを複数観点で検査し、
# 結果を 1(正常)/0(異常)として CloudWatch メトリクスに発行する。systemd timer が一定間隔で
# 実行し、このメトリクスを AZ ごとのアラームが監視する。EC2 ステータスチェック等の浅いヘルスでは
# 検知できない、転送経路に固有の故障 (IP 転送が無効 / SNAT ルールが消失 / 上流へ到達できない) を検出する。
# conntrack 枯渇のような負荷・容量の問題は対象外: 待機系へ切り替えても同じ負荷で再発するため、
# フェイルオーバーでは直らない (容量はインスタンスサイズ / nf_conntrack_max の調整で対処する)。

# 自分の AZ を取得 (IMDSv2)。最後の発行で次元 Az= に使い、AZ ごとに値を分けてアラームを AZ 単位にする。
TOKEN="$(curl -sS -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
AZ="$(curl -sS -H "X-aws-ec2-metadata-token: ${!TOKEN}" http://169.254.169.254/latest/meta-data/placement/availability-zone)"

# 3 つの検査。いずれもインスタンス固有の故障 (片方だけ壊れる) なのでフェイルオーバーで直る。
# 1 つでも失敗したら healthy を 0 にする。
healthy=1
# (1) IP フォワーディングが有効か。SNAT は転送を行うので必須。無効だと一切転送できない。
[ "$(cat /proc/sys/net/ipv4/ip_forward)" = "1" ] || healthy=0
# (2) 送信元を固定 IP へ書き換える SNAT (POSTROUTING) ルールが存在するか。消えると送信元が固定されない。
iptables -t nat -S POSTROUTING | grep -q -- "--to-source ${FIXED_EGRESS_IP}" || healthy=0
# (3) 上流 (VPN ルーター) への到達性。VPN トンネルと SNAT サブネット → VGW → VPN の経路が通っているかを end-to-end で確認する。
ping -c 1 -W 2 "${PROBE_TARGET}" >/dev/null 2>&1 || healthy=0

# 検査結果を高解像度メトリクス (storage-resolution 1) として発行する。高解像度なので 30 秒周期の
# アラームが使え、短い発行間隔とあわせて約 1 分以内に異常を検知できる。インスタンスが停止や終了で
# 発行できなくなった場合は、アラーム側の「欠損 = breaching」設定が異常とみなす。
aws cloudwatch put-metric-data \
  --region "${REGION}" \
  --namespace "${METRIC_NAMESPACE}" \
  --metric-name "${METRIC_NAME}" \
  --unit Count \
  --value "${!healthy}" \
  --storage-resolution 1 \
  --dimensions Az="${!AZ}"
HEOF
chmod +x /usr/local/bin/snat-healthcheck.sh

# --- systemd timer (PROBE_INTERVAL 秒ごと) -------------------------------------
cat >/etc/systemd/system/snat-healthcheck.service <<EOF
[Unit]
Description=SNAT detailed health check
[Service]
Type=oneshot
ExecStart=/usr/local/bin/snat-healthcheck.sh
EOF

cat >/etc/systemd/system/snat-healthcheck.timer <<EOF
[Unit]
Description=Run SNAT detailed health check periodically
[Timer]
OnBootSec=30
OnUnitActiveSec=${PROBE_INTERVAL}
AccuracySec=1s
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now snat-healthcheck.timer
