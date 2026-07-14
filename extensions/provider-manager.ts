/**
 * pi provider manager — 自定义 OpenAI 兼容服务的交互管理。
 *
 * /provider 主菜单：
 *   - 切换模型    已配置凭据的服务（内置/自定义同级）
 *   - 配置服务      先选服务，再：测连接 / 编模型 / 改地址密钥 / 删 / 设默认模型；也可添加
 *   - 设置默认模型  写入 settings.json 的 defaultProvider/defaultModel
 *
 * 用词：服务 = provider，模型 = model，地址 = baseUrl，密钥 = apiKey
 * - 切换 / 设置默认模型：getAvailable()，内置已登录 + 自定义同级
 * - 配置服务：只操作 ~/.pi/agent/models.json（对象优先）
 * - 改动同时写 models.json + registerProvider，当前会话立即生效
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI, Theme, KeybindingsManager } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const MODELS_PATH = join(AGENT_DIR, "models.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

// ---- 类型 ----

interface CustomModel {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

interface ProviderConfig {
  api?: string;
  apiKey?: string;
  baseUrl: string;
  models: CustomModel[];
  name?: string;
  [key: string]: unknown;
}

interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

type Settings = Record<string, unknown>;
type CmdCtx = ExtensionCommandContext;

// ---- 文件 ----

async function readModels(): Promise<ModelsConfig> {
  try {
    const raw = await readFile(MODELS_PATH, "utf8");
    const parsed = JSON.parse(raw) as ModelsConfig;
    return parsed?.providers ? parsed : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

/** 写回时透传未知字段，避免抹掉 compat/headers 等 */
async function writeModels(cfg: ModelsConfig): Promise<void> {
  const ordered: Record<string, ProviderConfig> = {};
  for (const key of Object.keys(cfg.providers).sort()) {
    const p = cfg.providers[key];
    const { models: _m, ...rest } = p;
    const entry: ProviderConfig = {
      ...rest,
      api: p.api ?? "openai-completions",
      baseUrl: p.baseUrl,
      models: p.models.map((m) => {
        const { id, name, contextWindow, reasoning, ...mRest } = m;
        return {
          ...mRest,
          id,
          name: name ?? id,
          contextWindow: contextWindow ?? 128000,
          reasoning: reasoning ?? false,
        };
      }),
    };
    if (p.apiKey === undefined) delete entry.apiKey;
    else entry.apiKey = p.apiKey;
    ordered[key] = entry;
  }
  await writeFile(
    MODELS_PATH,
    JSON.stringify({ ...cfg, providers: ordered }, null, 2) + "\n",
    "utf8",
  );
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return {};
  }
}

async function writeSettings(s: Settings): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", "utf8");
}

// ---- 工具 ----

function maskKey(key?: string): string {
  if (!key) return "(未设置)";
  if (key.startsWith("$")) return key;
  if (key.length <= 10) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function resolveEnvKey(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (!s.startsWith("$")) return s;
  let v = s.slice(1);
  if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1);
  return process.env[v];
}

function shortUrl(url: string, max = 36): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + "…";
}

function providerListLabel(name: string, p: ProviderConfig, ctx?: CmdCtx): string {
  const cur = ctx?.model?.provider === name ? " ✓当前" : "";
  if (p.models.length === 0) {
    return `${name}${cur}  ·  ⚠无模型  ·  ${shortUrl(p.baseUrl)}`;
  }
  return `${name}${cur}  ·  ${p.models.length}个模型  ·  ${shortUrl(p.baseUrl)}`;
}

function providerSummary(name: string, p: ProviderConfig): string {
  const models =
    p.models.length === 0
      ? "(无模型)"
      : p.models
          .slice(0, 6)
          .map((m) => m.id)
          .join(", ") + (p.models.length > 6 ? ` …+${p.models.length - 6}` : "");
  return [
    `名称: ${name}`,
    `baseUrl: ${p.baseUrl}`,
    `apiKey: ${maskKey(p.apiKey)}`,
    `模型(${p.models.length}): ${models}`,
  ].join("\n");
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

async function testConnectivity(
  baseUrl: string,
  modelId: string,
  apiKey?: string,
): Promise<{ ok: boolean; latency: number; detail: string }> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const realKey = resolveEnvKey(apiKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (realKey) headers["Authorization"] = `Bearer ${realKey}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 32,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const latency = Date.now() - t0;
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as ChatResponse | null;
      const reply = data?.choices?.[0]?.message?.content ?? "";
      const preview = typeof reply === "string" ? reply.slice(0, 40) : "";
      return {
        ok: true,
        latency,
        detail: `HTTP ${res.status} (${latency}ms)${preview ? ` · ${preview}` : ""}`,
      };
    }
    const text = await res.text().catch(() => "");
    const preview = text.slice(0, 160).replace(/\s+/g, " ").trim();
    return {
      ok: false,
      latency,
      detail: `HTTP ${res.status}${preview ? ` · ${preview}` : ""}`,
    };
  } catch (e) {
    return {
      ok: false,
      latency: Date.now() - t0,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function discoverModels(
  baseUrl: string,
  apiKey?: string,
): Promise<CustomModel[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  const realKey = resolveEnvKey(apiKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (realKey) headers["Authorization"] = `Bearer ${realKey}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    data?: Array<{ id: string; name?: string; context_window?: number }>;
  };
  const list = data.data ?? [];
  if (list.length === 0) throw new Error("服务没有返回任何模型");
  return list.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.context_window ?? 128000,
    reasoning: false,
  }));
}

function registerProviderNow(
  pi: ExtensionAPI,
  name: string,
  baseUrl: string,
  apiKey: string | undefined,
  models: CustomModel[],
): void {
  pi.registerProvider(name, {
    baseUrl,
    apiKey,
    api: "openai-completions",
    models: models.map((m) => ({
      id: m.id,
      name: (m.name as string | undefined) ?? m.id,
      reasoning: Boolean(m.reasoning),
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: (m.contextWindow as number | undefined) ?? 128000,
      maxTokens: 8192,
    })),
  });
}

function groupAvailable(
  models: Array<{ provider: string; id: string; reasoning?: boolean }>,
) {
  const order: string[] = [];
  const byProvider = new Map<string, typeof models>();
  for (const m of models) {
    if (!byProvider.has(m.provider)) {
      order.push(m.provider);
      byProvider.set(m.provider, []);
    }
    byProvider.get(m.provider)!.push(m);
  }
  return { order, byProvider };
}

// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ---------- 多选 ----------
  async function multiSelect(
    ctx: CmdCtx,
    title: string,
    items: { id: string; name?: string }[],
    initialSelected?: Iterable<string>,
  ): Promise<string[] | undefined> {
    if (items.length === 0) return [];
    const defaultSel = initialSelected
      ? new Set(initialSelected)
      : new Set(items.map((i) => i.id));

    return (
      (await ctx.ui.custom<string[] | undefined>(
        (tui: TUI, theme: Theme, _kb: KeybindingsManager, done) => {
          let cursor = 0;
          const selected = new Set(defaultSel);
          let cached: string[] | undefined;
          const page = 16;
          const refresh = () => {
            cached = undefined;
            tui.requestRender();
          };
          const submit = (cancel: boolean) =>
            done(cancel ? undefined : [...selected]);

          const handleInput = (data: string) => {
            if (matchesKey(data, Key.up)) {
              cursor = Math.max(0, cursor - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              cursor = Math.min(items.length - 1, cursor + 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.pageUp)) {
              cursor = Math.max(0, cursor - page);
              refresh();
              return;
            }
            if (matchesKey(data, Key.pageDown)) {
              cursor = Math.min(items.length - 1, cursor + page);
              refresh();
              return;
            }
            if (matchesKey(data, Key.home)) {
              cursor = 0;
              refresh();
              return;
            }
            if (matchesKey(data, Key.end)) {
              cursor = items.length - 1;
              refresh();
              return;
            }
            if (matchesKey(data, Key.space)) {
              const it = items[cursor];
              if (selected.has(it.id)) selected.delete(it.id);
              else selected.add(it.id);
              refresh();
              return;
            }
            if (matchesKey(data, "a") || data === "A") {
              if (selected.size === items.length) selected.clear();
              else items.forEach((i) => selected.add(i.id));
              refresh();
              return;
            }
            if (matchesKey(data, Key.enter)) {
              submit(false);
              return;
            }
            if (matchesKey(data, Key.escape)) {
              submit(true);
              return;
            }
          };

          const render = (width: number): string[] => {
            if (cached) return cached;
            const W = Math.max(1, width);
            const lines: string[] = [];
            lines.push(theme.fg("accent", "─".repeat(W)));
            lines.push(theme.fg("accent", theme.bold(title)));
            lines.push("");
            const vis = Math.min(items.length, page);
            const start = Math.max(
              0,
              Math.min(cursor - Math.floor(vis / 2), items.length - vis),
            );
            const end = Math.min(start + vis, items.length);
            if (start > 0)
              lines.push(theme.fg("dim", `  ⋮ 上方 ${start} 个`));
            for (let i = start; i < end; i++) {
              const it = items[i];
              const on = i === cursor;
              const sel = selected.has(it.id);
              const box = sel
                ? theme.fg("success", "[x]")
                : theme.fg("muted", "[ ]");
              const pre = on ? theme.fg("accent", ">") : " ";
              const id = theme.fg(on ? "accent" : "text", it.id);
              const nm =
                it.name && it.name !== it.id
                  ? theme.fg("muted", `  (${it.name})`)
                  : "";
              lines.push(`${pre} ${box} ${id}${nm}`);
            }
            if (end < items.length)
              lines.push(
                theme.fg("dim", `  ⋮ 下方 ${items.length - end} 个`),
              );
            lines.push("");
            lines.push(
              theme.fg(
                "dim",
                `空格 · ↑↓/PgUp/PgDn · a 全选 · Enter 确认 · Esc 取消  ·  ${selected.size}/${items.length}`,
              ),
            );
            lines.push(theme.fg("accent", "─".repeat(W)));
            cached = lines;
            return lines;
          };

          return {
            render,
            invalidate: () => {
              cached = undefined;
            },
            handleInput,
          };
        },
      )) ?? undefined
    );
  }

  /**
   * 拉模型：默认直接探测（少一步 confirm）；失败再问手填。
   * skipConfirmDiscover=false 时仍先问（极少用）。
   */
  async function pickModels(
    ctx: CmdCtx,
    baseUrl: string,
    apiKey: string | undefined,
    opts: {
      title: string;
      excludeIds?: Set<string>;
      defaultSelect: "all" | "none";
      /** 探测失败或用户拒绝时是否允许手填 */
      allowManual: boolean;
      /** true=不问直接探测（默认） */
      autoDiscover?: boolean;
    },
  ): Promise<CustomModel[] | undefined> {
    const auto = opts.autoDiscover !== false;
    let models: CustomModel[] = [];
    let discovered = false;

    const doDiscover = async () => {
      ctx.ui.setStatus("provider", "探测模型列表…");
      try {
        models = await discoverModels(baseUrl, apiKey);
        if (opts.excludeIds?.size) {
          models = models.filter((m) => !opts.excludeIds!.has(m.id));
        }
        discovered = true;
      } catch (e) {
        ctx.ui.notify(
          `探测失败：${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("provider", undefined);
      }
    };

    if (auto) {
      await doDiscover();
    } else {
      const yes = await ctx.ui.confirm(
        "自动探测？",
        `向 ${baseUrl}/models 拉取？`,
      );
      if (yes) await doDiscover();
    }

    if (models.length === 0) {
      if (!opts.allowManual) {
        ctx.ui.notify(
          discovered ? "没有新模型可添加" : "探测无结果",
          "warning",
        );
        return undefined;
      }
      // 探测失败：给一次手填机会；Esc 取消
      const prompt = discovered
        ? "没有新模型。可手填 id（逗号分隔），或 Esc 取消"
        : "探测失败/跳过。手填模型 id（逗号分隔），或 Esc 取消";
      const ids = await ctx.ui.input(prompt);
      if (ids === undefined) return undefined;
      if (!ids.trim()) {
        ctx.ui.notify("已取消", "warning");
        return undefined;
      }
      models = ids
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((id) => !opts.excludeIds?.has(id))
        .map((id) => ({
          id,
          name: id,
          contextWindow: 128000,
          reasoning: false,
        }));
      if (models.length === 0) {
        ctx.ui.notify("没有可添加的模型", "warning");
        return undefined;
      }
      // 手填通常量少，直接用，不再多选
      return models;
    }

    // 只有 1 个且 default all → 直接收下，少一次确认
    if (models.length === 1 && opts.defaultSelect === "all") {
      return models;
    }

    const initial =
      opts.defaultSelect === "all" ? models.map((m) => m.id) : [];
    const chosen = await multiSelect(
      ctx,
      opts.title.replace("{n}", String(models.length)),
      models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
      initial,
    );
    if (!chosen) return undefined;
    if (chosen.length === 0) {
      ctx.ui.notify("未选择任何模型", "warning");
      return undefined;
    }
    const want = new Set(chosen);
    return models.filter((m) => want.has(m.id));
  }

  async function switchTo(
    ctx: CmdCtx,
    provider: string,
    modelId: string,
  ): Promise<boolean> {
    const full = ctx.modelRegistry.find(provider, modelId);
    if (!full) {
      ctx.ui.notify("注册表找不到该模型，试试 /reload", "warning");
      return false;
    }
    const ok = await pi.setModel(full);
    if (!ok) {
      ctx.ui.notify(`没有 ${provider}/${modelId} 的密钥`, "error");
      return false;
    }
    ctx.ui.notify(`已切换到 ${provider}/${modelId}`, "info");
    return true;
  }

  async function pickOneModel(
    ctx: CmdCtx,
    title: string,
    models: Array<{ id: string; reasoning?: boolean }>,
    curId?: string,
  ): Promise<string | undefined> {
    if (models.length === 0) return undefined;
    if (models.length === 1) return models[0].id;
    const labels = models.map((m) => {
      const tag = m.id === curId ? " ✓" : "";
      const r = m.reasoning ? " · reasoning" : "";
      return `${m.id}${r}${tag}`;
    });
    const choice = await ctx.ui.select(title, labels);
    if (!choice) return undefined;
    const idx = labels.indexOf(choice);
    return idx >= 0 ? models[idx].id : undefined;
  }

  // ---------- 命令入口 ----------
  pi.registerCommand("provider", {
    description: "切换模型 / 配置自定义服务 / 设置默认模型",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/provider 需要交互模式", "error");
        return;
      }
      while (true) {
        const cur = ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : "(未选模型)";
        const menu = await ctx.ui.select(`当前 ${cur}`, [
          "切换模型",
          "配置服务",
          "设置默认模型",
        ]);
        if (!menu) return;
        if (menu === "切换模型") {
          const switched = await doSwitch(ctx);
          // 切换成功就退出 /provider
          if (switched) return;
        } else if (menu === "配置服务") {
          await doManage(ctx);
        } else if (menu === "设置默认模型") {
          await doDefault(ctx);
        }
      }
    },
  });

  // ---------- 切换（全局） ----------
  /** @returns true 若成功切换 */
  async function doSwitch(ctx: CmdCtx): Promise<boolean> {
    ctx.modelRegistry.refresh();
    const models = ctx.modelRegistry.getAvailable();
    if (models.length === 0) {
      ctx.ui.notify(
        "没有可用模型。可「配置服务」添加，或 /login 登录内置",
        "info",
      );
      return false;
    }
    const curP = ctx.model?.provider;
    const curId = ctx.model?.id;
    const { order, byProvider } = groupAvailable(models);

    let providerName: string;
    if (order.length === 1) {
      providerName = order[0];
    } else {
      const labels = order.map((n) => {
        const tag = n === curP ? " ✓当前" : "";
        const display = ctx.modelRegistry.getProviderDisplayName(n) ?? n;
        return `${display}${tag}  (${byProvider.get(n)!.length})`;
      });
      const choice = await ctx.ui.select("选择服务", labels);
      if (!choice) return false;
      const idx = labels.indexOf(choice);
      if (idx < 0) return false;
      providerName = order[idx];
    }

    const pModels = byProvider.get(providerName)!;
    const display =
      ctx.modelRegistry.getProviderDisplayName(providerName) ?? providerName;
    const modelId = await pickOneModel(
      ctx,
      `${display} 的模型`,
      pModels,
      curP === providerName ? curId : undefined,
    );
    if (!modelId) return false;
    return switchTo(ctx, providerName, modelId);
  }

  // ---------- 设默认（全局） ----------
  async function doDefault(ctx: CmdCtx): Promise<void> {
    ctx.modelRegistry.refresh();
    const models = ctx.modelRegistry.getAvailable();
    if (models.length === 0) {
      ctx.ui.notify("没有可设为默认模型的选项", "warning");
      return;
    }
    const { order, byProvider } = groupAvailable(models);
    const settings = await readSettings();
    const curP = settings.defaultProvider as string | undefined;
    const curM = settings.defaultModel as string | undefined;

    const pLabels = order.map((n) => {
      const d = ctx.modelRegistry.getProviderDisplayName(n) ?? n;
      return n === curP ? `${d} ✓默认` : d;
    });
    const pChoice = await ctx.ui.select("默认模型 · 先选服务", pLabels);
    if (!pChoice) return;
    const pIdx = pLabels.indexOf(pChoice);
    if (pIdx < 0) return;
    const providerName = order[pIdx];
    const pModels = byProvider.get(providerName)!;
    const display =
      ctx.modelRegistry.getProviderDisplayName(providerName) ?? providerName;
    const modelId = await pickOneModel(
      ctx,
      `${display} 的默认模型`,
      pModels,
      curP === providerName ? curM : undefined,
    );
    if (!modelId) return;
    settings.defaultProvider = providerName;
    settings.defaultModel = modelId;
    await writeSettings(settings);
    ctx.ui.notify(
      `默认模型 → ${providerName}/${modelId}（下次启动生效）`,
      "info",
    );
  }

  // ---------- 配置服务（对象优先） ----------
  async function doManage(ctx: CmdCtx): Promise<void> {
    while (true) {
      const cfg = await readModels();
      const names = Object.keys(cfg.providers).sort();
      const items = [
        "+ 添加服务",
        ...names.map((n) => providerListLabel(n, cfg.providers[n], ctx)),
      ];
      const title =
        names.length === 0
          ? "自定义服务（空）· 选「添加服务」开始"
          : `自定义服务（${names.length}）· 选一个进入`;
      const choice = await ctx.ui.select(title, items);
      if (!choice) return;

      if (choice === "+ 添加服务") {
        await doAdd(ctx);
        continue;
      }

      const idx = items.indexOf(choice) - 1; // 去掉「添加服务」
      if (idx < 0 || idx >= names.length) continue;
      await manageOne(ctx, names[idx]);
    }
  }

  async function manageOne(ctx: CmdCtx, name: string): Promise<void> {
    while (true) {
      // 每次循环重读，保证摘要最新
      const cfg = await readModels();
      const provider = cfg.providers[name];
      if (!provider) return; // 已删除

      const persist = async () => {
        const p = cfg.providers[name];
        await writeModels(cfg);
        registerProviderNow(pi, name, p.baseUrl, p.apiKey, p.models);
        ctx.modelRegistry.refresh();
      };

      const head = [
        `${name}`,
        shortUrl(provider.baseUrl, 40),
        provider.models.length === 0
          ? "⚠无模型"
          : `${provider.models.length}模型`,
        `key ${maskKey(provider.apiKey)}`,
      ].join(" · ");

      // 无模型时把「添加模型」置顶引导；有模型时露出连接/编辑等
      const menu =
        provider.models.length === 0
          ? [
              "添加模型  ← 先补模型",
              "修改地址",
              "修改密钥",
              "查看配置",
              "删除服务",
              "返回",
            ]
          : [
              "测试连接",
              "编辑模型",
              "修改地址",
              "修改密钥",
              "查看配置",
              "设为默认模型",
              "删除服务",
              "返回",
            ];

      const what = await ctx.ui.select(head, menu);
      if (!what || what === "返回") return;

      if (what.startsWith("添加模型") || what === "编辑模型") {
        if (what.startsWith("添加模型")) {
          const added = await pickModels(ctx, provider.baseUrl, provider.apiKey, {
            title: "选择要添加的 {n} 个模型",
            excludeIds: new Set(provider.models.map((m) => m.id)),
            defaultSelect: "all",
            allowManual: true,
          });
          if (!added) continue;
          provider.models.push(...added);
          await persist();
          ctx.ui.notify(
            `已添加 ${added.length} 个模型，现共 ${provider.models.length}`,
            "info",
          );
          continue;
        }

        // 编辑模型子菜单
        while (true) {
          const p = cfg.providers[name];
          const sub = await ctx.ui.select(`模型 · ${name}（${p.models.length}）`, [
            "添加模型",
            "删除模型",
            "重新探测",
            "返回",
          ]);
          if (!sub || sub === "返回") break;

          if (sub === "添加模型") {
            const existing = new Set(p.models.map((m) => m.id));
            const added = await pickModels(ctx, p.baseUrl, p.apiKey, {
              title: "选择要添加的 {n} 个新模型",
              excludeIds: existing,
              defaultSelect: "none",
              allowManual: true,
            });
            if (!added) continue;
            p.models.push(...added);
            await persist();
            ctx.ui.notify(`+${added.length} → 共 ${p.models.length}`, "info");
            continue;
          }

          if (sub === "删除模型") {
            if (p.models.length === 0) {
              ctx.ui.notify("没有模型", "warning");
              continue;
            }
            const chosen = await multiSelect(
              ctx,
              "勾选要删除的模型",
              p.models.map((m) => ({
                id: m.id,
                name: m.name as string | undefined,
              })),
              [],
            );
            if (!chosen || chosen.length === 0) {
              if (chosen) ctx.ui.notify("未选择", "warning");
              continue;
            }
            if (
              !(await ctx.ui.confirm(
                `删除 ${chosen.length} 个模型？`,
                chosen.join(", "),
              ))
            )
              continue;
            const del = new Set(chosen);
            if (
              ctx.model?.provider === name &&
              ctx.model.id &&
              del.has(ctx.model.id)
            ) {
              if (
                !(await ctx.ui.confirm(
                  "含当前正在使用的模型",
                  `${name}/${ctx.model.id} 在用。仍删？`,
                ))
              )
                continue;
            }
            p.models = p.models.filter((m) => !del.has(m.id));
            await persist();
            ctx.ui.notify(`已删 ${chosen.length}，剩 ${p.models.length}`, "info");
            continue;
          }

          if (sub === "重新探测") {
            if (
              !(await ctx.ui.confirm(
                "替换全部模型？",
                `现有 ${p.models.length} 个会被探测结果替换`,
              ))
            )
              continue;
            const next = await pickModels(ctx, p.baseUrl, p.apiKey, {
              title: `新列表 · {n} 个可选（替换现有 ${p.models.length}）`,
              defaultSelect: "all",
              allowManual: false,
            });
            if (!next) continue;
            p.models = next;
            await persist();
            ctx.ui.notify(`已替换为 ${p.models.length} 个`, "info");
          }
        }
        continue;
      }

      if (what === "测试连接") {
        await runTest(ctx, name, provider);
        continue;
      }

      if (what === "查看配置") {
        await ctx.ui.confirm(`配置 · ${name}`, providerSummary(name, provider));
        continue;
      }

      if (what === "设为默认模型") {
        const id = await pickOneModel(
          ctx,
          `将 ${name} 的哪个模型设为默认？`,
          provider.models,
        );
        if (!id) continue;
        const settings = await readSettings();
        settings.defaultProvider = name;
        settings.defaultModel = id;
        await writeSettings(settings);
        ctx.ui.notify(`默认模型 → ${name}/${id}`, "info");
        continue;
      }

      if (what === "修改地址") {
        const edited = await ctx.ui.editor(
          "服务地址 baseUrl（保存提交 / Esc 取消）",
          provider.baseUrl,
        );
        if (edited === undefined) continue;
        const url = edited.trim();
        if (!url) {
          ctx.ui.notify("不能为空", "error");
          continue;
        }
        if (!/^https?:\/\//i.test(url)) {
          ctx.ui.notify("需以 http:// 或 https:// 开头", "error");
          continue;
        }
        if (url === provider.baseUrl) {
          ctx.ui.notify("未变化", "info");
          continue;
        }
        provider.baseUrl = url;
        await persist();
        ctx.ui.notify("地址已更新", "info");
        if (
          await ctx.ui.confirm(
            "重新探测模型？",
            "地址变了，是否立即重新拉取并替换模型列表？",
          )
        ) {
          const next = await pickModels(ctx, provider.baseUrl, provider.apiKey, {
            title: "新模型 · {n} 个",
            defaultSelect: "all",
            allowManual: true,
          });
          if (next) {
            provider.models = next;
            await persist();
            ctx.ui.notify(`模型已同步为 ${next.length} 个`, "info");
          }
        }
        continue;
      }

      if (what === "修改密钥") {
        const prefill = provider.apiKey ?? "";
        const edited = await ctx.ui.editor(
          `密钥 apiKey（留空=移除；$VAR=环境变量）\n当前: ${maskKey(provider.apiKey)}`,
          prefill,
        );
        if (edited === undefined) continue;
        const t = edited.trim();
        if (t === "") {
          if (provider.apiKey === undefined) {
            ctx.ui.notify("本来就没设", "info");
            continue;
          }
          delete provider.apiKey;
          await persist();
          ctx.ui.notify("已移除密钥", "info");
        } else if (t === provider.apiKey) {
          ctx.ui.notify("未变化", "info");
        } else {
          provider.apiKey = t;
          await persist();
          ctx.ui.notify(`密钥 → ${maskKey(t)}`, "info");
        }
        continue;
      }

      if (what === "删除服务") {
        const warnings = ["不可撤销。"];
        if (ctx.model?.provider === name) {
          warnings.push(
            `⚠ 当前在用 ${name}/${ctx.model.id}，删后下一条消息可能失败。`,
          );
        }
        const settings = await readSettings();
        if (settings.defaultProvider === name) {
          warnings.push("⚠ 会同时清除默认模型设置。");
        }
        if (
          !(await ctx.ui.confirm(`删除服务 "${name}"？`, warnings.join("\n")))
        )
          continue;

        delete cfg.providers[name];
        await writeModels(cfg);
        pi.unregisterProvider(name);
        ctx.modelRegistry.refresh();
        if (settings.defaultProvider === name) {
          delete settings.defaultProvider;
          delete settings.defaultModel;
          await writeSettings(settings);
          ctx.ui.notify(`已删除 ${name}，并清除默认模型设置`, "info");
        } else {
          ctx.ui.notify(`已删除 ${name}`, "info");
        }
        return;
      }
    }
  }

  // ---------- 添加 ----------
  async function doAdd(ctx: CmdCtx): Promise<void> {
    const nameRaw = await ctx.ui.input(
      "服务名称（唯一，支持中文，如 my-proxy / 薄荷公益）",
    );
    if (nameRaw === undefined) return;
    const name = nameRaw.trim();
    if (!name) {
      ctx.ui.notify("名称不能为空", "error");
      return;
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(name)) {
      ctx.ui.notify(
        "仅中文/字母/数字/下划线/连字符，无空格",
        "error",
      );
      return;
    }

    const cfg = await readModels();
    if (name in cfg.providers) {
      if (
        !(await ctx.ui.confirm(
          `"${name}" 已存在`,
          "继续将覆盖地址、密钥和模型列表。确定？",
        ))
      )
        return;
    }

    const baseUrlRaw = await ctx.ui.input(
      "服务地址 baseUrl",
      "http://host:port/v1",
    );
    if (baseUrlRaw === undefined) return;
    const baseUrl = baseUrlRaw.trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      ctx.ui.notify("地址需以 http:// 或 https:// 开头", "error");
      return;
    }

    const apiKeyRaw = await ctx.ui.input(
      "密钥 apiKey（可留空；Esc 取消；$VAR 表环境变量）",
    );
    if (apiKeyRaw === undefined) return;
    const apiKey = apiKeyRaw.trim() || undefined;

    // 默认直接探测，少一步
    const models = await pickModels(ctx, baseUrl, apiKey, {
      title: "发现 {n} 个模型，选要保留的",
      defaultSelect: "all",
      allowManual: true,
    });
    if (!models) return;

    const existed = name in cfg.providers;
    cfg.providers[name] = {
      api: "openai-completions",
      apiKey,
      baseUrl,
      models,
    };
    await writeModels(cfg);
    registerProviderNow(pi, name, baseUrl, apiKey, models);
    ctx.modelRegistry.refresh();
    ctx.ui.notify(
      `已${existed ? "更新" : "添加"} "${name}"（${models.length} 模型）`,
      "info",
    );

    const next = await ctx.ui.select("接下来？", [
      "测试连接",
      "立即使用",
      "完成",
    ]);
    if (!next || next === "完成") return;
    if (next === "测试连接") {
      await runTest(ctx, name, cfg.providers[name]);
      return;
    }
    const id = await pickOneModel(ctx, `${name} 的模型`, models);
    if (id) await switchTo(ctx, name, id);
  }

  // ---------- 测试 ----------
  async function runTest(
    ctx: CmdCtx,
    name: string,
    provider: ProviderConfig,
  ): Promise<void> {
    if (provider.models.length === 0) {
      ctx.ui.notify("没有模型可测", "warning");
      return;
    }

    // 多模型：先多选要测哪些，再批量跑，避免「测一个问一次」
    let targets: string[];
    if (provider.models.length === 1) {
      targets = [provider.models[0].id];
    } else {
      const chosen = await multiSelect(
        ctx,
        `选择要测试的模型（${provider.models.length}）`,
        provider.models.map((m) => ({ id: m.id, name: m.name as string | undefined })),
        [provider.models[0].id], // 默认勾第一个，快速单测
      );
      if (!chosen || chosen.length === 0) {
        if (chosen) ctx.ui.notify("未选择", "warning");
        return;
      }
      targets = chosen;
    }

    const lines: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const modelId = targets[i];
      ctx.ui.setStatus(
        "provider",
        `测试 ${i + 1}/${targets.length} · ${name}/${modelId}…`,
      );
      const r = await testConnectivity(
        provider.baseUrl,
        modelId,
        provider.apiKey,
      );
      lines.push(
        `${r.ok ? "✓" : "✗"} ${modelId}  —  ${r.detail}`,
      );
    }
    ctx.ui.setStatus("provider", undefined);

    // 汇总展示
    const okN = lines.filter((l) => l.startsWith("✓")).length;
    const title = `测试结果 · ${name}  ${okN}/${targets.length} 通过`;
    if (targets.length === 1) {
      const ok = lines[0].startsWith("✓");
      ctx.ui.notify(lines[0], ok ? "info" : "error");
    } else {
      await ctx.ui.confirm(title, lines.join("\n"));
    }
  }
}
