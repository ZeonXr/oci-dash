import { regionCountryCode } from "@/lib/region-countries";
import { regionName } from "./format";
import { CodeTag } from "./code-tag";

function RegionFlag({ region }: { region: string }) {
  const country = regionCountryCode(region);
  return country ? (
    <img
      src={`/flags/${country}.svg`}
      width={18}
      height={12}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  ) : null;
}

export function RegionLabel({ region }: { region: string }) {
  const label = regionName(region);
  return (
    <span className="region-label">
      <RegionFlag region={region} />
      <span>{typeof label === "string" ? label : region}</span>
    </span>
  );
}

export function RegionTag({ region, showName = true }: { region: string; showName?: boolean }) {
  const label = regionName(region);
  return (
    <span className="region-tag" title={showName ? undefined : label}>
      {showName && label !== region ? (
        <RegionLabel region={region} />
      ) : (
        <RegionFlag region={region} />
      )}
      <CodeTag>{region}</CodeTag>
    </span>
  );
}
