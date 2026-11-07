/** The non-secret fields imported from one OCI configuration profile. */
export interface ParsedOciConfig {
  tenancyId: string;
  userId: string;
  fingerprint: string;
  homeRegion: string;
  profileName: string;
}

const MAX_INPUT_BYTES = 16 * 1024;
const REQUIRED_KEYS = ["user", "fingerprint", "tenancy", "region"] as const;
type RequiredKey = (typeof REQUIRED_KEYS)[number];
interface Profile {
  name: string;
  values: Map<RequiredKey, string[]>;
}
const labels: Record<RequiredKey, string> = {
  user: "用户 OCID",
  fingerprint: "密钥指纹",
  tenancy: "租户 OCID",
  region: "区域",
};

function parseValue(raw: string): string {
  const value = raw.trim();
  if (!value || value.startsWith("#") || value.startsWith(";")) return "";
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    const comment = value.search(/\s+[#;]/);
    return (comment === -1 ? value : value.slice(0, comment)).trim();
  }

  let decoded = "";
  for (let i = 1; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && (value[i + 1] === quote || value[i + 1] === "\\")) {
      decoded += value[++i];
    } else if (char === quote) {
      const rest = value.slice(i + 1);
      if (rest && !/^\s+(?:[#;].*)?$/.test(rest)) {
        throw new Error("引号后只能保留空白或以空白分隔的注释。");
      }
      return decoded.trim();
    } else {
      decoded += char;
    }
  }
  throw new Error("配置值的引号未闭合，请检查粘贴的配置。");
}

/**
 * Parse one OCI profile in the browser. No file, environment, or network access occurs.
 * An explicit DEFAULT wins; otherwise exactly one named or unsectioned profile is allowed.
 * Values never inherit from another profile. Unknown fields (including key_file) are ignored.
 */
export function parseOciConfig(input: string): ParsedOciConfig {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("请粘贴 OCI 配置内容。");
  }
  // Check character length first to avoid encoding an arbitrarily large paste.
  if (
    input.length > MAX_INPUT_BYTES ||
    new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES
  ) {
    throw new Error("OCI 配置不能超过 16 KiB，请仅粘贴需要导入的配置。");
  }

  const profiles = new Map<string, Profile>();
  let current: Profile | undefined;
  let unsectioned: Profile | undefined;
  for (const sourceLine of input.replace(/^\uFEFF/, "").split(/\r\n?|\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    if (line.startsWith("[")) {
      const heading = line.match(/^\[([^\]]+)\](?:\s+(?:[#;].*)?)?$/);
      const name = heading?.[1].trim();
      if (!name || /[\x00-\x1f]/.test(name)) {
        throw new Error("配置档标题格式不正确，请使用方括号包围配置档名称。");
      }
      if (profiles.has(name)) throw new Error("存在重复的配置档，请合并或删除重复配置档。");
      current = { name, values: new Map() };
      profiles.set(name, current);
      continue;
    }

    const assignment = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=(.*)$/);
    if (!assignment) throw new Error("配置格式不正确，每个配置项应使用“键=值”。");
    const key = assignment[1].toLowerCase();
    if (!REQUIRED_KEYS.includes(key as RequiredKey)) continue;
    if (!current) {
      unsectioned ??= { name: "DEFAULT", values: new Map() };
      current = unsectioned;
    }
    const requiredKey = key as RequiredKey;
    const values = current.values.get(requiredKey) ?? [];
    values.push(assignment[2]);
    current.values.set(requiredKey, values);
  }

  let selected = profiles.get("DEFAULT");
  if (!selected) {
    const candidates = [...profiles.values(), ...(unsectioned ? [unsectioned] : [])];
    if (candidates.length > 1) {
      throw new Error("配置包含多个配置档，请保留 DEFAULT 配置档或仅粘贴一个完整配置档。");
    }
    selected = candidates[0] ?? { name: "DEFAULT", values: new Map() };
  }

  const values = {} as Record<RequiredKey, string>;
  for (const key of REQUIRED_KEYS) {
    const entries = selected.values.get(key);
    if (!entries?.length) throw new Error(`所选配置档缺少必填项：${labels[key]}。`);
    if (entries.length !== 1) throw new Error(`所选配置档存在重复的${labels[key]}，请仅保留一项。`);
    values[key] = parseValue(entries[0]);
    if (!values[key]) throw new Error(`所选配置档的${labels[key]}不能为空。`);
  }

  // Keep these constraints aligned with the server's account schema.
  if (
    values.user.length < 15 ||
    values.user.length > 512 ||
    !/^ocid1\.user\.[A-Za-z0-9._-]+$/.test(values.user)
  ) {
    throw new Error("用户 OCID 格式不正确。");
  }
  if (
    values.tenancy.length < 15 ||
    values.tenancy.length > 512 ||
    !/^ocid1\.tenancy\.[A-Za-z0-9._-]+$/.test(values.tenancy)
  ) {
    throw new Error("租户 OCID 格式不正确。");
  }
  if (!/^(?:[a-fA-F0-9]{2}:){15}[a-fA-F0-9]{2}$/.test(values.fingerprint)) {
    throw new Error("密钥指纹格式不正确，应为 16 组以冒号分隔的十六进制字符。");
  }
  if (
    values.region.length < 4 ||
    values.region.length > 80 ||
    !/^[a-z][a-z0-9-]+-\d+$/.test(values.region)
  ) {
    throw new Error("区域名称格式不正确。");
  }

  return {
    tenancyId: values.tenancy,
    userId: values.user,
    fingerprint: values.fingerprint.toLowerCase(),
    homeRegion: values.region,
    profileName: selected.name,
  };
}
