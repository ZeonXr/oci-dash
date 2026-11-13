import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const chartTick = { fill: "var(--muted-foreground)", fontSize: 12 };

export function ChartFrame({
  compact = false,
  className,
  ...props
}: ComponentProps<"div"> & { compact?: boolean }) {
  return (
    <div
      role="img"
      className={cn("w-full min-w-0", compact ? "h-56 2xl:h-64" : "h-64 sm:h-72", className)}
      {...props}
    />
  );
}

export function ChartLegend({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ChartSwatch({ color }: { color: string }) {
  return (
    <i
      className="legend-dot size-1.5 shrink-0 rounded-full"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

export function ChartLegendItem({
  color,
  children,
}: {
  color: string;
  children: ComponentProps<"span">["children"];
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
      <ChartSwatch color={color} />
      {children}
    </span>
  );
}

export function ChartTooltip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid max-w-72 gap-1.5 rounded-lg border border-border bg-popover p-3 text-xs leading-normal text-popover-foreground shadow-md wrap-anywhere",
        className,
      )}
      {...props}
    />
  );
}
