import { regionCountryCode } from "@/lib/region-countries";
import styles from "./code-tag.module.css";

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

export function RegionTag({ region }: { region: string }) {
  return (
    <span className={`${styles.tag} ${styles.region}`} title={region}>
      <RegionFlag region={region} />
      <code>{region}</code>
    </span>
  );
}
