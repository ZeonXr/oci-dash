import type { OperationRequest } from "@/lib/contracts";
import {
  CloudError,
  type ExecutionContext,
  type OciCredentials,
  type OperationResult,
} from "./types";
import {
  allPages,
  checkCancelled,
  cloudError,
  errorStatus,
  invoke,
  type CloudDocument,
  type OciClients,
} from "./sdk";
import {
  canonical,
  checkEtag,
  checkpoint,
  compartments,
  digest,
  numeric,
  ocid,
  protectedPublicIp,
  requireCompartment,
  retryWindow,
  ruleToCloud,
  securityListRuleId,
  text,
} from "./helpers";
import { attachedVnics, getPublicBinding } from "./read";

export interface ExecuteOptions {
  now(): number;
  pollIntervalMs: number;
  pollAttempts: number;
}
const JOB_TAG = "oci-dash-job";
function result(message: string, details?: CloudDocument): OperationResult {
  return { message, details };
}
async function pause(ms: number, context: ExecutionContext): Promise<void> {
  checkCancelled(context);
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new CloudError("操作已取消", "CANCELLED"));
    };
    const timer = setTimeout(() => {
      context.signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    context.signal.addEventListener("abort", cancel, { once: true });
  });
}
async function waitForInstance(
  clients: OciClients,
  id: string,
  predicate: (instance: CloudDocument) => boolean,
  context: ExecutionContext,
  options: ExecuteOptions,
): Promise<CloudDocument> {
  for (let i = 0; i < options.pollAttempts; i++) {
    const { instance } = await invoke(clients.compute, "getInstance", { instanceId: id }, context);
    if (predicate(instance)) return instance;
    if (instance.lifecycleState === "TERMINATED")
      throw new CloudError("实例已终止，无法完成此操作", "RESOURCE_STATE_CONFLICT");
    if (i + 1 < options.pollAttempts) await pause(options.pollIntervalMs, context);
  }
  throw new CloudError("OCI 操作仍在进行，稍后继续核对结果", "RESOURCE_PENDING", true);
}
async function newIntent(
  context: ExecutionContext,
  key: string,
  data: CloudDocument,
  now: number,
): Promise<CloudDocument> {
  const existing = context.checkpoints[key] as CloudDocument | undefined;
  if (existing) return existing;
  const intent = { ...data, startedAt: now };
  await checkpoint(context, key, intent);
  return intent;
}
function expectedState(instance: CloudDocument, payload: CloudDocument): void {
  if (payload.expectedState !== undefined && payload.expectedState !== instance.lifecycleState)
    throw new CloudError("实例状态已变化，请刷新后重新提交", "RESOURCE_STATE_CONFLICT");
}
function semanticRule(raw: CloudDocument): string {
  const { id: _id, timeCreated: _time, isValid: _valid, ...rest } = raw;
  const clean = (value: any): any =>
    Array.isArray(value)
      ? value.map(clean)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => [k, clean(v)]),
          )
        : value;
  return canonical(
    clean({
      ...rest,
      description: rest.description ?? "",
      isStateless: Boolean(rest.isStateless),
      ...(rest.source ? { sourceType: rest.sourceType ?? "CIDR_BLOCK" } : {}),
      ...(rest.destination ? { destinationType: rest.destinationType ?? "CIDR_BLOCK" } : {}),
    }),
  );
}
function securityListFingerprint(list: CloudDocument): string {
  return digest({
    ingress: list.ingressSecurityRules.map(semanticRule),
    egress: list.egressSecurityRules.map(semanticRule),
  });
}

export async function executeOperation(
  clients: OciClients,
  credentials: OciCredentials,
  operation: OperationRequest,
  context: ExecutionContext,
  options: ExecuteOptions,
): Promise<OperationResult> {
  checkCancelled(context);
  const fingerprint = digest({
    kind: operation.kind,
    resourceId: operation.resourceId,
    region: operation.region,
    payload: operation.payload,
  });
  if (context.checkpoints.operationHash && context.checkpoints.operationHash !== fingerprint)
    throw new CloudError("任务参数与原始操作不一致", "CHECKPOINT_MISMATCH");
  if (!context.checkpoints.operationHash) await checkpoint(context, "operationHash", fingerprint);
  const accessible = await compartments(clients, credentials, context);
  const payload = operation.payload;
  if (operation.kind === "instance-create")
    return createInstance(clients, credentials, operation, context, options, accessible);
  const instanceId = ocid(operation.resourceId, "instance", "实例 ID");
  const response = await invoke(clients.compute, "getInstance", { instanceId }, context);
  const instance = response.instance;
  if (!instance || instance.id !== instanceId)
    throw new CloudError("实例身份不一致", "RESOURCE_MISMATCH");
  requireCompartment(instance.compartmentId, accessible);

  if (["instance-start", "instance-stop", "instance-reboot"].includes(operation.kind)) {
    const target = operation.kind === "instance-stop" ? "STOPPED" : "RUNNING";
    const reboot = operation.kind === "instance-reboot";
    if (!reboot && instance.lifecycleState === target)
      return result("实例已处于目标状态", { instanceId, state: target });
    let intent = context.checkpoints.lifecycleIntent as CloudDocument | undefined;
    if (!intent) {
      expectedState(instance, payload);
      const allowed = operation.kind === "instance-start" ? "STOPPED" : "RUNNING";
      if (instance.lifecycleState !== allowed)
        throw new CloudError("当前实例状态不能执行此操作", "RESOURCE_STATE_CONFLICT");
      intent = await newIntent(
        context,
        "lifecycleIntent",
        {
          instanceId,
          target,
          action:
            operation.kind === "instance-start"
              ? "START"
              : operation.kind === "instance-stop"
                ? "SOFTSTOP"
                : "SOFTRESET",
          etag: checkEtag(response.etag, payload.etag),
        },
        options.now(),
      );
    }
    if (!context.checkpoints.lifecycleAccepted) {
      retryWindow(intent, options.now());
      await context.progress("正在提交实例电源操作", { instanceId, action: intent.action });
      await invoke(
        clients.compute,
        "instanceAction",
        { instanceId, action: intent.action, ifMatch: intent.etag, opcRetryToken: context.jobId },
        context,
      );
      await checkpoint(context, "lifecycleAccepted", true);
    }
    const done = await waitForInstance(
      clients,
      instanceId,
      (current) => current.lifecycleState === target,
      context,
      options,
    );
    return result(reboot ? "重启请求已接受，实例目前处于运行状态" : "实例状态变更已完成", {
      instanceId,
      state: done.lifecycleState,
    });
  }

  if (operation.kind === "instance-rename") {
    const displayName = text(payload.displayName, "实例名称");
    if (instance.displayName === displayName)
      return result("实例名称已更新", { instanceId, displayName });
    const intent = context.checkpoints.renameIntent as CloudDocument | undefined;
    if (!intent) expectedState(instance, payload);
    const plan = await newIntent(
      context,
      "renameIntent",
      { displayName, etag: checkEtag(response.etag, payload.etag) },
      options.now(),
    );
    checkEtag(response.etag, plan.etag);
    await invoke(
      clients.compute,
      "updateInstance",
      { instanceId, ifMatch: plan.etag, updateInstanceDetails: { displayName } },
      context,
    );
    const done = await waitForInstance(
      clients,
      instanceId,
      (current) => current.displayName === displayName,
      context,
      options,
    );
    return result("实例名称已更新", { instanceId: done.id, displayName });
  }

  if (operation.kind === "instance-terminate") {
    if (instance.lifecycleState === "TERMINATED")
      return result("实例已终止", { instanceId, state: "TERMINATED" });
    let plan = context.checkpoints.terminateIntent as CloudDocument | undefined;
    if (!plan) {
      if (instance.lifecycleState === "TERMINATING")
        throw new CloudError(
          "实例已有终止请求，无法改变该请求的磁盘保留选项",
          "RESOURCE_STATE_CONFLICT",
        );
      if (operation.confirmation !== instance.displayName)
        throw new CloudError("终止确认名称与当前实例名称不一致", "CONFIRMATION_REQUIRED");
      expectedState(instance, payload);
      plan = await newIntent(
        context,
        "terminateIntent",
        {
          instanceId,
          etag: checkEtag(response.etag, payload.etag),
          preserveBootVolume: payload.preserveBootVolume !== false,
          preserveDataVolumesCreatedAtLaunch: payload.preserveDataVolumes !== false,
        },
        options.now(),
      );
    }
    if (instance.lifecycleState !== "TERMINATING" && !context.checkpoints.terminateAccepted) {
      await invoke(
        clients.compute,
        "terminateInstance",
        {
          instanceId,
          ifMatch: plan.etag,
          preserveBootVolume: plan.preserveBootVolume,
          preserveDataVolumesCreatedAtLaunch: plan.preserveDataVolumesCreatedAtLaunch,
        },
        context,
      );
      await checkpoint(context, "terminateAccepted", true);
    }
    await waitForInstance(
      clients,
      instanceId,
      (current) => current.lifecycleState === "TERMINATED",
      context,
      options,
    );
    return result("实例已终止", {
      instanceId,
      preserveBootVolume: plan.preserveBootVolume,
      preserveDataVolumes: plan.preserveDataVolumesCreatedAtLaunch,
    });
  }

  const vnics = [
    "public-ip-rotate",
    "security-rule-add",
    "security-rule-delete",
    "ipv6-assign",
  ].includes(operation.kind)
    ? await attachedVnics(clients, instance, context)
    : [];
  if (operation.kind === "public-ip-rotate")
    return rotatePublicIp(clients, operation, instance, vnics, context, options, accessible);
  if (operation.kind === "boot-volume-update")
    return updateBootVolume(clients, operation, instance, context, options);
  if (operation.kind === "security-rule-add" || operation.kind === "security-rule-delete")
    return changeSecurityRule(clients, operation, vnics, context, options);
  if (operation.kind === "ipv6-assign")
    return assignIpv6(clients, operation, vnics, context, options);
  throw new CloudError("此操作类型不受支持", "UNSUPPORTED_OPERATION");
}

async function createInstance(
  clients: OciClients,
  credentials: OciCredentials,
  operation: OperationRequest,
  context: ExecutionContext,
  options: ExecuteOptions,
  accessible: { id: string; name: string }[],
): Promise<OperationResult> {
  const p = operation.payload;
  const compartmentId = ocid(p.compartmentId, ["tenancy", "compartment"], "区间 ID");
  requireCompartment(compartmentId, accessible);
  const existing = (
    await allPages(clients.compute, "listInstances", { compartmentId }, context)
  ).filter((i) => i.freeformTags?.[JOB_TAG] === context.jobId);
  if (existing.length > 1)
    throw new CloudError("发现多个同任务标识的实例，已停止自动创建", "AMBIGUOUS_RESOURCE");
  const knownId = context.checkpoints.createdInstanceId as string | undefined;
  if (knownId || existing.length) {
    const instanceId = knownId ?? existing[0].id;
    const { instance } = await invoke(clients.compute, "getInstance", { instanceId }, context);
    if (
      instance.compartmentId !== compartmentId ||
      instance.freeformTags?.[JOB_TAG] !== context.jobId
    )
      throw new CloudError("恢复的实例与创建任务不一致", "RESOURCE_MISMATCH");
    await checkpoint(context, "createdInstanceId", instanceId);
    if (instance.lifecycleState === "TERMINATED" || instance.lifecycleState === "TERMINATING")
      throw new CloudError("已创建实例被终止，不会自动再建一台", "RESOURCE_STATE_CONFLICT");
    await waitForInstance(
      clients,
      instanceId,
      (i) => i.lifecycleState === "RUNNING" || i.lifecycleState === "STOPPED",
      context,
      options,
    );
    return result("实例创建已完成", { instanceId });
  }
  let plan = context.checkpoints.createIntent as CloudDocument | undefined;
  if (!plan) {
    const displayName = text(p.displayName, "实例名称"),
      availabilityDomain = text(p.availabilityDomain, "可用域"),
      shape = text(p.shape, "实例规格");
    const imageId = ocid(p.imageId, "image", "镜像 ID"),
      subnetId = ocid(p.subnetId, "subnet", "子网 ID");
    const sshPublicKey = text(p.sshPublicKey, "SSH 公钥", 20000);
    if (
      !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(
        sshPublicKey,
      )
    )
      throw new CloudError("SSH 公钥格式不正确", "VALIDATION_ERROR");
    const domains = await allPages(
      clients.identity,
      "listAvailabilityDomains",
      { compartmentId: credentials.tenancyId },
      context,
    );
    if (!domains.some((d) => d.name === availabilityDomain))
      throw new CloudError("可用域不属于所选区域", "RESOURCE_MISMATCH");
    const { subnet } = await invoke(clients.network, "getSubnet", { subnetId }, context);
    requireCompartment(subnet.compartmentId, accessible);
    if (
      subnet.lifecycleState !== "AVAILABLE" ||
      (subnet.availabilityDomain && subnet.availabilityDomain !== availabilityDomain)
    )
      throw new CloudError("子网不可用或与可用域不一致", "RESOURCE_MISMATCH");
    if (p.assignPublicIp === true && subnet.prohibitPublicIpOnVnic)
      throw new CloudError("此子网禁止分配公网 IP", "VALIDATION_ERROR");
    const { image } = await invoke(clients.compute, "getImage", { imageId }, context);
    if (image.lifecycleState !== "AVAILABLE")
      throw new CloudError("镜像不可用", "RESOURCE_STATE_CONFLICT");
    const shapes = await allPages(
      clients.compute,
      "listShapes",
      { compartmentId, availabilityDomain, imageId },
      context,
    );
    const shapeInfo = shapes.find((s) => s.shape === shape);
    if (!shapeInfo) throw new CloudError("规格在所选可用域或镜像下不可用", "VALIDATION_ERROR");
    const shapeConfig = shapeInfo.isFlexible
      ? {
          ocpus: numeric(
            p.ocpus,
            "OCPU",
            shapeInfo.ocpuOptions?.min ?? 1,
            shapeInfo.ocpuOptions?.max ?? 256,
          ),
          memoryInGBs: numeric(
            p.memoryGb,
            "内存",
            shapeInfo.memoryOptions?.minInGBs ?? 1,
            shapeInfo.memoryOptions?.maxInGBs ?? 4096,
          ),
        }
      : undefined;
    const request: CloudDocument = {
      launchInstanceDetails: {
        compartmentId,
        availabilityDomain,
        displayName,
        shape,
        ...(shapeConfig ? { shapeConfig } : {}),
        sourceDetails: {
          sourceType: "image",
          imageId,
          ...(p.bootVolumeSizeGb !== undefined
            ? {
                bootVolumeSizeInGBs: numeric(
                  p.bootVolumeSizeGb,
                  "启动卷容量",
                  image.sizeInMBs ? Math.ceil(image.sizeInMBs / 1024) : 50,
                  32768,
                  true,
                ),
              }
            : {}),
        },
        createVnicDetails: { subnetId, assignPublicIp: p.assignPublicIp === true },
        metadata: { ssh_authorized_keys: sshPublicKey },
        freeformTags: { [JOB_TAG]: context.jobId },
      },
      opcRetryToken: context.jobId,
    };
    plan = await newIntent(context, "createIntent", { request }, options.now());
  }
  retryWindow(plan, options.now());
  await context.progress("正在向 OCI 提交创建请求", { compartmentId });
  const { instance } = await invoke(clients.compute, "launchInstance", plan.request, context);
  if (!instance?.id)
    throw new CloudError("创建响应未包含实例 ID，稍后通过任务标识核对", "UNCERTAIN_OUTCOME", true);
  await checkpoint(context, "createdInstanceId", instance.id);
  await waitForInstance(
    clients,
    instance.id,
    (i) => i.lifecycleState === "RUNNING" || i.lifecycleState === "STOPPED",
    context,
    options,
  );
  return result("实例创建已完成", { instanceId: instance.id });
}

async function rotatePublicIp(
  clients: OciClients,
  operation: OperationRequest,
  instance: CloudDocument,
  vnics: CloudDocument[],
  context: ExecutionContext,
  options: ExecuteOptions,
  accessible: { id: string; name: string }[],
): Promise<OperationResult> {
  const p = operation.payload;
  const vnicId = ocid(p.vnicId, "vnic"),
    privateIpId = ocid(p.privateIpId, "privateip"),
    expectedPublicIpId = ocid(p.expectedPublicIpId, "publicip");
  if (!vnics.some((v) => v.id === vnicId))
    throw new CloudError("指定网卡未挂载到此实例", "RESOURCE_MISMATCH");
  const { privateIp } = await invoke(clients.network, "getPrivateIp", { privateIpId }, context);
  if (privateIp?.vnicId !== vnicId)
    throw new CloudError("私网 IP 不属于指定网卡", "RESOURCE_MISMATCH");
  let current = await getPublicBinding(clients, privateIpId, context);
  let plan = context.checkpoints.rotateIntent as CloudDocument | undefined;
  if (current && protectedPublicIp(current))
    throw new CloudError("保留或受保护的公网 IP 禁止自动轮换", "PROTECTED_PUBLIC_IP");
  if (!plan) {
    if (
      !current ||
      current.id !== expectedPublicIpId ||
      (p.expectedPublicIp && p.expectedPublicIp !== current.ipAddress)
    )
      throw new CloudError("公网 IP 绑定与预期不一致，请刷新后重试", "RESOURCE_CHANGED");
    if (p.protected === true) throw new CloudError("该 IP 已标记为受保护", "PROTECTED_PUBLIC_IP");
    requireCompartment(current.compartmentId, accessible);
    const response = await invoke(
      clients.network,
      "getPublicIp",
      { publicIpId: current.id },
      context,
    );
    if (response.publicIp.privateIpId !== privateIpId || protectedPublicIp(response.publicIp))
      throw new CloudError("公网 IP 绑定或保护状态已变化", "RESOURCE_CHANGED");
    plan = await newIntent(
      context,
      "rotateIntent",
      {
        instanceId: instance.id,
        vnicId,
        privateIpId,
        oldPublicIpId: current.id,
        oldPublicIp: current.ipAddress,
        compartmentId: current.compartmentId,
        deleteEtag: checkEtag(response.etag, undefined),
      },
      options.now(),
    );
  }
  if (
    plan.privateIpId !== privateIpId ||
    plan.oldPublicIpId !== expectedPublicIpId ||
    plan.vnicId !== vnicId
  )
    throw new CloudError("轮换任务恢复参数不一致", "CHECKPOINT_MISMATCH");
  if (current && current.id !== plan.oldPublicIpId) {
    if (
      current.id !== context.checkpoints.rotatedPublicIpId &&
      current.freeformTags?.[JOB_TAG] !== context.jobId
    )
      throw new CloudError("私网 IP 已绑定其他公网地址，已停止轮换", "RESOURCE_CHANGED");
    await checkpoint(context, "rotatedPublicIpId", current.id);
    return result("出口公网 IP 已更换", {
      privateIpId,
      oldPublicIp: plan.oldPublicIp,
      publicIp: current.ipAddress,
      publicIpId: current.id,
    });
  }
  if (current) {
    // Re-read the exact public resource immediately before deletion. Never select the first IP or list-clean others.
    const response = await invoke(
      clients.network,
      "getPublicIp",
      { publicIpId: plan.oldPublicIpId },
      context,
    );
    if (response.publicIp.privateIpId !== privateIpId || protectedPublicIp(response.publicIp))
      throw new CloudError("公网 IP 绑定或保护状态已变化", "RESOURCE_CHANGED");
    checkEtag(response.etag, plan.deleteEtag);
    await checkpoint(context, "rotateDeletionRequested", true);
    await context.progress("正在释放所选出口的临时公网 IP", {
      privateIpId,
      publicIpId: plan.oldPublicIpId,
    });
    await invoke(
      clients.network,
      "deletePublicIp",
      { publicIpId: plan.oldPublicIpId, ifMatch: plan.deleteEtag },
      context,
    );
    await checkpoint(context, "rotateOldIpReleased", true);
  }
  current = await getPublicBinding(clients, privateIpId, context);
  if (current) {
    if (current.id === plan.oldPublicIpId)
      throw new CloudError("旧公网 IP 仍在释放，稍后继续", "RESOURCE_PENDING", true);
    if (current.freeformTags?.[JOB_TAG] !== context.jobId || protectedPublicIp(current))
      throw new CloudError("IP 绑定被其他操作改变", "RESOURCE_CHANGED");
    return result("出口公网 IP 已更换", {
      privateIpId,
      oldPublicIp: plan.oldPublicIp,
      publicIp: current.ipAddress,
      publicIpId: current.id,
    });
  }
  const createPlan = await newIntent(
    context,
    "rotateCreateIntent",
    {
      request: {
        createPublicIpDetails: {
          compartmentId: plan.compartmentId,
          lifetime: "EPHEMERAL",
          privateIpId,
          displayName: `oci-dash-rotate-${context.jobId}`,
          freeformTags: { [JOB_TAG]: context.jobId },
        },
        opcRetryToken: context.jobId,
      },
    },
    options.now(),
  );
  retryWindow(createPlan, options.now());
  await context.progress("旧出口已释放，正在分配新出口；固定保留 IP 不参与操作", { privateIpId });
  const { publicIp } = await invoke(clients.network, "createPublicIp", createPlan.request, context);
  if (!publicIp?.id)
    throw new CloudError(
      "新公网 IP 响应不完整，将通过绑定和幂等令牌核对",
      "UNCERTAIN_OUTCOME",
      true,
    );
  await checkpoint(context, "rotatedPublicIpId", publicIp.id);
  const binding = await getPublicBinding(clients, privateIpId, context);
  if (!binding || binding.id !== publicIp.id || !binding.ipAddress)
    throw new CloudError("新公网 IP 尚未完成绑定，稍后继续核对", "RESOURCE_PENDING", true);
  return result("出口公网 IP 已更换", {
    privateIpId,
    oldPublicIp: plan.oldPublicIp,
    publicIp: binding.ipAddress,
    publicIpId: binding.id,
  });
}

async function updateBootVolume(
  clients: OciClients,
  operation: OperationRequest,
  instance: CloudDocument,
  context: ExecutionContext,
  options: ExecuteOptions,
): Promise<OperationResult> {
  const p = operation.payload,
    bootVolumeId = ocid(p.bootVolumeId, "bootvolume");
  const attachments = await allPages(
    clients.compute,
    "listBootVolumeAttachments",
    {
      compartmentId: instance.compartmentId,
      availabilityDomain: instance.availabilityDomain,
      instanceId: instance.id,
    },
    context,
  );
  if (!attachments.some((a) => a.bootVolumeId === bootVolumeId && a.lifecycleState === "ATTACHED"))
    throw new CloudError("启动卷不属于此实例的当前挂载", "RESOURCE_MISMATCH");
  const response = await invoke(clients.storage, "getBootVolume", { bootVolumeId }, context);
  const volume = response.bootVolume;
  const sizeGb =
    p.sizeGb !== undefined
      ? numeric(p.sizeGb, "启动卷容量", 1, 32768, true)
      : Number(volume.sizeInGBs);
  const vpusPerGb =
    p.vpusPerGb !== undefined
      ? numeric(p.vpusPerGb, "VPU", 0, 120, true)
      : Number(volume.vpusPerGB);
  if (vpusPerGb % 10 !== 0) throw new CloudError("VPU 必须以 10 为步长", "VALIDATION_ERROR");
  if (sizeGb < volume.sizeInGBs) throw new CloudError("启动卷不支持缩容", "VOLUME_SHRINK_REFUSED");
  if (sizeGb > volume.sizeInGBs && sizeGb < 50)
    throw new CloudError("启动卷扩容后的容量至少为 50 GiB", "VALIDATION_ERROR");
  if (sizeGb === volume.sizeInGBs && vpusPerGb === volume.vpusPerGB)
    return result("启动卷已处于目标配置", { bootVolumeId, sizeGb, vpusPerGb });
  let plan = context.checkpoints.volumeIntent as CloudDocument | undefined;
  if (plan && context.checkpoints.volumeAccepted)
    throw new CloudError("启动卷配置正在更新，稍后核对", "RESOURCE_PENDING", true);
  if (!plan)
    plan = await newIntent(
      context,
      "volumeIntent",
      {
        etag: checkEtag(response.etag, p.etag),
        sizeGb,
        vpusPerGb,
        updateDetails: {
          ...(sizeGb > volume.sizeInGBs ? { sizeInGBs: sizeGb } : {}),
          ...(vpusPerGb !== volume.vpusPerGB ? { vpusPerGB: vpusPerGb } : {}),
        },
      },
      options.now(),
    );
  checkEtag(response.etag, plan.etag);
  // Existing 47-GiB boot volumes are valid. OCI's size field has a 50-GiB minimum,
  // so a performance-only change must omit sizeInGBs altogether.
  const updateDetails = plan.updateDetails ?? {
    ...(plan.sizeGb > volume.sizeInGBs ? { sizeInGBs: plan.sizeGb } : {}),
    vpusPerGB: plan.vpusPerGb,
  };
  await invoke(
    clients.storage,
    "updateBootVolume",
    { bootVolumeId, ifMatch: plan.etag, updateBootVolumeDetails: updateDetails },
    context,
  );
  await checkpoint(context, "volumeAccepted", true);
  const after = await invoke(clients.storage, "getBootVolume", { bootVolumeId }, context);
  if (after.bootVolume.sizeInGBs !== sizeGb || after.bootVolume.vpusPerGB !== vpusPerGb)
    throw new CloudError("启动卷配置正在更新，稍后核对", "RESOURCE_PENDING", true);
  return result("启动卷配置已更新", { bootVolumeId, sizeGb, vpusPerGb });
}

async function changeSecurityRule(
  clients: OciClients,
  operation: OperationRequest,
  vnics: CloudDocument[],
  context: ExecutionContext,
  options: ExecuteOptions,
): Promise<OperationResult> {
  const p = operation.payload,
    isNsg = p.groupKind === "nsg";
  if (!isNsg && p.groupKind !== "security-list")
    throw new CloudError("安全规则容器类型不正确", "VALIDATION_ERROR");
  const groupId = ocid(p.groupId, isNsg ? "networksecuritygroup" : "securitylist");
  const add = operation.kind === "security-rule-add";
  const owned = new Set<string>(vnics.flatMap((v) => v.nsgIds ?? []));
  if (!isNsg) {
    owned.clear();
    for (const subnetId of new Set(vnics.map((v) => v.subnetId))) {
      const { subnet } = await invoke(clients.network, "getSubnet", { subnetId }, context);
      for (const id of subnet.securityListIds ?? []) owned.add(id);
    }
  }
  if (!owned.has(groupId)) throw new CloudError("安全规则容器未关联到此实例", "RESOURCE_MISMATCH");
  const newRule = add ? ruleToCloud(p.rule, isNsg) : null;
  if (isNsg) {
    const response = await invoke(
      clients.network,
      "getNetworkSecurityGroup",
      { networkSecurityGroupId: groupId },
      context,
    );
    const rules = await allPages(
      clients.network,
      "listNetworkSecurityGroupSecurityRules",
      { networkSecurityGroupId: groupId },
      context,
    );
    if (newRule && rules.some((r) => semanticRule(r) === semanticRule(newRule)))
      return result("安全规则已存在", { groupId });
    const ruleId = add ? undefined : text(p.ruleId, "规则 ID", 512);
    if (!add && !rules.some((r) => r.id === ruleId))
      return result("安全规则已删除", { groupId, ruleId });
    if (context.checkpoints.nsgAccepted)
      throw new CloudError("规则变更尚未可见，稍后核对", "RESOURCE_PENDING", true);
    let intent = context.checkpoints.nsgIntent as CloudDocument | undefined;
    if (intent && add && !intent.knownNotApplied)
      throw new CloudError(
        "上次添加规则的响应未确认，当前未见目标规则；为避免重复添加已停止重试",
        "UNCERTAIN_OUTCOME",
      );
    if (!intent && p.etag !== undefined) checkEtag(response.etag, p.etag);
    if (!intent) intent = { groupId, ruleId, rule: newRule, startedAt: options.now() };
    await checkpoint(context, "nsgIntent", { ...intent, knownNotApplied: false });
    checkCancelled(context);
    try {
      if (add)
        await clients.network.call("addNetworkSecurityGroupSecurityRules", {
          networkSecurityGroupId: groupId,
          addNetworkSecurityGroupSecurityRulesDetails: { securityRules: [newRule] },
        });
      else
        await clients.network.call("removeNetworkSecurityGroupSecurityRules", {
          networkSecurityGroupId: groupId,
          removeNetworkSecurityGroupSecurityRulesDetails: { securityRuleIds: [ruleId] },
        });
    } catch (error) {
      if ([400, 401, 403, 404, 409, 412, 429].includes(errorStatus(error) ?? 0)) {
        await checkpoint(context, "nsgIntent", { ...intent, knownNotApplied: true });
        throw cloudError(error);
      }
      throw new CloudError("安全规则操作结果尚未确认，请稍后核对", "UNCERTAIN_OUTCOME", true);
    }
    await checkpoint(context, "nsgAccepted", true);
    const after = await allPages(
      clients.network,
      "listNetworkSecurityGroupSecurityRules",
      { networkSecurityGroupId: groupId },
      context,
    );
    if (
      add
        ? !after.some((r) => semanticRule(r) === semanticRule(newRule!))
        : after.some((r) => r.id === ruleId)
    )
      throw new CloudError("规则变更尚未可见，稍后核对", "RESOURCE_PENDING", true);
    return result(add ? "安全规则已添加" : "安全规则已删除", {
      groupId,
      ...(ruleId ? { ruleId } : {}),
    });
  }

  const response = await invoke(
    clients.network,
    "getSecurityList",
    { securityListId: groupId },
    context,
  );
  const before = {
    ingressSecurityRules: response.securityList.ingressSecurityRules ?? [],
    egressSecurityRules: response.securityList.egressSecurityRules ?? [],
  };
  let intent = context.checkpoints.securityListIntent as CloudDocument | undefined;
  if (intent && securityListFingerprint(before) === intent.afterHash)
    return result("安全列表规则已更新", { groupId });
  if (intent && securityListFingerprint(before) !== intent.beforeHash)
    throw new CloudError("安全列表已被其他操作修改", "RESOURCE_CHANGED");
  if (!intent) {
    const etag = checkEtag(response.etag, p.etag, true);
    const after = {
      ingressSecurityRules: [...before.ingressSecurityRules],
      egressSecurityRules: [...before.egressSecurityRules],
    };
    if (newRule) {
      const key =
        (p.rule as CloudDocument).direction === "INGRESS"
          ? "ingressSecurityRules"
          : "egressSecurityRules";
      if (after[key].some((r: CloudDocument) => semanticRule(r) === semanticRule(newRule)))
        return result("安全规则已存在", { groupId });
      after[key].push(newRule);
    } else {
      const ruleId = text(p.ruleId, "规则 ID", 512);
      let found = false;
      for (const [direction, key] of [
        ["INGRESS", "ingressSecurityRules"],
        ["EGRESS", "egressSecurityRules"],
      ] as const) {
        after[key] = after[key].filter((r: CloudDocument, index: number) => {
          const matches = securityListRuleId(direction, index, r) === ruleId;
          if (matches) found = true;
          return !matches;
        });
      }
      if (!found) throw new CloudError("规则标识已过期，请刷新安全列表", "RESOURCE_CHANGED");
    }
    intent = await newIntent(
      context,
      "securityListIntent",
      {
        groupId,
        etag,
        beforeHash: securityListFingerprint(before),
        afterHash: securityListFingerprint(after),
        after,
      },
      options.now(),
    );
  }
  checkEtag(response.etag, intent.etag);
  await invoke(
    clients.network,
    "updateSecurityList",
    { securityListId: groupId, ifMatch: intent.etag, updateSecurityListDetails: intent.after },
    context,
  );
  const verified = await invoke(
    clients.network,
    "getSecurityList",
    { securityListId: groupId },
    context,
  );
  if (
    securityListFingerprint({
      ingressSecurityRules: verified.securityList.ingressSecurityRules ?? [],
      egressSecurityRules: verified.securityList.egressSecurityRules ?? [],
    }) !== intent.afterHash
  )
    throw new CloudError("安全列表变更尚未可见，稍后核对", "RESOURCE_PENDING", true);
  return result("安全列表规则已更新", { groupId });
}

async function assignIpv6(
  clients: OciClients,
  operation: OperationRequest,
  vnics: CloudDocument[],
  context: ExecutionContext,
  options: ExecuteOptions,
): Promise<OperationResult> {
  const p = operation.payload,
    vnicId = ocid(p.vnicId, "vnic");
  const vnic = vnics.find((v) => v.id === vnicId);
  if (!vnic || (p.subnetId && p.subnetId !== vnic.subnetId))
    throw new CloudError("网卡或子网与实例不匹配", "RESOURCE_MISMATCH");
  const existing = await allPages(clients.network, "listIpv6s", { vnicId }, context);
  const known = existing.find(
    (ip) =>
      ip.freeformTags?.[JOB_TAG] === context.jobId || ip.id === context.checkpoints.createdIpv6Id,
  );
  if (known || (existing.length && !context.checkpoints.ipv6Intent))
    return result("网卡已分配 IPv6 地址", {
      vnicId,
      ipv6: (known ?? existing[0]).ipAddress,
      note: "来宾系统和网络访问规则需支持 IPv6 才能使用",
    });
  let intent = context.checkpoints.ipv6Intent as CloudDocument | undefined;
  if (!intent) {
    const { subnet } = await invoke(
      clients.network,
      "getSubnet",
      { subnetId: vnic.subnetId },
      context,
    );
    const prefixes = subnet.ipv6CidrBlocks ?? (subnet.ipv6CidrBlock ? [subnet.ipv6CidrBlock] : []);
    if (!prefixes.length) throw new CloudError("子网尚未配置 IPv6 网段", "IPV6_SUBNET_REQUIRED");
    if (prefixes.length > 1 && !p.ipv6SubnetCidr)
      throw new CloudError("子网包含多个 IPv6 前缀，请明确选择", "IPV6_PREFIX_REQUIRED");
    if (p.ipv6SubnetCidr && !prefixes.includes(p.ipv6SubnetCidr))
      throw new CloudError("IPv6 前缀不属于此子网", "RESOURCE_MISMATCH");
    intent = await newIntent(
      context,
      "ipv6Intent",
      {
        request: {
          createIpv6Details: {
            vnicId,
            displayName: `oci-dash-${context.jobId}`,
            freeformTags: { [JOB_TAG]: context.jobId },
            ...(p.ipv6SubnetCidr ? { ipv6SubnetCidr: p.ipv6SubnetCidr } : {}),
          },
          opcRetryToken: context.jobId,
        },
      },
      options.now(),
    );
  }
  retryWindow(intent, options.now());
  const { ipv6 } = await invoke(clients.network, "createIpv6", intent.request, context);
  if (!ipv6?.id) throw new CloudError("IPv6 创建响应不完整，稍后核对", "UNCERTAIN_OUTCOME", true);
  await checkpoint(context, "createdIpv6Id", ipv6.id);
  const after = await allPages(clients.network, "listIpv6s", { vnicId }, context);
  const address = after.find((ip) => ip.id === ipv6.id);
  if (!address) throw new CloudError("IPv6 分配尚未可见，稍后核对", "RESOURCE_PENDING", true);
  return result("IPv6 地址已分配", {
    vnicId,
    ipv6: address.ipAddress,
    note: "来宾系统和网络访问规则需支持 IPv6 才能使用",
  });
}
