<h1><sub><img src="assets/tiktok-logo.png" alt="TikTok" width="28"></sub>&ensp;TikTok MCP</h1>

![TikTok MCP examples](assets/tiktok-mcp-examples.png)

Allow any AI agent to use the full TikTok interface through this self-hosted MCP. With this MCP you can:

- Post/schedule videos
- Manage profile; pfp, display name, and bio
- Find viral tiktok hooks
- Track analytics from TikTok Studio

Works with any MCP-compatible agent or CLI(Claude Code, Codex, Hermes Agent, etc.). **Maintained by [Palmyr](https://palmyr.ai/)**

--

You can connect unlimited number of accounts. The agent will keep all TikTok sessions, media, browser profiles, and analytics local.

## Tools


| Tool                      | What it does                              |
| ------------------------- | ----------------------------------------- |
| `tiktok_connect`          | Return a shareable QR login link          |
| `tiktok_connect_status`   | Check whether login completed             |
| `tiktok_accounts`         | List local accounts and session state     |
| `tiktok_post`             | Post or natively schedule a video         |
| `tiktok_mix_media`        | Merge a separate audio track into a video (use a sound) |
| `tiktok_make_quiz`        | Burn a question + options onto a video    |
| `tiktok_make_duet`        | Compose a duet (split screen) or stitch MP4 |
| `tiktok_monetization_status` | Read monetization status from TikTok Studio |
| `tiktok_comment_reply`       | Reply to a comment in TikTok Studio's Comment Management |
| `tiktok_pin_video`           | Pin or unpin a video on the profile |
| `tiktok_playlist_manage`     | Create a playlist, or add/remove a post from one |
| `tiktok_search`             | Search TikTok (videos, users, hashtags) |
| `tiktok_trending`           | Read the For You feed (trending for you) |
| `tiktok_operation_status` | Poll an asynchronous browser job          |
| `tiktok_follow`           | Follow a user                             |
| `tiktok_like`             | Like a video                              |
| `tiktok_unlike`           | Remove the like from a video              |
| `tiktok_comment`          | Comment on another user's video           |
| `tiktok_comments`         | List comments on the account's videos     |
| `tiktok_delete`           | Delete a video                            |
| `tiktok_update_profile`   | Update a display name or bio              |
| `tiktok_update_avatar`    | Update a profile image                    |
| `tiktok_analytics`        | Collect and save post metrics locally     |
| `tiktok_series`           | Read saved performance history and growth |
| `tiktok_hooks`            | Analyze caption hooks from local history  |
| `tiktok_niches`           | List suggested hook-analysis niches       |
| `tiktok_scheduled`        | List scheduled posts recorded locally     |
| `tiktok_cancel_scheduled` | Cancel a scheduled post                   |




## Quick start

You need Node.js 18.18+ and Chrome, Edge, or Brave. Add this server to your agent's MCP configuration:

```json
{
  "mcpServers": {
    "tiktok": {
      "command": "npx",
      "args": ["-y", "github:0xArtex/tiktok-mcp"]
    }
  }
}
```

Restart the agent, then ask:

```text
Connect my TikTok account as [my-brand]
```

The MCP returns a shareable `connect_url`. Send it to the human who owns the account; they open it, scan the live TikTok QR, and confirm login while the agent polls the connection.

> **Important:** make sure the agent's VPS/browser and the human's phone to be in the same country or a nearby region, since TikTok may refuse geographically distant QR logins. If they are different, we suggest to use a temporarily VPN/proxy while scanning.

If no installed browser is detected, install Playwright's Chromium once:

```bash
npx playwright install chromium
```

On a Linux VPS without a desktop display, install Xvfb so TikTok receives a headed browser while the human uses the remote link:

```bash
sudo apt-get install -y xvfb
```



## Hosted HTTP API

Don't want to run the browser/runtime yourself? Use our hosted x402 API at `https://tiktok.palmyr.ai/v1` with AgentCash, Agentic Market, or any x402 client. It is an HTTP API, not a remote MCP server.

```bash
npx agentcash@latest add https://tiktok.palmyr.ai
npx agentcash@latest discover https://tiktok.palmyr.ai
npx agentcash@latest check https://tiktok.palmyr.ai/v1/post
```

AgentCash handles the x402 challenge and USDC payment.

- [Hosted API skill](https://tiktok.palmyr.ai/skill.md)
- [OpenAPI](https://tiktok.palmyr.ai/openapi.json)
- [Agentic Market](https://agentic.market/services/tiktok-palmyr-ai)

The paid hosted automation API is optional.

## Local configuration


| Setting                    | Default                    | Description                              |
| -------------------------- | -------------------------- | ---------------------------------------- |
| `TIKTOK_MCP_DATA_DIR`      | `~/.tiktok-mcp`            | Local profiles, job state, and analytics |
| `TIKTOK_BROWSER_PATH`      | auto-detected              | Chrome-family browser executable         |
| `TIKTOK_HEADLESS`          | headed on desktop          | Set `true` for headless operation        |
| `TIKTOK_CONNECT_RELAY_URL` | `https://tiktok.palmyr.ai` | Ephemeral QR hand-off origin             |




## Development

```bash
git clone https://github.com/0xArtex/tiktok-mcp.git
cd tiktok-mcp
npm install
npm test
```



## License

MIT
