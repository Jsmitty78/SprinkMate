# 現場カメラエージェント

The independent [Pi + JEV workflow connection](packages/workflow/README.md) provides the new two-scenario runner and reproducible connection fixtures. It is not yet connected to this older camera-workflow server/UI or the pending work-package services.

配管1区間の図面と観測を照合し、追加撮影・計測・人による確認を経て、根拠と未解決事項を含む変更検討資料を作ります。

**設備全体の適合判定は対象外。採用した限定ルールの判定は対象です。** TFP171に基づくメーカー条件10項目を採用しています。各条件と図面比較の結果を独立に表示します。実装済みの範囲とNFPA側の残件は [ルール台帳](docs/rule-inventory.md) を参照してください。

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
2. 画面から方向・重力基準の追加撮影を要求する。
3. デモの追加記録を読み込むか、保存済み写真を選んで回答する。写真からの認識候補は人が確認するまで未確認。
4. 再検証して変更検討資料を作る。Web表示とJSONで取得できる。
5. 別の仕事で「図面も現物も上向き」を読み込む。図面比較は一致、採用ルールは `fail`。資料が完成しても不適合は残る。
6. 「方向は合うが使用圧力が超過」を読み込む。取付方向が `pass` でも、最大使用圧力の `fail` は別の結果として資料に残る。

実クライアントと同じHTTP APIへ画像・確認・計測・回答を送る一巡確認:

```sh
pnpm replay
```

生成された記録・画像・資料には合成であることが残ります。この結果は実写の認識能力やAR計測精度の実証ではありません。

## 限定ルールと資料

根拠は [TYCO TFP171・August 2026](https://docs.johnsoncontrols.com/tycofire/api/khub/documents/JXGj~rL_f_FBVCY52uMTJw/content)。型式ごとの方向、埋込型と化粧板の組合せ、ガラス球の状態、指定レンチ、NPT施工トルク、対象型式の改修限定、工場出荷後の仕上げ変更、漏れ、目視腐食、最大使用圧力の10条件を個別に評価します。全条件が対象とするのは取付済みの限定された製品です。取付前の検品・施工許可の判定ではありません。

通常形の対象はTY2131/TY2231/TY3131/TY3231/TY4131/TY4231/TY4831/TY4931。埋込の対象はTY2231/TY3231/TY4231です。NPT条件を特殊なISO接続へ流用しません。各条件のページ・適用範囲は `GET /api/rules` と検証結果に含みます。

| 条件 | 結果 |
| --- | --- |
| 対象製品・取付条件を確認し、その条件に必要な観測／記録が採用要件を満たす | その条件だけ `pass` |
| 適用範囲内で採用要件を満たさないことを確認 | その条件だけ `fail` |
| 適用条件、観測、記録、確認、根拠が不足 | `unknown` |
| 未採用製品、未取付、その条件の対象外の取付方式・ねじなどを独立に確認 | `not_applicable` |

確認済みの除外条件があれば、無関係な入力が未確認でも適用外にできます。曖昧な型式名・姿勢・根拠は除外の根拠にしません。画面下方向から重力を推測せず、角度許容値も独自に設けません。

使用工具とトルクは施工時の記録で確認し、完成後の見た目から推測しません。トルクは数値のft-lb、圧力は数値のpsiで記録します。圧力は設計・運用記録により確認した系統の最高使用圧力と、その根拠区分 `pressureBasis: system_maximum` が必要です。一時的な圧力計の値、試験圧力、カタログ上限を入力しても最高使用圧力の適合にはなりません。175 psiを超える対象製品の許容条件には、独立した承認根拠の確認が必要です。漏れや目視腐食がないという確認も、設備全体の健全性や耐圧試験の合格を意味しません。

ルール定義・出典版はコード内の固定レジストリです。`validation.rules` に全条件の適用判定、状態、理由、不足入力、根拠ID、仕事版・ルール版・資料版を保持します。互換用の `validation.rule` は取付方向だけなので、全結果の表示には使わないでください。図面版は検証レポートに保持します。観測IDは不変で、画像とメタデータのdigestを保存し、同じIDで異なる内容は受け付けません。

旧5項目の保存済みタスクは、追加項目を未確認として読み込み、旧成果物を失効させて全条件を再検証します。数値の観測と複数条件に対応したWebクライアントを使用してください。サーバー再起動時も、いずれかの採用ルール版・資料版が変われば再検証します。

観測・確認・図面を変更すると現行版で再検証し、旧成果物を失効させます。成果物を作る際にも再検証します。未確認項目は追加要求で解消するか、取得不能の理由を回答する必要があります。取得不能を記録した資料でも結果は `unknown` のままです。観測上の障害物などは未検証の差異候補として資料へ残し、散水障害の適否には変換しません。

## 構成・API

- `packages/core`: TypeBox契約、純粋な限定ルール／図面比較／計測検証、合成テスト。
- `apps/server`: Hono、SQLite、画像保存・sharp、操作ログ・再送の重複防止。
- `apps/web`: React + Vite。図面SVG、写真、候補の確認訂正、要求への回答、独立した判定欄、資料。
- `scripts`: HTTPリプレイ、ルール評価CLI、オフライン実記録評価。
- `evaluation`: 実写／実機の評価手順。正解ラベルはここへ分離し、サーバーへ渡さない。

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
| `POST /api/tasks/:id/cancel` | 取消 |
| `GET /api/tasks/:id/events` | SSE。Bearer付きfetch、`Last-Event-ID` または `after` |
| `POST /api/tasks/:id/replay` | 合成デモ入力 |
| `GET /api/rules` | 採用ルール（読取り専用） |
| `POST /api/rules/san-francisco/resolve-edition` | `{facts, context}` 許可記録からNFPA 13版を照合。タスク変更・適合判定は行わない |

書込みの再送は同じ `Idempotency-Key` を使います。画像・計測・回答はその記録IDでも重複防止します。確認／図面編集は `baseRevision` で競合を検出します。SSEイベントには連番があり、再接続時に再取得できます。

`.data/field.sqlite` が業務状態の正本で、画像は `.data/assets/` です。仕事、操作の応答、イベント、画像参照を保存します。既存の業務データは保持します。

設定: `FIELD_AGENT_DATA_DIR`、`FIELD_AGENT_TOKEN`、`FIELD_AGENT_HOST`、`PORT`。起動時のモデル認証は不要です。

Pi実行基盤とiOSクライアントは削除しました。旧DB内の実行履歴や観測の取得元は保持しますが、実行キューは再開しません。Web・CLI・APIで確認済み入力を検証します。

## サンフランシスコの規格版の照合

SFFD AB 2.04 (2025) p.1の限定された許可条件を、別の照合関数とCLIにしています。新築のsite/architectural permitが2025基準ならNFPA 13-2025、2022なら2022、2019なら2016を対応付けます。所有者が新しい版を選ぶ場合と、原FIRE Only許可の版を維持するrevision/as-builtを分けます。サンフランシスコという所在地だけで全タスクを2025版には設定しません。

```sh
pnpm rules:sf-basis docs/san-francisco-basis.example.json
```

この例は明示的な合成許可データです。実案件では許可記録・確認者による確認と根拠を入力します。戻り値は `resolved` / `unknown` / `not_applicable` と版・理由・出典であり、設計の適合や許可承認ではありません。NFPA 13R/13Dや、この資料で扱っていない許可区分はこの版照合の対象外です。判定器へのタスク単位のNFPA条件の採用と、配置・障害物などの数値判定はまだ実装していません。

## 検証と未評価範囲

`pnpm test` は限定ルール、欠落入力、図面との比較、API認証、再送、SQLite再開、取消、版の更新を検査します。型検査は `pnpm typecheck`、Webビルドは `pnpm build` です。

実写の方向認識と計測誤差を評価する独立ツールは [evaluation/README.md](evaluation/README.md) にあります。保存済み計測の読み取りと検証は保持しますが、撮影・AR計測のクライアントは含みません。実装済みルールと未対応範囲は [ルール台帳](docs/rule-inventory.md) を参照してください。
