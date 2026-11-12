import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";

export const codeTagClassName =
  "h-auto min-w-0 max-w-full shrink whitespace-normal font-mono font-normal wrap-anywhere";

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
    <Badge
      asChild
      variant="outline"
      className={cn(codeTagClassName, className)}
      title={title ?? children}
    >
      <code>{children}</code>
    </Badge>
  );
}
