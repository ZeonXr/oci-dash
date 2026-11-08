"use client";
import { Check, Moon, Sun } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { useResource } from "@/components/api";
import { Alert, Badge, Card, ErrorState, LoadingState } from "@/components/ui";
import { formatDate } from "@/components/format";
import type { SettingsResult } from "@/lib/settings-contracts";

export function SettingsGeneral() {
  const { theme, setTheme } = useApp();
  const resource = useResource<SettingsResult>("/api/settings", 30000);
  if (resource.loading) return <LoadingState />;
  const settings = resource.data;
  if (!settings)
    return <ErrorState message={resource.error || "无法加载设置。"} retry={resource.reload} />;
  return (
    <div className="stack">
      {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
      <div className="settings-section">
        <div className="settings-copy">
          <h2>外观</h2>
          <p>主题偏好保存在当前浏览器中。</p>
        </div>
        <Card>
          <div className="theme-options">
            <button
              className={`theme-option ${theme === "light" ? "selected" : ""}`}
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
            >
              <Sun size={25} />
              <span>浅色{theme === "light" && <Check size={13} style={{ marginLeft: 8 }} />}</span>
            </button>
            <button
              className={`theme-option ${theme === "dark" ? "selected" : ""}`}
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              <Moon size={25} />
              <span>深色{theme === "dark" && <Check size={13} style={{ marginLeft: 8 }} />}</span>
            </button>
          </div>
        </Card>
      </div>
      <div className="settings-section">
        <div className="settings-copy">
          <h2>运行状态</h2>
          <p>查看当前应用与后台任务执行器状态。</p>
        </div>
        <Card>
          <dl className="details-list">
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
            <div style={{ marginTop: 18 }}>
              <Alert>后台执行器尚未连接，已排队的任务会等待执行器恢复。</Alert>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
