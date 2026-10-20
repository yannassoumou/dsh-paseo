import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDshProvider } from "./server/bridge.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDshProvider());
  return () => {};
}
