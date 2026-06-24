#!/bin/bash
set -uo pipefail

# =============================================================================
# VPN ルーター UserData (オンプレ側 = customer gateway 役, CloudFormation Fn::Sub)
#   プレースホルダ (波カッコ) = デプロイ時に Fn::Sub が置換する値
#   シェル変数は Fn::Sub のエスケープ記法 (波カッコ内先頭に bang) で記述する
#   - libreswan (IPsec, VTI) + FRR (BGP)。FRR は spal-release から導入。
#   - 参考: aws-cdk-cloud-wan の vpn-router-userdata.sh を単一 ENI 構成に簡略化。
# =============================================================================

dnf install -y jq libreswan
dnf install -y spal-release
dnf install -y frr
sed -i 's/^bgpd=.*/bgpd=yes/' /etc/frr/daemons
ipsec initnss 2>/dev/null || true

cat >/etc/sysctl.d/99-vpn.conf <<EOF
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
EOF
sysctl --system
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv4.conf.all.rp_filter=0

TOKEN="$(curl -sS -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 1800')"
imds() { curl -sS -H "X-aws-ec2-metadata-token: ${!TOKEN}" "http://169.254.169.254/latest/meta-data/$1"; }
CGW_IP="$(imds public-ipv4)"
CGW_PRIV="$(imds local-ipv4)"

# VPN 設定 (available になるまで待機)
for _ in $(seq 1 90); do
  VPN_JSON="$(aws ec2 describe-vpn-connections --region "${REGION}" \
    --filters "Name=tag:Name,Values=${VPN_TAG}" "Name=state,Values=available" --no-cli-pager 2>/dev/null)"
  [ -n "$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[0].VpnConnectionId // empty')" ] && break
  sleep 10
done

O1="$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[0].Options.TunnelOptions[0].OutsideIpAddress')"
O2="$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[0].Options.TunnelOptions[1].OutsideIpAddress')"
C1="$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[0].Options.TunnelOptions[0].TunnelInsideCidr')"
C2="$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[0].Options.TunnelOptions[1].TunnelInsideCidr')"

# /30 の net+1 = AWS 側, net+2 = CGW 側
inside() { echo "$1" | cut -d/ -f1 | awk -F. -v o="$2" '{printf "%s.%s.%s.%d",$1,$2,$3,(int($4/4)*4)+o}'; }
AWS1="$(inside "${!C1}" 1)"; CGW1="$(inside "${!C1}" 2)"
AWS2="$(inside "${!C2}" 1)"; CGW2="$(inside "${!C2}" 2)"

# --- libreswan (IPsec, VTI) ----------------------------------------------------
cat >/etc/ipsec.d/aws.secrets <<EOF
${!CGW_IP} ${!O1} : PSK "${PSK}"
${!CGW_IP} ${!O2} : PSK "${PSK}"
EOF
chmod 600 /etc/ipsec.d/aws.secrets

write_conn() {
  cat >>/etc/ipsec.d/aws.conf <<EOF
conn $1
  type=tunnel
  auto=start
  authby=secret
  ikev2=insist
  ike=aes256-sha2_256;dh14
  esp=aes256-sha2_256;dh14
  ikelifetime=28800s
  salifetime=3600s
  rekey=yes
  dpddelay=10
  dpdtimeout=30
  dpdaction=restart
  left=${!CGW_PRIV}
  leftid=${!CGW_IP}
  leftsubnet=0.0.0.0/0
  right=$2
  rightid=$2
  rightsubnet=0.0.0.0/0
  mark=$3/0xffffffff
  vti-interface=$4
  vti-routing=no
EOF
}
: >/etc/ipsec.d/aws.conf
write_conn tunnel1 "${!O1}" 100 vti1
write_conn tunnel2 "${!O2}" 200 vti2

systemctl enable ipsec
systemctl restart ipsec
sleep 5
for _ in $(seq 1 30); do ipsec auto --up tunnel1 2>&1 | grep -q established && break; sleep 10; done
for _ in $(seq 1 30); do ipsec auto --up tunnel2 2>&1 | grep -q established && break; sleep 10; done

# --- VTI 待ち + 内部 IP 付与 ---------------------------------------------------
for _ in $(seq 1 30); do ip link show vti1 >/dev/null 2>&1 && ip link show vti2 >/dev/null 2>&1 && break; sleep 2; done
ip link set vti1 up mtu 1436; ip addr add "${!CGW1}/30" dev vti1 2>/dev/null || true
ip link set vti2 up mtu 1436; ip addr add "${!CGW2}/30" dev vti2 2>/dev/null || true

# --- FRR (BGP) -----------------------------------------------------------------
cat >/etc/frr/frr.conf <<EOF
frr defaults traditional
hostname vpn-router
no ipv6 forwarding
!
router bgp ${CUSTOMER_ASN}
 no bgp ebgp-requires-policy
 neighbor ${!AWS1} remote-as ${AMAZON_ASN}
 neighbor ${!AWS1} ebgp-multihop 255
 neighbor ${!AWS2} remote-as ${AMAZON_ASN}
 neighbor ${!AWS2} ebgp-multihop 255
 !
 address-family ipv4 unicast
  network ${LOCAL_CIDR}
  neighbor ${!AWS1} soft-reconfiguration inbound
  neighbor ${!AWS2} soft-reconfiguration inbound
 exit-address-family
exit
!
end
EOF
systemctl enable frr
systemctl restart frr
