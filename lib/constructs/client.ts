import { readFileSync } from 'fs';
import { join } from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { destinationServerIp } from '../network-config';
import type { ManagedSubnet } from './client-vpc';

export interface ClientProps {
  readonly vpcId: string;
  /** クライアントを配置するサブネット (各 AZ)。 */
  readonly subnets: ManagedSubnet[];
}

/**
 * 検証用クライアント。各 AZ に 1 台。SSM Session Manager 経由でアクセスし、
 * `/usr/local/bin/test-egress.sh` で接続先サーバーへの疎通 (送信元 IP) を確認する。
 */
export class Client extends Construct {
  constructor(scope: Construct, id: string, props: ClientProps) {
    super(scope, id);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const profile = new iam.CfnInstanceProfile(this, 'Profile', { roles: [role.roleName] });

    const sg = new ec2.CfnSecurityGroup(this, 'Sg', {
      groupDescription: 'Client (egress only via SSM / SNAT path)',
      vpcId: props.vpcId,
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0', description: 'all egress' }],
    });

    const imageId = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;
    const userData = cdk.Fn.base64(
      cdk.Fn.sub(readFileSync(join(__dirname, '../../src/ec2/client-userdata.sh'), 'utf-8'), {
        DEST_SERVER_IP: destinationServerIp,
      }),
    );

    props.subnets.forEach((subnet, i) => {
      new ec2.CfnInstance(this, `Instance${i}`, {
        imageId,
        instanceType: 't3.micro',
        subnetId: subnet.subnet.ref,
        securityGroupIds: [sg.attrGroupId],
        iamInstanceProfile: profile.ref,
        userData,
        tags: [{ key: 'Name', value: `fixed-egress-client-${i}` }],
      });
    });
  }
}
