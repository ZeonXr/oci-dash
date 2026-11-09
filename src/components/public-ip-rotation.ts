import type { InstanceSummary, JobSummary, PublicIpBinding, VnicSummary } from "@/lib/contracts";
import { isJobPending } from "@/lib/job-state";
import type { OperationDialogProps } from "./operation-dialog";

export function canRotatePublicIp(binding: PublicIpBinding): boolean {
  return (
    binding.lifetime === "EPHEMERAL" &&
    !binding.protected &&
    Boolean(binding.publicIpId && binding.publicIp)
  );
}

export function rotationNeedsRefresh(
  instance: InstanceSummary,
  rotation?: JobSummary,
  syncJob?: JobSummary,
): boolean {
  if (rotation?.state !== "succeeded") return false;
  const synchronization = rotation.result?.synchronization as { status?: string } | undefined;
  const incomplete =
    synchronization?.status === "completed-with-warnings" ||
    Boolean(
      syncJob &&
      (["failed", "cancelled"].includes(syncJob.state) ||
        (syncJob.state === "interrupted" && !isJobPending(syncJob)) ||
        (Array.isArray(syncJob.result?.warnings) && syncJob.result.warnings.length > 0)),
    );
  if (!incomplete) return false;
  const details = rotation.result?.details as
    { privateIpId?: string; publicIpId?: string; publicIp?: string } | undefined;
  return (
    !details?.privateIpId ||
    !details.publicIpId ||
    !details.publicIp ||
    !instance.vnics.some((vnic) =>
      vnic.privateIps.some(
        (binding) =>
          binding.privateIpId === details.privateIpId &&
          binding.publicIpId === details.publicIpId &&
          binding.publicIp === details.publicIp,
      ),
    )
  );
}

export function ipRotationContext(
  instance: InstanceSummary,
  state: {
    jobs: JobSummary[];
    loading: boolean;
    error: string | null;
    busyInstanceIds: ReadonlySet<string>;
  },
  inventoryError?: string | null,
) {
  const rotation = state.jobs.find(
    (job) =>
      job.kind === "public-ip-rotate" &&
      job.accountId === instance.accountId &&
      job.resourceId === instance.id,
  );
  const synchronization = rotation?.result?.synchronization as
    { status?: string; jobId?: string } | undefined;
  const syncJob =
    rotation?.state === "succeeded" && synchronization?.status === "queued"
      ? state.jobs.find((job) => job.id === synchronization.jobId)
      : undefined;
  const warning = rotationNeedsRefresh(instance, rotation, syncJob);
  const blockedReason = inventoryError
    ? "实例信息读取失败，请刷新资源后再更换 IP"
    : instance.staleFields?.some((field) => ["网卡", "私网 IP", "公网 IP"].includes(field))
      ? "地址信息未完整更新，请先刷新资源"
      : state.loading
        ? "正在读取任务状态，请稍候"
        : state.error
          ? "任务状态读取失败，请重试后再更换 IP"
          : warning
            ? "地址同步不完整，请先刷新资源"
            : state.busyInstanceIds.has(instance.id)
              ? "此实例有未完成的任务，暂时不能更换 IP"
              : undefined;
  return { job: syncJob || rotation, warning, blockedReason };
}

/** Target the selected binding explicitly, including the address the user reviewed. */
export function publicIpRotation(
  instance: InstanceSummary,
  vnic: VnicSummary,
  binding: PublicIpBinding,
): Omit<OperationDialogProps, "onClose"> | null {
  if (
    !canRotatePublicIp(binding) ||
    binding.vnicId !== vnic.id ||
    !instance.vnics.some((item) => item.id === vnic.id) ||
    !vnic.privateIps.some((item) => item.privateIpId === binding.privateIpId)
  )
    return null;
  return {
    title: "更换公网 IP",
    description: "将替换此私网地址绑定的临时公网 IP。旧地址释放后无法保证找回。",
    summary: [
      ["实例", instance.displayName],
      ["网卡名称", vnic.name || vnic.id],
      ["私网地址", binding.privateIp],
      ["当前公网地址", binding.publicIp!],
    ],
    operation: {
      kind: "public-ip-rotate",
      accountId: instance.accountId,
      region: instance.region,
      resourceId: instance.id,
      payload: {
        vnicId: vnic.id,
        privateIpId: binding.privateIpId,
        expectedPublicIpId: binding.publicIpId,
        expectedPublicIp: binding.publicIp,
      },
    },
  };
}
