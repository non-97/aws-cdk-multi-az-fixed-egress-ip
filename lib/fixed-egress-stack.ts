import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { ClientVpc } from "./constructs/client-vpc";
import { SnatAppliance } from "./constructs/snat-appliance";
import { FixedEgressRouting } from "./constructs/fixed-egress-routing";
import { SnatRouteManager } from "./constructs/snat-route-manager";
import { Client } from "./constructs/client";
import { DestinationVpc } from "./constructs/destination-vpc";
import { SiteToSiteVpn } from "./constructs/site-to-site-vpn";
import { clientSubnets } from "./network-config";

/**
 * Multi-AZ 固定送信元 IP egress 基盤 (単一スタック)。
 *
 * - クライアント VPC (10.10.0.0/24): SNAT (ASG, 1 枚 ENI) / 固定送信元ルーティング /
 *   ルート管理 (フェイルオーバー) / VGW / 検証用クライアント
 * - 接続先サーバー VPC (192.168.100.0/24): libreswan (CGW 役) + 接続先サーバー
 * - 両 VPC を S2S VPN (BGP) で接続
 */
export class FixedEgressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 全リソースに Project タグ (何用のリソースか分かるように)。
    cdk.Tags.of(this).add("Project", "fixed-egress");

    // --- 接続先サーバー VPC (別 VPC) ------------------------------------------
    const destination = new DestinationVpc(this, "Destination");

    // --- クライアント VPC ------------------------------------------------------
    const clientVpc = new ClientVpc(this, "ClientVpc");
    const vpcId = clientVpc.vpc.attrVpcId;

    // クライアント / SNAT サブネットは用途ごとに RT を共有 (各 1 つ)。
    const clientRouteTables = [clientVpc.clientRouteTable];

    // --- 固定送信元ルーティングの静的部分 (VGW 伝播 + 空のゲートウェイ RT) -----------
    // 向け先 ENI が動的なため、SNAT より先に作る (Lambda が後で実ルートを投入)。
    const routing = new FixedEgressRouting(this, "Routing", {
      vpcId,
      vpnGateway: clientVpc.vpnGateway,
      vpnGatewayAttachment: clientVpc.vpnGatewayAttachment,
      snatRouteTables: [clientVpc.snatRouteTable],
    });

    // --- SNAT (ASG 常時2台, 1 枚 ENI) -----------------------------------------
    const snat = new SnatAppliance(this, "Snat", {
      vpcId,
      vpcCidr: clientVpc.cidr,
      clientSubnetCidrs: [clientSubnets.clientA.cidr, clientSubnets.clientC.cidr],
      snatSubnetA: clientVpc.subnets.snatA,
      snatSubnetC: clientVpc.subnets.snatC,
    });

    // --- ルート管理 + 詳細なヘルスチェック連動のフェイルオーバー ---------------------------
    new SnatRouteManager(this, "RouteManager", {
      clientRouteTables,
      gatewayRouteTable: routing.gatewayRouteTable,
      vipSubnetCidr: clientSubnets.vip.cidr,
      autoScalingGroup: snat.autoScalingGroup,
      asgName: snat.asgName,
    });

    // --- 検証用クライアント ---------------------------------------------------
    new Client(this, "Client", {
      vpcId,
      subnets: [clientVpc.subnets.clientA, clientVpc.subnets.clientC],
    });

    // --- S2S VPN (CGW + VPN Connection, BGP) ----------------------------------
    new SiteToSiteVpn(this, "SiteToSiteVpn", {
      vpnGateway: clientVpc.vpnGateway,
      vpnGatewayAttachment: clientVpc.vpnGatewayAttachment,
      customerGatewayIp: destination.routerPublicIp,
    });
  }
}
