import { clsx } from "clsx";
import styles from "./code-tag.module.css";

export function CodeTag({
  children,
  title,
  className,
}: {
  children: string;
  title?: string;
  className?: string;
}) {
  return (
    <code className={clsx(styles.tag, className)} title={title ?? children}>
      {children}
    </code>
  );
}
