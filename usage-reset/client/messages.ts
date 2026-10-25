import { defineTranslations, type useTranslation } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });

export type Translate = ReturnType<typeof useTranslation<typeof en>>["t"];
