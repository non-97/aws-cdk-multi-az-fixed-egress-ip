import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { clientSubnets, clientVpcCidr, vpnConfig, type SubnetSpec } from '../network-config';

/** サブネット本体 + そのサブネットが使うルートテーブル。 */
export interface ManagedSubnet {
  readonly subnet: ec2.CfnSubnet;
  readonly routeTable: ec2.CfnRouteTable;
}

/** subnets レコードに載せるキー (VIP は専用 RT を持たないので含めない)。 */
type ClientSubnetKey = Exclude<keyof typeof clientSubnets, 'vip'>;

/**
 * クライアント VPC (10.10.0.0/24)。
 *
 * - 正確な CIDR 配置 / 空の VIP 専用サブネットが必要なため、サブネットは L1 で明示構築する。
 * - ルートテーブルは用途ごとに 1 つ共有する (AZ 固有のルーティングは不要なため):
 *   - client-rt: クライアントサブネット 2 つ (接続先宛 → 現用 ENI を Lambda が書く)。
 *   - snat-rt:   SNAT サブネット 2 つ (接続先宛 → VGW を BGP 伝播)。
 *   - VIP 専用サブネットは空なので専用 RT を持たせず VPC メイン RT に任せる (向ける対象として実在のみ)。
 * - public 化 (IGW + デフォルトルート→IGW)。AL2023 に iptables 等が無く private では dnf 不可のため。
 * - VGW をアタッチ (BGP)。戻りの向け先を指定するゲートウェイ RT は別 Construct で付与する。
 */
export class ClientVpc extends Construct {
  public readonly vpc: ec2.CfnVPC;
  public readonly vpnGateway: ec2.CfnVPNGateway;
  public readonly vpnGatewayAttachment: ec2.CfnVPCGatewayAttachment;
  /** クライアント / SNAT サブネット (VIP は含めない)。 */
  public readonly subnets: Record<ClientSubnetKey, ManagedSubnet>;
  /** クライアントサブネット共有 RT (接続先宛 → 現用 ENI を Lambda が書く)。 */
  public readonly clientRouteTable: ec2.CfnRouteTable;
  /** SNAT サブネット共有 RT (接続先宛 → VGW を BGP 伝播)。 */
  public readonly snatRouteTable: ec2.CfnRouteTable;

  private readonly internetGateway: ec2.CfnInternetGateway;
  private readonly igwAttachment: ec2.CfnVPCGatewayAttachment;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.CfnVPC(this, 'Resource', {
      cidrBlock: clientVpcCidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: 'fixed-egress/client-vpc' }],
    });

    this.internetGateway = new ec2.CfnInternetGateway(this, 'Igw', {
      tags: [{ key: 'Name', value: 'fixed-egress/client-igw' }],
    });
    this.igwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: this.vpc.attrVpcId,
      internetGatewayId: this.internetGateway.ref,
    });

    // 用途ごとの共有ルートテーブル (各 1 つ)。
    this.clientRouteTable = this.publicRouteTable('Client');
    this.snatRouteTable = this.publicRouteTable('Snat');

    // クライアント / SNAT サブネットを作成し、共有 RT に関連付ける。
    const routeTableByKey: Record<ClientSubnetKey, ec2.CfnRouteTable> = {
      clientA: this.clientRouteTable,
      clientC: this.clientRouteTable,
      snatA: this.snatRouteTable,
      snatC: this.snatRouteTable,
    };
    this.subnets = Object.fromEntries(
      (Object.keys(routeTableByKey) as ClientSubnetKey[]).map((key) => {
        const spec = clientSubnets[key];
        const routeTable = routeTableByKey[key];
        const subnet = this.createSubnet(spec, true);
        new ec2.CfnSubnetRouteTableAssociation(this, `${spec.name}RtAssoc`, {
          subnetId: subnet.ref,
          routeTableId: routeTable.ref,
        });
        return [key, { subnet, routeTable }];
      }),
    ) as Record<ClientSubnetKey, ManagedSubnet>;

    // VIP 専用サブネット: 向ける対象として実在させるが、空なので専用 RT は持たせない (メイン RT)。
    this.createSubnet(clientSubnets.vip, false);

    // VGW を VPC にアタッチ (BGP の AWS 側 ASN を指定)。
    this.vpnGateway = new ec2.CfnVPNGateway(this, 'VpnGateway', {
      type: 'ipsec.1',
      amazonSideAsn: vpnConfig.amazonSideAsn,
      tags: [{ key: 'Name', value: 'fixed-egress/client-vgw' }],
    });
    this.vpnGatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, 'VpnGatewayAttachment', {
      vpcId: this.vpc.attrVpcId,
      vpnGatewayId: this.vpnGateway.ref,
    });
  }

  /** public ルートテーブル (0.0.0.0/0 → IGW) を作成する。 */
  private publicRouteTable(name: string): ec2.CfnRouteTable {
    const rt = new ec2.CfnRouteTable(this, `${name}Rt`, {
      vpcId: this.vpc.attrVpcId,
      tags: [{ key: 'Name', value: `fixed-egress/${name.toLowerCase()}-rt` }],
    });
    const igwRoute = new ec2.CfnRoute(this, `${name}DefaultRoute`, {
      routeTableId: rt.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: this.internetGateway.ref,
    });
    igwRoute.addDependency(this.igwAttachment);
    return rt;
  }

  /** サブネットを作成する (ルートテーブルの関連付けは呼び出し側)。 */
  private createSubnet(spec: SubnetSpec, mapPublicIpOnLaunch: boolean): ec2.CfnSubnet {
    return new ec2.CfnSubnet(this, `${spec.name}Subnet`, {
      vpcId: this.vpc.attrVpcId,
      cidrBlock: spec.cidr,
      availabilityZone: spec.az,
      mapPublicIpOnLaunch,
      tags: [{ key: 'Name', value: `fixed-egress/${spec.name}` }],
    });
  }

  /** クライアント / SNAT が属する VPC の CIDR。 */
  public get cidr(): string {
    return clientVpcCidr;
  }

  /** クロススタック参照用に VGW ID を返す。 */
  public get vpnGatewayId(): string {
    return this.vpnGateway.ref;
  }
}
