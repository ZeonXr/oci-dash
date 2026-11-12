"use client";
import { Check, Moon, Sun } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { useResource } from "@/components/api";
import { Alert, Badge, Button, Card, ErrorState, LoadingState } from "@/components/ui";
import { formatDate } from "@/components/format";
import type { SettingsResult } from "@/lib/settings-contracts";
import { SettingsSection } from "./settings-section";

export function SettingsGeneral() {
  const { theme, setTheme } = useApp();
  const resource = useResource<SettingsResult>("/api/settings", 30000);
  if (resource.loading) return <LoadingState />;
  const settings = resource.data;
  if (!settings)
    return <ErrorState message={resource.error || "无法加载设置。"} retry={resource.reload} />;
  return (
    <div className="flex flex-col gap-5">
      {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
      <SettingsSection title="外观" description="主题偏好保存在当前浏览器中。">
        <Card>
          <div className="theme-options flex gap-3 max-[620px]:flex-wrap">
            <Button
              className="h-auto min-w-32 flex-col gap-3 p-4 aria-pressed:border-primary aria-pressed:bg-soft aria-pressed:text-primary max-sm:flex-1"
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
            >
              <Sun size={25} />
              <span>浅色{theme === "light" && <Check size={13} className="ml-2" />}</span>
            </Button>
            <Button
              className="h-auto min-w-32 flex-col gap-3 p-4 aria-pressed:border-primary aria-pressed:bg-soft aria-pressed:text-primary max-sm:flex-1"
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              <Moon size={25} />
              <span>深色{theme === "dark" && <Check size={13} className="ml-2" />}</span>
            </Button>
          </div>
        </Card>
      </SettingsSection>
      <SettingsSection title="运行状态" description="查看当前应用与后台任务执行器状态。">
        <Card>
          <dl className="grid grid-cols-[105px_minmax(0,1fr)] gap-x-4 gap-y-4 text-sm [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:flex [&_dd]:min-w-0 [&_dd]:flex-wrap [&_dd]:items-center [&_dd]:gap-1.5 [&_dd]:text-foreground [&_dd]:wrap-anywhere max-[620px]:grid-cols-[85px_minmax(0,1fr)] max-[620px]:gap-x-2.5 max-[620px]:gap-y-3.5 max-[620px]:text-xs">
            <dt>应用版本</dt>
            <dd>{settings.version}</dd>
            <dt>任务执行器</dt>
            <dd>
              <Badge tone={settings.worker.alive ? "success" : "warning"}>
                {settings.worker.alive ? "运行正常" : "未收到心跳"}
              </Badge>
            </dd>
            <dt>最近心跳</dt>
            <dd>{formatDate(settings.worker.lastSeenAt, true)}</dd>
            <dt>执行中任务</dt>
            <dd>{settings.worker.runningJobs}</dd>
          </dl>
          {!settings.worker.alive && (
            <div className="mt-4">
              <Alert>后台执行器尚未连接，已排队的任务会等待执行器恢复。</Alert>
            </div>
          )}
        </Card>
      </SettingsSection>
    </div>
  );
}
