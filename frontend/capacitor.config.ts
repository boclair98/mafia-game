import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "kr.blackmidnight.game",
  appName: "검은 자정",
  webDir: "out",
  server: { androidScheme: "https" },
  android: { allowMixedContent: false },
};

export default config;
