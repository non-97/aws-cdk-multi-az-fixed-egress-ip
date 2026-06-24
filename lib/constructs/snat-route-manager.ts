import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { availabilityZones, destinationVpcCidr, healthConfig } from '../network-config';

export interface SnatRouteManagerProps {
  /** クライアントが属するサブネットのルートテーブル (接続先宛 → 現用 ENI)。 */
  readonly clientRouteTables: ec2.CfnRouteTable[];
  /** 戻りの向け先を指定するゲートウェイ RT (VIP → 現用 ENI)。 */
  readonly gatewayRouteTable: ec2.CfnRouteTable;
  /** VIP 専用サブネット CIDR (10.10.0.80/28)。向ける対象。 */
  readonly vipSubnetCidr: string;
  /** ルール作成順序を保証するため依存させる単一 ASG。 */
  readonly autoScalingGroup: autoscaling.CfnAutoScalingGroup;
  /** ASG 名 (静的)。 */
  readonly asgName: string;
}

/**
 * SNAT のルート管理 + 詳細なヘルスチェック連動のフェイルオーバー (1 枚 ENI 方式)。
 *
 * - 各 AZ の `SnatPathHealthy` を監視するアラーム (欠損は breaching 扱い)。
 * - 3 つの EventBridge ルール (インスタンス起動完了 / 停止や終了 / アラーム状態変化) → Lambda が、
 *   正常な AZ の現用インスタンス ENI へ送信 / 戻りルートを向ける。
 *   source/dest 無効化は各インスタンスが userdata で実施。launch ルールが初回ルートと障害復旧を担う。
 * - 異常なインスタンス (ALARM の AZ) は、正常な対向 AZ があるとき Lambda が ASG 的に Unhealthy にして
 *   入れ替えさせる (両系 ALARM の全系障害では入れ替えが止まらなくなるため行わない)。
 */
export class SnatRouteManager extends Construct {
  constructor(scope: Construct, id: string, props: SnatRouteManagerProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const alarmA = this.healthAlarm('A', availabilityZones.a);
    const alarmC = this.healthAlarm('C', availabilityZones.c);

    // ログは無期限だとコストが嵩むため保持期間を設定する。
    const logGroup = new logs.LogGroup(this, 'RouteManagerLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'RouteManagerFn', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src/lambda/snat-route-manager')),
      timeout: cdk.Duration.minutes(2),
      logGroup,
      // 構造化 JSON ログ + ログレベルを Lambda 設定 (ApplicationLogLevel) で制御する。
      // コード側で setLevel しないので、コンソール / CDK でレベルを変えるだけで切り替わる。
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      // 同時実行を 1 に絞り、複数イベント (起動 / アラーム / スケジュール) が交錯して
      // ルート書き込みがインターリーブするのを防ぐ。最後に走った起動が最新状態で最終決定する。
      reservedConcurrentExecutions: 1,
      environment: {
        // 静的文字列のみ (ref トークンを使うと ASG との循環依存になる)。
        ASG_NAME: props.asgName,
        AZS: stack.toJsonString([availabilityZones.a, availabilityZones.c]),
        ALARM_BY_AZ: stack.toJsonString({
          [availabilityZones.a]: alarmA.alarmName,
          [availabilityZones.c]: alarmC.alarmName,
        }),
        CLIENT_ROUTE_TABLE_IDS: stack.toJsonString(props.clientRouteTables.map((rt) => rt.ref)),
        GATEWAY_ROUTE_TABLE_ID: props.gatewayRouteTable.ref,
        DEST_CIDR: destinationVpcCidr,
        VIP_CIDR: props.vipSubnetCidr,
        PREFER_AZ: availabilityZones.a,
        REPLACE_MIN_AGE_SECONDS: String(healthConfig.replaceMinAgeSeconds),
      },
    });
    // Describe 系はリソースレベルの権限を持てないので * 。
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:DescribeInstances',
          'ec2:DescribeRouteTables',
          'cloudwatch:DescribeAlarms',
        ],
        resources: ['*'],
      }),
    );
    // ルート書き込みは管理対象のルートテーブルに限定 (最小権限)。
    const routeTableArns = [props.gatewayRouteTable, ...props.clientRouteTables].map((rt) =>
      stack.formatArn({ service: 'ec2', resource: 'route-table', resourceName: rt.ref }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:CreateRoute', 'ec2:ReplaceRoute'],
        resources: routeTableArns,
      }),
    );
    // 異常なインスタンスを Unhealthy にして ASG に入れ替えさせる権限 (対象 ASG に限定)。
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['autoscaling:SetInstanceHealth'],
        resources: [
          stack.formatArn({
            service: 'autoscaling',
            resource: 'autoScalingGroup',
            resourceName: `*:autoScalingGroupName/${props.asgName}`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // インスタンス起動完了イベント (静的 ASG 名でフィルタ → ref トークン不要)。
    const launchRule = new events.Rule(this, 'InstanceLaunchRule', {
      eventPattern: {
        source: ['aws.autoscaling'],
        detailType: ['EC2 Instance Launch Successful'],
        detail: { AutoScalingGroupName: [props.asgName] },
      },
      targets: [new targets.LambdaFunction(fn)],
    });

    // EC2 インスタンス状態変化イベント (停止 / 終了)。アラームの欠損確定を待たず数秒で発火し、
    // 停止したインスタンスは describe-instances にヒットしなくなる → その AZ が usable=false →
    // 即座に他 AZ へフェイルオーバー。タグで絞れないので全インスタンス対象だが、Lambda は冪等
    // (無関係なら no-op) なので安全。
    // 各遷移の「最初の状態」だけ拾う (stopping=停止の起点 / shutting-down=終了の起点)。両方必要:
    // stopping は停止を最速検知、shutting-down は stopping を経ない直接終了 (ASG の異常置換等) 用。
    // stopped/terminated は同じ遷移の後追い状態なので拾わない (冗長 + terminated は describe から
    // 消える)。なお ASG インスタンスを停止すると、後で ASG がそれを終了するため stopping に続き
    // shutting-down も発火し Lambda は 2 回起動するが、2 回目は冪等な no-op (既に付け替え済み)。
    new events.Rule(this, 'InstanceStateChangeRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: { state: ['stopping', 'shutting-down'] },
      },
      targets: [new targets.LambdaFunction(fn)],
    });

    // 詳細なヘルスチェックのアラームの状態変化イベント (稼働しているが経路が壊れた場合の予備の検知)。
    new events.Rule(this, 'AlarmStateChangeRule', {
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        resources: [alarmA.alarmArn, alarmC.alarmArn],
      },
      targets: [new targets.LambdaFunction(fn)],
    });

    // 初回起動の launch イベントを漏らさないよう、ルール / Lambda 完成後に ASG を作る。
    // launch ルールが初回ルートの作成と障害復旧を担う (post-deploy Trigger / 定期再同期は持たない)。
    const launchRuleResource = launchRule.node.defaultChild as cdk.CfnResource;
    props.autoScalingGroup.addDependency(launchRuleResource);

    // 既知の運用上の注意点: ルートテーブルを置換するが SNAT インスタンスを作り直さないデプロイの後は、
    // launch イベントが出ないため新ルートテーブルにルートが張られない。その場合はこの Lambda を
    // 手動で 1 回実行して復旧する (自動修復の仕組みは持たない)。
  }

  private healthAlarm(suffix: string, az: string): cloudwatch.Alarm {
    const metric = new cloudwatch.Metric({
      namespace: healthConfig.metricNamespace,
      metricName: healthConfig.metricName,
      dimensionsMap: { Az: az },
      period: cdk.Duration.seconds(healthConfig.alarmPeriodSeconds),
      statistic: cloudwatch.Stats.MINIMUM,
    });

    return new cloudwatch.Alarm(this, `SnatHealthAlarm${suffix}`, {
      metric,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: healthConfig.evaluationPeriods,
      datapointsToAlarm: healthConfig.evaluationPeriods,
      // インスタンスが停止 / 終了して PutMetricData できない (欠損) 場合も異常として検知する。
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: `SNAT detailed health check for ${az}`,
    });
  }
}
