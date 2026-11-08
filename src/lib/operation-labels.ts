import type { OperationKind } from "./contracts";

export const operationLabels: Record<OperationKind, string> = {
  "sync-account": "同步账号",
  "instance-start": "启动实例",
  "instance-stop": "停止实例",
  "instance-reboot": "重启实例",
  "instance-terminate": "终止实例",
  "instance-rename": "重命名实例",
  "instance-create": "创建实例",
  "public-ip-rotate": "更换公网 IP",
  "boot-volume-update": "更新启动卷",
  "security-rule-add": "添加安全规则",
  "security-rule-delete": "删除安全规则",
  "ipv6-assign": "分配 IPv6",
};
