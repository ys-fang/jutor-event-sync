# Claude Code Notes

## TODO

- [x] ~~**同步 GAS 程式碼**：線上部署的 `KNOWN_APP_IDS` 包含 `vocabwall` 和 `vocabprint`，但 repo 中只有 3 個 app。~~ ✅ 已完成
- [x] ~~**改善 daily report**：auto-discover apps, Cloud Monitoring API, two-sheet history, Firestore health alerts~~ ✅ 已完成 (v2)

## Daily Report v2 — 部署注意事項

- 首次部署後需在 GAS 編輯器執行 `setupTrigger()` 設定 09:00 排程
- Service account 已授予 `roles/monitoring.viewer`（jutor-event + jutor-tools）
- Cloud Monitoring API 透過 `jutor-tools` 計費（`X-Goog-User-Project` header）
- SA 在 jutor-tools 需要 `serviceUsageConsumer` + `monitoring.viewer`
- 設計文件：`docs/plans/2026-03-08-daily-report-v2-design.md`
