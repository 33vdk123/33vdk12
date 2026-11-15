// سجل المزودات — يربط معرف المزود بمحوله المنفذ
import type { ProviderId } from "../models";
import type { ProviderAdapter } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";
import { pollinationsAdapter } from "./pollinations";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  pollinations: pollinationsAdapter,
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export type { ProviderAdapter, CheckResult, CreateTaskResult } from "./types";
