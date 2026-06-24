import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FixedEgressStack } from '../lib/fixed-egress-stack';

const env = { account: '123456789012', region: 'ap-northeast-1' };

describe('FixedEgressStack', () => {
  const app = new cdk.App();
  const stack = new FixedEgressStack(app, 'TestFixedEgress', { env });
  const template = Template.fromStack(stack);

  test('VPC は 2 つ (クライアント 10.10.0.0/24, 接続先 192.168.100.0/24)', () => {
    template.resourceCountIs('AWS::EC2::VPC', 2);
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.10.0.0/24' });
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '192.168.100.0/24' });
  });

  test('サブネットは 6 つ (クライアント 5 + 接続先 1)', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  test('VIP 専用サブネット (10.10.0.80/28) が存在する', () => {
    template.hasResourceProperties('AWS::EC2::Subnet', { CidrBlock: '10.10.0.80/28' });
  });

  test('SNAT は 1 枚 ENI 方式 (明示的な NetworkInterface リソースは無し)', () => {
    // 固定 ENI を廃止。SNAT 用の明示 ENI は作らない (ASG インスタンスの暗黙 ENI のみ)。
    template.resourceCountIs('AWS::EC2::NetworkInterface', 0);
  });

  test('VGW と VPN Connection (BGP)', () => {
    template.resourceCountIs('AWS::EC2::VPNGateway', 1);
    template.hasResourceProperties('AWS::EC2::VPNConnection', {
      Type: 'ipsec.1',
      StaticRoutesOnly: false,
    });
  });

  test('VGW ゲートウェイルートテーブルの edge association (VIP 向け先ルートは Lambda 投入)', () => {
    // 向け先 ENI が動的なため、VIP / 接続先宛ルートは CDK では作らず Lambda が投入する。
    template.resourceCountIs('AWS::EC2::GatewayRouteTableAssociation', 1);
  });

  test('ASG ×1 (desired=2, balanced-only で各 AZ 1 台, grace period で起動直後を保護)', () => {
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '2',
      MaxSize: '2',
      DesiredCapacity: '2',
      AutoScalingGroupName: 'fixed-egress-snat',
      AvailabilityZoneDistribution: { CapacityDistributionStrategy: 'balanced-only' },
      // 異常で Unhealthy 指定する際、起動直後のインスタンスを保護する猶予。
      HealthCheckGracePeriod: 300,
    });
  });

  test('ルート管理 Lambda が SetInstanceHealth 権限を持つ (異常インスタンスの入れ替え)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'autoscaling:SetInstanceHealth',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('詳細なヘルスチェックのアラーム ×2 (欠損は breaching)', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'FixedEgress',
      MetricName: 'SnatPathHealthy',
      TreatMissingData: 'breaching',
    });
  });

  test('接続先サーバー (固定 IP) と libreswan (EIP, sourceDestCheck off)', () => {
    template.hasResourceProperties('AWS::EC2::Instance', { PrivateIpAddress: '192.168.100.20' });
    template.hasResourceProperties('AWS::EC2::Instance', { PrivateIpAddress: '192.168.100.5' });
    template.resourceCountIs('AWS::EC2::EIP', 1);
    template.hasResourceProperties('AWS::EC2::Instance', { SourceDestCheck: false });
  });

  test('ルート管理 Lambda が存在する', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(1);
  });
});
