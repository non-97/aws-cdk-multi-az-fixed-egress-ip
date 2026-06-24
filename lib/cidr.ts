/**
 * CIDR の最初のホストアドレス (base + 1) を返す。
 * VPC サブネットのルーター (暗黙のゲートウェイ) は常にサブネット先頭 + 1。
 */
export function subnetGatewayIp(cidr: string): string {
  const [addr] = cidr.split('/');
  const octets = addr.split('.').map((o) => Number(o));
  octets[3] += 1;
  return octets.join('.');
}
