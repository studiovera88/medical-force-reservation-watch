# Medical Force Reservation Watch

Medical Forceの予約ページを定期確認し、予約表本体に `◎` が出たらDiscord Webhookへ通知するローカル監視ツール。

凡例の `◎ 予約できます` は誤検知しないように除外します。

## 初期設定

1. Discordで通知先チャンネルのWebhook URLを作る。
2. このプロジェクトで `.env.example` を `.env` にコピーする。
3. `.env` の `WATCH_URL` に予約ページURLを入れる。
4. `.env` の `DISCORD_WEBHOOK_URL` にWebhook URLを入れる。
5. 予約表を出すためにクリックするメニュー名を `MENU_TEXTS` に入れる。
6. 1回だけ確認する。

```sh
cp .env.example .env
npm run watch:dry
npm run watch:once
```

## 5分おきに自動監視

Mac上で監視する場合:

```sh
bin/install-launchd.sh
```

停止する場合:

```sh
bin/uninstall-launchd.sh
```

## GitHub Actionsで無料監視

Macを閉じていても監視したい場合は、GitHub Actionsで5分おきに実行できます。

GitHubリポジトリのSecrets/Variablesに以下を設定します。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| Secret | `DISCORD_WEBHOOK_URL` | Discord Webhook URL |
| Secret | `MENU_TEXTS` | 予約表までにクリックするメニュー名 |
| Variable または Secret | `WATCH_URL` | 監視する予約ページURL |
| Variable | `CONFIRM_TEXT` | 通常は `メニューを確定する` |

Workflowは `.github/workflows/reservation-watch.yml` です。

注意:

- public repoならGitHub Actionsの分数課金を気にせず使えます。
- private repoで5分おきにすると無料枠を超える可能性があります。
- Actions側では `state/notified-slots.json` に通知済み枠だけ保存し、同じ空き枠の連続通知を防ぎます。
- public repoへ上げる場合、`WATCH_URL` は必ずSecret/Variable側に置き、コードやREADMEへ実URLを書かないでください。
- public repoへ上げるときは、ローカル履歴をそのままpushせず、履歴なしの公開用snapshotから作成してください。

公開用snapshotを作る:

```sh
bin/create-public-snapshot.sh
```

## 設定

| 変数 | 内容 |
| --- | --- |
| `WATCH_URL` | 監視する予約ページURL |
| `DISCORD_WEBHOOK_URL` | DiscordのWebhook URL |
| `MENU_TEXTS` | 予約表までにクリックするメニュー名。複数ある場合は `院長指名|山田医師` のように `|` 区切り |
| `CONFIRM_TEXT` | メニュー選択後に押す確定ボタン。不要なら空文字 |
| `CHECK_TIMEOUT_MS` | ページ表示を待つ最大時間 |
| `PAGE_SETTLE_MS` | 予約表らしき文字を検知した後の追加待機 |
| `STATE_FILE` | 通知済み枠の記録ファイル |
| `CHROME_PATH` | 起動するChromeの実行ファイル |
| `WRITE_STATUS_STATE` | `false` にすると空きなし/通知済みだけではstateを書き換えない |

## 動作条件

- Node.js 22以上
- Google Chrome
- npm install不要
