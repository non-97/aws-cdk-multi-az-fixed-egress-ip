import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { DestinationServer } from './destination-server';
import { LibreswanRouter } from './destination-vpn';
import type { ManagedSubnet } from './client-vpc';
import { destinationSubnet, destinationVpcCidr, type SubnetSpec } from '../network-config';

/**
 * 接続先サーバー VPC (192.168.100.0/24)。クライアント VPC とは別 VPC で、
 * S2S VPN (customer gateway 役 = libreswan) で接続する。
 */
export class DestinationVpc extends Construct {
  /** CGW の IP に使う libreswan の public IP。 */
  public readonly routerPublicIp: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: destinationVpcCidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: 'fixed-egress/destination-vpc' }],
    });

    const igw = new ec2.CfnInternetGateway(this, 'Igw', {
      tags: [{ key: 'Name', value: 'fixed-egress/destination-igw' }],
    });
    const igwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: vpc.attrVpcId,
      internetGatewayId: igw.ref,
    });

    // 1 サブネットにルーターと接続先サーバーを同居させる (public: dnf 用にインターネット可)。
    const subnet = this.addSubnet(vpc.attrVpcId, destinationSubnet, true);

    // インターネット経路 (public IP / IPsec 用)。
    const defaultRoute = new ec2.CfnRoute(this, 'DefaultRoute', {
      routeTableId: subnet.routeTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });
    defaultRoute.addDependency(igwAttachment);

    const router = new LibreswanRouter(this, 'Router', {
      vpcId: vpc.attrVpcId,
      subnet,
    });
    this.routerPublicIp = router.publicIp;

    new DestinationServer(this, 'Server', { vpcId: vpc.attrVpcId, subnet });
  }

  private addSubnet(vpcId: string, spec: SubnetSpec, isPublic: boolean): ManagedSubnet {
    const subnet = new ec2.CfnSubnet(this, `${spec.name}Subnet`, {
      vpcId,
      cidrBlock: spec.cidr,
      availabilityZone: spec.az,
      mapPublicIpOnLaunch: isPublic,
      tags: [{ key: 'Name', value: `fixed-egress/destination-${spec.name}` }],
    });
    const routeTable = new ec2.CfnRouteTable(this, `${spec.name}Rt`, {
      vpcId,
      tags: [{ key: 'Name', value: `fixed-egress/destination-${spec.name}-rt` }],
    });
    new ec2.CfnSubnetRouteTableAssociation(this, `${spec.name}RtAssoc`, {
      subnetId: subnet.ref,
      routeTableId: routeTable.ref,
    });
    return { subnet, routeTable };
  }
}
