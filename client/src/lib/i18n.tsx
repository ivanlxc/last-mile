import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import * as english from "./narrative.en";
import * as chinese from "./narrative";
import { en, zh, type MessageKey } from "./messages";
import type { ErrorCode } from "../../../docs/engineering_v0.5/contracts/public.types";

export type Locale = "en-US" | "zh-CN";
export const LANGUAGE_STORAGE_KEY = "last-mile-locale-v1";
export const DEFAULT_LOCALE: Locale = "en-US";
export function isLocale(value: unknown): value is Locale {
  return value === "en-US" || value === "zh-CN";
}
export function readPreferredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}
export function savePreferredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    /* The selection still applies for this page. */
  }
}
export function translate(
  locale: Locale,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const text = (locale === "zh-CN" ? zh : en)[key];
  return text.replace(/\{(\w+)\}/g, (token, name: string) =>
    values[name] === undefined ? token : String(values[name]),
  );
}

const channelScopes = {
  "zh-CN": {
    satellite:
      "卫星资料是历史地表观察，不能确认当前登记系统、通行许可或集市当前车道状态。",
    drone:
      "无人机只能观察可见区域，不能确认登记系统、通行许可、爆炸原因或人员敌意。",
    localAgency:
      "机构联系只提供其授权与掌握范围内的答复；转述不自动成为现场事实。",
    witness: "目击者只提供个人经历与转述；不能仅凭人数认定独立来源或事件原因。",
  },
  "en-US": {
    satellite:
      "Satellite records are historical surface observations. They cannot confirm the current registration system, crossing permission, or current market-lane access.",
    drone:
      "A drone observes visible areas only. It cannot confirm registration systems, crossing permission, an explosion's cause, or hostile intent.",
    localAgency:
      "An agency can answer only within its authority and information. A retelling does not automatically become an observed fact.",
    witness:
      "A witness provides personal experience and retellings. The number of speakers alone cannot establish independent sources or the cause of an event.",
  },
};
export function getChannelScopes(locale: Locale) {
  return channelScopes[locale];
}
const nodes = {
  "en-US": {
    N00: "Assembly yard",
    N01: "West gate",
    N02: "Old market",
    N03: "Community clinic",
    N04: "Ridge radio station",
    N05: "West bridgehead",
    N06: "East bridgehead",
    N07: "Daybreak reception",
    N08: "South service road",
    N09: "Old riverbed track",
    N10: "Transfer depot",
  },
  "zh-CN": {
    N00: "安全集结院",
    N01: "西门检查站",
    N02: "旧市集",
    N03: "社区诊所",
    N04: "山脊通信站",
    N05: "主桥西端",
    N06: "主桥东端",
    N07: "曙光撤离站",
    N08: "南侧服务路",
    N09: "旧河床便道",
    N10: "仓储转运区",
  },
};
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);
export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title =
      locale === "en-US"
        ? "LAST MILE · The final stretch"
        : "LAST MILE · 最后一程";
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        "content",
        locale === "en-US"
          ? "LAST MILE — Guide twenty civilians home with incomplete information and an AI advisor."
          : "LAST MILE — 在不完整的信息中，护送二十个人走完最后一程。",
      );
  }, [locale]);
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  );
}
export function useI18n() {
  const locale = useContext(LocaleContext);
  return useMemo(() => {
    const t = (key: MessageKey, values?: Record<string, string | number>) =>
      translate(locale, key, values);
    return {
      ...(locale === "en-US" ? english : chinese),
      locale,
      t,
      channelScope: (channel: keyof (typeof channelScopes)["en-US"]) =>
        getChannelScopes(locale)[channel],
      nodeLabel: (id: string) =>
        nodes[locale][id as keyof (typeof nodes)["en-US"]] ?? id,
      duration: (ms: number | null) => {
        if (ms === null) return t("common.unknownDuration");
        const totalSeconds = Math.ceil(ms / 1000);
        if (totalSeconds < 60)
          return t("common.seconds", { seconds: totalSeconds });
        const minutes = Math.floor(totalSeconds / 60),
          seconds = totalSeconds % 60;
        return seconds
          ? t("common.minutesSeconds", { minutes, seconds })
          : t("common.minutes", { minutes });
      },
    };
  }, [locale]);
}

const errors: Record<Locale, Record<ErrorCode, string>> = {
  "en-US": {
    INVALID_REQUEST:
      "This request is incomplete or invalid. Check your selection and try again.",
    UNAUTHORIZED:
      "The local launch credential has expired. Reopen the game from its launcher.",
    CAPABILITY_DENIED:
      "This launch does not have permission to open that session.",
    RESOURCE_NOT_FOUND:
      "That session or record is no longer available to this launch.",
    STATE_VERSION_CONFLICT:
      "The mission changed while you were choosing. Review the updated state and confirm again.",
    SCENE_CONFLICT:
      "The convoy has entered another scene. Review the current options.",
    RUN_EPOCH_CONFLICT:
      "This session belongs to a different run. Refresh its record.",
    IDEMPOTENCY_KEY_REUSED:
      "This request key was already used for different content. Please try the action again.",
    PHASE_NOT_ALLOWED: "This action is unavailable in the current phase.",
    POLICY_NOT_APPROVED:
      "These rules are still under review. Use the design preview mode.",
    BUDGET_EXHAUSTED:
      "The mission allowance for that investigation channel is exhausted.",
    ROLE_BUSY: "That team member is still working on another task.",
    TARGET_NOT_AVAILABLE:
      "That investigation target is unavailable. Choose a current option.",
    REPORT_LIMIT: "That role has no report slots left in this scene.",
    UPLOAD_LIMIT:
      "The scene upload allowance has been used. Uploaded cards cannot be replaced.",
    REVISION_CONFLICT:
      "The report version changed. Open the current report and try again.",
    NOT_REPORTED: "That information has not been delivered as a report yet.",
    ACTION_NOT_AVAILABLE: "That route or action is currently unavailable.",
    SEALED_HASH_MISMATCH:
      "The requested review does not match this sealed mission record.",
    NOT_TERMINAL: "End the mission before requesting its review or export.",
    ALREADY_TERMINAL:
      "This mission has ended. Its record is available for review.",
    CURSOR_EXPIRED: "The event position has expired. Refresh to synchronize.",
    CURSOR_SCOPE_MISMATCH:
      "That event position belongs to a different session.",
    RATE_LIMITED: "Too many requests. Please wait briefly and try again.",
    MODEL_BUDGET_EXHAUSTED:
      "This mission has reached its AI request limit. You can continue independently.",
    BODY_TOO_LARGE: "The request is too long. Shorten your text and try again.",
    STORAGE_UNAVAILABLE:
      "The local database is busy. Please try again shortly.",
    SERVICE_UNAVAILABLE:
      "The local service is unavailable. Check that it is running.",
  },
  "zh-CN": {
    INVALID_REQUEST: "请求内容不完整或不正确，请检查选择后重试。",
    UNAUTHORIZED: "本次启动凭证已失效，请从启动器重新打开游戏。",
    CAPABILITY_DENIED: "本次启动未获该会话访问权限。",
    RESOURCE_NOT_FOUND: "此会话或记录当前不可用。",
    STATE_VERSION_CONFLICT: "任务状态已更新，请查看最新信息后再次确认。",
    SCENE_CONFLICT: "车队已进入另一个场景，请查看当前选项。",
    RUN_EPOCH_CONFLICT: "本局运行世代已变化，请刷新记录。",
    IDEMPOTENCY_KEY_REUSED: "请求键已用于不同内容，请重新发起操作。",
    PHASE_NOT_ALLOWED: "当前阶段不能执行此操作。",
    POLICY_NOT_APPROVED: "规则仍在评审，请使用设计预览模式。",
    BUDGET_EXHAUSTED: "该调查渠道的整局次数已用完。",
    ROLE_BUSY: "该岗位仍在执行另一项任务。",
    TARGET_NOT_AVAILABLE: "调查目标当前不可用，请选择当前选项。",
    REPORT_LIMIT: "该岗位在本关的上报额度已满。",
    UPLOAD_LIMIT: "本关上传额度已用完，已上传版本不能替换。",
    REVISION_CONFLICT: "报告版本已变化，请打开当前版本后重试。",
    NOT_REPORTED: "这条信息尚未正式上报。",
    ACTION_NOT_AVAILABLE: "这条路线或行动当前不可用。",
    SEALED_HASH_MISMATCH: "复盘请求与本局封存版本不匹配。",
    NOT_TERMINAL: "请先结束任务，再申请复盘或导出。",
    ALREADY_TERMINAL: "本局已经结束，可以查看复盘记录。",
    CURSOR_EXPIRED: "事件位置已过期，请刷新同步。",
    CURSOR_SCOPE_MISMATCH: "事件位置不属于本局。",
    RATE_LIMITED: "请求过于频繁，请稍后重试。",
    MODEL_BUDGET_EXHAUSTED: "本局 AI 调用次数已满，你可以继续独立决策。",
    BODY_TOO_LARGE: "请求内容过长，请缩短后重试。",
    STORAGE_UNAVAILABLE: "本地数据库正忙，请稍后重试。",
    SERVICE_UNAVAILABLE: "本地服务不可用，请确认服务仍在运行。",
  },
};
export function formatError(error: unknown, locale: Locale): string {
  if (error && typeof error === "object" && "problem" in error) {
    const problem = error.problem as { code?: ErrorCode };
    return problem.code && errors[locale][problem.code]
      ? errors[locale][problem.code]
      : translate(locale, "error.requestFailed");
  }
  if (error instanceof Error) {
    if (error.message === "CONNECTION_LOST")
      return translate(locale, "error.connection");
    if (error.message === "REQUEST_CANCELLED")
      return translate(locale, "error.cancelled");
    return error.message;
  }
  return translate(locale, "error.requestFailed");
}
