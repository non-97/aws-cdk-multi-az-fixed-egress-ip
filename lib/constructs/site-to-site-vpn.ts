import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { vpnConfig, vpnConnectionTagName } from '../network-config';

export interface SiteToSiteVpnProps {
  readonly vpnGateway: ec2.CfnVPNGateway;
  readonly vpnGatewayAttachment: ec2.CfnVPCGatewayAttachment;
  /** CGW の IP (オンプレ側 = VPN ルーターの public IP)。 */
  readonly customerGatewayIp: string;
}

/**
 * Site-to-Site VPN (CGW + VPN Connection, BGP)。
 *
 * トンネルオプション (IKEv2 / Phase1-2 アルゴリズム / DH 14-24 / DPD / CloudWatch ログ) は
 * 参考リポジトリ aws-cdk-cloud-wan と同一。
 */
export class SiteToSiteVpn extends Construct {
  public readonly vpnConnection: ec2.CfnVPNConnection;

  constructor(scope: Construct, id: string, props: SiteToSiteVpnProps) {
    super(scope, id);

    const cgw = new ec2.CfnCustomerGateway(this, 'CustomerGateway', {
      type: 'ipsec.1',
      bgpAsn: vpnConfig.customerSideAsn,
      ipAddress: props.customerGatewayIp,
    });

    const activityLog = new logs.LogGroup(this, 'ActivityLog', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const bgpLog = new logs.LogGroup(this, 'BgpLog', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logArn = (lg: logs.ILogGroup): string =>
      cdk.Arn.format(
        {
          service: 'logs',
          resource: 'log-group',
          resourceName: lg.logGroupName,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        },
        cdk.Stack.of(this),
      );

    const dh = [14, 15, 16, 19, 20, 21, 22, 23, 24].map((value) => ({ value }));
    const enc = [{ value: 'AES256' }, { value: 'AES128-GCM-16' }, { value: 'AES256-GCM-16' }];
    const integ = [{ value: 'SHA2-256' }, { value: 'SHA2-384' }, { value: 'SHA2-512' }];

    const tunnelOptions = {
      ikeVersions: [{ value: 'ikev2' }],
      phase1EncryptionAlgorithms: enc,
      phase1IntegrityAlgorithms: integ,
      phase1DhGroupNumbers: dh,
      phase2EncryptionAlgorithms: enc,
      phase2IntegrityAlgorithms: integ,
      phase2DhGroupNumbers: dh,
      dpdTimeoutAction: 'clear',
      startupAction: 'add',
      logOptions: {
        cloudwatchLogOptions: {
          logEnabled: true,
          logGroupArn: logArn(activityLog),
          logOutputFormat: 'json',
          bgpLogEnabled: true,
          bgpLogGroupArn: logArn(bgpLog),
          bgpLogOutputFormat: 'json',
        },
      },
    };

    this.vpnConnection = new ec2.CfnVPNConnection(this, 'Resource', {
      type: 'ipsec.1',
      customerGatewayId: cgw.ref,
      vpnGatewayId: props.vpnGateway.ref,
      staticRoutesOnly: false,
      vpnTunnelOptionsSpecifications: [
        { tunnelInsideCidr: vpnConfig.tunnel1InsideCidr, preSharedKey: vpnConfig.preSharedKey, ...tunnelOptions },
        { tunnelInsideCidr: vpnConfig.tunnel2InsideCidr, preSharedKey: vpnConfig.preSharedKey, ...tunnelOptions },
      ],
      tags: [{ key: 'Name', value: vpnConnectionTagName }],
    });
    this.vpnConnection.addDependency(props.vpnGatewayAttachment);
  }
}
