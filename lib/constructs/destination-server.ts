import { readFileSync } from 'fs';
import { join } from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { clientVpcCidr, destinationServerIp, fixedEgressIp } from '../network-config';
import type { ManagedSubnet } from './client-vpc';

export interface DestinationServerProps {
  readonly vpcId: string;
  readonly subnet: ManagedSubnet;
}

/**
 * 接続先サーバー。送信元 IP allowlist を持つ HTTP サーバー。
 * iptables で送信元 `10.10.0.85` (VIP) のみ許可し、それ以外は drop する。
 * クライアントからのリクエストは SNAT で送信元が VIP になるため通過する。
 */
export class DestinationServer extends Construct {
  constructor(scope: Construct, id: string, props: DestinationServerProps) {
    super(scope, id);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const profile = new iam.CfnInstanceProfile(this, 'Profile', { roles: [role.roleName] });

    const sg = new ec2.CfnSecurityGroup(this, 'Sg', {
      groupDescription: 'Destination server: HTTP from client VPC (allowlist enforced by iptables)',
      vpcId: props.vpcId,
      securityGroupIngress: [
        { ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: clientVpcCidr, description: 'HTTP from client VPC' },
        { ipProtocol: 'icmp', fromPort: -1, toPort: -1, cidrIp: clientVpcCidr, description: 'ICMP from client VPC' },
      ],
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0', description: 'all egress' }],
    });

    const imageId = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;
    const userData = cdk.Fn.base64(
      cdk.Fn.sub(readFileSync(join(__dirname, '../../src/ec2/destination-server-userdata.sh'), 'utf-8'), {
        ALLOWED_SOURCE_IP: fixedEgressIp,
      }),
    );

    new ec2.CfnInstance(this, 'Instance', {
      imageId,
      instanceType: 't3.micro',
      subnetId: props.subnet.subnet.ref,
      privateIpAddress: destinationServerIp,
      securityGroupIds: [sg.attrGroupId],
      iamInstanceProfile: profile.ref,
      sourceDestCheck: true,
      userData,
      tags: [{ key: 'Name', value: 'fixed-egress-destination-server' }],
    });
  }
}
