# pi-provider-manager

Interactive manager for **custom OpenAI-compatible providers** in [pi](https://github.com/earendil-works/pi).

Adds a `/provider` command to:

- **切换模型** — switch among all available models (built-in + custom, same level)
- **配置服务** — add / edit / test / delete custom endpoints in `~/.pi/agent/models.json`
- **设置默认模型** — write `defaultProvider` / `defaultModel` in settings

Complements pi’s built-in `/model` (switch only) and `/login` (built-in OAuth only).  
There is no built-in wizard for third-party OpenAI-compatible base URLs — this package fills that gap.

## Install

```bash
# from GitHub
pi install git:github.com/jiangnan1224/pi-provider-manager

# pin a tag (after you create releases)
pi install git:github.com/jiangnan1224/pi-provider-manager@v1.0.0

# try without writing settings
pi -e git:github.com/jiangnan1224/pi-provider-manager
```

Then in pi:

```
/provider
```

If the command does not show up, run `/reload` or restart pi.

### Uninstall

```bash
pi remove git:github.com/jiangnan1224/pi-provider-manager
```

## Usage

```
当前 opencode-go/glm-5.2
> 切换模型
  配置服务
  设置默认模型
```

### 配置服务

Object-first UI: pick a service, then operate on it.

```
自定义服务（2）· 选一个进入
> + 添加服务
  openai-5018  ·  3个模型  ·  http://host:port/v1
  薄荷公益  ·  ⚠无模型  ·  https://...
```

Inside a service:

- **测试连接** — POST `/chat/completions` with a minimal `ping` (batch multi-select)
- **编辑模型** — add / remove / rediscover from `/v1/models`
- **修改地址** / **修改密钥** — prefilled editor; empty key removes it; `$VAR` env refs supported
- **设为默认模型** / **删除服务**

Adding a service:

1. Name (Unicode / Chinese OK)
2. baseUrl (`http://` / `https://`)
3. apiKey (optional; Esc cancels; `$ENV_VAR` stored as reference)
4. Auto-discover models → multi-select which to keep
5. Optional: test connection or switch immediately

## What it writes

| File | Purpose |
|------|---------|
| `~/.pi/agent/models.json` | Custom providers (api, baseUrl, apiKey, models, …) |
| `~/.pi/agent/settings.json` | `defaultProvider` / `defaultModel` when you set default |

Changes also call `registerProvider` / `unregisterProvider` so the current session updates without restart. Unknown fields (`compat`, `headers`, …) are preserved on write-back.

## Requirements

- [pi](https://github.com/earendil-works/pi) with extension support
- TUI / interactive mode (`/provider` is not for pure RPC/print)

Peer packages (provided by pi, not bundled):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

## Security note

API keys may be stored in `models.json` in plaintext if you paste them. Prefer:

```text
$OPENAI_5018_API_KEY
```

and export the variable in your shell profile.

Review third-party pi packages before install — extensions run with full local permissions.

## Package layout

```
pi-provider-manager/
├── package.json          # pi.extensions + pi-package keyword
├── extensions/
│   └── provider-manager.ts
├── README.md
└── LICENSE
```

## Development

```bash
# load from local clone while hacking
pi install /absolute/path/to/pi-provider-manager
# or for one run
pi -e /absolute/path/to/pi-provider-manager
```

Edit `extensions/provider-manager.ts`, then `/reload` in pi.

## License

MIT
