/**
 * ネットワーク設定の一元管理。
 *
 * 全 CIDR / IP / ASN / PSK / VIP / タグを本ファイルに集約し、Stack / Construct へ
 * Props 経由で注入する。値はすべて synth 時に決定する (CloudFormation Parameters は使わない)。
 */

// ---------------------------------------------------------------------------
// リージョン / AZ
// ---------------------------------------------------------------------------

export const region = 'ap-northeast-1';

/** 2 AZ 構成。SNAT / クライアントを各 AZ に配置する。 */
export const availabilityZones = {
  a: `${region}a`,
  c: `${region}c`,
} as const;

// ---------------------------------------------------------------------------
// クライアント VPC (10.10.0.0/24)
// ---------------------------------------------------------------------------

export const clientVpcCidr = '10.10.0.0/24';

/**
 * 固定送信元 IP (VIP)。
 *
 * どの ENI にも割り当てない。SNATの masquerade 送信元として使い、
 * 戻りは VIP 専用サブネット CIDR を VGW ゲートウェイ RT で現用 ENI へ向ける。
 */
export const fixedEgressIp = '10.10.0.85';

export interface SubnetSpec {
  readonly name: string;
  readonly cidr: string;
  readonly az: string;
}

export const clientSubnets = {
  clientA: { name: 'ClientA', cidr: '10.10.0.0/27', az: availabilityZones.a },
  clientC: { name: 'ClientC', cidr: '10.10.0.32/27', az: availabilityZones.c },
  snatA: { name: 'SnatA', cidr: '10.10.0.64/28', az: availabilityZones.a },
  /** VIP 専用サブネット。空サブネットだが実在させ、その CIDR 全体を向ける対象にする。 */
  vip: { name: 'Vip', cidr: '10.10.0.80/28', az: availabilityZones.a },
  snatC: { name: 'SnatC', cidr: '10.10.0.96/28', az: availabilityZones.c },
} as const satisfies Record<string, SubnetSpec>;

// ---------------------------------------------------------------------------
// 接続先サーバー VPC (192.168.100.0/24, 別 VPC, S2S VPN で接続)
// ---------------------------------------------------------------------------

export const destinationVpcCidr = '192.168.100.0/24';

/**
 * 接続先 VPC は 1 サブネット。VPN ルーターと接続先サーバーを同居させる。
 * こうするとルーターが接続先サブネットに直結 (connected) するため、FRR の aggregate が
 * 作る Null0 ブラックホールに当たらず、サーバーサブネットへの静的ルートが不要になる。
 */
export const destinationSubnet: SubnetSpec = {
  name: 'Main',
  cidr: destinationVpcCidr,
  az: availabilityZones.a,
};

/** 接続先サーバーの固定 IP。allowlist の検証対象。 */
export const destinationServerIp = '192.168.100.20';

/**
 * libreswan ルーターの固定プライベート IP。
 *
 * SNAT の詳細なヘルスチェック「上流到達性」probe 先。VPN トンネルが確立している時だけ
 * 到達でき、接続先サーバー本体には負荷をかけない。
 */
export const destinationRouterPrivateIp = '192.168.100.5';

// ---------------------------------------------------------------------------
// Site-to-Site VPN (BGP)
// ---------------------------------------------------------------------------

/** VPN Connection を VPN ルーター (libreswan) が DescribeVpnConnections で見つけるためのタグ値。 */
export const vpnConnectionTagName = 'fixed-egress-vpn';

export const vpnConfig = {
  /** AWS 側 VGW の BGP ASN。 */
  amazonSideAsn: 64512,
  /** オンプレ側 (libreswan) の BGP ASN。 */
  customerSideAsn: 65010,
  /** デモ用 PSK。本番では Secrets Manager 等で管理する。 */
  preSharedKey: 'fixedEgressDemoPsk1234',
  tunnel1InsideCidr: '169.254.21.0/30',
  tunnel2InsideCidr: '169.254.22.0/30',
} as const;

// ---------------------------------------------------------------------------
// 詳細なヘルスチェック / フェイルオーバー
// ---------------------------------------------------------------------------

export const healthConfig = {
  /** カスタムメトリクスの名前空間。 */
  metricNamespace: 'FixedEgress',
  /** 詳細なヘルスチェックの結果メトリクス名 (1=正常 / 0=異常)。 */
  metricName: 'SnatPathHealthy',
  /** 詳細なヘルスチェックの実行間隔 (秒)。高解像度メトリクスとして PutMetricData する。 */
  probeIntervalSeconds: 15,
  /** アラームの評価期間 (秒)。高解像度メトリクスなので 30 秒を使える。 */
  alarmPeriodSeconds: 30,
  /** アラーム判定の評価データポイント数 (連続失敗閾値)。30s × 2 ≒ 1 分で検知。 */
  evaluationPeriods: 2,
  /**
   * 異常で入れ替える際、起動からこの秒数に満たないインスタンスは見送る (入れ替えの連続を緩和)。
   * ASG の healthCheckGracePeriod (300s) 以上にして、起動直後の保護を延ばす。
   */
  replaceMinAgeSeconds: 600,
} as const;

// ---------------------------------------------------------------------------
// SNAT インスタンス
// ---------------------------------------------------------------------------

/**
 * SNAT インスタンスのタイプ。conntrack 容量 / スループットに効くチューニング値なので集約する。
 */
export const snatInstanceType = 't3.small';
