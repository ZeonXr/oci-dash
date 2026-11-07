"use client";

import { useParams } from "next/navigation";
import { ConsoleView } from "@/components/console-view";

export default function InstanceConsolePage() {
  const { id } = useParams<{ id: string }>();
  return <ConsoleView key={id} instanceId={id} />;
}
