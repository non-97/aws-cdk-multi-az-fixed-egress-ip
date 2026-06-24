#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FixedEgressStack } from '../lib/fixed-egress-stack';
import { region } from '../lib/network-config';

const app = new cdk.App();

new FixedEgressStack(app, 'FixedEgressStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});
