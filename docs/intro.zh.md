# 给 pi 用户：一个管理第三方模型服务的插件

如果你在用 [pi](https://github.com/earendil-works/pi)，大概率已经体会过它的干净：模型切换靠 `/model`，登录靠 `/login`，配置落在 `~/.pi/agent/` 里的几个 JSON。

但一旦你开始接 **OpenAI 兼容的第三方服务**——自建代理、公益站、公司网关、临时测试端点——事情就会变得有点别扭：

- `/model` 只能在**已经配好**的服务里切换
- `/login` 只覆盖内置 OAuth 厂商，**加不了自定义 baseUrl**
- 真正能加第三方的方式，往往是手改 `~/.pi/agent/models.json`

能用，但不够顺手。尤其当你经常换端点、补模型列表、测连通性时，反复打开 JSON 文件会很快变成负担。

所以我写了这个插件：

**[pi-provider-manager](https://github.com/jiangnan1224/pi-provider-manager)**

一条命令：

```bash
pi install git:github.com/jiangnan1224/pi-provider-manager
```

装完在 pi 里输入：

```text
/provider
```

## 它解决什么问题

一句话：**把「第三方 OpenAI 兼容服务」的增删改查、探测、测试、设默认，做成 pi 里的交互菜单。**

它和官方能力是互补关系：

| 能力 | 官方 | 这个插件 |
|------|------|----------|
| 切换已有模型 | `/model` | `/provider` → 切换模型 |
| 登录内置厂商 | `/login` | — |
| 添加自定义 baseUrl + key | 手改 `models.json` | 引导式添加 |
| 探测 `/v1/models` | 无 | 自动探测 + 多选 |
| 测试端点是否真的通 | 无 | 最小化 chat 请求 |
| 编辑模型列表 / 地址 / 密钥 | 手改 JSON | 对象优先的配置页 |
| 设置启动默认模型 | 手改 `settings.json` | 菜单一键写入 |

如果你的 provider 列表长期稳定，继续手改 JSON 也完全够用。  
如果你会**经常加服务、换地址、补模型、测通不通**，这个插件会省很多时间。

## 安装

```bash
# 推荐：从 GitHub 安装
pi install git:github.com/jiangnan1224/pi-provider-manager

# 想钉版本
pi install git:github.com/jiangnan1224/pi-provider-manager@v1.0.0

# 只想临时试用，不写 settings
pi -e git:github.com/jiangnan1224/pi-provider-manager
```

安装后重启 pi，或执行 `/reload`，然后：

```text
/provider
```

卸载：

```bash
pi remove git:github.com/jiangnan1224/pi-provider-manager
```

## 主菜单长什么样

打开后是三个入口，职责分得很清楚：

```text
当前 opencode-go/glm-5.2
> 切换模型
  配置服务
  设置默认模型
```

### 1. 切换模型

把**内置已登录**和**自定义已配置**的服务放在同一层，先选服务，再选模型。

适合日常切模型。切成功后会直接退出 `/provider`，不会把你留在菜单里绕圈。

> 如果你更习惯官方 `/model`，继续用也完全没问题。这里只是多了一条更贴近「服务 → 模型」的路径。

### 2. 配置服务

这是插件的核心，采用 **对象优先**：

1. 先看你有哪些自定义服务
2. 点进某一个
3. 再在这个服务上做所有操作

不会每点一个动作就重新选一遍 provider。

服务列表大概像这样：

```text
自定义服务（2）· 选一个进入
> + 添加服务
  openai-5018  ·  3个模型  ·  http://host:port/v1
  薄荷公益  ·  ⚠无模型  ·  https://...
```

空模型会直接标出来，进页后会把「添加模型」顶到最前面，减少你点进测试/切换却发现什么都没有的情况。

进入某个服务后：

- **测试连接**：对端点发最小化 `chat/completions`（`ping`），支持批量勾选多个模型
- **编辑模型**：添加 / 删除 / 重新探测
- **修改地址 / 修改密钥**：编辑器预填当前值，不用整段重打
- **查看配置 / 设为默认模型 / 删除服务**

### 3. 设置默认模型

写入 `settings.json` 的 `defaultProvider` / `defaultModel`，下次启动 pi 自动使用。

## 添加一个第三方服务有多快

典型流程：

1. 起个名字（支持中文，比如「薄荷公益」）
2. 填 `baseUrl`，例如 `https://api.example.com/v1`
3. 填密钥（可留空；也可以写成 `$MY_API_KEY` 引用环境变量）
4. 插件自动请求 `/models`
5. 多选你要保留的模型
6. 可选：立刻测试连接，或立刻切过去用

密钥相关约定：

- 直接粘贴：写入 `models.json`（明文，注意安全）
- 以 `$` 开头：当作环境变量引用，例如 `$OPENAI_5018_API_KEY`
- 编辑时留空：表示移除密钥
- 添加过程中 Esc：取消整个流程

更推荐环境变量，而不是把 key 长期放在 JSON 里。

## 一些用起来会舒服的细节

这些不是大功能，但决定了「会不会想天天用」：

- **写回不丢字段**：`compat` / `headers` / `modelOverrides` 等手写配置不会被插件抹掉
- **同名覆盖有确认**：不会静默覆盖已有服务
- **探测失败可手填**：端点没有 `/models` 时，仍可逗号分隔输入模型 id
- **改地址后顺手问要不要重新探测**：换端口/域名是常见操作，模型列表通常也要跟着变
- **删除服务会清理默认设置**：如果默认模型正好指向它，会一并清掉，避免启动指空
- **当前模型有标记**：列表和选择页能看到 ✓当前 / ⚠无模型

## 它会改哪些文件

| 文件 | 作用 |
|------|------|
| `~/.pi/agent/models.json` | 自定义服务配置 |
| `~/.pi/agent/settings.json` | 默认启动模型（仅在你设置默认时） |

同时会调用 pi 的 `registerProvider` / `unregisterProvider`，所以**当前会话一般立刻生效**，不必为了加个服务重启整个 pi。

## 适合谁

更适合：

- 经常接 OpenAI 兼容中转 / 代理 / 公益站
- 需要快速验证某个 baseUrl + key 是否真的能聊
- 不想每次都手改 `models.json`
- 希望内置服务和自定义服务在切换时处于同一层级

不太需要：

- 只用 Anthropic / OpenAI 官方订阅，从不碰第三方兼容接口
- provider 列表一年都不改一次

## 安全提醒

pi 扩展拥有本机完整权限，**安装任何第三方包前请先看源码**。

这个仓库结构很简单：

```text
extensions/provider-manager.ts
package.json
README.md
```

没有额外后端，没有偷偷联网的后台逻辑；只有你主动测试/探测时，才会请求你填的那个服务地址。

另外：

- 明文 key 写进 `models.json` 有泄露风险
- 优先用 `$ENV_VAR`
- 如果 key 曾经进过聊天记录或配置文件，记得轮换

## 开始用

```bash
pi install git:github.com/jiangnan1224/pi-provider-manager
```

然后：

```text
/provider
```

仓库地址：

**https://github.com/jiangnan1224/pi-provider-manager**

如果你也在用 pi，又受够了为第三方端点反复改 JSON，欢迎试试，也欢迎提 issue / PR。
