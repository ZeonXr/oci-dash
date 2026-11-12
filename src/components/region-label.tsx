import { regionCountryCode } from "@/lib/region-countries";
import { cn } from "@/lib/utils";
import { codeTagClassName } from "./code-tag";
import { Badge } from "./ui/badge";

function RegionFlag({ region }: { region: string }) {
  const country = regionCountryCode(region);
  return country ? (
    <img
      className="h-3 w-4.5 shrink-0 rounded-xs object-contain"
      src={`/flags/${country}.svg`}
      width={18}
      height={12}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  ) : null;
}

export function RegionTag({ region }: { region: string }) {
  return (
    <Badge variant="outline" className={cn(codeTagClassName, "gap-1.5")} title={region}>
      <RegionFlag region={region} />
      <code className="min-w-0 [font:inherit]">{region}</code>
    </Badge>
  );
}
