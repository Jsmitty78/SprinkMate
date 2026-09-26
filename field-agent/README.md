# 現場カメラエージェント

配管1区間の図面と観測を照合し、追加撮影・計測・人による確認を経て、根拠と未解決事項を含む変更検討資料を作ります。

**設備全体の適合判定は対象外。採用した限定ルールの判定は対象です。** 初版で採用するのは `TY3231_INSTALL_ORIENTATION_V1` だけです。図面との一致・不一致と、メーカーの方向条件への適合・不適合を独立に表示します。

## 起動

Node.js 22.19以上、pnpm 10を使用します。

```sh
cd /Users/yuyoshimuta/dev/InnovationCup/field-agent
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

http://127.0.0.1:4310 を開き、初回起動で生成される `.data/access-token` の内容を接続画面へ入力します。このトークンはアプリへの接続専用です。モデルの認証情報を入力しないでください。アプリ用トークンを確認するコマンドは `cat .data/access-token` です。ブラウザのタブを閉じると接続用のsessionStorageも消えます。

開発時は `pnpm dev`。APIは4310、Viteは5173、`/api` はViteからAPIへ転送します。ビルド後のWebはAPIサーバーが同じoriginで配信します。`pnpm start` 後にWebを初めてビルドした場合はサーバーを再起動します。

## 最初に試す流れ

1. 仕事を作成し、合成ケース「欠測」を読み込む。方向と基準は `unknown`。
2. Piを実行するか、画面から方向・重力基準の追加撮影を要求する。
3. デモの追加記録を読み込むか、保存済み写真を選んで回答する。写真からの認識候補は人が確認するまで未確認。
4. 再検証して変更検討資料を作る。Web表示とJSONで取得できる。
5. 別の仕事で「図面も現物も上向き」を読み込む。図面比較は一致、採用ルールは `fail`。資料が完成しても不適合は残る。

Piを使わず、実クライアントと同じHTTP APIへ画像・確認・計測・回答を送る一巡確認:

```sh
pnpm replay
```

生成された記録・画像・資料には合成であることが残ります。この結果は実写の認識能力やAR計測精度の実証ではありません。期待結果を持つテストと評価器はPiのコンテキストに渡しません。

## Pi

`@earendil-works/pi-coding-agent@0.87.1` を固定し、既存Piの `ModelRuntime` から `openai-codex / gpt-6-astra` を利用します。認証は実行開始時にサーバー内で読み込みます。Piの既定agent directory（通常 `~/.pi/agent`）に有効な認証が必要です。認証が空の場合はPi CLIの `/login` から `openai-codex` へログインし、サーバーを再起動してください。

2026-09-26の実装確認時点ではPi認証ストアが空でした。ユーザーの指定により、実モデルの画像接続試験は保留しています。下のコマンドは認証後に実行するための手順です。

```sh
pnpm smoke:pi
```

この試験は合成画像だけに書かれた識別コードの読取りと `validate_task` の呼出しを確認します。結果には成功条件だけを出力し、モデル認証情報・生のモデル応答は出しません。認証／接続失敗は検査未完了として扱います。実写評価とは独立です。

アプリ独自のResourceLoader、12個の業務ツール、アプリ専用の設定を使います。個人のextensions・skills・AGENTS.mdや既定のshell／ファイル編集ツールは読み込みません。画像取得、crop、資料参照、未確認候補、差異候補、追加要求、検証、資料作成だけを公開します。確認済みへの変更、ルールの変更、検証結果の上書き、ユーザーに代わる回答は公開しません。

同じ仕事のPi処理を直列化し、ツールも逐次実行します。人の回答を待つ間はrunを終了し、要求はDBへ残します。回答時は保存したsessionで再開します。処理中に終了した仕事は再起動時に再開対象となり、取消済みの仕事に遅れて書き込む操作は拒否します。

## iPhone

`ios/FieldAgent.xcodeproj` をXcodeで開きます。iOS 18以上、SwiftUI・ARKit・RealityKit、FocusEntityの固定commitを使用します。詳細なビルド手順と実機前提は [ios/README.md](ios/README.md) を参照してください。

MacとiPhoneを同じネットワークに置き、LANからの接続を使う場合だけ次で起動します:

```sh
FIELD_AGENT_HOST=0.0.0.0 pnpm start
```

iPhoneの設定には `http://<MacのLANアドレス>:4310` とアプリ用接続トークンを入れます。初版は単一利用者・ローカルネットワーク用です。モデル認証は端末に送信しません。

FocusEntityは照準表示だけに使います。計測は確定時のraw raycastを採用し、交点なし／仮位置／追跡不十分なら距離を返しません。端点と写真には同じARFrameの時刻、セッション、座標系、trackingを記録します。座標系変更時は未完了の端点を破棄します。写真・計測・要求への回答は端末の送信待ちへ保存し、同じIDで順番に再送します。

## 限定ルールと資料

根拠は [TYCO TFP171・August 2026](https://docs.johnsoncontrols.com/tycofire/api/khub/documents/JXGj~rL_f_FBVCY52uMTJw/content)、3ページの製品識別と5ページのInstallation Step 1です。TY3231をPendent型として識別し、Pendent型に下向き設置を指定しています。

| 条件 | 結果 |
| --- | --- |
| TY3231・取付後・通常形／非埋込を確認し、独立した現物観測と方向基準から下向きを確認 | `pass` |
| 同じ適用条件で上向き／横向きと確認 | `fail` |
| 型式、適用条件、実方向、方向基準、確認、根拠が不足 | `unknown` |
| 別型式、未取付、埋込など範囲外と独立に確認 | `not_applicable` |

確認済みの除外条件があれば、無関係な入力が未確認でも適用外にできます。曖昧な型式名・姿勢・根拠は除外の根拠にしません。画面下方向から重力を推測せず、角度許容値も独自に設けません。

ルール定義・出典版はコード内の固定レジストリです。検証結果に適用判定、状態、理由、不足入力、根拠ID、仕事版・ルール版・資料版を保持します。図面版は検証レポートに保持します。観測IDは不変で、画像とメタデータのdigestを保存し、同じIDで異なる内容は受け付けません。

観測・確認・図面を変更すると現行版で再検証し、旧成果物を失効させます。成果物を作る際にも再検証します。未確認項目は追加要求で解消するか、取得不能の理由を回答する必要があります。取得不能を記録した資料でも結果は `unknown` のままです。観測上の障害物などは未検証の差異候補として資料へ残し、散水障害の適否には変換しません。

## 構成・API

- `packages/core`: TypeBox契約、純粋な限定ルール／図面比較／計測検証、合成テスト。
- `apps/server`: Hono、SQLite、画像保存・sharp、Pi、永続job・操作ログ・再送の重複防止。`src/plugins/field-review.ts` に業務指示とツールをまとめ、`pi.ts` の実行ハーネスから登録。
- `apps/web`: React + Vite。図面SVG、写真、候補の確認訂正、要求への回答、独立した判定欄、資料。
- `ios`: SwiftUIの撮影・AR概測・Keychain・送信待ち。
- `scripts`: HTTPリプレイ、Pi実接続試験、オフライン実記録評価。
- `evaluation`: 実写／実機の評価手順。正解ラベルはここへ分離し、サーバー・Piへ渡さない。

すべての `/api/*` に `Authorization: Bearer <app token>` が必要です。

| Method / Path | 内容 |
| --- | --- |
| `GET/POST /api/tasks` | 一覧／作成 |
| `GET /api/tasks/:id` | 現行の仕事 |
| `POST /api/tasks/:id/observations` | multipart `metadata` JSON + `image` |
| `GET /api/tasks/:id/assets/:assetId` | 対象の画像（原本／表示用） |
| `POST /api/tasks/:id/facts` | `{baseRevision, facts}` 人による確認／訂正 |
| `POST /api/tasks/:id/plan` | `{baseRevision, orientation}` 図面の更新 |
| `POST /api/tasks/:id/measurements` | 共通Measurement契約 |
| `POST /api/tasks/:id/requests` | `{kind, reason, fields}` 追加要求 |
| `POST /api/tasks/:id/answers` | `{id, requestId, observationIds, measurementIds?, unavailableReason?}` |
| `POST /api/tasks/:id/validate` | 決定的な再検証 |
| `POST/GET /api/tasks/:id/artifact` | 現行版資料の作成／取得 |
| `POST /api/tasks/:id/run` | `{message?}` Pi開始／再開 |
| `POST /api/tasks/:id/cancel` | 取消 |
| `GET /api/tasks/:id/events` | SSE。Bearer付きfetch、`Last-Event-ID` または `after` |
| `POST /api/tasks/:id/replay` | 合成デモ入力 |
| `GET /api/rules` | 採用ルール（読取り専用） |

書込みの再送は同じ `Idempotency-Key` を使います。画像・計測・回答はその記録IDでも重複防止します。確認／図面編集は `baseRevision` で競合を検出します。SSEイベントには連番があり、再接続時に再取得できます。

`.data/field.sqlite` が業務状態の正本で、画像は `.data/assets/`、Piの実行記録は `.data/pi/` です。SQLiteには仕事、操作の応答、イベント、画像参照、Pi session参照、永続jobを保存します。Pi sessionは業務状態の正本ではありません。`.data/` と端末のKeychain／送信待ちをGitへ含めません。

設定: `FIELD_AGENT_DATA_DIR`、`FIELD_AGENT_TOKEN`、`FIELD_AGENT_HOST`、`PORT`。Piを無効にした保存・検証のデモは `FIELD_AGENT_DISABLE_PI=1 pnpm start`。

## 検証と未評価範囲

`pnpm test` は、限定ルール、欠落入力、図面との独立性、AR取得メタデータ、API認証、再送、SQLite再開、取消、版の更新、Piのtool境界を検査します。最初の検証器53テストが通過してからPiとカメラの接続実装へ進みました。

2026-09-26の確認: TypeScript側102テスト、全packageの型検査、Web production buildが通過。実HTTPリプレイと認証付きSSEも確認しました。Webの実操作で「欠測→要求→回答→資料」「図面一致＋ルール不適合」「確認取消→旧資料失効」を確認しました。iOS Simulatorでは6 unit testsと1 live API testが通過し、native URLSessionで画像・計測・回答の再送から成果物まで確認しています。実モデルの接続試験は上記のとおり保留、iPhone実機の撮影・AR精度は未評価です。

実写の方向認識とAR誤差は [evaluation/README.md](evaluation/README.md) の別データで評価します。計測入力が有効でも `accuracy: "unknown"` を保持します。実機データがない段階では、認識率・寸法精度・施工に使える精度を主張しません。

対象外: 設備全体の適合判定、水理計算、未採用のNFPA配置条件、散水障害・支持耐震の判定、CAD自動変更、加工寸法の確定、外部発注、常時動画・音声、LiDAR、公開クラウド運用。
