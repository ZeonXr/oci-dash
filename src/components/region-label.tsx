import { regionCountryCode } from "@/lib/region-countries";
import { regionName } from "./format";

export function RegionLabel({ region }: { region: string }) {
  const country = regionCountryCode(region);
  const label = regionName(region);
  return (
    <span className="region-label">
      {country && (
        <img
          src={`/flags/${country}.svg`}
          width={18}
          height={12}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      <span>{typeof label === "string" ? label : region}</span>
    </span>
  );
}
