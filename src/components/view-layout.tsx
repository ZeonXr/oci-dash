import type { ComponentProps } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "./ui/input";

export const filterSelectClassName = cn("w-44 min-w-28 max-w-full max-sm:flex-1");

export function FilterBar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("mb-5 flex min-w-0 flex-wrap items-center gap-3 max-sm:gap-2", className)}
      {...props}
    />
  );
}

export function SearchField({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <div className="flex min-w-52 max-w-sm flex-1 items-center gap-2 rounded-lg border bg-card px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15 max-sm:w-full max-sm:max-w-none max-sm:basis-full">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input
        {...props}
        className={cn("border-0 bg-transparent pl-0 shadow-none focus-visible:ring-0", className)}
      />
    </div>
  );
}

export function DetailList({ className, ...props }: ComponentProps<"dl">) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-4 text-sm max-sm:grid-cols-[5.5rem_minmax(0,1fr)] max-sm:gap-3",
        className,
      )}
      {...props}
    />
  );
}

export function DetailTerm({ className, ...props }: ComponentProps<"dt">) {
  return <dt className={cn("text-muted-foreground", className)} {...props} />;
}

export function DetailValue({ className, ...props }: ComponentProps<"dd">) {
  return (
    <dd
      className={cn("m-0 flex min-w-0 flex-wrap items-center gap-1.5 wrap-anywhere", className)}
      {...props}
    />
  );
}
