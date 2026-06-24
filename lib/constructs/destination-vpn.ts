import { readFileSync } from "fs";
import { join } from "path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import {
  clientVpcCidr,
  destinationRouterPrivateIp,
  destinationVpcCidr,
  region,
  vpnConfig,
  vpnConnectionTagName,
} from "../network-config";
import type { ManagedSubnet } from "./client-vpc";

export interface LibreswanRouterProps {
  readonly vpcId: string;
  /** ルーターと接続先サーバーを同居させる単一サブネット。 */
  readonly subnet: ManagedSubnet;
}

/**
 * オンプレ側 (customer gateway 役) の libreswan ルーター。
 * 実行時に DescribeVpnConnections で AWS のトンネル設定を取得し IPsec + BGP を自己構成する。
 */
export class LibreswanRouter extends Construct {
  /** クロススタック用: CGW の IP として使うルーターの public IP。 */
  public readonly publicIp: string;

  constructor(scope: Construct, id: string, props: LibreswanRouterProps) {
    super(scope, id);

    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeVpnConnections"],
        resources: ["*"],
      })
    );
    const profile = new iam.CfnInstanceProfile(this, "Profile", {
      roles: [role.roleName],
    });

    const sg = new ec2.CfnSecurityGroup(this, "Sg", {
      groupDescription: "libreswan router: IPsec + tunnel traffic",
      vpcId: props.vpcId,
      securityGroupIngress: [
        {
          ipProtocol: "udp",
          fromPort: 500,
          toPort: 500,
          cidrIp: "0.0.0.0/0",
          description: "IKE",
        },
        {
          ipProtocol: "udp",
          fromPort: 4500,
          toPort: 4500,
          cidrIp: "0.0.0.0/0",
          description: "NAT-T",
        },
        { ipProtocol: "50", cidrIp: "0.0.0.0/0", description: "ESP" },
        {
          ipProtocol: "-1",
          cidrIp: clientVpcCidr,
          description: "tunnel traffic from client VPC",
        },
        {
          ipProtocol: "-1",
          cidrIp: destinationVpcCidr,
          description: "from destination VPC",
        },
      ],
      securityGroupEgress: [
        { ipProtocol: "-1", cidrIp: "0.0.0.0/0", description: "all egress" },
      ],
    });

    const imageId =
      ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;
    const userData = cdk.Fn.base64(
      cdk.Fn.sub(
        readFileSync(
          join(__dirname, "../../src/ec2/vpn-router-userdata.sh"),
          "utf-8"
        ),
        {
          REGION: region,
          VPN_TAG: vpnConnectionTagName,
          LOCAL_CIDR: destinationVpcCidr,
          AMAZON_ASN: String(vpnConfig.amazonSideAsn),
          CUSTOMER_ASN: String(vpnConfig.customerSideAsn),
          PSK: vpnConfig.preSharedKey,
        }
      )
    );

    const instance = new ec2.CfnInstance(this, "Instance", {
      imageId,
      instanceType: "t3.small",
      subnetId: props.subnet.subnet.ref,
      privateIpAddress: destinationRouterPrivateIp,
      securityGroupIds: [sg.attrGroupId],
      iamInstanceProfile: profile.ref,
      sourceDestCheck: false,
      userData,
      tags: [{ key: "Name", value: "fixed-egress-libreswan" }],
    });

    const eip = new ec2.CfnEIP(this, "Eip", { domain: "vpc" });
    new ec2.CfnEIPAssociation(this, "EipAssoc", {
      allocationId: eip.attrAllocationId,
      instanceId: instance.ref,
    });
    this.publicIp = eip.ref;

    // クライアント宛 (戻り) → libreswan ルーター経由でトンネルへ (IGW デフォルトは DestinationVpc 側)。
    new ec2.CfnRoute(this, "ServerToClientRoute", {
      routeTableId: props.subnet.routeTable.ref,
      destinationCidrBlock: clientVpcCidr,
      instanceId: instance.ref,
    });
  }
}
