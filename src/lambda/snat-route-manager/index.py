"""SNAT のルート管理 (1 枚 ENI 方式, 冪等)。

インスタンス起動完了イベント / アラーム状態変化イベントを受けるたびに、望ましい状態を
再計算して適用する (イベントの中身には依存しない):
  1. 各 AZ の現用インスタンスのプライマリ ENI を発見
  2. アラーム状態 + インスタンス存在から現用 AZ を決定 (現用が正常 & 稼働中ならそのまま維持し、切り替えない)
  3. クライアント RT (接続先宛) と VGW ゲートウェイ RT (VIP) を現用 ENI へ向ける
  4. 正常な対向 AZ があるとき、ALARM の AZ の異常なインスタンスを ASG 的に Unhealthy にして
     入れ替えさせる (両系 ALARM の全系障害では行わない。起動して間もないインスタンスも見送る)

source/dest check の無効化はインスタンス自身が userdata で行う (ここでは扱わない)。
"""

from datetime import datetime, timedelta, timezone
import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

# ログレベルは Lambda の Advanced Logging Controls (ApplicationLogLevel) で制御する。
# コード側で setLevel するとその設定を上書きしてしまうため、ここでは設定しない。
logger = logging.getLogger()

ec2 = boto3.client("ec2")
cw = boto3.client("cloudwatch")
asg = boto3.client("autoscaling")

# 単一 ASG の名前。各 AZ のインスタンスは availability-zone フィルタで引き分ける。
ASG_NAME = os.environ.get("ASG_NAME")
# 対象 AZ 一覧 ["<az-a>", "<az-c>"]
AZS = json.loads(os.environ.get("AZS", "[]"))
# {"<az>": "<alarm name>"}
ALARM_BY_AZ = json.loads(os.environ.get("ALARM_BY_AZ", "{}"))
CLIENT_ROUTE_TABLE_IDS = json.loads(
    os.environ.get("CLIENT_ROUTE_TABLE_IDS", "[]")
)
GATEWAY_ROUTE_TABLE_ID = os.environ.get("GATEWAY_ROUTE_TABLE_ID")
DEST_CIDR = os.environ.get("DEST_CIDR")
VIP_CIDR = os.environ.get("VIP_CIDR")
# 両系正常な初回はこの AZ を現用にする (tie-break)。
PREFER_AZ = os.environ.get("PREFER_AZ")
# 異常で入れ替える際、起動からこの秒数に満たないインスタンスは見送る (入れ替えの連続を緩和)。
REPLACE_MIN_AGE_SECONDS = int(os.environ.get("REPLACE_MIN_AGE_SECONDS", "600"))


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """イベントを受け、望ましいルート状態を再計算して適用する。

    Args:
        event: EventBridge / 手動実行のイベント。中身には依存せず、種別の判定だけに使う。
        _context: Lambda の実行コンテキスト (未使用)。

    Returns:
        処理結果の要約。changed / activeAz / target などを含む dict。
    """
    event = event or {}
    logger.info(
        "trigger", extra={"detailType": event.get("detail-type", "direct")}
    )

    # EC2 状態変化イベントは全インスタンス対象で届く (イベントにタグが無く EventBridge 側で
    # 絞れない)。自 ASG のインスタンスでなければ無関係なので、ここで即 return する。
    if event.get("detail-type") == "EC2 Instance State-change Notification":
        iid = (event.get("detail") or {}).get("instance-id")
        if not _belongs_to_asg(iid):
            logger.info(
                "ignore non-SNAT state-change", extra={"instanceId": iid}
            )
            return {"changed": False, "ignored": iid}

    azs = list(AZS)

    # 1) 各 AZ の現用インスタンス (id + プライマリ ENI) を発見 (source/dest 無効化は userdata 側)。
    eni_by_az: dict[str, str] = {}
    instance_by_az: dict[str, str] = {}
    launch_by_az: dict[str, datetime | None] = {}
    for az in azs:
        iid, eni_id, launch = _primary_instance(ASG_NAME, az)
        if iid:
            instance_by_az[az] = iid
            launch_by_az[az] = launch
        if eni_id:
            eni_by_az[az] = eni_id
    logger.info("eni discovered", extra={"eniByAz": eni_by_az})

    # 2) 現用 AZ を決定。現在の向け先 ENI から現用 AZ を逆引きし、正常 & 稼働中ならそのまま維持する。
    healthy = _health_by_az(azs)
    current_eni = _current_steer_eni()
    current_az = next(
        (az for az in azs if eni_by_az.get(az) == current_eni), None
    )

    def usable(az: str) -> bool:
        return bool(healthy.get(az)) and bool(eni_by_az.get(az))

    if current_az and usable(current_az):
        active_az = current_az  # フラッピング / 不要な切り戻しを避ける
    else:
        candidates = [az for az in azs if usable(az)]
        if candidates:
            active_az = PREFER_AZ if PREFER_AZ in candidates else candidates[0]
        elif current_eni is None:
            # ブートストラップ: まだ向け先が無く正常判定も付かない初回は、ENI が存在する
            # prefer AZ へ暫定で向ける (起動直後の breaching で永久に未設定になるのを防ぐ。
            # 本当に異常なら詳細なヘルスチェック確立後にフェイルオーバーする)。
            active_az = PREFER_AZ if eni_by_az.get(PREFER_AZ) else next(
                (az for az in azs if eni_by_az.get(az)), None
            )
        else:
            active_az = None

    logger.info(
        "active az decided",
        extra={
            "currentAz": current_az,
            "activeAz": active_az,
            "healthy": healthy,
        },
    )

    if not active_az:
        logger.info(
            "no usable AZ; leaving routes as-is", extra={"healthy": healthy}
        )
        return {"changed": False}

    # 3) 全ルート (クライアント RT + ゲートウェイ RT) を現用 ENI へ毎回冪等に upsert する。
    #    ゲートウェイ RT だけ見て "既に正しい" と短絡してはいけない: RT 入替などで一部の RT
    #    だけルートが欠落する「部分ドリフト」を見落とすため (実際にこれで疎通断が起きた)。
    #    ReplaceRoute は冪等なので、既に正しい場合に毎回書いても無害。
    target = eni_by_az[active_az]
    _point_routes(target)
    logger.info(
        "routes synced",
        extra={
            "target": target,
            "activeAz": active_az,
            "prevGatewayEni": current_eni,
        },
    )

    # 4) 異常なインスタンスの入れ替え (条件付きフェイルオーバー)。正常な対向 AZ が「実際に存在する」
    #    ときだけ行う。ブートストラップ等で両系異常でも active_az が便宜的に決まる場合があるが、
    #    その状況で入れ替えると、フェイルオーバー先が無いまま両系を terminate して churn になる
    #    だけなので、usable な AZ が無ければ何もしない。起動直後の新インスタンスは grace period と
    #    起動からの経過時間で二重に保護し、片 AZ で起動と入れ替えを繰り返すのを緩和する。
    if any(usable(az) for az in azs):
        for az in azs:
            if not healthy.get(az) and instance_by_az.get(az):
                if _too_young(launch_by_az.get(az)):
                    logger.info(
                        "skip replace (within cooldown)",
                        extra={"az": az, "instanceId": instance_by_az[az]},
                    )
                    continue
                _mark_unhealthy(instance_by_az[az])

    return {
        "changed": target != current_eni,
        "activeAz": active_az,
        "target": target,
    }


def _belongs_to_asg(instance_id: str | None) -> bool:
    """指定インスタンスが自 ASG のものかを判定する (EC2 状態変化イベントのガード用)。

    Args:
        instance_id: 判定対象のインスタンス id。None / 空文字なら False を返す。

    Returns:
        自 ASG のインスタンスなら True。

    Raises:
        ClientError: NotFound 以外の describe-instances エラー。
    """
    if not instance_id:
        return False
    try:
        res = ec2.describe_instances(
            InstanceIds=[instance_id],
            Filters=[
                {"Name": "tag:aws:autoscaling:groupName", "Values": [ASG_NAME]}
            ],
        )
    except ClientError as e:
        # 既に消えたインスタンス (terminated) 等は NotFound。無関係扱いでよい
        # (停止直前の shutting-down イベントで既に処理済みのため)。
        if "NotFound" in e.response.get("Error", {}).get("Code", ""):
            return False
        raise
    return any(r.get("Instances") for r in res.get("Reservations", []))


def _primary_instance(
    asg_name: str | None, az: str
) -> tuple[str | None, str | None, datetime | None]:
    """ASG 名 + AZ で現用 (pending/running) の最新 1 台を引く。

    単一 ASG なので availability-zone フィルタが必須 (無いと両 AZ 用に同じ 1 台を返してしまう)。

    Args:
        asg_name: 対象 ASG 名。None なら何も引かない。
        az: 対象アベイラビリティーゾーン。

    Returns:
        (instance_id, primary_eni_id, launch_time) のタプル。該当が無ければ全て None。
    """
    if not asg_name:
        return None, None, None
    res = ec2.describe_instances(
        Filters=[
            {"Name": "tag:aws:autoscaling:groupName", "Values": [asg_name]},
            {"Name": "availability-zone", "Values": [az]},
            {"Name": "instance-state-name", "Values": ["pending", "running"]},
        ]
    )
    instances = [
        i
        for r in res.get("Reservations", [])
        for i in r.get("Instances", [])
    ]
    instances.sort(key=lambda i: i.get("LaunchTime"), reverse=True)
    if not instances:
        return None, None, None
    inst = instances[0]
    eni_id = None
    for ni in inst.get("NetworkInterfaces", []):
        if ni.get("Attachment", {}).get("DeviceIndex") == 0:
            eni_id = ni.get("NetworkInterfaceId")
            break
    return inst.get("InstanceId"), eni_id, inst.get("LaunchTime")


def _too_young(launch_time: datetime | None) -> bool:
    """起動から `REPLACE_MIN_AGE_SECONDS` 秒に満たないインスタンスかを判定する (歯止め)。

    grace period (ShouldRespectGracePeriod) に加えた緩和策。起動して間もないインスタンスを
    続けて入れ替えると、片 AZ で起動と入れ替えを繰り返す恐れがあるため、一定時間は見送る。

    Args:
        launch_time: 対象インスタンスの起動時刻 (timezone 付き)。None なら歯止めを効かせない。

    Returns:
        起動から猶予時間に満たなければ True (= 入れ替えを見送る)。
    """
    if not launch_time:
        return False
    age = datetime.now(timezone.utc) - launch_time
    return age < timedelta(seconds=REPLACE_MIN_AGE_SECONDS)


def _mark_unhealthy(instance_id: str) -> None:
    """異常なインスタンスを ASG 的に Unhealthy にして入れ替えさせる。

    ShouldRespectGracePeriod=True なので、起動直後 (ASG の healthCheckGracePeriod 内) の
    インスタンスは保護され、ブート中に終了されない。既に終了 / 置換中なら例外は無視する。

    Args:
        instance_id: Unhealthy にするインスタンス id。
    """
    try:
        asg.set_instance_health(
            InstanceId=instance_id,
            HealthStatus="Unhealthy",
            ShouldRespectGracePeriod=True,
        )
        logger.info(
            "marked unhealthy for replacement",
            extra={"instanceId": instance_id},
        )
    except ClientError as e:
        logger.warning(
            "set_instance_health failed",
            extra={"instanceId": instance_id, "error": str(e)},
        )


def _health_by_az(azs: list[str]) -> dict[str, bool]:
    """AZ ごとの正常性を返す (アラームが ALARM 以外なら正常)。

    Args:
        azs: 対象 AZ の一覧。

    Returns:
        {AZ: 正常か} の dict。OK / INSUFFICIENT_DATA は正常 (True) 扱い。
    """
    names = [ALARM_BY_AZ[az] for az in azs if ALARM_BY_AZ.get(az)]
    res = cw.describe_alarms(AlarmNames=names)
    state_by_name = {
        a["AlarmName"]: a["StateValue"] for a in res.get("MetricAlarms", [])
    }
    return {az: state_by_name.get(ALARM_BY_AZ.get(az)) != "ALARM" for az in azs}


def _current_steer_eni() -> str | None:
    """VGW ゲートウェイ RT の VIP ルートが現在向いている ENI を返す。

    Returns:
        現用 ENI の id。ルート未設定なら None。
    """
    res = ec2.describe_route_tables(RouteTableIds=[GATEWAY_ROUTE_TABLE_ID])
    tables = res.get("RouteTables", [])
    if not tables:
        return None
    for route in tables[0].get("Routes", []):
        if route.get("DestinationCidrBlock") == VIP_CIDR:
            return route.get("NetworkInterfaceId")
    return None


def _point_routes(eni_id: str) -> None:
    """クライアント RT (接続先宛) と VGW ゲートウェイ RT (VIP) を現用 ENI へ向ける。

    Args:
        eni_id: 向け先の現用 ENI id。
    """
    for rt_id in CLIENT_ROUTE_TABLE_IDS:
        _upsert_route(rt_id, DEST_CIDR, eni_id)
    _upsert_route(GATEWAY_ROUTE_TABLE_ID, VIP_CIDR, eni_id)


def _upsert_route(route_table_id: str, cidr: str, eni_id: str) -> None:
    """ルートが無ければ作成、有れば置換し、どちらの状況でも収束させる。

    Create を先に試す: 既存ルートへの Create は明確に `RouteAlreadyExists` を返すため判定が堅牢。
    (逆に未定義ルートへの Replace は `InvalidParameterValue` "no route defined" でコードが曖昧。)

    Args:
        route_table_id: 対象ルートテーブル id。
        cidr: 宛先 CIDR。
        eni_id: 向け先の ENI id。

    Raises:
        ClientError: RouteAlreadyExists 以外の create/replace エラー。
    """
    try:
        ec2.create_route(
            RouteTableId=route_table_id,
            DestinationCidrBlock=cidr,
            NetworkInterfaceId=eni_id,
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code", "") == "RouteAlreadyExists":
            ec2.replace_route(
                RouteTableId=route_table_id,
                DestinationCidrBlock=cidr,
                NetworkInterfaceId=eni_id,
            )
        else:
            raise
