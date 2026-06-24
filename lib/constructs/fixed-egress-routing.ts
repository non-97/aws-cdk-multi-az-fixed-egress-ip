import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface FixedEgressRoutingProps {
  readonly vpcId: string;
  readonly vpnGateway: ec2.CfnVPNGateway;
  readonly vpnGatewayAttachment: ec2.CfnVPCGatewayAttachment;
  /** SNATサブネットのルートテーブル (接続先宛 → VGW を BGP 伝播)。 */
  readonly snatRouteTables: ec2.CfnRouteTable[];
}

/**
 * 固定送信元 IP を成立させるルーティングの「静的部分」。
 *
 * - SNAT サブネット RT は VGW から BGP 学習ルートを伝播 (SNAT インスタンスが接続先へ到達)。
 * - 戻りの向け先を指定するゲートウェイルートテーブル (edge association) を空で用意する。
 *
 * 送信 (クライアント RT → 接続先) と戻り (ゲートウェイ RT → VIP) の実ルートは、向け先 ENI が
 * 入れ替えで変わるため CDK では作らない。SnatRouteManager の Lambda が現用 ENI へ向ける。
 */
export class FixedEgressRouting extends Construct {
  /** 戻りの向け先を指定するゲートウェイルートテーブル。 */
  public readonly gatewayRouteTable: ec2.CfnRouteTable;

  constructor(scope: Construct, id: string, props: FixedEgressRoutingProps) {
    super(scope, id);

    // --- SNATサブネット: VGW からの BGP 学習ルートを伝播 -------------------
    const propagation = new ec2.CfnVPNGatewayRoutePropagation(this, 'SnatRoutePropagation', {
      routeTableIds: props.snatRouteTables.map((rt) => rt.ref),
      vpnGatewayId: props.vpnGateway.ref,
    });
    // 伝播は VGW アタッチメント完了後でなければ作成できない。
    propagation.addDependency(props.vpnGatewayAttachment);

    // --- 戻り: VGW ゲートウェイルートテーブル (edge association, propagation 無効の専用 RT) ----
    // 「VIP サブネット CIDR → 現用 ENI」のルートはデプロイ後に Lambda が投入する。
    this.gatewayRouteTable = new ec2.CfnRouteTable(this, 'GatewayRouteTable', {
      vpcId: props.vpcId,
      tags: [{ key: 'Name', value: 'fixed-egress/vgw-gateway-rt (VIP 向け先)' }],
    });

    const association = new ec2.CfnGatewayRouteTableAssociation(this, 'GatewayRtAssociation', {
      gatewayId: props.vpnGateway.ref,
      routeTableId: this.gatewayRouteTable.ref,
    });
    association.addDependency(props.vpnGatewayAttachment);
  }
}
