import * as path from 'path';
import { readFileSync } from 'fs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';
import {
  destinationVpcCidr,
  destinationRouterPrivateIp,
  fixedEgressIp,
  healthConfig,
  region,
  snatInstanceType,
} from '../network-config';
import type { ManagedSubnet } from './client-vpc';

export interface SnatApplianceProps {
  readonly vpcId: string;
  readonly vpcCidr: string;
  /** SNAT 対象とするクライアントサブネット CIDR 群 (自身発の probe を除外するため)。 */
  readonly clientSubnetCidrs: string[];
  /** SNAT インスタンス (ASG) を置くサブネット。 */
  readonly snatSubnetA: ManagedSubnet;
  readonly snatSubnetC: ManagedSubnet;
}

/**
 * SNAT層 (1 枚 ENI 方式, 単一 ASG)。
 *
 * - ASG ×1 (desired=min=max=2, 2 サブネットにまたがる) で常時 2 台 (待機系も常時起動)。
 * - `availabilityZoneDistribution: balanced-only` で「片 AZ に 2 台が偏ること」を防ぐ
 *   (= 各 AZ ちょうど 1 台。起動失敗時も別 AZ へ振らず、その AZ で再試行する)。
 * - ENI はインスタンスのプライマリ 1 枚のみ。固定 ENI / 管理サブネットは持たない。
 * - source/dest check の無効化は userdata が、ルートを現用 ENI へ向ける処理は SnatRouteManager の
 *   Lambda が担う (向け先 ENI が入れ替えで変わるため、ルートは CDK ではなく Lambda が管理する)。
 * - ASG 名は静的文字列で明示する (EventBridge ルール / Lambda env が ref トークンを参照すると
 *   ルール → Lambda → ASG → ルール の循環依存になるため)。
 */
export class SnatAppliance extends Construct {
  /** ルール作成順序の保証に使う ASG (ASG をルールに依存させる)。 */
  public readonly autoScalingGroup: autoscaling.CfnAutoScalingGroup;
  /** ASG 名 (静的)。ルート管理 Lambda がインスタンス / ENI を引くのに使う。 */
  public readonly asgName = 'fixed-egress-snat';

  constructor(scope: Construct, id: string, props: SnatApplianceProps) {
    super(scope, id);

    // --- セキュリティグループ (単一 ENI: 転送クライアント + 戻りトラフィック) -------
    const sg = new ec2.CfnSecurityGroup(this, 'Sg', {
      groupDescription: 'SNAT instance (single ENI): forwarded client and return traffic',
      vpcId: props.vpcId,
      securityGroupIngress: [
        { ipProtocol: '-1', cidrIp: props.vpcCidr, description: 'from clients / health' },
        { ipProtocol: '-1', cidrIp: destinationVpcCidr, description: 'return from destination' },
      ],
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0', description: 'all egress' }],
    });

    // --- インスタンスロール / プロファイル -------------------------------------
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': healthConfig.metricNamespace } },
      }),
    );
    // 起動時に自身の source/dest check を無効化するため (userdata)。
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:ModifyInstanceAttribute'],
        resources: ['*'],
      }),
    );
    const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [instanceRole.roleName],
    });

    const imageId = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;

    // --- 起動テンプレート ×1 (userdata は AZ 非依存なので共有) -------------------
    const userData = cdk.Fn.base64(
      cdk.Fn.sub(readFileSync(path.join(__dirname, '../../src/ec2/snat-userdata.sh'), 'utf-8'), {
        FIXED_EGRESS_IP: fixedEgressIp,
        DEST_VPC_CIDR: destinationVpcCidr,
        CLIENT_CIDRS: props.clientSubnetCidrs.join(' '),
        PROBE_TARGET: destinationRouterPrivateIp,
        METRIC_NAMESPACE: healthConfig.metricNamespace,
        METRIC_NAME: healthConfig.metricName,
        PROBE_INTERVAL: String(healthConfig.probeIntervalSeconds),
        REGION: region,
      }),
    );

    const lt = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateData: {
        imageId,
        instanceType: snatInstanceType,
        iamInstanceProfile: { arn: instanceProfile.attrArn },
        securityGroupIds: [sg.attrGroupId],
        userData,
        metadataOptions: { httpTokens: 'required' },
      },
    });

    // --- ASG ×1 (desired=2, 2 サブネット, balanced-only で各 AZ 1 台) ------------
    this.autoScalingGroup = new autoscaling.CfnAutoScalingGroup(this, 'Asg', {
      autoScalingGroupName: this.asgName,
      minSize: '2',
      maxSize: '2',
      desiredCapacity: '2',
      vpcZoneIdentifier: [props.snatSubnetA.subnet.ref, props.snatSubnetC.subnet.ref],
      launchTemplate: { launchTemplateId: lt.ref, version: lt.attrLatestVersionNumber },
      healthCheckType: 'EC2',
      // 詳細なヘルスチェックで異常を検知して Lambda が Unhealthy 指定する際、起動直後のインスタンスを
      // 保護する猶予 (この間は ShouldRespectGracePeriod により入れ替え対象にしない)。
      healthCheckGracePeriod: 300,
      // 起動失敗時も別 AZ へ振らず当該 AZ で再試行 → 片 AZ に 2 台が偏らない。
      availabilityZoneDistribution: { capacityDistributionStrategy: 'balanced-only' },
      // 起動インスタンスに Name タグを伝播 (何用のインスタンスか分かるように)。
      tags: [{ key: 'Name', value: 'fixed-egress/snat', propagateAtLaunch: true }],
    });
  }
}
