// سجل المزودات — يربط معرف المزود بمحوله المنفذ
import type { ProviderId } from "../models";
import type { ProviderAdapter } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export type { ProviderAdapter, CheckResult, CreateTaskResult } from "./types";
