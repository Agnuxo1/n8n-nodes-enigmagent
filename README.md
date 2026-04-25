# n8n-nodes-enigmagent

> **Stop pasting raw API keys into n8n credentials and AI agent prompts.**
> Resolve encrypted vault secrets at the HTTP boundary — your LLMs and your workflow JSON only ever see opaque placeholders like `{{OPENAI_KEY}}`.

[![CI](https://github.com/Agnuxo1/n8n-nodes-enigmagent/actions/workflows/ci.yml/badge.svg)](https://github.com/Agnuxo1/n8n-nodes-enigmagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/n8n-nodes-enigmagent.svg)](https://www.npmjs.com/package/n8n-nodes-enigmagent)
[![npm downloads](https://img.shields.io/npm/dw/n8n-nodes-enigmagent.svg)](https://www.npmjs.com/package/n8n-nodes-enigmagent)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Agnuxo1/n8n-nodes-enigmagent?style=social)](https://github.com/Agnuxo1/n8n-nodes-enigmagent)

---

## The problem

Every n8n workflow that talks to a paid API has the same hole:

- **Credentials** sit in n8n's database, encrypted with a single key on the host.
- **AI Agent / LangChain nodes** see raw secrets the moment you reference `{{$credentials.api.apiKey}}` in a prompt template — and many of those prompts get logged, sent to OpenAI/Anthropic, embedded in vector stores, or copy-pasted into Slack as part of debugging.
- **Sub-workflows and Code nodes** can read every credential the parent workflow has access to.

[EnigmAgent](https://github.com/Agnuxo1/EnigmAgent) fixes this by moving secrets out of n8n entirely. The vault lives on a tiny local MCP server (`npx enigmagent-mcp`) that only ever returns the real value at the moment the HTTP request is made — bound to a specific origin. The rest of your workflow speaks in placeholders.

This package brings that pattern into n8n as a community node.

---

## Install

### Inside n8n (recommended)

1. Go to **Settings → Community Nodes**.
2. Click **Install**.
3. Enter `n8n-nodes-enigmagent` and confirm.
4. Restart n8n (it will prompt you).

### Manually via npm

```bash
cd ~/.n8n
npm install n8n-nodes-enigmagent
```

Then restart n8n.

---

## Setup — run the EnigmAgent REST server first

This package talks to the EnigmAgent vault over HTTP. On the same machine that runs n8n (or anywhere reachable on a private network), start:

```bash
npx enigmagent-mcp --mode rest --port 3737
```

The first run will prompt you for a master passphrase, create a vault, and let you register placeholder → secret pairs. See the [EnigmAgent README](https://github.com/Agnuxo1/EnigmAgent) for the full setup walk-through.

For shared n8n deployments, also pass `--shared-secret <token>` and configure the same value in the n8n credential below.

### Configure the credential

In n8n: **Credentials → New → EnigmAgent API**.

| Field             | Value                                     |
| ----------------- | ----------------------------------------- |
| EnigmAgent REST URL | `http://localhost:3737` (default)        |
| Shared Secret     | leave empty unless you set `--shared-secret` |

Click **Test** — if the vault is unlocked you should see `{ status: "ok", unlocked: true }`.

---

## Nodes

### 1. EnigmAgent

The thin wrapper around the REST API. Three operations:

| Operation | What it does                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve   | `POST /resolve` — given `placeholder` (e.g. `OPENAI_KEY`) and `origin` (e.g. `https://api.openai.com`), returns `{ value: "sk-..." }`. |
| List      | `GET /list` — returns the placeholders registered in the vault (names + origins, never values).                                       |
| Status    | `GET /status` — `{ status, unlocked }`.                                                                                               |

### 2. EnigmAgent Substitute

Sugar node. Walks every string in the input JSON, replaces `{{PLACEHOLDER}}` tokens with their real values from the vault, emits the substituted JSON. Drop it in **right before** an HTTP Request node.

| Field                       | Purpose                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Origin URL                  | The single origin all placeholders in this batch are resolved against. EnigmAgent will refuse to release a key registered for a different origin. |
| Field Names To Substitute   | Optional comma-separated list of top-level keys to walk (e.g. `headers, body`). Empty = walk everything.                       |
| Fail On Unresolved          | If on, the node errors out when any `{{PLACEHOLDER}}` is unknown. Off = leave the literal token in place.                     |

---

## Example workflows

### A. AI agent drafts an HTTP call, EnigmAgent injects the key

The classic dangerous pattern is asking an LLM to "call the OpenAI API with my key" — which means giving the LLM your key. With EnigmAgent the LLM only ever sees the placeholder.

```
[ AI Agent / LLM Chain ]            // produces: { headers: { Authorization: "Bearer {{OPENAI_KEY}}" }, body: {...} }
        │
        ▼
[ EnigmAgent Substitute ]           // originUrl = https://api.openai.com
        │                            // {{OPENAI_KEY}} → real sk-... at this moment only
        ▼
[ HTTP Request ]                    // executes with real Authorization header, returns response
        │
        ▼
[ ... ]                              // downstream nodes see the response, never the key
```

The prompt the LLM is fed contains only `{{OPENAI_KEY}}`. The execution log of the LLM node contains only `{{OPENAI_KEY}}`. The HTTP Request node is the only place the real value briefly exists, and the value is never persisted into n8n's database.

### B. One-shot resolve in an expression

If you just want to grab a single secret for a Code node or expression:

```
[ Manual Trigger ] → [ EnigmAgent: Resolve | placeholder=STRIPE_KEY origin=https://api.stripe.com ] → [ HTTP Request ]
```

In the HTTP Request node, set the Authorization header to `Bearer {{ $json.value }}`. The value sits in the execution data of the Resolve node only for as long as the workflow runs (and you can configure n8n to delete execution data immediately, see "Security model" below).

---

## Security model

- **No long-lived n8n credential holds the real key.** The only thing in n8n's encrypted credential store is the URL of your local EnigmAgent server (and optionally a shared secret).
- **Origin pinning.** EnigmAgent enforces that a placeholder is only released for the origin it was registered against — a leak in workflow code can't cross-pollute a Stripe key into an OpenAI request.
- **Local-first.** The default URL is `http://localhost:3737` — the vault never leaves your host. For multi-host n8n, run EnigmAgent on a private network address and set `--shared-secret`.
- **Short-lived in execution data.** For maximum hygiene, set n8n's `EXECUTIONS_DATA_PRUNE=true` and a short retention window — resolved values only ever exist in the execution data of the Resolve / Substitute node, and are gone the moment you prune.

For the full threat model and crypto details see the [EnigmAgent main repo](https://github.com/Agnuxo1/EnigmAgent).

---

## Development

```bash
git clone https://github.com/Agnuxo1/n8n-nodes-enigmagent
cd n8n-nodes-enigmagent
npm install
npm run build
# link into a local n8n install
npm link
cd ~/.n8n && npm link n8n-nodes-enigmagent
```

PRs welcome — especially additional ergonomics (bulk resolve in one POST, expression-language helpers, etc.).

---

## Links

- Main repo: https://github.com/Agnuxo1/EnigmAgent
- MCP server: https://github.com/Agnuxo1/enigmagent-mcp · `npm install -g enigmagent-mcp`
- This community node: https://github.com/Agnuxo1/n8n-nodes-enigmagent
- n8n community-node docs: https://docs.n8n.io/integrations/creating-nodes/build/reference/

## License

MIT © Francisco Angulo de Lafuente
