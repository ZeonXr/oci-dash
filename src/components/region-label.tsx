import { regionCountryCode } from "@/lib/region-countries";
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
  return (
    <span className="region-label">
      <RegionFlag region={region} />
      <span>{region}</span>
    </span>
  );
}

export function RegionTag({ region }: { region: string }) {
  return (
    <span className="region-tag">
      <RegionFlag region={region} />
      <CodeTag>{region}</CodeTag>
    </span>
  );
}
