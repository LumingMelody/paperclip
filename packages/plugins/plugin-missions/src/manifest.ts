import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.missions",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Missions",
  description: "First-party Missions plugin package for Paperclip mission orchestration workflows.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "missions-health-widget",
        displayName: "Missions Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
